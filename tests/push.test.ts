// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Web push tests: the VAPID token and its verification, the aes128gcm round
 * trip against a test-generated subscription keypair, the subscribe and
 * unsubscribe routes, the malformed-body 400, the spam skip, the
 * never-throws guarantee for a rejecting push service, the 404/410 prune and
 * the per-mailbox subscription cap.
 *
 * No push service is ever contacted. The transport takes an injected fetch,
 * and the receiveEmail path is exercised with the isolate's global fetch
 * swapped — the technique tests/webhook.test.ts uses, because
 * vitest-pool-workers 0.22.0 does not export `fetchMock` from
 * `cloudflare:test`. The decryptor below is an independent HMAC-based
 * implementation of the RFC 8291 derivation, so a passing round trip proves
 * the production WebCrypto path rather than echoing it.
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
import {
	MAX_PUSH_SUBSCRIPTIONS,
	base64UrlToBytes,
	bytesToBase64Url,
	validatePushSubscription,
	type PushSubscriptionInput,
} from "../shared/push";
import { app, receiveEmail, type InboundEmailEvent } from "../workers/index";
import {
	PUSH_SUBJECT_MAX_LENGTH,
	VAPID_TOKEN_TTL_SECONDS,
	buildPushPayload,
	buildVapidAuthorization,
	encryptPushPayload,
	notifyPushSubscriptions,
	resolveVapidConfig,
} from "../workers/lib/webpush";
import type { Env } from "../workers/types";


/** The test config omits the VAPID vars; each push test supplies its own. */
const appEnv = env as unknown as Env;

/** Delivery settings that keep the inbound pipeline deterministic (no AI calls). */
const PIPELINE_SETTINGS = { categorization: { enabled: false }, items: { enabled: false } };

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


/** Register the mailbox record the API middleware and the pipeline check. */
async function registerMailbox(mailbox: string, settings: Record<string, unknown> = {}) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify(settings));
}


/** An Env with VAPID configured, the way the operator configures a deploy. */
function pushEnv(vapid: { publicKey: string; privateKey: string; subject: string }): Env {
	return {
		...env,
		VAPID_PUBLIC_KEY: vapid.publicKey,
		VAPID_PRIVATE_KEY: vapid.privateKey,
		VAPID_SUBJECT: vapid.subject,
	} as unknown as Env;
}


// ── Test key material ──────────────────────────────────────────────


interface TestVapid {
	publicKey: string;
	privateKey: string;
	subject: string;
	verifyKey: CryptoKey;
}


/** A VAPID signing keypair in the deployment's shapes: raw public, scalar private. */
async function generateVapid(): Promise<TestVapid> {
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
		verifyKey: keys.publicKey,
	};
}


interface TestSubscription {
	input: PushSubscriptionInput;
	keys: CryptoKeyPair;
	authSecret: Uint8Array;
	publicBytes: Uint8Array;
}


/** A subscription with a real P-256 keypair, as a browser would hand out. */
async function generateSubscription(endpoint: string): Promise<TestSubscription> {
	const keys = await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" },
		true,
		["deriveBits"],
	);
	const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
	const authSecret = crypto.getRandomValues(new Uint8Array(16));
	return {
		input: {
			endpoint,
			p256dh: bytesToBase64Url(publicBytes),
			auth: bytesToBase64Url(authSecret),
		},
		keys,
		authSecret,
		publicBytes,
	};
}


// ── Independent RFC 8291 decryptor (HMAC-based HKDF) ───────────────


function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.byteLength;
	}
	return joined;
}


async function hmac(keyBytes: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		"raw",
		keyBytes,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
}


/**
 * HKDF-Extract then the first Expand block, spelled out with plain HMAC:
 * PRK = HMAC(salt, ikm); output = HMAC(PRK, info || 0x01) truncated. One
 * block covers every length this app derives (16, 12, 32).
 */
async function hkdf(
	salt: Uint8Array,
	ikm: Uint8Array,
	info: Uint8Array,
	length: number,
): Promise<Uint8Array> {
	const prk = await hmac(salt, ikm);
	const block = await hmac(prk, concat(info, new Uint8Array([1])));
	return block.slice(0, length);
}


