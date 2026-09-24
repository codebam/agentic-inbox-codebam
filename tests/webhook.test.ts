// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Outbound webhook tests: the snippet/signature/request helpers, the settings
 * route's URL validation, the /webhook/test probe route, and the delivery
 * guarantee that a failing webhook never affects mail delivery.
 *
 * @cloudflare/vitest-pool-workers 0.22.0 does not export `fetchMock` from
 * `cloudflare:test`, so outbound calls are captured by swapping the isolate's
 * global `fetch` for the duration of a test. Tests and the main worker run in
 * the same isolate, so the worker sees the swap too.
 */


import {
	SELF,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { SPAM_CATEGORY_ID } from "../shared/categories";
import { Folders } from "../shared/folders";
import { validateWebhookUrl } from "../shared/webhook";
import { receiveEmail } from "../workers/index";
import {
	WEBHOOK_SNIPPET_MAX_LENGTH,
	WEBHOOK_TIMEOUT_MS,
	buildWebhookPayload,
	buildWebhookRequest,
	emailSnippet,
	notifyNewEmail,
	signWebhookBody,
	type WebhookEmail,
} from "../workers/lib/webhook";
import type { Env } from "../workers/types";


/** The test config omits account-level vars; the webhook path only needs BUCKET + MAILBOX. */
const appEnv = env as unknown as Env;


const WEBHOOK_URL = "https://hooks.example.com/inbound";
const SECRET = "s3cret";


const EMAIL: WebhookEmail = {
	id: "email-1",
	subject: "Hello",
	sender: "alice@example.org",
	recipient: "notify@example.com",
	date: "2026-01-01T00:00:00.000Z",
	folder: Folders.INBOX,
	category: "work",
	body: "<p>Body <b>text</b></p>",
};


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


/** Register the mailbox record the API middleware checks before routing. */
async function registerMailbox(
	mailbox: string,
	settings: Record<string, unknown> = {},
) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify(settings));
}


async function storedSettings(mailbox: string) {
	const object = await env.BUCKET.get(`mailboxes/${mailbox}.json`);
	return object ? ((await object.json()) as Record<string, unknown>) : null;
}


// ── Outbound fetch capture ─────────────────────────────────────────


interface CapturedCall {
	url: string;
	request: Request;
	body: string;
}


const originalFetch = globalThis.fetch;


/**
 * Swap the isolate's global fetch for a capture stub, so the exact request the
 * notifier builds can be inspected. Every outbound call is recorded; the
 * responder decides what the endpoint "answers".
 */
function captureFetch(
	respond: (request: Request) => Response | Promise<Response>,
): CapturedCall[] {
	const calls: CapturedCall[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init);
		calls.push({ url: request.url, request, body: await request.clone().text() });
		return respond(request);
	}) as typeof fetch;
	return calls;
}


/** Capture stub whose endpoint is unreachable, to prove failures are swallowed. */
function captureFetchThatFails(message = "connection refused"): CapturedCall[] {
	return captureFetch(() => {
		throw new Error(message);
	});
}


function webhookCalls(calls: CapturedCall[]): CapturedCall[] {
	return calls.filter((call) => call.url === WEBHOOK_URL);
}


afterEach(() => {
	globalThis.fetch = originalFetch;
});


// ── Pure helpers ───────────────────────────────────────────────────


describe("validateWebhookUrl", () => {
	it("accepts https URLs and treats absent/blank values as 'no webhook'", () => {
		expect(validateWebhookUrl("https://hooks.example.com/inbound")).toBeNull();
		expect(validateWebhookUrl("  https://hooks.example.com/inbound  ")).toBeNull();
		expect(validateWebhookUrl(undefined)).toBeNull();
		expect(validateWebhookUrl(null)).toBeNull();
		expect(validateWebhookUrl("")).toBeNull();
		expect(validateWebhookUrl("   ")).toBeNull();
	});


	it("rejects anything that is not an absolute https URL", () => {
		expect(validateWebhookUrl("http://hooks.example.com")).toContain("https://");
		expect(validateWebhookUrl("ftp://hooks.example.com")).toContain("https://");
		expect(validateWebhookUrl("not a url")).toContain("valid absolute URL");
		expect(validateWebhookUrl("hooks.example.com")).toContain("valid absolute URL");
		expect(validateWebhookUrl(42)).toContain("string");
		expect(validateWebhookUrl(`https://example.com/${"x".repeat(3000)}`)).toContain(
			"at most",
		);
	});
});


