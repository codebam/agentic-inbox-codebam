// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Thread mute tests: the Durable Object's mute rows and their routes, and —
 * the point of the feature — that the push and webhook notification fan-outs
 * skip a muted thread while an arrival in an unmuted thread still notifies.
 * No push service and no webhook endpoint is ever contacted: outbound calls
 * are captured by swapping the isolate's global fetch (the technique
 * tests/push.test.ts and tests/webhook.test.ts use, because this pool does not
 * export `fetchMock`), with the request cloned at capture time before
 * anything reads it. Inbound mail goes through the real receiveEmail path.
 */


import {
	SELF,
	createExecutionContext,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { bytesToBase64Url, type PushSubscriptionInput } from "../shared/push";
import { receiveEmail, type InboundEmailEvent } from "../workers/index";
import { notifyNewEmail } from "../workers/lib/webhook";
import { notifyPushSubscriptions } from "../workers/lib/webpush";
import type { Env } from "../workers/types";


/** The test config omits the VAPID vars; each push test supplies its own. */
const appEnv = env as unknown as Env;

/** Delivery settings that keep the inbound pipeline deterministic (no AI calls). */
const PIPELINE_SETTINGS = { categorization: { enabled: false }, items: { enabled: false } };

const WEBHOOK_URL = "https://hooks.example.com/inbound";

/**
 * The thread every delivered message in this file points at: the reference
 * rides in the References header, which the pipeline reads as the thread id,
 * so a test knows the thread before the message is stored.
 */
const THREAD_ID = "mute-thread-1@example.org";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

type Stub = ReturnType<typeof stubFor>;


/** Register the mailbox record the API middleware and the pipeline check. */
async function registerMailbox(mailbox: string, settings: Record<string, unknown> = {}) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify(settings));
}


// ── Outbound fetch capture ─────────────────────────────────────────


interface CapturedCall {
	url: string;
	method: string;
	/** Read through a clone taken at capture time, so nothing consumes it. */
	request: Request;
}


/**
 * Swap the isolate's global fetch for a capture stub: every outbound call is
 * recorded (the request cloned before it is read) and the responder decides
 * what the endpoint "answers".
 */
function captureFetch(
	respond: (request: Request) => Response | Promise<Response>,
): CapturedCall[] {
	const calls: CapturedCall[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init);
		const clone = request.clone();
		calls.push({ url: request.url, method: request.method, request: clone });
		return respond(request);
	}) as typeof fetch;
	return calls;
}


/** The captured calls that went to the push service. */
function pushCalls(calls: CapturedCall[]): CapturedCall[] {
	return calls.filter((call) => call.url.startsWith("https://push.example.com/"));
}


/** The captured calls that went to the configured webhook. */
function webhookCalls(calls: CapturedCall[]): CapturedCall[] {
	return calls.filter((call) => call.url === WEBHOOK_URL);
}


// ── Push test material ─────────────────────────────────────────────


/** An Env with VAPID configured, the way the operator configures a deploy. */
function pushEnv(vapid: { publicKey: string; privateKey: string; subject: string }): Env {
	return {
		...env,
		VAPID_PUBLIC_KEY: vapid.publicKey,
		VAPID_PRIVATE_KEY: vapid.privateKey,
		VAPID_SUBJECT: vapid.subject,
	} as unknown as Env;
}


/** A VAPID signing keypair in the deployment's shapes: raw public, scalar private. */
async function generateVapid(): Promise<{ publicKey: string; privateKey: string; subject: string }> {
	const keys = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	);
	const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
	const jwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
	if (!jwk.d) throw new Error("generated P-256 key has no private scalar");
	return {
		publicKey: bytesToBase64Url(publicKeyBytes),
		privateKey: jwk.d,
		subject: "mailto:push@example.com",
	};
}


/** A subscription with a real P-256 keypair, as a browser would hand out. */
async function generateSubscription(endpoint: string): Promise<PushSubscriptionInput> {
	const keys = await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" },
		true,
		["deriveBits"],
	);
	const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
	const authSecret = crypto.getRandomValues(new Uint8Array(16));
	return {
		endpoint,
		p256dh: bytesToBase64Url(publicBytes),
		auth: bytesToBase64Url(authSecret),
	};
}


// ── Inbound delivery ───────────────────────────────────────────────


/**
 * Deliver one MIME message through the real inbound path. `threadRef` is the
 * reference the message is threaded on; `deliveryEnv` is the Env the pipeline
 * runs with, so a push test can hand it VAPID-configured env the way the
 * operator's deploy has it.
 */
