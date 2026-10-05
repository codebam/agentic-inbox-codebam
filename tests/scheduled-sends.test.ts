import {
	SELF,
	createExecutionContext,
	createScheduledController,
	runDurableObjectAlarm,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { Folders } from "../shared/folders";
import worker from "../workers/app";
import { createEmailTools } from "../workers/agent/index";
import { listMailboxes } from "../workers/lib/email-helpers";
import { sweepDueMail } from "../workers/lib/mail-sweep";
import {
	SCHEDULED_SEND_NOT_FOUND,
	serializeScheduledSendPayload,
	setScheduledSendSenderFactory,
	type ScheduledSendPayloadInput,
	type ScheduledSendRow,
} from "../workers/lib/scheduled-sends";
import { pendingUploadR2Key } from "../workers/lib/pending-uploads";
import { toolCancelScheduledSend, toolListScheduledSends } from "../workers/lib/tools";
import type { SendEmailParams } from "../workers/email-sender";


type Stub = ReturnType<typeof stubFor>;

/** Raw `scheduled_sends` columns the fire logic owns. */
interface ScheduledSendRawRow {
	id: string;
	draft_id: string | null;
	send_at: string;
	status: string;
	payload: string;
	attempts: number;
	last_error: string | null;
	created_at: string;
	sent_at: string | null;
}


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


/** ISO instant `ms` from now (negative for the past). */
function isoIn(ms: number) {
	return new Date(Date.now() + ms).toISOString();
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


/** Bounded JSON of one queued send; throws when the serializer rejects it. */
function sendPayloadJson(overrides: Partial<ScheduledSendPayloadInput> = {}) {
	const serialized = serializeScheduledSendPayload({
		to: "recipient@example.org",
		from: "schedule-sender@example.com",
		subject: "Queued hello",
		html: "<p>hi</p>",
		...overrides,
	});
	if ("error" in serialized) throw new Error(serialized.error);
	return serialized.payload;
}


/** Rewrite a row's `send_at` with raw SQL — the only way to make a queued
 * send come due at a known instant without waiting for it. No alarm is
 * touched, so a forced-due row is exactly the state the sweep exists for. */
async function forceDue(stub: Stub, id: string, sendAt: string) {
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec(
			"UPDATE scheduled_sends SET send_at = ?1 WHERE id = ?2",
			sendAt,
			id,
		);
	});
}


/** The Durable Object's armed alarm, or null when none is set. */
async function alarmAt(stub: Stub) {
	return runInDurableObject(stub, async (_instance, state) =>
		state.storage.getAlarm(),
	);
}


/** Raw read of one stored row; null when the id is gone. */
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


