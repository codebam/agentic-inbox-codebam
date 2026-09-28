// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Access-token crypto helpers (worker bundle only). The shared wire format
 * lives in shared/access-tokens.ts; this module owns the random secret and
 * the hash the Durable Object stores.
 *
 * A token is a bearer credential: possession is authorization, so the
 * plaintext is generated here, shown once by the create route, and never
 * stored — MailboxDO keeps only the SHA-256 hex of the full token string,
 * which is what verifyAccessToken looks up by.
 */

/** A secret is 32 random bytes; base64url without padding is 43 characters. */
const ACCESS_TOKEN_SECRET_BYTES = 32;

/** Encode bytes as base64url without padding (the URL-safe alphabet, no "="). */
function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mint a fresh token secret: ACCESS_TOKEN_SECRET_BYTES bytes from
 * crypto.getRandomValues, base64url without padding (43 characters). The
 * bytes never leave the worker; only the assembled token is handed to
 * formatAccessToken and then shown to its owner once.
 */
export function generateAccessTokenSecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(ACCESS_TOKEN_SECRET_BYTES));
	return bytesToBase64Url(bytes);
}

/**
 * SHA-256 of the FULL token string (prefix, mailbox id and secret),
 * lowercase hex — the value stored in `access_tokens.token_hash` and the
 * lookup key for verifyAccessToken. Hashing the whole string means the
 * stored digest covers the wire format too, so an edited prefix or mailbox
 * segment can never resolve.
 */
export async function hashAccessToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