describe("emailSnippet", () => {
	it("strips HTML and collapses whitespace into one plain-text line", () => {
		expect(emailSnippet("<p>Hello <b>there</b></p>\n\n<p>second line</p>")).toBe(
			"Hello there second line",
		);
	});


	it("returns an empty string for missing bodies", () => {
		expect(emailSnippet(undefined)).toBe("");
		expect(emailSnippet(null)).toBe("");
		expect(emailSnippet("")).toBe("");
		expect(emailSnippet("<style>p{color:red}</style>")).toBe("");
	});


	it("truncates a long body at the cap and marks the cut with an ellipsis", () => {
		const snippet = emailSnippet("x".repeat(WEBHOOK_SNIPPET_MAX_LENGTH + 50));
		expect(snippet).toBe(`${"x".repeat(WEBHOOK_SNIPPET_MAX_LENGTH)}…`);
		expect(snippet.length).toBe(WEBHOOK_SNIPPET_MAX_LENGTH + 1);
	});


	it("keeps a body exactly at the cap un-truncated", () => {
		const exact = "y".repeat(WEBHOOK_SNIPPET_MAX_LENGTH);
		expect(emailSnippet(exact)).toBe(exact);
	});
});


describe("signWebhookBody", () => {
	it("signs the exact body bytes with HMAC-SHA256", async () => {
		// Vector: HMAC-SHA256(key="s3cret", msg='{"hello":"world"}').
		await expect(signWebhookBody(SECRET, '{"hello":"world"}')).resolves.toBe(
			"sha256=d5d644dccc0b0763243db8acd3c44bab4adda9a2511ed24f2ba86379ff0f8a66",
		);
	});


	it("changes with the body and with the secret", async () => {
		const base = await signWebhookBody(SECRET, "one");
		expect(base).toMatch(/^sha256=[0-9a-f]{64}$/);
		expect(await signWebhookBody(SECRET, "two")).not.toBe(base);
		expect(await signWebhookBody("other-secret", "one")).not.toBe(base);
	});
});


describe("buildWebhookPayload", () => {
	it("carries the documented fields with a plain-text snippet", () => {
		expect(buildWebhookPayload("notify@example.com", EMAIL)).toEqual({
			mailbox: "notify@example.com",
			id: "email-1",
			subject: "Hello",
			sender: "alice@example.org",
			recipient: "notify@example.com",
			date: "2026-01-01T00:00:00.000Z",
			folder: "inbox",
			category: "work",
			snippet: "Body text",
		});
	});


	it("defaults a missing category to null", () => {
		const payload = buildWebhookPayload("notify@example.com", {
			...EMAIL,
			category: undefined,
			body: "",
		});
		expect(payload.category).toBeNull();
		expect(payload.snippet).toBe("");
	});
});


describe("buildWebhookRequest", () => {
	it("POSTs JSON with the signature header when a secret is configured", async () => {
		const request = buildWebhookRequest(WEBHOOK_URL, '{"a":1}', "sha256=abc");
		expect(request.method).toBe("POST");
		expect(request.url).toBe(WEBHOOK_URL);
		expect(request.headers.get("content-type")).toBe("application/json");
		expect(request.headers.get("X-Agentic-Inbox-Signature")).toBe("sha256=abc");
		expect(await request.text()).toBe('{"a":1}');
		expect(request.signal.aborted).toBe(false);
	});


	it("omits the signature header when no secret is configured", () => {
		const request = buildWebhookRequest(WEBHOOK_URL, "{}", null);
		expect(request.headers.get("X-Agentic-Inbox-Signature")).toBeNull();
	});


	it("gives every request a 5-second timeout", () => {
		expect(WEBHOOK_TIMEOUT_MS).toBe(5_000);
	});
});


// ── notifyNewEmail ─────────────────────────────────────────────────


