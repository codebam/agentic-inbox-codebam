import { runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { setSendEmailSenderFactory } from "../workers/email-sender";

/**
 * Upstream #84: a send the binding rejects must be reported to the caller as
 * a failure and must not be filed in Sent as a delivered message.
 * Upstream #83: the Sent copy's message_id must be the Message-ID the binding
 * actually assigned, not a locally generated id no recipient ever received.
 *
 * wrangler.test.jsonc declares no send_email binding, so the sender seam is
 * injected per test (a rejecting sender for #84, a known-id sender for #83).
 */

async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(
		`mailboxes/${mailbox}.json`,
		JSON.stringify({ categorization: { enabled: false } }),
	);
}

function postEmail(mailbox: string, body: Record<string, unknown>) {
	return SELF.fetch(`http://example.com/api/v1/mailboxes/${mailbox}/emails`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function sentRows(mailbox: string) {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
	return runInDurableObject(stub, async (_instance, state) =>
		[...state.storage.sql.exec(
			"SELECT id, message_id FROM emails WHERE folder_id = (SELECT id FROM folders WHERE name = 'sent' OR id = 'sent' LIMIT 1)",
		)],
	) as unknown as { id: string; message_id: string }[];
}

afterEach(() => setSendEmailSenderFactory(null));

describe("send failure reporting (upstream #84)", () => {
	it("reports a binding rejection as an error and files nothing in Sent", async () => {
		const mailbox = "send-rejected@example.com";
		await registerMailbox(mailbox);
		setSendEmailSenderFactory(() => ({
			send: async () => {
				throw new Error("destination not allowed");
			},
		}));

		const res = await postEmail(mailbox, {
			to: "eve@example.org",
			from: mailbox,
			subject: "Will fail",
			text: "hello eve",
		});

		expect(res.status).toBe(502);
		const body = (await res.json()) as { error?: string; status?: string };
		expect(body.error).toContain("Failed to send");
		expect(body.status).toBeUndefined();
		expect(await sentRows(mailbox)).toHaveLength(0);
	});

	it("still reports success and files Sent when the binding accepts", async () => {
		const mailbox = "send-accepted@example.com";
		await registerMailbox(mailbox);
		setSendEmailSenderFactory(() => ({
			send: async () => ({ messageId: "accepted-id@example.com" }),
		}));

		const res = await postEmail(mailbox, {
			to: "dave@example.net",
			from: mailbox,
			subject: "Will succeed",
			text: "hello dave",
		});

		expect(res.status).toBe(202);
		const rows = await sentRows(mailbox);
		expect(rows).toHaveLength(1);
	});
});

describe("delivered Message-ID (upstream #83)", () => {
	it("stores the binding's Message-ID, not a locally generated one", async () => {
		const mailbox = "send-msgid@example.com";
		await registerMailbox(mailbox);
		setSendEmailSenderFactory(() => ({
			send: async () => ({ messageId: "actual-binding-id@example.com" }),
		}));

		const res = await postEmail(mailbox, {
			to: "dave@example.net",
			from: mailbox,
			subject: "Outbound start",
			text: "hello dave",
		});
		expect(res.status).toBe(202);

		const rows = await sentRows(mailbox);
		expect(rows).toHaveLength(1);
		expect(rows[0].message_id).toBe("actual-binding-id@example.com");
		// The internal row id is a UUID; the stored message_id must not be it.
		expect(rows[0].message_id).not.toBe(rows[0].id);
		expect(rows[0].message_id).not.toContain(rows[0].id);
	});
});