function jsonInit(body: unknown): RequestInit {
	return {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}


function parseSse(text: string) {
	return text
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
}


describe("scheduled_sends schema", () => {
	it("applies the scheduled-sends migration to a fresh mailbox", async () => {
		const stub = stubFor("schedule-migration@example.com");
		const info = await runInDurableObject(stub, async (_instance, state) => {
			const columns = [
				...state.storage.sql.exec("SELECT * FROM scheduled_sends LIMIT 1").columnNames,
			];
			const indexes = [
				...state.storage.sql.exec(
					"SELECT name FROM sqlite_master WHERE type = 'index'",
				),
			].map((row) => String((row as { name: unknown }).name));
			const applied = [
				...state.storage.sql.exec(
					"SELECT name FROM d1_migrations WHERE name = '22_add_scheduled_sends'",
				),
			].length;
			return { columns, indexes, applied };
		});

		expect(info.columns).toEqual(
			expect.arrayContaining([
				"id",
				"draft_id",
				"send_at",
				"status",
				"payload",
				"attempts",
				"last_error",
				"created_at",
				"sent_at",
			]),
		);
		expect(info.indexes).toEqual(
			expect.arrayContaining(["idx_scheduled_sends_send_at"]),
		);
		expect(info.applied).toBe(1);
	});
});


describe("scheduleSend", () => {
	it("inserts a pending row and arms the alarm at its send_at", async () => {
		const mailbox = "schedule-insert@example.com";
		const stub = stubFor(mailbox);
		const sendAt = isoIn(60 * 60 * 1000);
		const payload = sendPayloadJson({ from: mailbox });

		const send = (await stub.scheduleSend({ sendAt, payload })) as ScheduledSendRow;

		expect(send.status).toBe("pending");
		expect(send.send_at).toBe(sendAt);
		expect(send.attempts).toBe(0);
		expect(send.last_error).toBeNull();
		expect(send.sent_at).toBeNull();
		expect(typeof send.created_at).toBe("string");
		expect(send.payload).toMatchObject({
			to: "recipient@example.org",
			subject: "Queued hello",
		});
		expect(await alarmAt(stub)).toBe(Date.parse(sendAt));

		// Newest-first listing plus the stored total.
		const listed = (await stub.listScheduledSends()) as ScheduledSendRow[];
		expect(listed.map((row) => row.id)).toEqual([send.id]);
		expect(await stub.countScheduledSends()).toBe(1);
	});


	it("prunes terminal rows beyond the newest 200 on insert", async () => {
		const mailbox = "schedule-prune@example.com";
		const stub = stubFor(mailbox);
		await runInDurableObject(stub, async (_instance, state) => {
			for (let i = 0; i < 205; i++) {
				state.storage.sql.exec(
					`INSERT INTO scheduled_sends
						(id, draft_id, send_at, status, payload, attempts, last_error, created_at, sent_at)
					 VALUES (?1, NULL, ?2, 'cancelled', '{}', 0, NULL, ?2, NULL)`,
					`terminal-${i}`,
					new Date(Date.now() - i * 1000).toISOString(),
				);
			}
		});

		const send = (await stub.scheduleSend({
			sendAt: isoIn(60 * 1000),
			payload: sendPayloadJson({ from: mailbox }),
		})) as ScheduledSendRow;

		const counts = await runInDurableObject(stub, async (_instance, state) => {
			const rows = [
				...state.storage.sql.exec(
					"SELECT status, COUNT(*) AS n FROM scheduled_sends GROUP BY status",
				),
			];
			return rows.map((row) => {
				const record = row as { status: unknown; n: unknown };
				return { status: String(record.status), n: Number(record.n) };
			});
		});
		const terminal = counts.find((row) => row.status === "cancelled")?.n;
		const pending = counts.find((row) => row.status === "pending")?.n;
		expect(terminal).toBe(200);
		// The just-queued row survives: pending rows are never pruned.
		expect(pending).toBe(1);
		expect((await readSendRow(stub, send.id))?.status).toBe("pending");
	});
});


describe("scheduled-send alarm", () => {
	it("fires a due send through the sender seam, stores the Sent copy and is idempotent", async () => {
		const mailbox = "schedule-fire@example.com";
		const stub = stubFor(mailbox);
		const payload = sendPayloadJson({ from: mailbox });
		const send = (await stub.scheduleSend({
			sendAt: isoIn(60 * 60 * 1000),
			payload,
		})) as ScheduledSendRow;
		await forceDue(stub, send.id, isoIn(-60 * 1000));

		const { sender, sent } = fakeSender();
		setScheduledSendSenderFactory(() => sender);
		try {
			expect(await runDurableObjectAlarm(stub)).toBe(true);
		} finally {
			setScheduledSendSenderFactory(null);
		}

		// The injected sender got the rebuilt parameters, not a live binding.
		expect(sent).toHaveLength(1);
		expect(sent[0]?.to).toBe("recipient@example.org");
		expect(sent[0]?.subject).toBe("Queued hello");
		expect(sent[0]?.html).toBe("<p>hi</p>");

		const fired = await readSendRow(stub, send.id);
		expect(fired?.status).toBe("sent");
		expect(typeof fired?.sent_at).toBe("string");
		expect(fired?.attempts).toBe(0);
		expect(fired?.last_error).toBeNull();

		// The Sent copy is stored exactly like the immediate path's.
		const sentFolder = (await stub.getEmails({ folder: Folders.SENT })) as {
			recipient: string;
			subject: string;
		}[];
		expect(sentFolder).toHaveLength(1);
		expect(sentFolder[0]).toMatchObject({
			recipient: "recipient@example.org",
			subject: "Queued hello",
		});

		// Idempotent: a second run finds nothing due and sends nothing again.
		const { sender: secondSender, sent: secondSent } = fakeSender();
		setScheduledSendSenderFactory(() => secondSender);
		try {
			expect(await stub.fireDueSends(new Date().toISOString())).toBe(0);
		} finally {
			setScheduledSendSenderFactory(null);
		}
		expect(secondSent).toHaveLength(0);
		expect((await readSendRow(stub, send.id))?.status).toBe("sent");
		// Nothing is pending, so the alarm is not re-armed.
		expect(await alarmAt(stub)).toBeNull();
	});


	it("leaves a not-yet-due send untouched", async () => {
		const mailbox = "schedule-future@example.com";
		const stub = stubFor(mailbox);
		const send = (await stub.scheduleSend({
			sendAt: isoIn(60 * 60 * 1000),
			payload: sendPayloadJson({ from: mailbox }),
		})) as ScheduledSendRow;

		const { sender, sent } = fakeSender();
		setScheduledSendSenderFactory(() => sender);
		try {
			expect(await runDurableObjectAlarm(stub)).toBe(true);
			expect(await stub.fireDueSends(new Date().toISOString())).toBe(0);
		} finally {
			setScheduledSendSenderFactory(null);
		}

		expect(sent).toHaveLength(0);
		const row = await readSendRow(stub, send.id);
		expect(row?.status).toBe("pending");
		expect(row?.sent_at).toBeNull();
		// The alarm is still armed for the send's own time.
		expect(await alarmAt(stub)).toBe(Date.parse(send.send_at));
	});
});


describe("cancelScheduledSend / retryScheduledSend", () => {
	it("cancels a pending send and refuses anything else", async () => {
		const mailbox = "schedule-cancel@example.com";
		const stub = stubFor(mailbox);
		const send = (await stub.scheduleSend({
			sendAt: isoIn(60 * 60 * 1000),
			payload: sendPayloadJson({ from: mailbox }),
		})) as ScheduledSendRow;

		const cancelled = await stub.cancelScheduledSend(send.id);
		expect(cancelled.ok).toBe(true);
		if (!cancelled.ok) throw new Error(cancelled.error);
		expect(cancelled.send.status).toBe("cancelled");
		expect((await readSendRow(stub, send.id))?.status).toBe("cancelled");

		// A cancelled row is no longer pending, so it cannot be cancelled again.
		const again = await stub.cancelScheduledSend(send.id);
		expect(again).toEqual({
			ok: false,
			error: expect.stringContaining("Only a pending send can be cancelled"),
		});

		// An unknown id is reported as missing.
		expect(await stub.cancelScheduledSend("missing")).toEqual({
			ok: false,
			error: SCHEDULED_SEND_NOT_FOUND,
		});
	});


	it("saves a cancelled send as a draft so the message survives", async () => {
		const mailbox = "schedule-cancel-draft@example.com";
		const stub = stubFor(mailbox);
		const send = (await stub.scheduleSend({
			sendAt: isoIn(60 * 60 * 1000),
			payload: sendPayloadJson({
				from: mailbox,
				subject: "Keep me",
				html: "<p>Body worth keeping</p>",
			}),
		})) as ScheduledSendRow;
		// A message queued from a new compose has no draft yet.
		expect(send.draft_id).toBeNull();

		const cancelled = await stub.cancelScheduledSend(send.id);
		expect(cancelled.ok).toBe(true);
		if (!cancelled.ok) throw new Error(cancelled.error);
		const draftId = cancelled.send.draft_id;
		expect(draftId).toEqual(expect.any(String));

		// The message is in Drafts, addressed and worded exactly as queued.
		const draft = await stub.getEmail(draftId!);
		expect(draft).toMatchObject({
			folder_id: Folders.DRAFT,
			subject: "Keep me",
			recipient: "recipient@example.org",
			body: "<p>Body worth keeping</p>",
		});
		expect(await stub.getEmails({ folder: Folders.DRAFT })).toHaveLength(1);

		// The row records the recovered draft, so the API can point at it.
		expect((await readSendRow(stub, send.id))?.draft_id).toBe(draftId);
	});


	it("keeps the draft a queued send was already backed by", async () => {
		const mailbox = "schedule-cancel-reuse@example.com";
		const stub = stubFor(mailbox);
		await stub.createEmail(
			Folders.DRAFT,
			{
				id: "existing-draft",
				subject: "Existing draft",
				sender: mailbox,
				recipient: "recipient@example.org",
				date: new Date().toISOString(),
				body: "<p>already saved</p>",
			},
			[],
		);

		const send = (await stub.scheduleSend({
			sendAt: isoIn(60 * 60 * 1000),
			payload: sendPayloadJson({ from: mailbox }),
			draft_id: "existing-draft",
		})) as ScheduledSendRow;

		const cancelled = await stub.cancelScheduledSend(send.id);
		expect(cancelled.ok).toBe(true);
		if (!cancelled.ok) throw new Error(cancelled.error);
		expect(cancelled.send.draft_id).toBe("existing-draft");

		// The existing draft is reused, never duplicated.
		expect(await stub.getEmails({ folder: Folders.DRAFT })).toHaveLength(1);
		expect((await stub.getEmail("existing-draft"))?.subject).toBe("Existing draft");
	});


	it("moves a cancelled send's queued files onto the recovered draft", async () => {
		const mailbox = "schedule-cancel-files@example.com";
		const stub = stubFor(mailbox);
		const bytes = new TextEncoder().encode("hello attachment");
		const uploadId = "cancel-upload-1";
		const queuedKey = pendingUploadR2Key({
			mailboxId: mailbox,
			id: uploadId,
			filename: "notes.txt",
		});
		await env.BUCKET.put(queuedKey, bytes);
		await stub.createPendingUpload({
			id: uploadId,
			filename: "notes.txt",
			mimetype: "text/plain",
			size: bytes.byteLength,
			r2Key: queuedKey,
		});

		const send = (await stub.scheduleSend({
			sendAt: isoIn(60 * 60 * 1000),
			payload: sendPayloadJson({ from: mailbox, upload_ids: [uploadId] }),
		})) as ScheduledSendRow;

		const cancelled = await stub.cancelScheduledSend(send.id);
		expect(cancelled.ok).toBe(true);
		if (!cancelled.ok) throw new Error(cancelled.error);
		const draftId = cancelled.send.draft_id!;

		const draft = await stub.getEmail(draftId);
		expect(draft?.attachments).toHaveLength(1);
		const attachment = draft!.attachments[0]!;
		expect(attachment.filename).toBe("notes.txt");

		// The bytes now live under the draft's own attachment key...
		const draftObject = await env.BUCKET.get(
			`attachments/${draftId}/${attachment.id}/notes.txt`,
		);
		expect(draftObject).not.toBeNull();
		expect(new Uint8Array(await draftObject!.arrayBuffer())).toEqual(bytes);

		// ...and the queue's copy is gone: neither the R2 object nor the row
		// is left behind for the sweep to find.
		expect(await env.BUCKET.get(queuedKey)).toBeNull();
		const uploadRow = await runInDurableObject(stub, async (_instance, state) => {
			const rows = [
				...state.storage.sql.exec(
					"SELECT id FROM pending_uploads WHERE id = ?1",
					uploadId,
				),
			];
			return rows[0] ?? null;
		});
		expect(uploadRow).toBeNull();
	});


	it("retries a failed row, re-arming it as pending and due now", async () => {
		const mailbox = "schedule-retry@example.com";
		const stub = stubFor(mailbox);
		// The row is made due by hand while the alarm stays parked at its
		// future time, and the first fire fails with no sender configured —
		// exactly the transient failure a retry exists for.
		const payload = sendPayloadJson({ from: mailbox });
		const send = (await stub.scheduleSend({
			sendAt: isoIn(60 * 60 * 1000),
			payload,
		})) as ScheduledSendRow;
		await forceDue(stub, send.id, isoIn(-60 * 1000));
		expect(await stub.fireDueSends(new Date().toISOString())).toBe(1);
		const failed = await readSendRow(stub, send.id);
		expect(failed?.status).toBe("failed");
		expect(failed?.last_error).toBe("no EMAIL binding configured");

		// The retry re-arms the row as pending, due immediately, with the
		// payload untouched; the alarm then fires it through the sender seam.
		const { sender, sent } = fakeSender();
		setScheduledSendSenderFactory(() => sender);
		try {
			const retried = await stub.retryScheduledSend(send.id);
			expect(retried.ok).toBe(true);
			if (!retried.ok) throw new Error(retried.error);
			expect(retried.send.status).toBe("pending");
			expect(retried.send.last_error).toBeNull();
			expect(Date.parse(retried.send.send_at)).toBeLessThanOrEqual(Date.now());
			expect(retried.send.payload).toMatchObject({ from: mailbox });

			// A retried row is due now, so the re-armed alarm fires it.
			await vi.waitFor(async () => {
				expect((await readSendRow(stub, send.id))?.status).toBe("sent");
			});
			expect(sent).toHaveLength(1);
			expect(sent[0]?.to).toBe("recipient@example.org");
		} finally {
			setScheduledSendSenderFactory(null);
		}

		const row = await readSendRow(stub, send.id);
		// The retry resends what was queued: the payload is untouched.
		expect(row?.payload).toBe(payload);

		// Only a failed row can be retried.
		expect(await stub.retryScheduledSend(send.id)).toEqual({
			ok: false,
			error: expect.stringContaining("Only a failed send can be retried"),
		});
		expect(await stub.retryScheduledSend("missing")).toEqual({
			ok: false,
			error: SCHEDULED_SEND_NOT_FOUND,
		});
	});
});


describe("fire-time guards", () => {
	it("records a failed guard with its reason and keeps the payload", async () => {
		const mailbox = "schedule-guard@example.com";
		const stub = stubFor(mailbox);
		// A reply to a spam-marked message is refused at fire time, mirroring
		// the draft route's spam guard.
		await stub.createEmail(
			Folders.SPAM,
			{
				id: "spam-original",
				subject: "Cheap pills",
				sender: "spammer@example.org",
				recipient: mailbox,
				date: new Date().toISOString(),
				body: "<p>spam</p>",
				in_reply_to: null,
				email_references: null,
				thread_id: "spam-thread",
			},
			[],
		);
		const payload = sendPayloadJson({
			from: mailbox,
			in_reply_to: "spam-original",
		});
		const send = (await stub.scheduleSend({
			sendAt: isoIn(60 * 60 * 1000),
			payload,
		})) as ScheduledSendRow;
		await forceDue(stub, send.id, isoIn(-60 * 1000));

		expect(await stub.fireDueSends(new Date().toISOString())).toBe(1);

		const row = await readSendRow(stub, send.id);
		expect(row?.status).toBe("failed");
		expect(row?.attempts).toBe(1);
		expect(row?.last_error).toContain("marked as spam");
		expect(row?.sent_at).toBeNull();
		// The failed row never loses its payload.
		expect(row?.payload).toBe(payload);
		// Nothing was sent and no Sent copy was stored.
		expect((await stub.getEmails({ folder: Folders.SENT })) as unknown[]).toHaveLength(0);
	});


	it("records a rejected send with its reason instead of dropping it", async () => {
		const mailbox = "schedule-guard-sender@example.com";
		const stub = stubFor(mailbox);
		const payload = sendPayloadJson({ from: "other@example.com" });
		const send = (await stub.scheduleSend({
			sendAt: isoIn(60 * 60 * 1000),
			payload,
		})) as ScheduledSendRow;
		await forceDue(stub, send.id, isoIn(-60 * 1000));

		expect(await stub.fireDueSends(new Date().toISOString())).toBe(1);

		const row = await readSendRow(stub, send.id);
		expect(row?.status).toBe("failed");
		expect(row?.attempts).toBe(1);
		expect(row?.last_error).toBe(
			"From address must match the mailbox email address",
		);
		expect(row?.payload).toBe(payload);
	});
});


describe("scheduled-send routes", () => {
	const MAILBOX = "schedule-routes@example.com";
	const URL = `http://example.com/api/v1/mailboxes/${MAILBOX}/scheduled-sends`;

	it("queues, lists and cancels over HTTP", async () => {
		await registerMailbox(MAILBOX);
		const stub = stubFor(MAILBOX);
		const sendAt = isoIn(60 * 60 * 1000);

		const created = await SELF.fetch(
			URL,
			jsonInit({
				to: "recipient@example.org",
				from: MAILBOX,
				subject: "Queued hello",
				html: "<p>hi</p>",
				send_at: sendAt,
			}),
		);
		expect(created.status).toBe(201);
		const row = (await created.json()) as ScheduledSendRow;
		expect(row.status).toBe("pending");
		expect(row.send_at).toBe(sendAt);
		expect(row.payload).toMatchObject({
			to: "recipient@example.org",
			subject: "Queued hello",
		});
		expect(await alarmAt(stub)).toBe(Date.parse(sendAt));

		const listed = await SELF.fetch(`${URL}?limit=50`);
		expect(listed.status).toBe(200);
		const listing = (await listed.json()) as {
			sends: ScheduledSendRow[];
			totalCount: number;
		};
		expect(listing.totalCount).toBe(1);
		expect(listing.sends.map((send) => send.id)).toEqual([row.id]);

		const cancelled = await SELF.fetch(`${URL}/${row.id}`, { method: "DELETE" });
		expect(cancelled.status).toBe(200);
		const cancelledBody = (await cancelled.json()) as { send: ScheduledSendRow };
		expect(cancelledBody.send.status).toBe("cancelled");

		// Cancelling a non-pending row is a 400; an unknown id is a 404.
		const again = await SELF.fetch(`${URL}/${row.id}`, { method: "DELETE" });
		expect(again.status).toBe(400);
		const missing = await SELF.fetch(`${URL}/missing`, { method: "DELETE" });
		expect(missing.status).toBe(404);
	});


	it("rejects attachments, a past send_at and a malformed body", async () => {
		// Its own mailbox so the listing assertion cannot see another test's row.
		const rejectMailbox = "schedule-routes-reject@example.com";
		const rejectUrl = `http://example.com/api/v1/mailboxes/${rejectMailbox}/scheduled-sends`;
		await registerMailbox(rejectMailbox);
		const base = {
			to: "recipient@example.org",
			from: MAILBOX,
			subject: "Queued hello",
			html: "<p>hi</p>",
			send_at: isoIn(60 * 60 * 1000),
		};

		const withAttachment = await SELF.fetch(
			rejectUrl,
			jsonInit({
				...base,
				attachments: [
					{
						content: "aGk=",
						filename: "hi.txt",
						type: "text/plain",
						disposition: "attachment",
					},
				],
			}),
		);
		expect(withAttachment.status).toBe(400);
		expect(((await withAttachment.json()) as { error: string }).error).toContain(
			"cannot carry attachments",
		);

		const past = await SELF.fetch(
			rejectUrl,
			jsonInit({ ...base, send_at: isoIn(-60 * 1000) }),
		);
		expect(past.status).toBe(400);
		expect(((await past.json()) as { error: string }).error).toContain("send_at");

		const malformed = await SELF.fetch(
			rejectUrl,
			jsonInit({ ...base, send_at: "tomorrow-ish" }),
		);
		expect(malformed.status).toBe(400);

		const missingSendAt = await SELF.fetch(
			rejectUrl,
			jsonInit({ ...base, send_at: undefined }),
		);
		expect(missingSendAt.status).toBe(400);

		// Nothing was queued by the rejected requests.
		const listed = await SELF.fetch(rejectUrl);
		expect(
			((await listed.json()) as { totalCount: number }).totalCount,
		).toBe(0);
	});


	it("validates the sender like the immediate send route", async () => {
		const senderMailbox = "schedule-routes-sender@example.com";
		await registerMailbox(senderMailbox);
		const mismatch = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${senderMailbox}/scheduled-sends`,
			jsonInit({
				to: "recipient@example.org",
				from: "other@example.com",
				subject: "Queued hello",
				html: "<p>hi</p>",
				send_at: isoIn(60 * 60 * 1000),
			}),
		);
		expect(mismatch.status).toBe(400);
		expect(((await mismatch.json()) as { error: string }).error).toBe(
			"From address must match the mailbox email address",
		);
	});


	it("retries a failed send over HTTP", async () => {
		const retryMailbox = "schedule-routes-retry@example.com";
		const retryUrl = `http://example.com/api/v1/mailboxes/${retryMailbox}/scheduled-sends`;
		await registerMailbox(retryMailbox);
		const stub = stubFor(retryMailbox);
		const send = (await stub.scheduleSend({
			sendAt: isoIn(60 * 60 * 1000),
			payload: sendPayloadJson({ from: "other@example.com" }),
		})) as ScheduledSendRow;
		await forceDue(stub, send.id, isoIn(-60 * 1000));
		await stub.fireDueSends(new Date().toISOString());

		const retried = await SELF.fetch(`${retryUrl}/${send.id}/retry`, { method: "POST" });
		expect(retried.status).toBe(200);
		const retriedBody = (await retried.json()) as { send: ScheduledSendRow };
		expect(retriedBody.send.status).toBe("pending");
		expect(retriedBody.send.last_error).toBeNull();

		// A row that is not failed is a 400; an unknown id is a 404. The
		// pending row below keeps its future send time, so its alarm stays
		// parked and the status cannot change underneath the assertion.
		const pendingSend = (await stub.scheduleSend({
			sendAt: isoIn(60 * 60 * 1000),
			payload: sendPayloadJson({ from: retryMailbox }),
		})) as ScheduledSendRow;
		const notFailed = await SELF.fetch(`${retryUrl}/${pendingSend.id}/retry`, {
			method: "POST",
		});
		expect(notFailed.status).toBe(400);
		const missing = await SELF.fetch(`${retryUrl}/missing/retry`, { method: "POST" });
		expect(missing.status).toBe(404);
	});
});


describe("scheduled-send tools", () => {
	const MAILBOX = "schedule-tools@example.com";

	it("lists and cancels through the shared tool logic", async () => {
		await registerMailbox(MAILBOX);
		const stub = stubFor(MAILBOX);
		const send = (await stub.scheduleSend({
			sendAt: isoIn(60 * 60 * 1000),
			payload: sendPayloadJson({ from: MAILBOX }),
		})) as ScheduledSendRow;

		const listed = await toolListScheduledSends(env, MAILBOX);
		expect(listed.totalCount).toBe(1);
		expect(listed.sends.map((row) => row.id)).toEqual([send.id]);

		const cancelled = await toolCancelScheduledSend(env, MAILBOX, send.id);
		expect(cancelled).toMatchObject({ status: "cancelled" });

		const refused = await toolCancelScheduledSend(env, MAILBOX, send.id);
		expect(refused).toEqual({ error: expect.stringContaining("Only a pending send") });
	});


	it("is on the agent map and the live /mcp handshake; scheduling is MCP-only", async () => {
		const tools = createEmailTools(env, MAILBOX);
		expect(Object.keys(tools)).toEqual(
			expect.arrayContaining(["list_scheduled_sends", "cancel_scheduled_send"]),
		);
		// Creating and retrying schedules stays off the agent surface.
		expect(Object.keys(tools)).not.toContain("schedule_send");
		expect(Object.keys(tools)).not.toContain("retry_scheduled_send");

		const init = await SELF.fetch("http://example.com/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "test", version: "1" },
				},
			}),
		});
		expect(init.status).toBe(200);
		const session = init.headers.get("mcp-session-id") ?? "";
		const headers = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(session ? { "mcp-session-id": session } : {}),
		};
		await SELF.fetch("http://example.com/mcp", {
			method: "POST",
			headers,
			body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
		});
		const list = await SELF.fetch("http://example.com/mcp", {
			method: "POST",
			headers,
			body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
		});
		expect(list.status).toBe(200);
		const messages = parseSse(await list.text());
		const names =
			(messages[0]?.result as { tools?: { name: string }[] } | undefined)?.tools?.map(
				(tool) => tool.name,
			) ?? [];
		expect(names).toEqual(
			expect.arrayContaining(["list_scheduled_sends", "cancel_scheduled_send"]),
		);
		// Scheduling is MCP-only since wave 17: the handshake carries the
		// create and retry tools; the agent surface keeps just the read-only
		// list and the cancel.
		expect(names.filter((name) => name.includes("schedul")).sort()).toEqual([
			"cancel_scheduled_send",
			"list_scheduled_sends",
			"retry_scheduled_send",
			"schedule_send",
		]);
	});
});


