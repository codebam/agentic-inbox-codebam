import {
	SELF,
	createExecutionContext,
	createScheduledController,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import worker from "../workers/app";
import { listMailboxes } from "../workers/lib/email-helpers";
import {
	LINK_SWEEP_BATCH,
	LINK_THRESHOLD_BYTES,
	LINK_TTL_DAYS,
	MAX_LINKED_FILE_BYTES,
	MAX_LINKED_FILES,
	MAX_LINKED_TOTAL_BYTES,
	createLinkToken,
	linkedAttachmentCapError,
	buildDownloadUrl,
	sweepAttachmentLinks,
} from "../workers/lib/attachment-links";
import {
	formatFileSize,
	isLinkableAttachment,
	toLinkedAttachmentPayloads,
	validateLinkedAttachmentSelection,
	type AttachmentCandidate,
} from "../app/lib/attachments";
import { SendEmailRequestSchema } from "../workers/lib/schemas";

const MB = 1024 * 1024;
/** "hello" — the bytes every linked file in these tests carries. */
const HELLO_BASE64 = "aGVsbG8=";

type Stub = ReturnType<typeof stubFor>;

/** Raw `attachments` columns the link feature owns. */
interface AttachmentLinkRow {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	link_token: string | null;
	link_expires_at: string | null;
}

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

/** Register the mailbox record the API middleware requires. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(
		`mailboxes/${mailbox}.json`,
		JSON.stringify({ categorization: { enabled: false } }),
	);
}

/**
 * Drop every mailbox record so a sweep only sees the mailboxes the test itself
 * registered — sweep summaries are otherwise order-dependent (storage is
 * shared across the tests in this file).
 */
async function resetMailboxes() {
	for (const mailbox of await listMailboxes(env.BUCKET)) {
		await env.BUCKET.delete(`mailboxes/${mailbox.id}.json`);
	}
}

/** POST the compose send route. */
async function sendEmail(mailbox: string, body: Record<string, unknown>) {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/emails`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				to: "recipient@example.org",
				from: mailbox,
				subject: "Large attachment",
				html: "<p>See the link</p>",
				...body,
			}),
		},
	);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The Sent copy a send route call just stored. */
async function sentCopy(stub: Stub) {
	const listed = (await stub.getEmails({ folder: Folders.SENT })) as {
		id: string;
	}[];
	const id = listed[0]?.id ?? "";
	return (await stub.getEmail(id)) as {
		id: string;
		body: string;
		attachments: AttachmentLinkRow[];
	} | null;
}

/** Raw read of one attachment row; undefined when it does not exist. */
async function readAttachmentRow(stub: Stub, id: string) {
	return runInDurableObject(stub, async (_instance, state) => {
		const rows = [
			...state.storage.sql.exec(
				"SELECT id, email_id, filename, mimetype, size, link_token, link_expires_at FROM attachments WHERE id = ?1",
				id,
			),
		];
		return rows.length > 0 ? (rows[0] as unknown as AttachmentLinkRow) : undefined;
	});
}

/**
 * Rewrite a row's link_expires_at with raw SQL — the only way to simulate a
 * link that expired at a known instant without adding test-only production
 * knobs. Mirrors `setTrashedAt` in tests/trash-retention.test.ts.
 */
async function setLinkExpiresAt(stub: Stub, id: string, expiresAt: string | null) {
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec(
			"UPDATE attachments SET link_expires_at = ?1 WHERE id = ?2",
			expiresAt,
			id,
		);
	});
}

/** One `linked_attachments[]` entry, the shape the composer sends. */
function linkedAttachment(
	filename: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		content: HELLO_BASE64,
		filename,
		type: "application/octet-stream",
		size: LINK_THRESHOLD_BYTES,
		...overrides,
	};
}

/** R2 key of a linked file, using the storeAttachments layout. */
function r2Key(emailId: string, attachmentId: string, filename: string) {
	return `attachments/${emailId}/${attachmentId}/${filename}`;
}

function isoDaysBefore(daysAgo: number, now = new Date()) {
	return new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

describe("attachment link migration", () => {
	it("migration 28 adds link_token and link_expires_at to attachments", async () => {
		const stub = stubFor("attach-links-migration@example.com");
		const columns = await runInDurableObject(stub, async (_instance, state) => {
			return [...state.storage.sql.exec("PRAGMA table_info(attachments)")] as unknown as {
				name: string;
			}[];
		});
		const names = columns.map((column) => column.name);
		expect(names).toContain("link_token");
		expect(names).toContain("link_expires_at");
	});
});

describe("linked attachment limits", () => {
	it("mirrors the composer's caps and the Email Service threshold", () => {
		expect(LINK_THRESHOLD_BYTES).toBe(5 * MB);
		expect(LINK_TTL_DAYS).toBe(30);
		expect(MAX_LINKED_FILE_BYTES).toBe(60 * MB);
		expect(MAX_LINKED_TOTAL_BYTES).toBe(100 * MB);
		expect(MAX_LINKED_FILES).toBe(5);
	});

	it("routes files at or above the threshold to the linked list", () => {
		expect(isLinkableAttachment({ size: LINK_THRESHOLD_BYTES - 1 })).toBe(false);
		expect(isLinkableAttachment({ size: LINK_THRESHOLD_BYTES })).toBe(true);
		expect(isLinkableAttachment({ size: 40 * MB })).toBe(true);
	});

	it("caps a batch at the file count, per-file and total limits", () => {
		const sixFiles = Array.from({ length: MAX_LINKED_FILES + 1 }, (_, index) => ({
			filename: `f${index}.bin`,
			size: MB,
		}));
		expect(linkedAttachmentCapError(sixFiles)).toContain(`${MAX_LINKED_FILES} files`);

		expect(
			linkedAttachmentCapError([
				{ filename: "huge.bin", size: MAX_LINKED_FILE_BYTES + 1 },
			]),
		).toContain("huge.bin");
		expect(linkedAttachmentCapError([{ filename: "big.bin", size: MAX_LINKED_FILE_BYTES }])).toBeNull();

		expect(
			linkedAttachmentCapError([
				{ filename: "a.bin", size: MAX_LINKED_TOTAL_BYTES / 2 },
				{ filename: "b.bin", size: MAX_LINKED_TOTAL_BYTES / 2 + 1 },
			]),
		).toContain("total");
		expect(
			linkedAttachmentCapError([
				{ filename: "a.bin", size: MAX_LINKED_TOTAL_BYTES / 2 },
				{ filename: "b.bin", size: MAX_LINKED_TOTAL_BYTES / 2 },
			]),
		).toBeNull();
	});

	it("shapes composer linked files into payloads the send schema accepts", () => {
		const payloads = toLinkedAttachmentPayloads([
			{
				id: "local-1",
				filename: "big.bin",
				type: "application/octet-stream",
				size: LINK_THRESHOLD_BYTES,
				content: HELLO_BASE64,
				disposition: "attachment",
			},
		]);
		expect(payloads).toEqual([
			{
				content: HELLO_BASE64,
				filename: "big.bin",
				type: "application/octet-stream",
				size: LINK_THRESHOLD_BYTES,
				disposition: "attachment",
			},
		]);
		const parsed = SendEmailRequestSchema.safeParse({
			to: "recipient@example.com",
			from: "sender@example.com",
			subject: "Big file",
			html: "<p>See link</p>",
			linked_attachments: payloads,
		});
		expect(parsed.success).toBe(true);
	});

	it("keeps the linked-file limits on the picker's linked list", () => {
		const candidate = (filename: string, size: number): AttachmentCandidate => ({
			filename,
			type: "application/octet-stream",
			size,
		});
		const overFile = validateLinkedAttachmentSelection([
			candidate("huge.bin", MAX_LINKED_FILE_BYTES + 1),
		]);
		expect(overFile.accepted).toEqual([]);
		expect(overFile.errors[0]).toContain(formatFileSize(MAX_LINKED_FILE_BYTES));

		const full = validateLinkedAttachmentSelection(
			[candidate("one-too-many.bin", MB)],
			Array.from({ length: MAX_LINKED_FILES }, () => ({ size: MB })),
		);
		expect(full.accepted).toEqual([]);
		expect(full.errors[0]).toContain(`up to ${MAX_LINKED_FILES} files`);
	});

	it("generates URL-safe 32-byte tokens", () => {
		const token = createLinkToken();
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(createLinkToken()).not.toBe(token);
		expect(buildDownloadUrl("box@example.com", "att-1", token)).toBe(
			`/api/v1/downloads/box%40example.com/att-1?token=${token}`,
		);
	});
});

describe("send with linked attachments", () => {
	it("stores the bytes in R2, links the row and appends the URL to the body", async () => {
		const mailbox = "attach-links-send@example.com";
		await registerMailbox(mailbox);

		const response = await sendEmail(mailbox, {
			linked_attachments: [linkedAttachment("big.bin")],
		});
		expect(response.status).toBe(202);

		const stub = stubFor(mailbox);
		const sent = await sentCopy(stub);
		expect(sent).not.toBeNull();
		const [attachment] = sent?.attachments ?? [];
		expect(attachment).toBeDefined();
		if (!attachment) throw new Error("no attachment row");

		// The row carries a token and a 30-day expiry …
		expect(attachment.link_token).toMatch(/^[0-9a-f]{64}$/);
		expect(attachment.link_expires_at).not.toBeNull();
		const ttlMs = Date.parse(attachment.link_expires_at ?? "") - Date.now();
		expect(ttlMs).toBeGreaterThan((LINK_TTL_DAYS - 1) * 24 * 60 * 60 * 1000);
		expect(ttlMs).toBeLessThanOrEqual(LINK_TTL_DAYS * 24 * 60 * 60 * 1000);

		// … the bytes sit in R2 under the shared keying …
		expect(
			await env.BUCKET.head(r2Key(sent?.id ?? "", attachment.id, "big.bin")),
		).not.toBeNull();

		// … and the body carries the public download URL plus the expiry note.
		const url = `/api/v1/downloads/${encodeURIComponent(mailbox)}/${attachment.id}?token=${attachment.link_token}`;
		expect(sent?.body).toContain(url);
		expect(sent?.body).toContain("big.bin");
		expect(sent?.body).toContain("download links");
		expect(sent?.body).toContain("See the link");
		// The bytes never appear in the message itself.
		expect(sent?.body).not.toContain(HELLO_BASE64);
	});

	it("accepts `mimetype` as an alias for `type`", async () => {
		const mailbox = "attach-links-mimetype@example.com";
		await registerMailbox(mailbox);

		const response = await sendEmail(mailbox, {
			linked_attachments: [
				{
					content: HELLO_BASE64,
					filename: "report.pdf",
					mimetype: "application/pdf",
					size: LINK_THRESHOLD_BYTES,
				},
			],
		});
		expect(response.status).toBe(202);

		const sent = await sentCopy(stubFor(mailbox));
		expect(sent?.attachments[0]?.mimetype).toBe("application/pdf");
	});

	it("rejects a file over the per-file cap with 400 and stores nothing", async () => {
		const mailbox = "attach-links-over-cap@example.com";
		await registerMailbox(mailbox);

		const response = await sendEmail(mailbox, {
			linked_attachments: [
				linkedAttachment("huge.bin", { size: MAX_LINKED_FILE_BYTES + 1 }),
			],
		});
		expect(response.status).toBe(400);
		expect(String(response.body.error)).toContain("huge.bin");

		const stub = stubFor(mailbox);
		expect(await sentCopy(stub)).toBeNull();
	});

	it("rejects more files than one message may link with 400", async () => {
		const mailbox = "attach-links-over-count@example.com";
		await registerMailbox(mailbox);

		const response = await sendEmail(mailbox, {
			linked_attachments: Array.from({ length: MAX_LINKED_FILES + 1 }, (_, index) =>
				linkedAttachment(`f${index}.bin`, { size: MB }),
			),
		});
		expect(response.status).toBe(400);
		expect(String(response.body.error)).toContain(`${MAX_LINKED_FILES} files`);
	});
});

describe("public download route", () => {
	/** Send one linked file and return everything needed to fetch it. */
	async function seedLinkedSend(mailbox: string, filename = "big.bin") {
		await registerMailbox(mailbox);
		const response = await sendEmail(mailbox, {
			linked_attachments: [linkedAttachment(filename)],
		});
		expect(response.status).toBe(202);
		const stub = stubFor(mailbox);
		const sent = await sentCopy(stub);
		const attachment = sent?.attachments[0];
		if (!attachment) throw new Error("no attachment row");
		return { stub, emailId: sent?.id ?? "", attachment };
	}

	it("serves the R2 bytes for the right token", async () => {
		const mailbox = "attach-links-download@example.com";
		const { attachment } = await seedLinkedSend(mailbox);

		const res = await SELF.fetch(
			`http://example.com/api/v1/downloads/${mailbox}/${attachment.id}?token=${attachment.link_token}`,
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("hello");
		expect(res.headers.get("content-type")).toBe("application/octet-stream");
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("content-disposition")).toContain("big.bin");
	});

	it("404s without a token", async () => {
		const mailbox = "attach-links-no-token@example.com";
		const { attachment } = await seedLinkedSend(mailbox);

		const res = await SELF.fetch(
			`http://example.com/api/v1/downloads/${mailbox}/${attachment.id}`,
		);
		expect(res.status).toBe(404);
	});

	it("404s for a wrong token", async () => {
		const mailbox = "attach-links-wrong-token@example.com";
		const { attachment } = await seedLinkedSend(mailbox);

		const res = await SELF.fetch(
			`http://example.com/api/v1/downloads/${mailbox}/${attachment.id}?token=${"0".repeat(64)}`,
		);
		expect(res.status).toBe(404);
	});

	it("404s for an unknown attachment", async () => {
		const mailbox = "attach-links-unknown@example.com";
		const { attachment } = await seedLinkedSend(mailbox);

		const res = await SELF.fetch(
			`http://example.com/api/v1/downloads/${mailbox}/does-not-exist?token=${attachment.link_token}`,
		);
		expect(res.status).toBe(404);
	});

	it("404s for an unknown mailbox", async () => {
		const res = await SELF.fetch(
			`http://example.com/api/v1/downloads/nobody@example.com/att-1?token=${"a".repeat(64)}`,
		);
		expect(res.status).toBe(404);
	});

	it("404s once the link has expired", async () => {
		const mailbox = "attach-links-expired@example.com";
		const { stub, emailId, attachment } = await seedLinkedSend(mailbox);

		// Rewrite the expiry into the past; the token is unchanged.
		await setLinkExpiresAt(stub, attachment.id, isoDaysBefore(1));

		const res = await SELF.fetch(
			`http://example.com/api/v1/downloads/${mailbox}/${attachment.id}?token=${attachment.link_token}`,
		);
		expect(res.status).toBe(404);
		// The blob is still there — only the daily sweep deletes it.
		expect(
			await env.BUCKET.head(r2Key(emailId, attachment.id, "big.bin")),
		).not.toBeNull();
	});
});

