import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { receiveEmail, type InboundEmailEvent } from "../workers/index";

/**
 * Upstream #85: an inbound reply that cites a stored message's Message-ID
 * (In-Reply-To / References) must be filed in that message's thread, not a
 * separate thread keyed on the raw header value. The conversation root carries
 * an internal UUID thread_id, so the reply has to be matched by message_id.
 */

async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(
		`mailboxes/${mailbox}.json`,
		JSON.stringify({ categorization: { enabled: false } }),
	);
}

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

async function deliverRaw(mailbox: string, raw: string) {
	const bytes = new TextEncoder().encode(raw);
	const ctx = createExecutionContext();
	const event: InboundEmailEvent = {
		raw: new Response(bytes).body as ReadableStream,
		rawSize: bytes.byteLength,
		to: mailbox,
	};
	await receiveEmail(event, env, ctx);
	await waitOnExecutionContext(ctx);
}

async function rows(mailbox: string) {
	return runInDurableObject(stubFor(mailbox), async (_instance, state) =>
		[...state.storage.sql.exec("SELECT id, thread_id, message_id, subject FROM emails")],
	) as unknown as { id: string; thread_id: string; message_id: string | null; subject: string }[];
}

describe("inbound reply threading (upstream #85)", () => {
	it("files a reply citing a stored Message-ID in that message's thread", async () => {
		const mailbox = "reply-threading@example.com";
		await registerMailbox(mailbox);

		await deliverRaw(mailbox, [
			"From: sender@example.org",
			`To: ${mailbox}`,
			"Subject: Project kickoff",
			"Message-ID: <root-85@example.net>",
			"",
			"first message",
			"",
		].join("\r\n"));

		const afterRoot = await rows(mailbox);
		const root = afterRoot.find((r) => r.message_id === "root-85@example.net");
		expect(root).toBeDefined();

		await deliverRaw(mailbox, [
			"From: sender@example.org",
			`To: ${mailbox}`,
			"Subject: Re: Project kickoff",
			"Message-ID: <reply-85@example.net>",
			"In-Reply-To: <root-85@example.net>",
			"References: <root-85@example.net>",
			"",
			"the reply",
			"",
		].join("\r\n"));

		const afterReply = await rows(mailbox);
		const reply = afterReply.find((r) => r.message_id === "reply-85@example.net");
		expect(reply).toBeDefined();
		// The reply must share the root's thread, not the raw Message-ID.
		expect(reply!.thread_id).toBe(root!.thread_id);
		expect(reply!.thread_id).not.toBe("root-85@example.net");
	});

	it("matches via the References chain when In-Reply-To is absent", async () => {
		const mailbox = "reply-threading-refs@example.com";
		await registerMailbox(mailbox);

		await deliverRaw(mailbox, [
			"From: sender@example.org",
			`To: ${mailbox}`,
			"Subject: Chain root",
			"Message-ID: <chain-root@example.net>",
			"",
			"root",
			"",
		].join("\r\n"));
		const root = (await rows(mailbox)).find((r) => r.message_id === "chain-root@example.net");
		expect(root).toBeDefined();

		await deliverRaw(mailbox, [
			"From: sender@example.org",
			`To: ${mailbox}`,
			"Subject: Re: Chain root",
			"Message-ID: <chain-reply@example.net>",
			"References: <chain-root@example.net>",
			"",
			"reply via references",
			"",
		].join("\r\n"));
		const reply = (await rows(mailbox)).find((r) => r.message_id === "chain-reply@example.net");
		expect(reply).toBeDefined();
		expect(reply!.thread_id).toBe(root!.thread_id);
	});
});