async function deliver(
	mailbox: string,
	subject: string,
	threadRef = THREAD_ID,
	deliveryEnv: Env = appEnv,
) {
	const mime = [
		"From: Alice <alice@example.org>",
		`To: ${mailbox}`,
		`Subject: ${subject}`,
		`Message-ID: <${crypto.randomUUID()}@example.org>`,
		`References: <${threadRef}>`,
		"Content-Type: text/html; charset=utf-8",
		"",
		"<p>Hello mute</p>",
	].join("\r\n");
	const bytes = new TextEncoder().encode(mime);
	const ctx = createExecutionContext();
	const event: InboundEmailEvent = {
		raw: new Response(bytes).body as ReadableStream,
		rawSize: bytes.byteLength,
		to: mailbox,
	};
	await receiveEmail(event, deliveryEnv, ctx);
	await waitOnExecutionContext(ctx);
}


/** The mailbox's inbox rows. */
async function inboxRows(mailbox: string): Promise<{ id: string; thread_id?: string | null }[]> {
	return (await stubFor(mailbox).getEmails({ folder: Folders.INBOX })) as {
		id: string;
		thread_id?: string | null;
	}[];
}


/** Every muted row in the mailbox's SQLite, read straight from the DO. */
async function mutedRows(stub: Stub): Promise<{ thread_id: string; created_at: string }[]> {
	return runInDurableObject(stub, (_instance, state) => [
		...state.storage.sql.exec(
			"SELECT thread_id, created_at FROM muted_threads ORDER BY thread_id",
		),
	] as unknown as { thread_id: string; created_at: string }[]);
}


// ── Durable Object round trip ──────────────────────────────────────


describe("MailboxDO thread mutes", () => {
	it("mutes, answers the lookup, unmutes, and keeps double-unmute false", async () => {
		const stub = stubFor("mute-store@example.com");
		const thread = "thread-1@example.org";

		expect(await stub.isThreadMuted(thread)).toBe(false);
		expect(await stub.muteThread(thread)).toBe(true);
		expect(await stub.isThreadMuted(thread)).toBe(true);

		// Trimming is part of the contract: a padded id is the same thread.
		expect(await stub.isThreadMuted(`  ${thread}  `)).toBe(true);

		expect(await stub.unmuteThread(thread)).toBe(true);
		expect(await stub.isThreadMuted(thread)).toBe(false);
		// Unmuting again — or a thread that was never muted — is false, not an
		// error, and the padded id no longer matches anything either.
		expect(await stub.unmuteThread(thread)).toBe(false);
		expect(await stub.unmuteThread("never-muted@example.org")).toBe(false);
		expect(await stub.isThreadMuted(`  ${thread}  `)).toBe(false);
	});

	it("is idempotent: re-muting refreshes one row instead of adding one", async () => {
		const stub = stubFor("mute-idempotent@example.com");

		expect(await stub.muteThread("first-thread")).toBe(true);
		expect(await stub.muteThread("first-thread")).toBe(true);
		expect(await stub.muteThread("  first-thread  ")).toBe(true);
		expect(await stub.muteThread("second-thread")).toBe(true);

		const rows = await mutedRows(stub);
		expect(rows.map((row) => row.thread_id)).toEqual(["first-thread", "second-thread"]);
		expect(new Date(rows[0]!.created_at).toISOString()).toBe(rows[0]!.created_at);
	});
});


// ── Routes ─────────────────────────────────────────────────────────


/** The mute path for one mailbox and thread id. */
function mutePath(mailbox: string, threadId: string) {
	return `http://example.com/api/v1/mailboxes/${mailbox}/threads/${threadId}/mute`;
}