describe("expired link sweep", () => {
	it("deletes the expired link's blob and keeps the live one", async () => {
		await resetMailboxes();
		const mailbox = "attach-links-sweep@example.com";
		await registerMailbox(mailbox);

		const response = await sendEmail(mailbox, {
			linked_attachments: [
				linkedAttachment("expired.bin"),
				linkedAttachment("live.bin"),
			],
		});
		expect(response.status).toBe(202);

		const stub = stubFor(mailbox);
		const sent = await sentCopy(stub);
		const expired = sent?.attachments.find((a) => a.filename === "expired.bin");
		const live = sent?.attachments.find((a) => a.filename === "live.bin");
		if (!sent || !expired || !live) throw new Error("missing rows");

		const now = new Date("2026-02-01T00:00:00.000Z");
		await setLinkExpiresAt(stub, expired.id, isoDaysBefore(1, now));

		const summary = await sweepAttachmentLinks(env, { now });
		expect(summary).toEqual({ mailboxes: 1, links: 1, blobsDeleted: 1 });

		// Only the expired blob is gone …
		expect(await env.BUCKET.head(r2Key(sent.id, expired.id, "expired.bin"))).toBeNull();
		expect(await env.BUCKET.head(r2Key(sent.id, live.id, "live.bin"))).not.toBeNull();

		// … and its row no longer carries a token, so the link stays dead.
		const row = await readAttachmentRow(stub, expired.id);
		expect(row?.link_token).toBeNull();
		expect(row?.link_expires_at).toBeNull();

		const res = await SELF.fetch(
			`http://example.com/api/v1/downloads/${mailbox}/${expired.id}?token=${expired.link_token}`,
		);
		expect(res.status).toBe(404);

		// The live link still works after the sweep.
		const liveRes = await SELF.fetch(
			`http://example.com/api/v1/downloads/${mailbox}/${live.id}?token=${live.link_token}`,
		);
		expect(liveRes.status).toBe(200);
	});

	it("does nothing when no link has expired", async () => {
		await resetMailboxes();
		const mailbox = "attach-links-sweep-fresh@example.com";
		await registerMailbox(mailbox);

		const response = await sendEmail(mailbox, {
			linked_attachments: [linkedAttachment("fresh.bin")],
		});
		expect(response.status).toBe(202);

		const summary = await sweepAttachmentLinks(env);
		expect(summary).toEqual({ mailboxes: 0, links: 0, blobsDeleted: 0 });
	});

	it("the daily housekeeping cron runs the sweep", async () => {
		await resetMailboxes();
		const mailbox = "attach-links-cron@example.com";
		await registerMailbox(mailbox);

		const response = await sendEmail(mailbox, {
			linked_attachments: [linkedAttachment("cron.bin")],
		});
		expect(response.status).toBe(202);

		const stub = stubFor(mailbox);
		const sent = await sentCopy(stub);
		const attachment = sent?.attachments[0];
		if (!sent || !attachment) throw new Error("missing row");
		await setLinkExpiresAt(stub, attachment.id, "2020-01-01T00:00:00.000Z");

		const ctx = createExecutionContext();
		await worker.scheduled(createScheduledController({ cron: "0 3 * * *" }), env, ctx);
		// The handler fires the sweep through ctx.waitUntil(), so wait for it.
		await waitOnExecutionContext(ctx);

		expect(await env.BUCKET.head(r2Key(sent.id, attachment.id, "cron.bin"))).toBeNull();
	});
});

