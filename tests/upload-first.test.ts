import {
	SELF,
	createExecutionContext,
	createScheduledController,
	runDurableObjectAlarm,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import worker from "../workers/app";
import { attachmentR2Key, decodeBase64Bytes } from "../workers/lib/attachments";
import {
	MAX_LINKED_FILE_BYTES,
	linkedAttachmentCapError,
} from "../workers/lib/attachment-links";
import { listMailboxes } from "../workers/lib/email-helpers";
import {
	PENDING_UPLOAD_TTL_DAYS,
	pendingUploadR2Key,
	sweepPendingUploads,
} from "../workers/lib/pending-uploads";
import {
	setScheduledSendSenderFactory,
	type ScheduledSendRow,
} from "../workers/lib/scheduled-sends";
import type { SendEmailParams } from "../workers/email-sender";

/** "hello" — the bytes every file in these tests carries. */
const HELLO_BASE64 = "aGVsbG8=";
const HELLO_BYTES = decodeBase64Bytes(HELLO_BASE64);
const DAY_MS = 24 * 60 * 60 * 1000;

type Stub = ReturnType<typeof stubFor>;

/** Raw `pending_uploads` columns the upload-first feature owns. */
interface PendingUploadRawRow {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	r2_key: string;
	created_at: string;
	consumed: number;
}

/** Raw `scheduled_sends` columns the fire logic owns. */
interface ScheduledSendRawRow {
	id: string;
	status: string;
	payload: string;
	last_error: string | null;
}

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

/** Register a mailbox record in R2 so the HTTP routes accept its id. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(
		`mailboxes/${mailbox}.json`,
		JSON.stringify({ categorization: { enabled: false } }),
	);
}

/**
 * Drop every mailbox record so a sweep only sees the mailboxes the test
 * itself registers — sweep summaries are otherwise order-dependent (storage
 * is shared across the tests in this file).
 */
async function resetMailboxes() {
	for (const mailbox of await listMailboxes(env.BUCKET)) {
		await env.BUCKET.delete(`mailboxes/${mailbox.id}.json`);
	}
}

/** POST one file to the upload route. */
async function uploadFile(mailbox: string, body: Record<string, unknown>) {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/uploads`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				content: HELLO_BASE64,
				filename: "hello.txt",
				...body,
			}),
		},
	);
	return {
		status: res.status,
		body: (await res.json()) as Record<string, unknown>,
	};
}

/** POST the scheduled-sends route. */
async function queueSend(mailbox: string, body: Record<string, unknown>) {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/scheduled-sends`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				to: "recipient@example.org",
				from: mailbox,
				subject: "Queued with files",
				html: "<p>See attached</p>",
				send_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
				...body,
			}),
		},
	);
	return {
		status: res.status,
		body: (await res.json()) as Record<string, unknown>,
	};
}

/** Raw read of one pending-upload row; null when the id is gone. */
async function readUploadRow(
	stub: Stub,
	id: string,
): Promise<PendingUploadRawRow | null> {
	return runInDurableObject(stub, async (_instance, state) => {
		const rows = [
			...state.storage.sql.exec("SELECT * FROM pending_uploads WHERE id = ?1", id),
		];
		return (rows[0] as unknown as PendingUploadRawRow | undefined) ?? null;
	});
}

/** Raw read of one queued send; null when the id is gone. */
async function readSendRow(
	stub: Stub,
	id: string,
): Promise<ScheduledSendRawRow | null> {
	return runInDurableObject(stub, async (_instance, state) => {
		const rows = [
			...state.storage.sql.exec("SELECT * FROM scheduled_sends WHERE id = ?1", id),
		];
		return (rows[0] as unknown as ScheduledSendRawRow | undefined) ?? null;
	});
}

/** Rewrite a row's `send_at` with raw SQL so it is due now. */
async function forceDue(stub: Stub, id: string, sendAt: string) {
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec(
			"UPDATE scheduled_sends SET send_at = ?1 WHERE id = ?2",
			sendAt,
			id,
		);
	});
}