/** Parse an aes128gcm body and decrypt its single record with the subscription key. */
async function decryptPushBody(body: Uint8Array, subscription: TestSubscription) {
	const salt = body.slice(0, 16);
	const recordSize =
		((body[16] ?? 0) << 24) | ((body[17] ?? 0) << 16) | ((body[18] ?? 0) << 8) | (body[19] ?? 0);
	const keyIdLength = body[20] ?? 0;
	const keyId = body.slice(21, 21 + keyIdLength);
	const ciphertext = body.slice(21 + keyIdLength);

	const serverKey = await crypto.subtle.importKey(
		"raw",
		keyId,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const shared = new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: "ECDH", public: serverKey },
			subscription.keys.privateKey,
			256,
		),
	);
	const keyInfo = concat(
		new TextEncoder().encode("WebPush: info\0"),
		subscription.publicBytes,
		keyId,
	);
	const ikm = await hkdf(subscription.authSecret, shared, keyInfo, 32);
	const cek = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);

	const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
	const record = new Uint8Array(
		await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, ciphertext),
	);
	return { salt, recordSize, keyIdLength, record };
}


// ── Outbound fetch capture ─────────────────────────────────────────


interface CapturedCall {
	url: string;
	request: Request;
	/** Body bytes, read from a clone at capture time (binary payload). */
	body: ArrayBuffer;
}


/**
 * Swap the isolate's global fetch for a capture stub, so the exact request
 * the notifier builds can be inspected. Every outbound call is recorded; the
 * responder decides what the push service "answers".
 */
function captureFetch(
	respond: (request: Request) => Response | Promise<Response>,
): CapturedCall[] {
	const calls: CapturedCall[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init);
		const clone = request.clone();
		calls.push({ url: request.url, request, body: await clone.arrayBuffer() });
		return respond(request);
	}) as typeof fetch;
	return calls;
}


/** The captured calls that went to the push service. */
function pushCalls(calls: CapturedCall[]): CapturedCall[] {
	return calls.filter((call) => call.url.startsWith("https://push.example.com/"));
}


// ── VAPID ──────────────────────────────────────────────────────────


describe("VAPID", () => {
	it("signs an ES256 token the push service can verify with the public key", async () => {
		const vapid = await generateVapid();
		const endpoint = "https://push.example.com/vapid-check";
		const now = Date.parse("2026-09-26T12:00:00.000Z");

		const authorization = await buildVapidAuthorization(
			{ publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: vapid.subject },
			endpoint,
			now,
		);

		expect(authorization.startsWith("vapid t=")).toBe(true);
		const [token, key] = authorization.slice("vapid ".length).split(", ");
		expect(key).toBe(`k=${vapid.publicKey}`);

		const jwt = (token ?? "").slice(2);
		const [header, payload, signature] = jwt.split(".");
		const headerJson = JSON.parse(new TextDecoder().decode(base64UrlToBytes(header ?? ""))) as {
			typ: string;
			alg: string;
		};
		expect(headerJson).toEqual({ typ: "JWT", alg: "ES256" });

		const payloadJson = JSON.parse(
			new TextDecoder().decode(base64UrlToBytes(payload ?? "")),
		) as { aud: string; sub: string; exp: number };
		expect(payloadJson.aud).toBe("https://push.example.com");
		expect(payloadJson.sub).toBe(vapid.subject);
		expect(payloadJson.exp).toBe(Math.floor(now / 1000) + VAPID_TOKEN_TTL_SECONDS);

		const verified = await crypto.subtle.verify(
			{ name: "ECDSA", hash: "SHA-256" },
			vapid.verifyKey,
			base64UrlToBytes(signature ?? ""),
			new TextEncoder().encode(`${header}.${payload}`),
		);
		expect(verified).toBe(true);
	});

	it("is not configured until every VAPID setting is present", async () => {
		const vapid = await generateVapid();
		expect(resolveVapidConfig(appEnv)).toBeNull();
		expect(resolveVapidConfig(pushEnv({ ...vapid, privateKey: "" }))).toBeNull();
		expect(resolveVapidConfig(pushEnv({ ...vapid, subject: "" }))).toBeNull();
		expect(resolveVapidConfig(pushEnv(vapid))).toMatchObject({
			publicKey: vapid.publicKey,
			subject: vapid.subject,
		});
	});
});


// ── Payload encryption ─────────────────────────────────────────────


