/**
 * schedule_send / retry_scheduled_send: the MCP-only tools that queue an
 * outbound message for a future instant and re-arm a failed one.
 *
 * The tools are called directly (like the other tool tests) and every
 * assertion reads real Durable Object state — the stored row, the queue the
 * DO lists and the armed alarm — so the queue contract is what is pinned,
 * not a mock.
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { Folders } from "../shared/folders";
import {
	SCHEDULED_SEND_NOT_FOUND,
	setScheduledSendSenderFactory,
	type ScheduledSendRow,
} from "../workers/lib/scheduled-sends";
import { toolRetryScheduledSend, toolScheduleSend } from "../workers/lib/tools";
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


/** Rewrite a row's `send_at` with raw SQL, so it comes due at a known instant. */
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


/** Fill the Sent folder with `count` rows dated now, so the rate limit trips. */
async function seedSentRows(stub: Stub, count: number, recipient: string) {
	await runInDurableObject(stub, async (_instance, state) => {
		for (let i = 0; i < count; i++) {
			state.storage.sql.exec(
				`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, read, starred)
				 VALUES (?1, ?2, 'Rate filler', 'sender@example.org', ?3, ?4, 0, 0)`,
				`rate-${i}`,
				Folders.SENT,
				recipient,
				new Date().toISOString(),
			);
		}
	});
}


describe("schedule_send tool", () => {
	it("queues a pending row, derives the text part and arms the alarm at sendAt", async () => {
		const mailbox = "schedule-tool-queue@example.com";
		const stub = stubFor(mailbox);
		const sendAt = isoIn(60 * 60 * 1000);

		const result = await toolScheduleSend(env, mailbox, {
			to: "recipient@example.org",
			cc: ["cc@example.org"],
			bcc: "bcc@example.org",
			subject: "Queued from the tool",
			bodyHtml: "<p>hi</p>",
			sendAt,
		});
		if ("error" in result) throw new Error(result.error);

		// The returned shape is the route's 201: the stored row itself.
		expect(result.status).toBe("pending");
		expect(result.send_at).toBe(sendAt);
		expect(result.attempts).toBe(0);
		expect(result.last_error).toBeNull();
		expect(result.sent_at).toBeNull();
		expect(result.payload).toMatchObject({
			to: "recipient@example.org",
			from: mailbox,
			subject: "Queued from the tool",
			html: "<p>hi</p>",
			// The plain-text alternative is derived exactly like the
			// composer derives it for every message it queues.
			text: "hi",
			cc: ["cc@example.org"],
			bcc: "bcc@example.org",
		});

		// Real DO state: the queue lists it, the stored row is pending, and
		// the alarm is armed for the queued instant.
		const listed = (await stub.listScheduledSends()) as ScheduledSendRow[];
		expect(listed.map((row) => row.id)).toEqual([result.id]);
		expect(await stub.countScheduledSends()).toBe(1);
		const raw = await readSendRow(stub, result.id);
		expect(raw?.status).toBe("pending");
		expect(await alarmAt(stub)).toBe(Date.parse(sendAt));
	});


	it("rejects a past or malformed sendAt and queues nothing", async () => {
		const mailbox = "schedule-tool-send-at@example.com";
		const stub = stubFor(mailbox);
		const base = {
			to: "recipient@example.org",
			subject: "Later",
			bodyHtml: "<p>hi</p>",
		};

		expect(
			await toolScheduleSend(env, mailbox, { ...base, sendAt: isoIn(-60 * 1000) }),
		).toEqual({ error: "`sendAt` must be a future ISO 8601 timestamp" });
		expect(
			await toolScheduleSend(env, mailbox, { ...base, sendAt: "tomorrow-ish" }),
		).toEqual({ error: "`sendAt` must be a future ISO 8601 timestamp" });
		expect(await stub.countScheduledSends()).toBe(0);
	});


	it("rejects a missing or invalid to and queues nothing", async () => {
		const mailbox = "schedule-tool-to@example.com";
		const stub = stubFor(mailbox);
		const base = {
			subject: "Nowhere",
			bodyHtml: "<p>hi</p>",
			sendAt: isoIn(60 * 1000),
		};

		expect(await toolScheduleSend(env, mailbox, { ...base, to: "" })).toEqual({
			error: "Invalid scheduled send request",
		});
		expect(
			await toolScheduleSend(env, mailbox, { ...base, to: "not-an-address" }),
		).toEqual({ error: "Invalid scheduled send request" });
		expect(await stub.countScheduledSends()).toBe(0);
	});


	it("rejects a mailbox that cannot be the sender", async () => {
		const mailbox = "schedule-tool-no-domain";
		const stub = stubFor(mailbox);

		expect(
			await toolScheduleSend(env, mailbox, {
				to: "recipient@example.org",
				subject: "Nowhere",
				bodyHtml: "<p>hi</p>",
				sendAt: isoIn(60 * 1000),
			}),
		).toEqual({ error: "Invalid sender email address" });
		expect(await stub.countScheduledSends()).toBe(0);
	});


	it("refuses to queue while the mailbox is over the send rate limit", async () => {
		const mailbox = "schedule-tool-rate@example.com";
		const stub = stubFor(mailbox);
		await seedSentRows(stub, 20, mailbox);

		expect(
			await toolScheduleSend(env, mailbox, {
				to: "recipient@example.org",
				subject: "Over the limit",
				bodyHtml: "<p>hi</p>",
				sendAt: isoIn(60 * 60 * 1000),
			}),
		).toEqual({
			error: "Rate limit exceeded: max 20 emails per hour per mailbox",
		});
		expect(await stub.countScheduledSends()).toBe(0);
	});


	it("still fails closed when the draft verifier cannot run", async () => {
		const mailbox = "schedule-tool-verifier@example.com";
		const stub = stubFor(mailbox);

		// Twenty or more characters of body text reaches the verifier. The
		// pool's AI binding cannot run remotely, so verifyDraft returns ""
		// and the queue must refuse rather than store unverified content.
		const result = await toolScheduleSend(env, mailbox, {
			to: "recipient@example.org",
			subject: "Unverifiable",
			bodyHtml: "<p>This body is comfortably longer than twenty characters.</p>",
			sendAt: isoIn(60 * 60 * 1000),
		});
		expect(result).toEqual({
			error: expect.stringContaining("Draft verification failed"),
		});
		expect(await stub.countScheduledSends()).toBe(0);
	});
});