describe("notifyNewEmail", () => {
	it("POSTs the payload and signature to the configured URL", async () => {
		const calls = captureFetch(() => new Response("ok", { status: 200 }));


		const result = await notifyNewEmail(appEnv, "notify@example.com", EMAIL, {
			notifyWebhookUrl: `  ${WEBHOOK_URL}  `,
			notifyWebhookSecret: `  ${SECRET}  `,
		});


		expect(result).toEqual({ ok: true, status: 200, error: null });
		const [call] = webhookCalls(calls);
		expect(webhookCalls(calls)).toHaveLength(1);
		expect(call.request.method).toBe("POST");
		expect(call.request.headers.get("X-Agentic-Inbox-Signature")).toBe(
			await signWebhookBody(SECRET, call.body),
		);
		expect(JSON.parse(call.body)).toEqual(
			buildWebhookPayload("notify@example.com", EMAIL),
		);
	});


	it("reads the mailbox settings from R2 when none are passed", async () => {
		await registerMailbox("webhook-r2@example.com", {
			notifyWebhookUrl: WEBHOOK_URL,
			notifyWebhookSecret: SECRET,
		});
		const calls = captureFetch(() => new Response("ok", { status: 200 }));


		const result = await notifyNewEmail(appEnv, "webhook-r2@example.com", EMAIL);


		expect(result.ok).toBe(true);
		expect(webhookCalls(calls)).toHaveLength(1);
	});


	it("sends nothing when no URL is configured", async () => {
		const calls = captureFetch(() => new Response("ok", { status: 200 }));


		const result = await notifyNewEmail(appEnv, "notify@example.com", EMAIL, {});


		expect(result).toEqual({ ok: false, status: null, error: null, skipped: true });
		expect(calls).toHaveLength(0);
	});


	it("never fetches an unusable stored URL", async () => {
		const calls = captureFetch(() => new Response("ok", { status: 200 }));


		const result = await notifyNewEmail(appEnv, "notify@example.com", EMAIL, {
			notifyWebhookUrl: "http://plain.example.com/hook",
		});


		expect(result.skipped).toBe(true);
		expect(result.ok).toBe(false);
		expect(calls).toHaveLength(0);
	});


	it("omits the signature header when no secret is configured", async () => {
		const calls = captureFetch(() => new Response("ok", { status: 200 }));


		const result = await notifyNewEmail(appEnv, "notify@example.com", EMAIL, {
			notifyWebhookUrl: WEBHOOK_URL,
		});


		expect(result.ok).toBe(true);
		expect(webhookCalls(calls)[0].request.headers.get("X-Agentic-Inbox-Signature")).toBeNull();
	});


	it("swallows an unreachable endpoint", async () => {
		captureFetchThatFails("connection refused");


		const result = await notifyNewEmail(appEnv, "notify@example.com", EMAIL, {
			notifyWebhookUrl: WEBHOOK_URL,
		});


		expect(result.ok).toBe(false);
		expect(result.status).toBeNull();
		expect(result.error).toContain("connection refused");
	});


	it("reports a non-2xx answer without throwing", async () => {
		captureFetch(() => new Response("nope", { status: 500 }));


		const result = await notifyNewEmail(appEnv, "notify@example.com", EMAIL, {
			notifyWebhookUrl: WEBHOOK_URL,
		});


		expect(result).toEqual({ ok: false, status: 500, error: "Webhook responded 500" });
	});
});


// ── Settings route validation ──────────────────────────────────────