describe("payload encryption", () => {
	it("round-trips a notification through a test-generated subscription keypair", async () => {
		const subscription = await generateSubscription("https://push.example.com/round-trip");
		const payload = {
			title: "alice@example.org",
			body: "Hello",
			url: "/mailbox/round-trip%40example.com",
		};

		const body = await encryptPushPayload(
			new TextEncoder().encode(JSON.stringify(payload)),
			subscription.input,
		);
		const { recordSize, keyIdLength, record } = await decryptPushBody(body, subscription);

		expect(recordSize).toBe(4096);
		expect(keyIdLength).toBe(65);
		// The final-record delimiter (RFC 8188 §2) closes the single record.
		expect(record[record.length - 1]).toBe(2);
		const plaintext = new TextDecoder().decode(record.slice(0, -1));
		expect(JSON.parse(plaintext)).toEqual(payload);
	});

	it("carries only the sender, a bounded subject and the mailbox url", () => {
		const payload = buildPushPayload("inbox@example.com", {
			sender: "alice@example.org",
			subject: "x".repeat(PUSH_SUBJECT_MAX_LENGTH + 200),
		});

		expect(Object.keys(payload).sort()).toEqual(["body", "title", "url"]);
		expect(payload.title).toBe("alice@example.org");
		expect(payload.body).toHaveLength(PUSH_SUBJECT_MAX_LENGTH);
		expect(payload.url).toBe("/mailbox/inbox%40example.com");
	});
});


// ── Subscription validation ────────────────────────────────────────


describe("validatePushSubscription", () => {
	it("accepts the browser shape and rejects malformed bodies", () => {
		const good = {
			endpoint: "https://push.example.com/ok",
			keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
		};
		expect(validatePushSubscription(good)).toBeNull();

		expect(validatePushSubscription(null)).not.toBeNull();
		expect(validatePushSubscription({})).not.toBeNull();
		expect(
			validatePushSubscription({ endpoint: "http://push.example.com/ok", keys: good.keys }),
		).not.toBeNull();
		expect(validatePushSubscription({ endpoint: good.endpoint })).not.toBeNull();
		expect(
			validatePushSubscription({
				endpoint: good.endpoint,
				keys: { p256dh: "not base64url!", auth: "B".repeat(22) },
			}),
		).not.toBeNull();
		expect(
			validatePushSubscription({
				endpoint: `https://push.example.com/${"x".repeat(3000)}`,
				keys: good.keys,
			}),
		).not.toBeNull();
	});
});


// ── Routes ─────────────────────────────────────────────────────────


async function postJson(path: string, body: unknown) {
	return SELF.fetch(`http://example.com${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}


/** The body a browser posts: `PushSubscription.toJSON()`'s nested shape. */
function browserBody(input: PushSubscriptionInput) {
	return {
		endpoint: input.endpoint,
		keys: { p256dh: input.p256dh, auth: input.auth },
	};
}


describe("push routes", () => {
	it("stores a subscription and removes it again through the real routes", async () => {
		const mailbox = "push-routes@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const subscription = await generateSubscription("https://push.example.com/routes-1");

		const subscribed = await postJson(
			`/api/v1/mailboxes/${mailbox}/push/subscribe`,
			browserBody(subscription.input),
		);
		expect(subscribed.status).toBe(200);
		expect(await subscribed.json()).toEqual({
			ok: true,
			endpoint: subscription.input.endpoint,
		});

		const rows = await stubFor(mailbox).listPushSubscriptions();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ ...subscription.input, last_ok_at: null });

		const removed = await postJson(`/api/v1/mailboxes/${mailbox}/push/unsubscribe`, {
			endpoint: subscription.input.endpoint,
		});
		expect(removed.status).toBe(200);
		expect(await removed.json()).toEqual({ ok: true, removed: true });
		expect(await stubFor(mailbox).listPushSubscriptions()).toHaveLength(0);
	});

	it("answers 400 for a malformed subscription and stores nothing", async () => {
		const mailbox = "push-malformed@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const keys = { p256dh: "A".repeat(87), auth: "B".repeat(22) };

		const malformed = [
			{},
			{ endpoint: "http://push.example.com/insecure", keys },
			{ endpoint: "https://push.example.com/no-keys" },
			{ endpoint: "https://push.example.com/bad-key", keys: { ...keys, auth: "not base64url!" } },
			{ endpoint: `https://push.example.com/${"x".repeat(3000)}`, keys },
		];
		for (const body of malformed) {
			const response = await postJson(
				`/api/v1/mailboxes/${mailbox}/push/subscribe`,
				body,
			);
			expect(response.status).toBe(400);
		}

		const badUnsubscribe = await postJson(
			`/api/v1/mailboxes/${mailbox}/push/unsubscribe`,
			{ endpoint: "http://push.example.com/insecure" },
		);
		expect(badUnsubscribe.status).toBe(400);
		expect(await stubFor(mailbox).listPushSubscriptions()).toHaveLength(0);
	});

	it("keeps only the newest subscriptions, capped at the mailbox limit", async () => {
		const mailbox = "push-cap@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);

		for (let i = 1; i <= MAX_PUSH_SUBSCRIPTIONS + 1; i++) {
			const subscription = await generateSubscription(`https://push.example.com/cap-${i}`);
			const response = await postJson(
				`/api/v1/mailboxes/${mailbox}/push/subscribe`,
				browserBody(subscription.input),
			);
			expect(response.status).toBe(200);
		}

		const rows = await stubFor(mailbox).listPushSubscriptions();
		const endpoints = rows.map((row) => row.endpoint);
		expect(rows).toHaveLength(MAX_PUSH_SUBSCRIPTIONS);
		expect(endpoints).not.toContain("https://push.example.com/cap-1");
		expect(endpoints).toContain(`https://push.example.com/cap-${MAX_PUSH_SUBSCRIPTIONS + 1}`);
		expect(endpoints[0]).toBe(`https://push.example.com/cap-${MAX_PUSH_SUBSCRIPTIONS + 1}`);
	});

	it("refreshes an existing endpoint instead of adding a row", async () => {
		const mailbox = "push-upsert@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const subscription = await generateSubscription("https://push.example.com/upsert");

		await postJson(`/api/v1/mailboxes/${mailbox}/push/subscribe`, browserBody(subscription.input));
		const [first] = await stubFor(mailbox).listPushSubscriptions();

		await postJson(`/api/v1/mailboxes/${mailbox}/push/subscribe`, {
			...browserBody(subscription.input),
			keys: { p256dh: "C".repeat(87), auth: subscription.input.auth },
		});
		const rows = await stubFor(mailbox).listPushSubscriptions();

		expect(rows).toHaveLength(1);
		expect(rows[0]?.p256dh).toBe("C".repeat(87));
		expect(rows[0]?.created_at).toBe(first?.created_at);

		// Removing an endpoint that was never stored is idempotent, not an error.
		expect(await stubFor(mailbox).deletePushSubscription("https://push.example.com/other")).toBe(false);
	});
});