describe("scheduled-send sweep", () => {
	it("fires due sends from the sweep backstop", async () => {
		await resetMailboxes();
		const mailbox = "schedule-sweep@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		const send = (await stub.scheduleSend({
			sendAt: isoIn(60 * 60 * 1000),
			payload: sendPayloadJson({ from: mailbox }),
		})) as ScheduledSendRow;
		await forceDue(stub, send.id, isoIn(-60 * 1000));

		const { sender, sent } = fakeSender();
		setScheduledSendSenderFactory(() => sender);
		try {
			const summary = await sweepDueMail(env, { now: new Date() });
			expect(summary.sends).toBe(1);
		} finally {
			setScheduledSendSenderFactory(null);
		}

		expect(sent).toHaveLength(1);
		expect((await readSendRow(stub, send.id))?.status).toBe("sent");
	});


	it("the scheduled handler runs the due-mail sweep", async () => {
		await resetMailboxes();
		const mailbox = "schedule-cron@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		const send = (await stub.scheduleSend({
			sendAt: "2020-01-01T00:00:00.000Z",
			payload: sendPayloadJson({ from: mailbox }),
		})) as ScheduledSendRow;

		const { sender, sent } = fakeSender();
		setScheduledSendSenderFactory(() => sender);
		try {
			const ctx = createExecutionContext();
			await worker.scheduled(
				createScheduledController({ cron: "0 3 * * *" }),
				env,
				ctx,
			);
			// The handler fires the sweep through ctx.waitUntil(), so wait for it.
			await waitOnExecutionContext(ctx);
		} finally {
			setScheduledSendSenderFactory(null);
		}

		expect(sent).toHaveLength(1);
		expect((await readSendRow(stub, send.id))?.status).toBe("sent");
	});
});