async function putSettings(mailbox: string, settings: unknown) {
	await registerMailbox(mailbox);
	const res = await SELF.fetch(`http://example.com/api/v1/mailboxes/${mailbox}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ settings }),
	});
	return {
		status: res.status,
		body: (await res.json()) as {
			error?: string;
			settings?: Record<string, unknown>;
		},
	};
}


describe("mailbox settings webhook validation", () => {
	it("stores a trimmed https URL and secret", async () => {
		const mailbox = "hook-store@example.com";
		const { status, body } = await putSettings(mailbox, {
			notifyWebhookUrl: `  ${WEBHOOK_URL}  `,
			notifyWebhookSecret: `  ${SECRET}  `,
		});


		expect(status).toBe(200);
		expect(body.settings?.notifyWebhookUrl).toBe(WEBHOOK_URL);
		expect(body.settings?.notifyWebhookSecret).toBe(SECRET);
		expect(await storedSettings(mailbox)).toMatchObject({
			notifyWebhookUrl: WEBHOOK_URL,
			notifyWebhookSecret: SECRET,
		});
	});


	it("rejects a non-https URL with 400 and stores nothing", async () => {
		const mailbox = "hook-http@example.com";
		const { status, body } = await putSettings(mailbox, {
			notifyWebhookUrl: "http://hooks.example.com/inbound",
		});


		expect(status).toBe(400);
		expect(body.error).toContain("https://");
		expect(await storedSettings(mailbox)).not.toHaveProperty("notifyWebhookUrl");
	});


	it("rejects a garbage URL with 400 and stores nothing", async () => {
		const mailbox = "hook-garbage@example.com";
		const { status, body } = await putSettings(mailbox, {
			notifyWebhookUrl: "not a url",
		});


		expect(status).toBe(400);
		expect(body.error).toContain("valid absolute URL");
		expect(await storedSettings(mailbox)).not.toHaveProperty("notifyWebhookUrl");
	});


	it("rejects a non-string URL with 400", async () => {
		const { status, body } = await putSettings("hook-type@example.com", {
			notifyWebhookUrl: 42,
		});
		expect(status).toBe(400);
		expect(body.error).toContain("string");
	});


	it("accepts a blank URL as 'no webhook' and drops it from the stored settings", async () => {
		const mailbox = "hook-blank@example.com";
		const { status, body } = await putSettings(mailbox, {
			notifyWebhookUrl: "   ",
			notifyWebhookSecret: "",
		});


		expect(status).toBe(200);
		expect(body.settings?.notifyWebhookUrl).toBeUndefined();
		expect(await storedSettings(mailbox)).not.toHaveProperty("notifyWebhookUrl");
	});
});


// ── Test route ─────────────────────────────────────────────────────


async function postWebhookTest(mailbox: string, body: unknown = {}) {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/webhook/test`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	return {
		status: res.status,
		body: (await res.json()) as {
			ok?: boolean;
			status?: number | null;
			error?: string | null;
		},
	};
}


describe("POST /api/v1/mailboxes/:mailboxId/webhook/test", () => {
	it("sends a sample payload to the submitted URL and reports the upstream status", async () => {
		const mailbox = "hook-test-route@example.com";
		await registerMailbox(mailbox);
		const calls = captureFetch(() => new Response(null, { status: 204 }));


		const res = await postWebhookTest(mailbox, {
			url: WEBHOOK_URL,
			secret: SECRET,
		});


		expect(res.status).toBe(200);
		expect(res.body).toEqual({ ok: true, status: 204, error: null });
		const [call] = webhookCalls(calls);
		expect(webhookCalls(calls)).toHaveLength(1);
		expect(call.request.headers.get("X-Agentic-Inbox-Signature")).toBe(
			await signWebhookBody(SECRET, call.body),
		);
		const payload = JSON.parse(call.body) as Record<string, unknown>;
		expect(payload.mailbox).toBe(mailbox);
		expect(payload.subject).toBe("Agentic Inbox webhook test");
		expect(payload.recipient).toBe(mailbox);
		expect(payload.folder).toBe(Folders.INBOX);
	});


	it("falls back to the stored settings when no URL is submitted", async () => {
		const mailbox = "hook-test-stored@example.com";
		await registerMailbox(mailbox, { notifyWebhookUrl: WEBHOOK_URL });
		const calls = captureFetch(() => new Response("ok", { status: 200 }));


		const res = await postWebhookTest(mailbox);


		expect(res.body.ok).toBe(true);
		expect(webhookCalls(calls)).toHaveLength(1);
	});


	it("returns the upstream failure status and error to the UI", async () => {
		const mailbox = "hook-test-fail@example.com";
		await registerMailbox(mailbox);
		captureFetch(() => new Response("nope", { status: 503 }));


		const res = await postWebhookTest(mailbox, { url: WEBHOOK_URL });


		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			ok: false,
			status: 503,
			error: "Webhook responded 503",
		});
	});


	it("rejects a non-https URL with 400", async () => {
		const mailbox = "hook-test-http@example.com";
		await registerMailbox(mailbox);
		const calls = captureFetch(() => new Response("ok", { status: 200 }));


		const res = await postWebhookTest(mailbox, {
			url: "http://hooks.example.com/inbound",
		});


		expect(res.status).toBe(400);
		expect(res.body.error).toContain("https://");
		expect(calls).toHaveLength(0);
	});


	it("rejects a garbage URL with 400", async () => {
		const mailbox = "hook-test-garbage@example.com";
		await registerMailbox(mailbox);


		const res = await postWebhookTest(mailbox, { url: "not a url" });


		expect(res.status).toBe(400);
		expect(res.body.error).toContain("valid absolute URL");
	});


	it("400s when neither the request nor the settings carry a URL", async () => {
		const mailbox = "hook-test-missing@example.com";
		await registerMailbox(mailbox);
		const calls = captureFetch(() => new Response("ok", { status: 200 }));


		const res = await postWebhookTest(mailbox);


		expect(res.status).toBe(400);
		expect(res.body.error).toContain("No webhook URL configured");
		expect(calls).toHaveLength(0);
	});
});