describe("push config route", () => {
	it("answers not-configured when the deployment has no VAPID key", async () => {
		const response = await SELF.fetch("http://example.com/api/v1/push/config");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ enabled: false, publicKey: null });
	});

	it("answers the public key once VAPID is configured", async () => {
		const vapid = await generateVapid();
		const response = await app.request("/api/v1/push/config", {}, pushEnv(vapid));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ enabled: true, publicKey: vapid.publicKey });
	});
});


// ── Inbound delivery ───────────────────────────────────────────────


/** Deliver one MIME message through the real inbound path. */
async function deliver(mailbox: string, deliveryEnv: Env, subject: string) {
	const mime = [
		"From: Alice <alice@example.org>",
		`To: ${mailbox}`,
		`Subject: ${subject}`,
		`Message-ID: <${crypto.randomUUID()}@example.org>`,
		"Content-Type: text/html; charset=utf-8",
		"",
		"<p>Hello push</p>",
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


async function inboxIds(mailbox: string): Promise<string[]> {
	const rows = (await stubFor(mailbox).getEmails({ folder: Folders.INBOX })) as {
		id: string;
	}[];
	return rows.map((row) => row.id);
}


describe("inbound delivery", () => {
	it("pushes once per non-spam arrival, carrying only the sender and subject", async () => {
		const mailbox = "push-inbound@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const subscription = await generateSubscription("https://push.example.com/inbound");
		await stubFor(mailbox).upsertPushSubscription(subscription.input);
		const vapid = await generateVapid();
		const calls = captureFetch(() => new Response(null, { status: 201 }));

		await deliver(mailbox, pushEnv(vapid), "Hello push");

		const push = pushCalls(calls);
		expect(push).toHaveLength(1);
		expect(push[0]?.request.method).toBe("POST");
		expect(push[0]?.request.headers.get("content-encoding")).toBe("aes128gcm");
		expect(push[0]?.request.headers.get("ttl")).toBe("86400");
		expect(push[0]?.request.headers.get("authorization")).toContain("vapid t=");

		// The notification decrypts with the subscription's own key and holds
		// the sender, the subject and the mailbox url — nothing else.
		const { record } = await decryptPushBody(new Uint8Array(push[0]?.body ?? new ArrayBuffer(0)), subscription);
		const payload = JSON.parse(new TextDecoder().decode(record.slice(0, -1)));
		expect(payload).toEqual({
			title: "alice@example.org",
			body: "Hello push",
			url: `/mailbox/${encodeURIComponent(mailbox)}`,
		});

		expect(await inboxIds(mailbox)).toHaveLength(1);
		const rows = await stubFor(mailbox).listPushSubscriptions();
		expect(rows[0]?.last_ok_at).not.toBeNull();
	});

	it("skips the push for spam-marked arrivals (spam stays notification-free)", async () => {
		const mailbox = "push-spam@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const subscription = await generateSubscription("https://push.example.com/spam");
		await stubFor(mailbox).upsertPushSubscription(subscription.input);
		await stubFor(mailbox).createRule({
			name: "Spam filter",
			match: { mode: "all", conditions: { from_contains: "alice@example.org" } },
			actions: { set_category: SPAM_CATEGORY_ID },
		});
		const vapid = await generateVapid();
		const calls = captureFetch(() => new Response(null, { status: 201 }));

		await deliver(mailbox, pushEnv(vapid), "Spam arrival");

		expect(pushCalls(calls)).toHaveLength(0);
		// The message itself is still delivered; only the push is skipped.
		expect(await inboxIds(mailbox)).toHaveLength(1);
		expect(await stubFor(mailbox).listPushSubscriptions()).toHaveLength(1);
	});

	it("still delivers mail when the push service is unreachable", async () => {
		const mailbox = "push-unreachable@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const subscription = await generateSubscription("https://push.example.com/unreachable");
		await stubFor(mailbox).upsertPushSubscription(subscription.input);
		const vapid = await generateVapid();
		const calls = captureFetch(() => {
			throw new Error("connection refused");
		});

		await deliver(mailbox, pushEnv(vapid), "Unreachable push");

		expect(pushCalls(calls)).toHaveLength(1);
		expect(await inboxIds(mailbox)).toHaveLength(1);
		// A failure that is not 404/410 leaves the subscription alone.
		const rows = await stubFor(mailbox).listPushSubscriptions();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.last_ok_at).toBeNull();
	});

	it("never throws when the injected fetch rejects", async () => {
		const mailbox = "push-reject@example.com";
		const subscription = await generateSubscription("https://push.example.com/reject");
		await stubFor(mailbox).upsertPushSubscription(subscription.input);
		const vapid = await generateVapid();
		const rejecting = (async () => {
			throw new Error("push service down");
		}) as typeof fetch;

		const result = await notifyPushSubscriptions(
			pushEnv(vapid),
			mailbox,
			{ sender: "alice@example.org", subject: "Hello" },
			rejecting,
		);

		expect(result).toMatchObject({
			attempted: 1,
			delivered: 0,
			pruned: 0,
			failed: 1,
			skipped: false,
		});
		expect(await stubFor(mailbox).listPushSubscriptions()).toHaveLength(1);
	});

	it("prunes a subscription the push service reports gone", async () => {
		const mailbox = "push-gone@example.com";
		const subscription = await generateSubscription("https://push.example.com/gone");
		await stubFor(mailbox).upsertPushSubscription(subscription.input);
		const vapid = await generateVapid();
		const gone = (async () => new Response(null, { status: 410 })) as typeof fetch;

		const result = await notifyPushSubscriptions(
			pushEnv(vapid),
			mailbox,
			{ sender: "alice@example.org", subject: "Hello" },
			gone,
		);

		expect(result).toMatchObject({ attempted: 1, delivered: 0, pruned: 1, failed: 0 });
		expect(await stubFor(mailbox).listPushSubscriptions()).toHaveLength(0);
	});

	it("does nothing when VAPID is not configured", async () => {
		const mailbox = "push-unconfigured@example.com";
		const subscription = await generateSubscription("https://push.example.com/unconfigured");
		await stubFor(mailbox).upsertPushSubscription(subscription.input);
		const attempted: string[] = [];
		const spy = (async (input: RequestInfo | URL) => {
			attempted.push(String(input));
			return new Response(null, { status: 201 });
		}) as typeof fetch;

		const result = await notifyPushSubscriptions(
			appEnv,
			mailbox,
			{ sender: "alice@example.org", subject: "Hello" },
			spy,
		);

		expect(result.skipped).toBe(true);
		expect(result.attempted).toBe(0);
		expect(attempted).toHaveLength(0);
	});
});
