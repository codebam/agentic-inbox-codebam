import {
	createExecutionContext,
	listDurableObjectIds,
	SELF,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { normalizeAutoDraft } from "../shared/auto-draft";
import { receiveEmail, type InboundEmailEvent } from "../workers/index";

/** Register the mailbox record the inbound pipeline checks. */
async function registerMailbox(mailbox: string, settings: Record<string, unknown>) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify(settings));
}

/** Delivery settings that keep the pipeline deterministic (no AI calls). */
const PIPELINE_SETTINGS = { categorization: { enabled: false } };

/** Push one raw message through the real receiveEmail path. */
async function deliver(mailbox: string) {
	const raw = [
		"From: sender@example.org",
		`To: ${mailbox}`,
		"Subject: Hello",
		"",
		"body",
		"",
	].join("\r\n");
	const bytes = new TextEncoder().encode(raw);
	const ctx = createExecutionContext();
	const event: InboundEmailEvent = {
		raw: new Response(bytes).body as ReadableStream,
		rawSize: bytes.byteLength,
		to: mailbox,
	};
	await receiveEmail(event, env, ctx);
	// Let the scheduled auto-draft trigger (and the webhook) settle.
	await waitOnExecutionContext(ctx);
}

/** Whether the agent DO for this mailbox was ever instantiated. */
async function agentTouched(mailbox: string) {
	const expected = env.EMAIL_AGENT.idFromName(mailbox).toString();
	const ids = await listDurableObjectIds(env.EMAIL_AGENT);
	return ids.some((id) => id.toString() === expected);
}

describe("normalizeAutoDraft", () => {
	it("only an explicit false disables auto-draft", () => {
		expect(normalizeAutoDraft(false)).toBe(false);
		expect(normalizeAutoDraft(true)).toBe(true);
		expect(normalizeAutoDraft(undefined)).toBe(true);
		expect(normalizeAutoDraft(null)).toBe(true);
		expect(normalizeAutoDraft("false")).toBe(true);
	});
});

describe("mailbox settings route", () => {
	it("normalises autoDraft on PUT", async () => {
		const mailbox = "auto-draft-settings@example.com";
		await registerMailbox(mailbox, {});

		const off = await SELF.fetch(`http://example.com/api/v1/mailboxes/${mailbox}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ settings: { autoDraft: false } }),
		});
		expect(off.status).toBe(200);
		const offBody = (await off.json()) as { settings: { autoDraft: boolean } };
		expect(offBody.settings.autoDraft).toBe(false);

		const junk = await SELF.fetch(`http://example.com/api/v1/mailboxes/${mailbox}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ settings: { autoDraft: "off" } }),
		});
		const junkBody = (await junk.json()) as { settings: { autoDraft: boolean } };
		expect(junkBody.settings.autoDraft).toBe(true);
	});
});

describe("auto-draft gate", () => {
	it("still triggers the agent for new mail by default", async () => {
		const mailbox = "auto-draft-default@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		await deliver(mailbox);
		expect(await agentTouched(mailbox)).toBe(true);
	});

	it("leaves the agent alone when the mailbox turns auto-draft off", async () => {
		const mailbox = "auto-draft-off@example.com";
		await registerMailbox(mailbox, { ...PIPELINE_SETTINGS, autoDraft: false });
		await deliver(mailbox);
		expect(await agentTouched(mailbox)).toBe(false);
	});
});