describe("thread mute routes", () => {
	it("answers GET false, POST true, GET true, DELETE false", async () => {
		const mailbox = "mute-routes@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const path = mutePath(mailbox, "route-thread@example.org");

		const initial = await SELF.fetch(path);
		expect(initial.status).toBe(200);
		expect(await initial.json()).toEqual({ muted: false });

		const muted = await SELF.fetch(path, { method: "POST" });
		expect(muted.status).toBe(200);
		expect(await muted.json()).toEqual({ muted: true });

		const stillMuted = await SELF.fetch(path);
		expect(await stillMuted.json()).toEqual({ muted: true });

		const unmuted = await SELF.fetch(path, { method: "DELETE" });
		expect(unmuted.status).toBe(200);
		expect(await unmuted.json()).toEqual({ muted: false });

		// Unmuting again is idempotent: it still answers false.
		const again = await SELF.fetch(path, { method: "DELETE" });
		expect(await again.json()).toEqual({ muted: false });
	});

	it("mutes a thread id that has no messages", async () => {
		const mailbox = "mute-no-messages@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);

		const muted = await SELF.fetch(mutePath(mailbox, "empty-thread@example.org"), {
			method: "POST",
		});
		expect(await muted.json()).toEqual({ muted: true });

		// Nothing was ever delivered for this thread: the mute is just a row.
		expect(await inboxRows(mailbox)).toHaveLength(0);
		expect(await stubFor(mailbox).isThreadMuted("empty-thread@example.org")).toBe(true);
	});

	it("answers 400 for a thread id past the bound and stores nothing", async () => {
		const mailbox = "mute-too-long@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const tooLong = "x".repeat(321);

		const response = await SELF.fetch(mutePath(mailbox, tooLong), { method: "POST" });
		expect(response.status).toBe(400);
		expect(await mutedRows(stubFor(mailbox))).toHaveLength(0);
	});
});


// ── Push fan-out suppression ───────────────────────────────────────


describe("push suppression", () => {
	it("skips a muted thread's arrival and notifies again once it is unmuted", async () => {
		const mailbox = "mute-push@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const subscription = await generateSubscription("https://push.example.com/mute");
		await stubFor(mailbox).upsertPushSubscription(subscription);
		const vapid = await generateVapid();
		const calls = captureFetch(() => new Response(null, { status: 201 }));

		// Positive control: the first arrival opens the thread and is pushed.
		await deliver(mailbox, "Muted thread subject", THREAD_ID, pushEnv(vapid));
		expect(pushCalls(calls)).toHaveLength(1);
		// The reference header is what the pipeline threaded the message on.
		expect((await inboxRows(mailbox))[0]?.thread_id).toBe(THREAD_ID);

		expect(await stubFor(mailbox).muteThread(THREAD_ID)).toBe(true);
		await deliver(mailbox, "Muted thread subject", THREAD_ID, pushEnv(vapid));
		expect(pushCalls(calls)).toHaveLength(1);
		// Only the notification is skipped: the message is still delivered.
		expect(await inboxRows(mailbox)).toHaveLength(2);

		expect(await stubFor(mailbox).unmuteThread(THREAD_ID)).toBe(true);
		await deliver(mailbox, "Muted thread subject", THREAD_ID, pushEnv(vapid));
		expect(pushCalls(calls)).toHaveLength(2);
		expect(await inboxRows(mailbox)).toHaveLength(3);

		// A different thread was never affected.
		await stubFor(mailbox).muteThread(THREAD_ID);
		await deliver(mailbox, "Other thread subject", "other-thread@example.org", pushEnv(vapid));
		expect(pushCalls(calls)).toHaveLength(3);
	});

	it("skips the whole fan-out when the payload's thread is muted", async () => {
		const mailbox = "mute-push-direct@example.com";
		const subscription = await generateSubscription("https://push.example.com/mute-direct");
		await stubFor(mailbox).upsertPushSubscription(subscription);
		await stubFor(mailbox).muteThread("direct-thread");
		const vapid = await generateVapid();
		const calls = captureFetch(() => new Response(null, { status: 201 }));

		const skipped = await notifyPushSubscriptions(pushEnv(vapid), mailbox, {
			sender: "alice@example.org",
			subject: "Hello",
			threadId: "direct-thread",
		});

		expect(pushCalls(calls)).toHaveLength(0);
		expect(skipped).toMatchObject({ attempted: 0, delivered: 0, skipped: true });

		// The same notification on a thread that is not muted is delivered.
		const delivered = await notifyPushSubscriptions(pushEnv(vapid), mailbox, {
			sender: "alice@example.org",
			subject: "Hello",
			threadId: "unmuted-thread",
		});

		expect(pushCalls(calls)).toHaveLength(1);
		expect(delivered).toMatchObject({ attempted: 1, delivered: 1, skipped: false });
	});

	it("sends anyway when the mute lookup fails (fails open, never rejects)", async () => {
		const subscription = await generateSubscription("https://push.example.com/mute-fail");
		const vapid = await generateVapid();
		const brokenEnv = {
			...env,
			VAPID_PUBLIC_KEY: vapid.publicKey,
			VAPID_PRIVATE_KEY: vapid.privateKey,
			VAPID_SUBJECT: vapid.subject,
			MAILBOX: {
				idFromName: (name: string) => name,
				get: () => ({
					isThreadMuted: async () => {
						throw new Error("mute table unreadable");
					},
					listPushSubscriptions: async () => [subscription],
					markPushSubscriptionOk: async () => undefined,
				}),
			},
		} as unknown as Env;
		const calls = captureFetch(() => new Response(null, { status: 201 }));

		const result = await notifyPushSubscriptions(brokenEnv, "mute-fail@example.com", {
			sender: "alice@example.org",
			subject: "Hello",
			threadId: "unreadable-thread",
		});

		expect(pushCalls(calls)).toHaveLength(1);
		expect(result).toMatchObject({ attempted: 1, delivered: 1, skipped: false });
	});
});


