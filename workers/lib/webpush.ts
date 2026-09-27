// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Web push notifications for new mail: RFC 8030 delivery, RFC 8291 payload
 * encryption and RFC 8292 VAPID — WebCrypto only, no dependency.
 *
 * One message per non-spam arrival goes to every subscription the mailbox has
 * stored, newest first and at most MAX_PUSH_SUBSCRIPTIONS of them. The
 * payload is `{ title, body, url }` and deliberately carries no message
 * content beyond the envelope: the title is the sender address, the body is
 * the subject clamped to PUSH_SUBJECT_MAX_LENGTH characters, and the url
 * opens the mailbox. A notification never carries a message body.
 *
 * Delivery is best-effort by design, mirroring the webhook notifier:
 *   - Notification only. Nothing here sends, replies or forwards mail; the
 *     only outbound request is the push POST to the browser's push service.
 *   - Failures never affect mail delivery: every error is logged and
 *     reported, and `notifyPushSubscriptions` never rejects, so callers can
 *     hand it straight to `ctx.waitUntil`.
 *   - A 404 or 410 answer means the subscription is gone (RFC 8030 §7.3) and
 *     its row is pruned; every other failure is logged and the row is left
 *     alone. The fan-out is bounded by the mailbox's own cap, so no arrival
 *     can ever loop over an unbounded number of rows.
 *   - Non-spam arrivals only — the call site in workers/index.ts skips spam,
 *     matching the auto-draft and webhook rules.
 *   - A muted thread is skipped: when the payload carries a threadId and its
 *     mailbox has muted it (MailboxDO.isThreadMuted), nothing is sent and one
 *     line is logged. That check fails OPEN — a lookup failure is logged and
 *     the push goes out anyway, because a notification is not a guardrail and
 *     a broken mute table must never silence mail.
 *   - The push-service fetch is injectable (`fetchImpl`), so tests can assert
 *     the exact request without a network, the same contract guardedFetch
 *     uses. Requests go through the SSRF guard: https only, no redirects,
 *     response body never read.
 */


import {
	MAX_PUSH_SUBSCRIPTIONS,
	base64UrlToBytes,
	bytesToBase64Url,
	type PushSubscriptionInput,
} from "../../shared/push";
import type { Env } from "../types";
import { getMailboxStub } from "./email-helpers";
import { guardedFetch } from "./ssrf-guard";


/** Longest subject carried in the notification body. */
export const PUSH_SUBJECT_MAX_LENGTH = 120;

/** How long the push service holds the notification for an offline device. */
export const PUSH_TTL_SECONDS = 24 * 60 * 60;

/** Hard cap on the subscriptions one arrival is fanned out to; mirrors the per-mailbox cap. */
export const MAX_PUSH_FANOUT = MAX_PUSH_SUBSCRIPTIONS;

/** Longest a VAPID token stays valid (RFC 8292 allows at most 24 hours). */
export const VAPID_TOKEN_TTL_SECONDS = 12 * 60 * 60;

/** Record size of the aes128gcm body; one notification is always one record. */
const PUSH_RECORD_SIZE = 4096;

/** RFC 8291 derivation labels; each is terminated by a NUL byte. */
const PUSH_KEY_INFO = "WebPush: info\0";
const PUSH_CEK_INFO = "Content-Encoding: aes128gcm\0";
const PUSH_NONCE_INFO = "Content-Encoding: nonce\0";

/** Length of the uncompressed P-256 point a subscription's p256dh carries. */
const P256_PUBLIC_KEY_BYTES = 65;

/** Length of the auth secret a subscription carries. */
const PUSH_AUTH_SECRET_BYTES = 16;


/** The VAPID settings push is signed with. */
export interface VapidConfig {
	/** Base64url 65-byte uncompressed P-256 public key (the VAPID_PUBLIC_KEY var). */
	publicKey: string;
	/** Base64url 32-byte private scalar; a wrangler secret, never in any file. */
	privateKey: string;
	/** `mailto:` or https: contact the push service can use. */
	subject: string;
}


/**
 * Read a VAPID setting through a guarded lookup: the value may be absent
 * (older deploys and the test config omit these vars) and only a non-empty
 * string counts. An absent setting answers "" so callers treat it as
 * not-configured rather than failing.
 */
