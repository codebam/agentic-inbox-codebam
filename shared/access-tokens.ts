// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Access-token helpers shared by the Worker API and the UI.
 *
 * An access token is a BEARER CREDENTIAL: whoever holds the string can act
 * on the mailbox with every scope it carries, so it is handled like a
 * password — shown once when it is created, stored only as a hash (the
 * worker bundle's workers/lib/access-tokens.ts), and never rendered back by
 * a read.
 *
 * Wire format (formatAccessToken / parseAccessToken):
 *
 *     ain1_6d61696c406578616d706c652e636f6d_<43-char base64url secret>
 *     └┬─┘ └──────────────┬─────────────────┘ └─────────┬────────────┘
 *      │                  │                             │
 *   prefix: three      the mailbox id's UTF-8       32 random bytes,
 *   letters (a, i, n)  bytes as lowercase hex,      base64url without
 *   then the digit 1   e.g. mail@example.com        padding = 43 chars
 *
 * The mailbox id is hex because the base64url secret alphabet itself
 * contains the underscore that separates the segments — hex keeps every
 * separator unambiguous, so do not switch encodings.
 */

/** The token prefix: three letters (a, i, n) then the digit one. */
export const ACCESS_TOKEN_PREFIX = "ain1";

/** The scopes a token may carry, in canonical order. */
export const ACCESS_TOKEN_SCOPES = ["read", "draft", "send"] as const;

/** One of the three scope strings a token may carry. */
export type AccessTokenScope = (typeof ACCESS_TOKEN_SCOPES)[number];

/** Most access tokens one mailbox can hold; createAccessToken refuses beyond it. */
export const MAX_ACCESS_TOKENS = 20;

/** Longest access-token name stored (and accepted), after trimming. */
export const MAX_ACCESS_TOKEN_NAME_LENGTH = 120;

/**
 * The metadata of one stored access token. A token is a bearer credential,
 * so this is all a read ever exposes: the plaintext secret and its stored
 * hash are deliberately absent.
 */
export interface AccessTokenRecord {
	id: string;
	/** Trimmed, 1..MAX_ACCESS_TOKEN_NAME_LENGTH characters. */
	name: string;
	/** Canonical (read, draft, send) scope list; never empty. */
	scopes: AccessTokenScope[];
	created_at: string;
	/** ISO instant the token was last verified, or null when never used. */
	last_used_at: string | null;
}

/** True when `value` is one of the three scope strings a token may carry. */
export function isAccessTokenScope(value: unknown): value is AccessTokenScope {
	return (
		typeof value === "string" &&
		(ACCESS_TOKEN_SCOPES as readonly string[]).includes(value)
	);
}

/**
 * Canonicalize a scope list from request input: deduplicated, ordered
 * (read, draft, send), and non-empty. Returns null when `value` is not an
 * array, is empty, or carries anything outside the three scope strings, so
 * an unusable request is refused rather than quietly narrowed.
 */
export function normalizeAccessTokenScopes(
	value: unknown,
): AccessTokenScope[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const scopes: unknown[] = value;
	if (!scopes.every(isAccessTokenScope)) return null;
	return ACCESS_TOKEN_SCOPES.filter((scope) => scopes.includes(scope));
}

/** The mailbox-id segment: a string's UTF-8 bytes as lowercase hex. */
function utf8ToHex(value: string): string {
	let hex = "";
	for (const byte of new TextEncoder().encode(value)) {
		hex += byte.toString(16).padStart(2, "0");
	}
	return hex;
}

/**
 * The inverse of utf8ToHex. Returns null when the bytes are not valid
 * UTF-8 — a segment that would decode to replacement characters is not a
 * mailbox id anyone minted.
 */
function hexToUtf8(value: string): string | null {
	const bytes = new Uint8Array(value.length / 2);
	for (let index = 0; index < bytes.length; index++) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

/**
 * The whole wire shape in one regex: the prefix, an underscore, an even
 * number of lowercase hex digits (the mailbox id's UTF-8 bytes), an
 * underscore, then exactly 43 base64url characters (32 bytes, no padding).
 */
const ACCESS_TOKEN_PATTERN = new RegExp(
	`^${ACCESS_TOKEN_PREFIX}_((?:[0-9a-f]{2})+)_([A-Za-z0-9_-]{43})$`,
);

/**
 * Build the wire form of an access token for a mailbox. The answer is a
 * bearer credential: hand it to its owner once and never store or log it —
 * only hashAccessToken's digest belongs in the database.
 */
export function formatAccessToken(mailboxId: string, secret: string): string {
	return `${ACCESS_TOKEN_PREFIX}_${utf8ToHex(mailboxId)}_${secret}`;
}

/**
 * Parse a wire token back to its mailbox id and secret, or null for
 * anything that is not exactly the expected shape — a bearer credential is
 * refused on a near miss, never guessed at. The mailbox id comes back with
 * its original bytes, so it can select the mailbox's Durable Object.
 */
export function parseAccessToken(
	token: string,
): { mailboxId: string; secret: string } | null {
	const match = ACCESS_TOKEN_PATTERN.exec(token);
	if (!match) return null;
	const hex = match[1];
	const secret = match[2];
	if (hex === undefined || secret === undefined) return null;
	const mailboxId = hexToUtf8(hex);
	if (mailboxId === null) return null;
	return { mailboxId, secret };
}