// ── Webhook fan-out suppression ────────────────────────────────────


describe("webhook suppression", () => {
	it("skips a muted thread's arrival and notifies again once it is unmuted", async () => {
		const mailbox = "mute-webhook@example.com";
		await registerMailbox(mailbox, { ...PIPELINE_SETTINGS, notifyWebhookUrl: WEBHOOK_URL });
		const calls = captureFetch(() => new Response("ok", { status: 200 }));

		// Positive control: the first arrival opens the thread and is POSTed.
		await deliver(mailbox, "Muted webhook subject");
		expect(webhookCalls(calls)).toHaveLength(1);
		expect((await inboxRows(mailbox))[0]?.thread_id).toBe(THREAD_ID);

		expect(await stubFor(mailbox).muteThread(THREAD_ID)).toBe(true);
		await deliver(mailbox, "Muted webhook subject");
		expect(webhookCalls(calls)).toHaveLength(1);
		// Only the notification is skipped: the message is still delivered.
		expect(await inboxRows(mailbox)).toHaveLength(2);

		expect(await stubFor(mailbox).unmuteThread(THREAD_ID)).toBe(true);
		await deliver(mailbox, "Muted webhook subject");
		expect(webhookCalls(calls)).toHaveLength(2);
		expect(await inboxRows(mailbox)).toHaveLength(3);

		// A different thread was never affected.
		await stubFor(mailbox).muteThread(THREAD_ID);
		await deliver(mailbox, "Other webhook subject", "other-thread@example.org");
		expect(webhookCalls(calls)).toHaveLength(3);
	});

	it("sends nothing when the payload's thread is muted", async () => {
		const mailbox = "mute-webhook-direct@example.com";
		await stubFor(mailbox).muteThread("direct-hook-thread");
		const calls = captureFetch(() => new Response("ok", { status: 200 }));
		const email = {
			id: "mute-webhook-1",
			subject: "Hello",
			sender: "alice@example.org",
			recipient: mailbox,
			date: "2026-01-01T00:00:00.000Z",
			folder: Folders.INBOX,
			category: null,
			body: "<p>Body</p>",
			threadId: "direct-hook-thread",
		};

		const skipped = await notifyNewEmail(appEnv, mailbox, email, {
			notifyWebhookUrl: WEBHOOK_URL,
		});

		expect(skipped).toEqual({ ok: false, status: null, error: null, skipped: true });
		expect(webhookCalls(calls)).toHaveLength(0);

		// The same notification on a thread that is not muted is POSTed.
		const delivered = await notifyNewEmail(
			appEnv,
			mailbox,
			{ ...email, threadId: "unmuted-hook-thread" },
			{ notifyWebhookUrl: WEBHOOK_URL },
		);

		expect(delivered).toEqual({ ok: true, status: 200, error: null });
		expect(webhookCalls(calls)).toHaveLength(1);
	});

	it("sends anyway when the mute lookup fails (fails open, never rejects)", async () => {
		const brokenEnv = {
			...env,
			MAILBOX: {
				idFromName: (name: string) => name,
				get: () => ({
					isThreadMuted: async () => {
						throw new Error("mute table unreadable");
					},
				}),
			},
		} as unknown as Env;
		const calls = captureFetch(() => new Response("ok", { status: 200 }));

		const result = await notifyNewEmail(
			brokenEnv,
			"mute-webhook-fail@example.com",
			{
				id: "mute-webhook-2",
				subject: "Hello",
				sender: "alice@example.org",
				recipient: "mute-webhook-fail@example.com",
				date: "2026-01-01T00:00:00.000Z",
				folder: Folders.INBOX,
				category: null,
				body: "<p>Body</p>",
				threadId: "unreadable-thread",
			},
			{ notifyWebhookUrl: WEBHOOK_URL },
		);

		expect(result).toEqual({ ok: true, status: 200, error: null });
		expect(webhookCalls(calls)).toHaveLength(1);
	});
});
