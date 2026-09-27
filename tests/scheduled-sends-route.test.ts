/**
 * Scheduled sends over the HTTP route and the real alarm handler.
 *
 * The rest of the scheduled-sends suite calls the DO methods directly and
 * force-dates rows; this file goes through the same entry points the
 * browser does — POST .../scheduled-sends, then the alarm that fires it —
 * with only the email binding faked.
 */
import {
	env,
	runDurableObjectAlarm,
	runInDurableObject,
	SELF,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SendEmailParams } from "../workers/email-sender";
import {
	setScheduledSendSenderFactory,
	type ScheduledSendRow,
} from "../workers/lib/scheduled-sends";

const MAILBOX = "probe-sched@example.com";

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
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

async function queue(body: Record<string, unknown>) {
	return SELF.fetch(
		`https://example.com/api/v1/mailboxes/${MAILBOX}/scheduled-sends`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
}

async function backdate(id: string) {
	const stub = stubFor(MAILBOX);
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec(
			"UPDATE scheduled_sends SET send_at = ?1 WHERE id = ?2",
			new Date(Date.now() - 60_000).toISOString(),
			id,
		);
	});
}

async function rawRow(id: string) {
	const stub = stubFor(MAILBOX);
	return runInDurableObject(stub, async (_instance, state) => {
		const rows = [
			...state.storage.sql.exec("SELECT * FROM scheduled_sends WHERE id = ?1", id),
		];
		return (rows[0] as { status?: string; last_error?: string | null } | undefined) ?? null;
	});
}

describe("scheduled sends over the route", () => {
	it("queues a plain message through the route and fires it on the alarm", async () => {
		await env.BUCKET.put(
			`mailboxes/${MAILBOX}.json`,
			JSON.stringify({ categorization: { enabled: false } }),
		);
		const stub = stubFor(MAILBOX);
		const sendAt = new Date(Date.now() + 10_000).toISOString();

		const res = await queue({
			to: "recipient@example.org",
			from: MAILBOX,
			subject: "Probe hello",
			html: "<p>probe</p>",
			send_at: sendAt,
		});
		expect(res.status).toBe(201);
		const row = (await res.json()) as ScheduledSendRow;

		// The route armed the alarm for the queued instant.
		const alarm = await runInDurableObject(stub, async (_instance, state) =>
			state.storage.getAlarm(),
		);
		expect(alarm).toBe(Date.parse(sendAt));

		await backdate(row.id);
		const { sender, sent } = fakeSender();
		setScheduledSendSenderFactory(() => sender);
		try {
			expect(await runDurableObjectAlarm(stub)).toBe(true);
		} finally {
			setScheduledSendSenderFactory(null);
		}

		expect(sent).toHaveLength(1);
		expect(sent[0]?.subject).toBe("Probe hello");
		expect((await rawRow(row.id))?.status).toBe("sent");
	});

	it("queues a message with a name-bearing from and fires it", async () => {
		const stub = stubFor(MAILBOX);
		const sendAt = new Date(Date.now() + 10_000).toISOString();
		const res = await queue({
			to: "recipient@example.org",
			from: { email: MAILBOX, name: "Probe Mailbox" },
			subject: "Probe named from",
			html: "<p>probe</p>",
			send_at: sendAt,
		});
		expect(res.status).toBe(201);
		const row = (await res.json()) as ScheduledSendRow;

		await backdate(row.id);
		const { sender, sent } = fakeSender();
		setScheduledSendSenderFactory(() => sender);
		try {
			expect(await runDurableObjectAlarm(stub)).toBe(true);
		} finally {
			setScheduledSendSenderFactory(null);
		}
		expect(sent).toHaveLength(1);
		expect((await rawRow(row.id))?.status).toBe("sent");
	});

	it("refuses a queued payload that carries attachment bytes", async () => {
		// The composer uploads files first and queues their ids; this is the
		// route contract that makes the inline bytes illegal on the queue.
		const res = await queue({
			to: "recipient@example.org",
			from: MAILBOX,
			subject: "Probe with bytes",
			html: "<p>probe</p>",
			attachments: [
				{
					content: "aGk=",
					filename: "hi.txt",
					type: "text/plain",
					disposition: "attachment",
				},
			],
			send_at: new Date(Date.now() + 10_000).toISOString(),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain(
			"cannot carry attachments",
		);
	});

	it("records the failure reason when the sender throws", async () => {
		const sendAt = new Date(Date.now() + 10_000).toISOString();
		const res = await queue({
			to: "recipient@example.org",
			from: MAILBOX,
			subject: "Probe failing send",
			html: "<p>probe</p>",
			send_at: sendAt,
		});
		const row = (await res.json()) as ScheduledSendRow;
		await backdate(row.id);

		const stub = stubFor(MAILBOX);
		setScheduledSendSenderFactory(() => ({
			send: async () => {
				throw new Error("binding exploded");
			},
		}));
		try {
			expect(await runDurableObjectAlarm(stub)).toBe(true);
		} finally {
			setScheduledSendSenderFactory(null);
		}
		const failed = await rawRow(row.id);
		expect(failed?.status).toBe("failed");
		expect(failed?.last_error).toContain("binding exploded");
	});
});