// ── Inbound delivery ───────────────────────────────────────────────


/** Deliver one MIME message through the real inbound path. */
async function deliver(mailbox: string, subject: string) {
	const mime = [
		"From: Alice <alice@example.org>",
		`To: ${mailbox}`,
		`Subject: ${subject}`,
		`Message-ID: <${crypto.randomUUID()}@example.org>`,
		"Content-Type: text/html; charset=utf-8",
		"",
		"<p>Hello <b>webhook</b> world</p>",
	].join("\r\n");
	const bytes = new TextEncoder().encode(mime);
	const ctx = createExecutionContext();
	await receiveEmail(
		{ raw: new Response(bytes).body!, rawSize: bytes.byteLength, to: mailbox },
		appEnv,
		ctx,
	);
	await waitOnExecutionContext(ctx);
}


async function inboxIds(mailbox: string): Promise<string[]> {
	const rows = (await stubFor(mailbox).getEmails({ folder: Folders.INBOX })) as {
		id: string;
	}[];
	return rows.map((row) => row.id);
}


describe("inbound delivery", () => {
	it("notifies the mailbox webhook once per non-spam arrival", async () => {
		const mailbox = "webhook-inbound@example.com";
		await registerMailbox(mailbox, {
			notifyWebhookUrl: WEBHOOK_URL,
			notifyWebhookSecret: SECRET,
		});
		const calls = captureFetch(() => new Response("ok", { status: 200 }));


		await deliver(mailbox, "Hello webhook");


		const [call] = webhookCalls(calls);
		expect(webhookCalls(calls)).toHaveLength(1);
		expect(call.request.method).toBe("POST");
		expect(call.request.headers.get("content-type")).toBe("application/json");
		expect(call.request.headers.get("X-Agentic-Inbox-Signature")).toBe(
			await signWebhookBody(SECRET, call.body),
		);


		const payload = JSON.parse(call.body) as Record<string, unknown>;
		expect(payload).toMatchObject({
			mailbox,
			subject: "Hello webhook",
			sender: "alice@example.org",
			recipient: mailbox,
			folder: Folders.INBOX,
			category: null,
			snippet: "Hello webhook world",
		});
		expect(new Date(payload.date as string).toISOString()).toBe(payload.date);


		// Delivery is untouched, and the payload names the stored row.
		expect(await inboxIds(mailbox)).toEqual([payload.id]);
	});


	it("still delivers mail when the webhook is unreachable", async () => {
		const mailbox = "webhook-unreachable@example.com";
		await registerMailbox(mailbox, { notifyWebhookUrl: WEBHOOK_URL });
		const calls = captureFetchThatFails();


		await deliver(mailbox, "Unreachable webhook");


		expect(webhookCalls(calls)).toHaveLength(1);
		expect(await inboxIds(mailbox)).toHaveLength(1);
	});


	it("still delivers mail when the webhook answers non-2xx", async () => {
		const mailbox = "webhook-500@example.com";
		await registerMailbox(mailbox, { notifyWebhookUrl: WEBHOOK_URL });
		captureFetch(() => new Response("nope", { status: 500 }));


		await deliver(mailbox, "Rejecting webhook");


		expect(await inboxIds(mailbox)).toHaveLength(1);
	});


	it("makes no outbound call when no webhook is configured", async () => {
		const mailbox = "webhook-none@example.com";
		await registerMailbox(mailbox, {});
		const calls = captureFetch(() => new Response("ok", { status: 200 }));


		await deliver(mailbox, "No webhook");


		expect(calls).toHaveLength(0);
		expect(await inboxIds(mailbox)).toHaveLength(1);
	});


	it("does not notify for spam-marked arrivals (spam stays notification-free)", async () => {
		const mailbox = "webhook-spam@example.com";
		await registerMailbox(mailbox, { notifyWebhookUrl: WEBHOOK_URL });
		await stubFor(mailbox).createRule({
			name: "Spam filter",
			match: { mode: "all", conditions: { from_contains: "alice@example.org" } },
			actions: { set_category: SPAM_CATEGORY_ID },
		});
		const calls = captureFetch(() => new Response("ok", { status: 200 }));


		await deliver(mailbox, "Spam arrival");


		expect(calls).toHaveLength(0);
		// The message itself is still delivered; only the notification is skipped.
		expect(await inboxIds(mailbox)).toHaveLength(1);
	});
});