describe("linked attachments are refused outside a new message", () => {
	/** Seed one stored message to reply to / forward. */
	async function seedInbox(mailbox: string, id: string) {
		await registerMailbox(mailbox);
		await stubFor(mailbox).createEmail(
			Folders.INBOX,
			{
				id,
				subject: `Subject ${id}`,
				sender: "sender@example.org",
				recipient: mailbox,
				date: new Date().toISOString(),
				body: "<p>body</p>",
				in_reply_to: null,
				email_references: null,
				thread_id: id,
			},
			[],
		);
	}

	const linkedBody = { linked_attachments: [linkedAttachment("big.bin")] };

	it("the reply route answers 400", async () => {
		const mailbox = "attach-links-reply@example.com";
		await seedInbox(mailbox, "reply-1");

		const res = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/emails/reply-1/reply`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					to: "recipient@example.org",
					from: mailbox,
					subject: "Re: Subject reply-1",
					html: "<p>reply</p>",
					...linkedBody,
				}),
			},
		);
		expect(res.status).toBe(400);
		expect(String(((await res.json()) as { error: string }).error)).toContain(
			"only supported on new messages",
		);
	});

	it("the forward route answers 400", async () => {
		const mailbox = "attach-links-forward@example.com";
		await seedInbox(mailbox, "forward-1");

		const res = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/emails/forward-1/forward`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					to: "recipient@example.org",
					from: mailbox,
					subject: "Fwd: Subject forward-1",
					html: "<p>forward</p>",
					...linkedBody,
				}),
			},
		);
		expect(res.status).toBe(400);
	});

	it("the draft route answers 400", async () => {
		const mailbox = "attach-links-draft@example.com";
		await registerMailbox(mailbox);

		const res = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/drafts`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					to: "recipient@example.org",
					subject: "Draft",
					body: "<p>draft</p>",
					...linkedBody,
				}),
			},
		);
		expect(res.status).toBe(400);
	});
});

describe("link sweep bounds", () => {
	it("keeps a bounded batch size per DO round trip", () => {
		expect(LINK_SWEEP_BATCH).toBeGreaterThan(0);
		expect(LINK_SWEEP_BATCH).toBeLessThanOrEqual(500);
	});
});