function vapidSetting(env: Env, name: string): string {
	const value = (env as unknown as Record<string, unknown>)[name];
	return typeof value === "string" ? value.trim() : "";
}


/**
 * The deployment's VAPID configuration, or null when it is incomplete.
 *
 * VAPID_PUBLIC_KEY and VAPID_SUBJECT are plain vars (wrangler.jsonc);
 * VAPID_PRIVATE_KEY is a wrangler secret and never appears in any file in
 * this repo. Push is answered "not configured" until all three are set:
 * without the public key a browser cannot subscribe, without the private key
 * nothing could be signed, and without a subject every push service would
 * reject the token.
 */
export function resolveVapidConfig(env: Env): VapidConfig | null {
	const publicKey = vapidSetting(env, "VAPID_PUBLIC_KEY");
	const privateKey = vapidSetting(env, "VAPID_PRIVATE_KEY");
	const subject = vapidSetting(env, "VAPID_SUBJECT");
	if (!publicKey || !privateKey || !subject) return null;
	return { publicKey, privateKey, subject };
}


/** The JSON a push notification carries. Never message content beyond the subject. */
export interface PushNotificationPayload {
	/** Sender address, shown as the notification title. */
	title: string;
	/** Subject, clamped to PUSH_SUBJECT_MAX_LENGTH characters. */
	body: string;
	/** App-relative URL the click opens: the mailbox this mail landed in. */
	url: string;
}


/** Build the notification for one arrival. */
export function buildPushPayload(
	mailboxId: string,
	email: { sender: string; subject: string },
): PushNotificationPayload {
	return {
		title: email.sender,
		body: email.subject.slice(0, PUSH_SUBJECT_MAX_LENGTH),
		url: `/mailbox/${encodeURIComponent(mailboxId)}`,
	};
}


/**
 * One HKDF-SHA-256 Extract + Expand step (WebCrypto has no expand-only call,
 * and both RFC 8291 derivations here extract first, so the single-step form
 * is exactly what is needed).
 */
async function hkdf(
	salt: Uint8Array<ArrayBuffer>,
	ikm: Uint8Array<ArrayBuffer>,
	info: Uint8Array<ArrayBuffer>,
	length: number,
): Promise<Uint8Array<ArrayBuffer>> {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt, info },
		key,
		length * 8,
	);
	return new Uint8Array(bits);
}


/** Concatenate byte strings in order. */
function concatBytes(...parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.byteLength;
	}
	return joined;
}


/**
 * Encrypt one push payload for a subscription (RFC 8291, `aes128gcm`).
 *
 * Returns the complete request body: the RFC 8188 header (salt, record size,
 * key id = the ephemeral public key) followed by the single AEAD record. The
 * ephemeral P-256 keypair is generated per call, so two pushes to the same
 * subscription never share a key. Throws on a key that is not a usable
 * P-256 point / 16-byte secret — the caller logs and skips that row.
 */
export async function encryptPushPayload(
	payload: Uint8Array<ArrayBuffer>,
	subscription: Pick<PushSubscriptionInput, "p256dh" | "auth">,
): Promise<Uint8Array<ArrayBuffer>> {
	const clientPublicBytes = base64UrlToBytes(subscription.p256dh);
	const authSecret = base64UrlToBytes(subscription.auth);
	if (clientPublicBytes.byteLength !== P256_PUBLIC_KEY_BYTES) {
		throw new Error("p256dh must be a 65-byte uncompressed P-256 point");
	}
	if (authSecret.byteLength !== PUSH_AUTH_SECRET_BYTES) {
		throw new Error("auth must be a 16-byte secret");
	}

	const clientKey = await crypto.subtle.importKey(
		"raw",
		clientPublicBytes,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const serverKeys = await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" },
		true,
		["deriveBits"],
	);
	const serverPublicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey));
	const sharedSecret = new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: "ECDH", public: clientKey },
			serverKeys.privateKey,
			256,
		),
	);

	// RFC 8291 §3.4: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" ||
	// 0x00 || ua_public || as_public), then the CEK and nonce are derived from
	// that IKM under the per-message salt.
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const keyInfo = concatBytes(
		new TextEncoder().encode(PUSH_KEY_INFO),
		clientPublicBytes,
		serverPublicBytes,
	);
	const ikm = await hkdf(authSecret, sharedSecret, keyInfo, 32);
	const cek = await hkdf(salt, ikm, new TextEncoder().encode(PUSH_CEK_INFO), 16);
	const nonce = await hkdf(salt, ikm, new TextEncoder().encode(PUSH_NONCE_INFO), 12);

	// The single record: the payload, then the 0x02 delimiter of the last
	// record (RFC 8188 §2). One notification never approaches the 4096-byte
	// record size.
	const record = concatBytes(payload, new Uint8Array([2]));
	if (record.byteLength > PUSH_RECORD_SIZE) {
		throw new Error("push payload is too large for one record");
	}

	const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, record),
	);

	const header = concatBytes(
		salt,
		new Uint8Array([
			(PUSH_RECORD_SIZE >>> 24) & 0xff,
			(PUSH_RECORD_SIZE >>> 16) & 0xff,
			(PUSH_RECORD_SIZE >>> 8) & 0xff,
			PUSH_RECORD_SIZE & 0xff,
		]),
		new Uint8Array([serverPublicBytes.byteLength]),
		serverPublicBytes,
	);
	return concatBytes(header, ciphertext);
}