/** A sender that records what it was asked to deliver. */
function fakeSender() {
	const sent: SendEmailParams[] = [];
	const sender = {
		send: async (params: SendEmailParams) => {
			sent.push(params);
			return { messageId: `fake-${sent.length}` };
		},
	};
	return { sender, sent };
}

/** Fire the mailbox's alarm through the sender seam, returning what was sent. */
async function fireAlarm(stub: Stub) {
	const { sender, sent } = fakeSender();
	setScheduledSendSenderFactory(() => sender);
	try {
		expect(await runDurableObjectAlarm(stub)).toBe(true);
	} finally {
		setScheduledSendSenderFactory(null);
	}
	return sent;
}

/** Store one pending upload directly (row + bytes), for age-sensitive cases. */
async function seedUpload(
	stub: Stub,
	mailbox: string,
	overrides: { id: string; filename?: string; createdAt?: string },
) {
	const filename = overrides.filename ?? "hello.txt";
	const r2Key = pendingUploadR2Key({ mailboxId: mailbox, id: overrides.id, filename });
	await env.BUCKET.put(r2Key, HELLO_BYTES);
	return stub.createPendingUpload({
		id: overrides.id,
		filename,
		mimetype: "text/plain",
		size: HELLO_BYTES.byteLength,
		r2Key,
		createdAt: overrides.createdAt,
	});
}

