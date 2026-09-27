// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Web push subscription shape shared by the Worker, the settings UI and the
 * push transport (workers/lib/webpush.ts).
 *
 * A browser subscription is the endpoint its push service handed out plus
 * the two keys the payload is encrypted to: `p256dh`, an uncompressed P-256
 * public point, and `auth`, the subscription's 16-byte secret. The Worker
 * stores one row per endpoint per mailbox (migration 30_add_push_subscriptions)
 * and reads them back when new mail arrives.
 *
 * The validators follow shared/webhook.ts: they take any submitted value and
 * answer a human-readable reason or null, so a route can turn one straight
 * into a 400. Nothing here sends mail — a subscription is notification
 * bookkeeping only.
 */


/** Subscriptions kept per mailbox; the oldest are pruned on every insert. */
export const MAX_PUSH_SUBSCRIPTIONS = 10;

/** Longest accepted endpoint URL; keeps oversized garbage out of the table. */
export const MAX_PUSH_ENDPOINT_LENGTH = 2048;

/**
 * Longest accepted key string. A 65-byte P-256 point is 87 base64url
 * characters and a 16-byte auth secret 22, so this only bounds what can be
 * stored — the push transport re-checks the decoded lengths before use.
 */
export const MAX_PUSH_KEY_LENGTH = 256;

/** Base64url without padding — what the Push API emits for both keys. */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;


/** One browser push subscription, as submitted by the client and stored. */
export interface PushSubscriptionInput {
	/** Push-service URL the notification is POSTed to. */
	endpoint: string;
	/** Base64url uncompressed P-256 public key (65 bytes) the payload is encrypted to. */
	p256dh: string;
	/** Base64url 16-byte subscription secret mixed into the key derivation. */
	auth: string;
}


/** One stored row: the subscription plus its bookkeeping timestamps. */
export interface PushSubscriptionRecord extends PushSubscriptionInput {
	/** When the endpoint was first stored (ISO 8601). */
	created_at: string;
	/** When a push to this endpoint last succeeded; null until one does. */
	last_ok_at: string | null;
}


/**
 * What GET /api/v1/push/config answers: whether this deployment can push at
 * all, and the VAPID public key the browser subscribes with. `enabled` is
 * false — and the key null — when the operator has not set the VAPID vars.
 */
export interface PushConfig {
	enabled: boolean;
	publicKey: string | null;
}


/** Trimmed non-empty string, or undefined for anything else. */
function readTrimmedString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}


/**
 * The trimmed endpoint of a subscription body (`{ endpoint }`), or null when
 * it is not an https URL of bounded length. The unsubscribe route only needs
 * the endpoint to delete the row, so it validates that much on its own.
 */
export function normalizePushEndpoint(value: unknown): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const endpoint = readTrimmedString((value as Record<string, unknown>)["endpoint"]);
	if (!endpoint || endpoint.length > MAX_PUSH_ENDPOINT_LENGTH) return null;
	try {
		return new URL(endpoint).protocol === "https:" ? endpoint : null;
	} catch {
		return null;
	}
}


/**
 * Human-readable reason a submitted value cannot be stored as a push
 * subscription, or null when it is acceptable. The body is the browser's
 * `PushSubscription.toJSON()` shape: `{ endpoint, keys: { p256dh, auth } }`.
 */
export function validatePushSubscription(value: unknown): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return "Subscription must be a JSON object";
	}
	const body = value as Record<string, unknown>;

	const endpoint = readTrimmedString(body["endpoint"]);
	if (!endpoint) return "Subscription endpoint is required";
	if (endpoint.length > MAX_PUSH_ENDPOINT_LENGTH) {
		return `Subscription endpoint must be at most ${MAX_PUSH_ENDPOINT_LENGTH} characters`;
	}
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return "Subscription endpoint must be a valid absolute URL";
	}
	if (url.protocol !== "https:") {
		return "Subscription endpoint must use https:// — notifications are never posted over plain http";
	}

	const keys = body["keys"];
	if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
		return "Subscription keys are required";
	}
	const keyObject = keys as Record<string, unknown>;
	const p256dh = readTrimmedString(keyObject["p256dh"]);
	const auth = readTrimmedString(keyObject["auth"]);
	if (!p256dh || !auth) return "Subscription keys must include p256dh and auth";

	for (const [name, key] of [["p256dh", p256dh], ["auth", auth]] as const) {
		if (key.length > MAX_PUSH_KEY_LENGTH) {
			return `Subscription ${name} key must be at most ${MAX_PUSH_KEY_LENGTH} characters`;
		}
		if (!BASE64URL_RE.test(key)) {
			return `Subscription ${name} key must be base64url without padding`;
		}
	}
	return null;
}


/** The validated, trimmed subscription in a submitted body, or null. */
export function normalizePushSubscription(value: unknown): PushSubscriptionInput | null {
	if (validatePushSubscription(value) !== null) return null;
	const body = value as Record<string, unknown>;
	const keys = body["keys"] as Record<string, unknown>;
	const endpoint = readTrimmedString(body["endpoint"]);
	const p256dh = readTrimmedString(keys["p256dh"]);
	const auth = readTrimmedString(keys["auth"]);
	// Unreachable once validation passed; repeated so no assertion is needed.
	if (!endpoint || !p256dh || !auth) return null;
	return { endpoint, p256dh, auth };
}


/** Decode base64url (padding optional) into bytes. Throws on invalid input. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}


/** Encode bytes as base64url without padding. */
export function bytesToBase64Url(bytes: Uint8Array<ArrayBuffer>): string {
	const binary = [...bytes].map((byte) => String.fromCharCode(byte)).join("");
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