describe("retry_scheduled_send tool", () => {
	it("re-arms a failed row as pending and the re-armed alarm fires it", async () => {
		const mailbox = "schedule-tool-retry@example.com";
		const stub = stubFor(mailbox);
		const queued = await toolScheduleSend(env, mailbox, {
			to: "recipient@example.org",
			subject: "Queued hello",
			bodyHtml: "<p>hi</p>",
			sendAt: isoIn(60 * 60 * 1000),
		});
		if ("error" in queued) throw new Error(queued.error);

		// Make the row due and fire it with no sender configured: the row
		// records the transient failure a retry exists for.
		await forceDue(stub, queued.id, isoIn(-60 * 1000));
		expect(await stub.fireDueSends(new Date().toISOString())).toBe(1);
		const failed = await readSendRow(stub, queued.id);
		expect(failed?.status).toBe("failed");
		expect(failed?.last_error).toBe("no EMAIL binding configured");

		const { sender, sent } = fakeSender();
		setScheduledSendSenderFactory(() => sender);
		try {
			const retried = await toolRetryScheduledSend(env, mailbox, queued.id);
			if ("error" in retried) throw new Error(retried.error);
			expect(retried.status).toBe("pending");
			expect(retried.send.status).toBe("pending");
			expect(retried.send.last_error).toBeNull();
			expect(Date.parse(retried.send.send_at)).toBeLessThanOrEqual(Date.now());

			// The retried row is due now, so the re-armed alarm fires it and
			// the message goes out through the sender seam.
			await vi.waitFor(async () => {
				expect((await readSendRow(stub, queued.id))?.status).toBe("sent");
			});
			expect(sent).toHaveLength(1);
			expect(sent[0]?.to).toBe("recipient@example.org");
		} finally {
			setScheduledSendSenderFactory(null);
		}
	});


	it("refuses a missing id and anything that is not failed", async () => {
		const mailbox = "schedule-tool-retry-refuse@example.com";
		const stub = stubFor(mailbox);
		const pending = await toolScheduleSend(env, mailbox, {
			to: "recipient@example.org",
			subject: "Still pending",
			bodyHtml: "<p>hi</p>",
			sendAt: isoIn(60 * 60 * 1000),
		});
		if ("error" in pending) throw new Error(pending.error);

		expect(await toolRetryScheduledSend(env, mailbox, pending.id)).toEqual({
			error: expect.stringContaining("Only a failed send can be retried"),
		});
		expect(await toolRetryScheduledSend(env, mailbox, "missing")).toEqual({
			error: SCHEDULED_SEND_NOT_FOUND,
		});
		expect(await stub.countScheduledSends()).toBe(1);
	});
});