describe("upload-first: the upload route", () => {
	it("stores a file's bytes in R2 and answers its id, filename, mimetype and size", async () => {
		const mailbox = "upload-first-store@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		const res = await uploadFile(mailbox, {
			filename: "notes.txt",
			type: "text/plain",
			size: HELLO_BYTES.byteLength,
		});
		expect(res.status).toBe(201);
		const id = res.body.id as string;
		expect(id).toEqual(expect.any(String));
		expect(res.body).toMatchObject({
			filename: "notes.txt",
			mimetype: "text/plain",
			size: HELLO_BYTES.byteLength,
		});

		// The bytes are in R2 under uploads/{mailboxId}/{uploadId}/{filename}.
		const key = pendingUploadR2Key({ mailboxId: mailbox, id, filename: "notes.txt" });
		const object = await env.BUCKET.get(key);
		expect(object).not.toBeNull();
		expect(new Uint8Array((await object!.arrayBuffer()))).toEqual(HELLO_BYTES);

		// The row records the file, its key and that it is unconsumed.
		const row = await readUploadRow(stub, id);
		expect(row).toMatchObject({
			id,
			filename: "notes.txt",
			mimetype: "text/plain",
			size: HELLO_BYTES.byteLength,
			r2_key: key,
			consumed: 0,
		});
	});


	it("sanitizes the filename exactly like the attachment paths", async () => {
		const mailbox = "upload-first-sanitize@example.com";
		await registerMailbox(mailbox);

		const res = await uploadFile(mailbox, { filename: "../re:port?.txt" });
		expect(res.status).toBe(201);
		expect(res.body.filename).toBe(".._re_port_.txt");

		const key = pendingUploadR2Key({
			mailboxId: mailbox,
			id: res.body.id as string,
			filename: ".._re_port_.txt",
		});
		expect(await env.BUCKET.head(key)).not.toBeNull();
	});


	it("refuses a file the linked path would refuse, with its exact error", async () => {
		const mailbox = "upload-first-caps@example.com";
		await registerMailbox(mailbox);
		const oversize = MAX_LINKED_FILE_BYTES + 1;

		const res = await uploadFile(mailbox, { filename: "big.bin", size: oversize });
		expect(res.status).toBe(400);
		// The message is the linked path's own, from the same helper.
		expect(res.body.error).toBe(
			linkedAttachmentCapError([{ filename: "big.bin", size: oversize }]),
		);

		// Nothing was stored: no object under this mailbox's upload prefix.
		expect(
			(await env.BUCKET.list({ prefix: `uploads/${mailbox}/` })).objects,
		).toHaveLength(0);
	});


	it("the delete route drops the row and the object, and 404s an unknown id", async () => {
		const mailbox = "upload-first-delete@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		const upload = await uploadFile(mailbox, { filename: "bye.txt" });
		expect(upload.status).toBe(201);
		const id = upload.body.id as string;
		const key = pendingUploadR2Key({ mailboxId: mailbox, id, filename: "bye.txt" });

		const res = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/uploads/${id}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "deleted" });

		expect(await readUploadRow(stub, id)).toBeNull();
		expect(await env.BUCKET.head(key)).toBeNull();

		// A second delete finds nothing to drop.
		const again = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/uploads/${id}`,
			{ method: "DELETE" },
		);
		expect(again.status).toBe(404);
	});
});


describe("upload-first: queued sends carrying uploads", () => {
	it("fires a queued send with its uploaded file and stores it with the Sent copy", async () => {
		const mailbox = "upload-first-fire@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		const upload = await uploadFile(mailbox, {
			filename: "hello.txt",
			type: "text/plain",
		});
		expect(upload.status).toBe(201);
		const uploadId = upload.body.id as string;

		// The queued payload carries the id, never the bytes.
		const queued = await queueSend(mailbox, { upload_ids: [uploadId] });
		expect(queued.status).toBe(201);
		const row = queued.body as unknown as ScheduledSendRow;
		expect(row.payload.upload_ids).toEqual([uploadId]);
		await forceDue(stub, row.id, new Date(Date.now() - 60 * 1000).toISOString());

		const sent = await fireAlarm(stub);
		expect(sent).toHaveLength(1);
		// The file travelled inline, base64 exactly like the immediate path's.
		expect(sent[0]?.attachments).toEqual([
			{
				content: HELLO_BASE64,
				filename: "hello.txt",
				type: "text/plain",
				disposition: "attachment",
			},
		]);

		// The Sent copy names the file and its bytes sit under the attachment
		// key the download routes read.
		const listed = (await stub.getEmails({ folder: Folders.SENT })) as { id: string }[];
		expect(listed).toHaveLength(1);
		const copy = (await stub.getEmail(listed[0]!.id)) as {
			attachments: {
				id: string;
				email_id: string;
				filename: string;
				mimetype: string;
				size: number;
			}[];
		} | null;
		expect(copy?.attachments).toHaveLength(1);
		const attachment = copy!.attachments[0]!;
		expect(attachment).toMatchObject({
			filename: "hello.txt",
			mimetype: "text/plain",
			size: HELLO_BYTES.byteLength,
		});
		const copyObject = await env.BUCKET.get(
			attachmentR2Key({
				email_id: attachment.email_id,
				id: attachment.id,
				filename: attachment.filename,
			}),
		);
		expect(copyObject).not.toBeNull();
		expect(new Uint8Array((await copyObject!.arrayBuffer()))).toEqual(HELLO_BYTES);

		// The upload was consumed by the send: row and bytes are gone.
		expect(await readUploadRow(stub, uploadId)).toBeNull();
		expect(
			await env.BUCKET.head(
				pendingUploadR2Key({ mailboxId: mailbox, id: uploadId, filename: "hello.txt" }),
			),
		).toBeNull();
	});


	it("records failed with a legible last_error when an upload id is missing", async () => {
		const mailbox = "upload-first-missing@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		const queued = await queueSend(mailbox, { upload_ids: ["missing-upload-id"] });
		expect(queued.status).toBe(201);
		const row = queued.body as unknown as ScheduledSendRow;
		await forceDue(stub, row.id, new Date(Date.now() - 60 * 1000).toISOString());

		const sent = await fireAlarm(stub);
		expect(sent).toHaveLength(0);

		const failed = await readSendRow(stub, row.id);
		expect(failed?.status).toBe("failed");
		expect(failed?.last_error).toContain("missing-upload-id");
		expect(failed?.last_error).toContain("nothing was sent");
		// The payload is kept, ids and all, so the row can be retried.
		expect(JSON.parse(failed!.payload).upload_ids).toEqual(["missing-upload-id"]);
	});


	it("records failed when an upload id has expired, and leaves its bytes alone", async () => {
		const mailbox = "upload-first-expired@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		const createdAt = new Date(
			Date.now() - (PENDING_UPLOAD_TTL_DAYS + 1) * DAY_MS,
		).toISOString();
		const seeded = await seedUpload(stub, mailbox, {
			id: "expired-upload-id",
			createdAt,
		});

		const queued = await queueSend(mailbox, { upload_ids: [seeded.id] });
		expect(queued.status).toBe(201);
		const row = queued.body as unknown as ScheduledSendRow;
		await forceDue(stub, row.id, new Date(Date.now() - 60 * 1000).toISOString());

		const sent = await fireAlarm(stub);
		expect(sent).toHaveLength(0);

		const failed = await readSendRow(stub, row.id);
		expect(failed?.status).toBe("failed");
		expect(failed?.last_error).toContain("expired");
		expect(failed?.last_error).toContain("nothing was sent");

		// Nothing was consumed: the row and its bytes are still there.
		expect(await readUploadRow(stub, seeded.id)).not.toBeNull();
		expect(
			await env.BUCKET.head(
				pendingUploadR2Key({
					mailboxId: mailbox,
					id: seeded.id,
					filename: seeded.filename,
				}),
			),
		).not.toBeNull();
	});
});


describe("upload-first: the pending-upload sweep", () => {
	it("deletes a stale upload's row and object and leaves a fresh one", async () => {
		await resetMailboxes();
		const mailbox = "upload-first-sweep@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		const staleCreated = new Date(
			Date.now() - (PENDING_UPLOAD_TTL_DAYS + 1) * DAY_MS,
		).toISOString();
		const stale = await seedUpload(stub, mailbox, {
			id: "stale-upload-id",
			filename: "stale.txt",
			createdAt: staleCreated,
		});
		const fresh = await seedUpload(stub, mailbox, {
			id: "fresh-upload-id",
			filename: "fresh.txt",
		});

		const summary = await sweepPendingUploads(env, { now: new Date() });
		expect(summary).toEqual({ mailboxes: 1, uploads: 1 });

		expect(await readUploadRow(stub, stale.id)).toBeNull();
		expect(
			await env.BUCKET.head(
				pendingUploadR2Key({ mailboxId: mailbox, id: stale.id, filename: "stale.txt" }),
			),
		).toBeNull();

		// The fresh upload is untouched, row and bytes.
		expect(await readUploadRow(stub, fresh.id)).not.toBeNull();
		expect(
			await env.BUCKET.head(
				pendingUploadR2Key({ mailboxId: mailbox, id: fresh.id, filename: "fresh.txt" }),
			),
		).not.toBeNull();
	});


	it("the daily housekeeping cron runs the pending-upload sweep", async () => {
		await resetMailboxes();
		const mailbox = "upload-first-cron@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		const staleCreated = new Date(
			Date.now() - (PENDING_UPLOAD_TTL_DAYS + 1) * DAY_MS,
		).toISOString();
		const stale = await seedUpload(stub, mailbox, {
			id: "cron-stale-upload-id",
			createdAt: staleCreated,
		});
		const key = pendingUploadR2Key({
			mailboxId: mailbox,
			id: stale.id,
			filename: stale.filename,
		});

		const ctx = createExecutionContext();
		await worker.scheduled(createScheduledController({ cron: "0 3 * * *" }), env, ctx);
		// The handler fires the sweep through ctx.waitUntil(), so wait for it.
		await waitOnExecutionContext(ctx);

		expect(await readUploadRow(stub, stale.id)).toBeNull();
		expect(await env.BUCKET.head(key)).toBeNull();
	});
});