/**
 * The `Authorization` header for one push request: a VAPID token (RFC 8292)
 * — an ES256 JWT signed with the private key, carrying the endpoint's origin
 * as `aud`, the configured subject as `sub` and a bounded expiry — plus the
 * public key the push service verifies it with.
 */
export async function buildVapidAuthorization(
	config: VapidConfig,
	endpoint: string,
	now: number = Date.now(),
): Promise<string> {
	const audience = new URL(endpoint).origin;
	const publicKeyBytes = base64UrlToBytes(config.publicKey);
	const privateKeyBytes = base64UrlToBytes(config.privateKey);
	if (publicKeyBytes.byteLength !== P256_PUBLIC_KEY_BYTES) {
		throw new Error("VAPID public key must be a 65-byte uncompressed P-256 point");
	}
	if (privateKeyBytes.byteLength !== 32) {
		throw new Error("VAPID private key must be a 32-byte P-256 scalar");
	}

	const signingKey = await crypto.subtle.importKey(
		"jwk",
		{
			kty: "EC",
			crv: "P-256",
			x: bytesToBase64Url(publicKeyBytes.slice(1, 33)),
			y: bytesToBase64Url(publicKeyBytes.slice(33, 65)),
			d: bytesToBase64Url(privateKeyBytes),
			key_ops: ["sign"],
			ext: true,
		},
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);

	const encoder = new TextEncoder();
	const header = bytesToBase64Url(
		encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })),
	);
	const payload = bytesToBase64Url(
		encoder.encode(
			JSON.stringify({
				aud: audience,
				exp: Math.floor(now / 1000) + VAPID_TOKEN_TTL_SECONDS,
				sub: config.subject,
			}),
		),
	);
	const signingInput = `${header}.${payload}`;
	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		signingKey,
		encoder.encode(signingInput),
	);
	const jwt = `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
	return `vapid t=${jwt}, k=${config.publicKey}`;
}


/** One push request's outcome. */
export interface PushDeliveryResult {
	/** True when the push service answered 2xx (202 is the normal answer). */
	ok: boolean;
	/** Upstream HTTP status, or null when the request never got a response. */
	status: number | null;
	/** Human-readable failure reason, or null on success. */
	error: string | null;
	/** True when the push service said the subscription is gone (404/410). */
	gone: boolean;
}


/**
 * POST one notification to one subscription.
 *
 * The request is built exactly as RFC 8030/8291 require: an `aes128gcm` body,
 * `Content-Encoding: aes128gcm`, a TTL, and a VAPID `Authorization` header.
 * The fetch goes through the SSRF guard's `guardedFetch` (https only, no
 * redirects, response body never read), with `fetchImpl` injectable so tests
 * can assert the request without a network. Never throws: every failure comes
 * back as a result for the caller to log, prune or ignore.
 */
export async function sendWebPush(
	subscription: PushSubscriptionInput,
	payload: PushNotificationPayload,
	config: VapidConfig,
	fetchImpl: typeof fetch = fetch,
): Promise<PushDeliveryResult> {
	try {
		const body = await encryptPushPayload(
			new TextEncoder().encode(JSON.stringify(payload)),
			subscription,
		);
		const authorization = await buildVapidAuthorization(config, subscription.endpoint);
		const result = await guardedFetch(
			subscription.endpoint,
			{
				method: "POST",
				headers: {
					Authorization: authorization,
					"Content-Encoding": "aes128gcm",
					"Content-Type": "application/octet-stream",
					TTL: String(PUSH_TTL_SECONDS),
					Urgency: "normal",
				},
				body,
			},
			fetchImpl,
		);
		if (result.ok) return { ok: true, status: result.status, error: null, gone: false };
		return {
			ok: false,
			status: result.status,
			error: result.error,
			gone: result.status === 404 || result.status === 410,
		};
	} catch (e) {
		return {
			ok: false,
			status: null,
			error: (e as Error).message || "push request failed",
			gone: false,
		};
	}
}


/** One arrival's fan-out outcome; logged by the caller and ignored by mail delivery. */
export interface PushNotifyResult {
	/** How many subscriptions were attempted (0 when push is not configured). */
	attempted: number;
	delivered: number;
	pruned: number;
	failed: number;
	/** True when VAPID is not configured, so nothing was attempted. */
	skipped: boolean;
}


/**
 * Push one new-mail notification to every subscription of a mailbox.
 *
 * Never throws and never rejects: a push failure can never affect mail
 * delivery. The fan-out is bounded twice over — the mailbox prunes its stored
 * rows to MAX_PUSH_SUBSCRIPTIONS and the list is read newest-first, so at
 * most MAX_PUSH_FANOUT requests are ever made for one arrival. A 404/410
 * answer prunes the dead endpoint instead of retrying it forever; a success
 * records `last_ok_at`. `fetchImpl` is injectable for tests. A payload that
 * names a muted thread is skipped outright, in one log line; that check fails
 * open, so an unreadable mute table can never silence a notification.
 */
export async function notifyPushSubscriptions(
	env: Env,
	mailboxId: string,
	email: { sender: string; subject: string; threadId?: string | undefined },
	fetchImpl: typeof fetch = fetch,
): Promise<PushNotifyResult> {
	const skipped: PushNotifyResult = {
		attempted: 0,
		delivered: 0,
		pruned: 0,
		failed: 0,
		skipped: true,
	};
	try {
		const config = resolveVapidConfig(env);
		if (!config) return skipped;

		// A muted thread never raises a notification. The check fails open: a
		// lookup failure is logged and the fan-out continues, because a
		// notification is not a guardrail and an unreadable mute table must
		// never silence mail.
		if (email.threadId) {
			try {
				const muted = await getMailboxStub(env, mailboxId).isThreadMuted(email.threadId);
				if (muted) {
					console.log(`Push skipped for ${mailboxId}: thread muted`);
					return skipped;
				}
			} catch (e) {
				console.error(
					`Push thread-mute check failed for ${mailboxId}; sending anyway:`,
					(e as Error).message,
				);
			}
		}

		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
		const subscriptions = await stub.listPushSubscriptions();
		const payload = buildPushPayload(mailboxId, email);
		const batch = subscriptions.slice(0, MAX_PUSH_FANOUT);

		let delivered = 0;
		let pruned = 0;
		let failed = 0;
		for (const subscription of batch) {
			const result = await sendWebPush(subscription, payload, config, fetchImpl);
			if (result.ok) {
				delivered += 1;
				await stub.markPushSubscriptionOk(subscription.endpoint).catch((e: unknown) => {
					console.error("Recording push delivery failed:", (e as Error).message);
				});
				continue;
			}
			if (result.gone) {
				pruned += 1;
				console.log(
					`Push subscription pruned for ${mailboxId}: ${result.status} from the push service`,
				);
				await stub.deletePushSubscription(subscription.endpoint).catch((e: unknown) => {
					console.error("Pruning push subscription failed:", (e as Error).message);
				});
				continue;
			}
			failed += 1;
			console.error(
				`Push for ${mailboxId} failed: ${result.error ?? "unknown error"}`,
			);
		}
		console.log(
			`Push fan-out for ${mailboxId}: ${subscriptions.length} subscription(s), delivered ${delivered}, pruned ${pruned}, failed ${failed}`,
		);
		return { attempted: batch.length, delivered, pruned, failed, skipped: false };
	} catch (e) {
		console.error("Web push notification failed:", (e as Error).message);
		return skipped;
	}
}