describe("scheduled-send verification", () => {
	it("sends when the payload's plain-text alternative is empty", async () => {
		// The composer sends html plus a derived text part; an image-only or
		// blank body legitimately has no plain text, and that empty
		// alternative must not refuse the send.
		const mailbox = "schedule-text-part@example.com";
		const stub = stubFor(mailbox);
		const payload = sendPayloadJson({ from: mailbox, text: "" });
		const send = (await stub.scheduleSend({
			sendAt: isoIn(60 * 60 * 1000),
			payload,
		})) as ScheduledSendRow;
		await forceDue(stub, send.id, isoIn(-60 * 1000));

		const { sender, sent } = fakeSender();
		setScheduledSendSenderFactory(() => sender);
		try {
			expect(await stub.fireDueSends(new Date().toISOString())).toBe(1);
		} finally {
			setScheduledSendSenderFactory(null);
		}

		expect(sent).toHaveLength(1);
		expect(sent[0]?.html).toBe("<p>hi</p>");
		expect((await readSendRow(stub, send.id))?.status).toBe("sent");
	});


	it("names an AI failure as a verifier failure, not a refusal", async () => {
		// A body long enough to reach the verifier (>= 20 chars of reply
		// text). The pool's AI binding cannot run remotely, so verifyDraft
		// throws and returns "" — exactly the live failure — and the row must
		// say the verifier could not run rather than the generic refusal.
		const mailbox = "schedule-verifier-down@example.com";
		const stub = stubFor(mailbox);
		const payload = sendPayloadJson({
			from: mailbox,
			html: "<p>This body is comfortably longer than twenty characters.</p>",
		});
		const send = (await stub.scheduleSend({
			sendAt: isoIn(60 * 60 * 1000),
			payload,
		})) as ScheduledSendRow;
		await forceDue(stub, send.id, isoIn(-60 * 1000));

		const { sender, sent } = fakeSender();
		setScheduledSendSenderFactory(() => sender);
		try {
			expect(await stub.fireDueSends(new Date().toISOString())).toBe(1);
		} finally {
			setScheduledSendSenderFactory(null);
		}

		expect(sent).toHaveLength(0);
		const row = await readSendRow(stub, send.id);
		expect(row?.status).toBe("failed");
		expect(row?.last_error).toContain("verifier could not run");
	});
});
