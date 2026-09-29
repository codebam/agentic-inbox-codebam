// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * App-level (all-mailbox) access tokens, stored in R2 rather than in any
 * mailbox's Durable Object. One token authenticates the whole deployment —
 * its wire format (shared/access-tokens.ts, the `ain2` prefix) carries no
 * mailbox segment — so the store is a single JSON object at
 * config/app-tokens.json:
 *
 *     { tokens: [{ id, name, scopes, created_at, last_used_at, token_hash }] }
 *
 * A token is a bearer credential: the plaintext is minted here, shown once
 * by the create route, and never stored — the object keeps only the SHA-256
 * hex of the full token string (hashAccessToken), which is what
 * verifyAppAccessToken matches on. Every read answers the metadata record
 * alone; `token_hash` never leaves this module.
 *
 * Every mutation is a read-modify-write of that one R2 object and last write
 * wins — fine for the admin surface this serves (single-operator, behind
 * Cloudflare Access), but not a pattern to copy for concurrent writers.
 */

import {
	MAX_ACCESS_TOKEN_NAME_LENGTH,
	MAX_APP_ACCESS_TOKENS,
	formatAppAccessToken,
	normalizeAccessTokenScopes,
	type AccessTokenRecord,
} from "../../shared/access-tokens";
import { generateAccessTokenSecret, hashAccessToken } from "./access-tokens";

/** Keep this key outside the `mailboxes/` prefix so it isn't a mailbox. */
export const APP_ACCESS_TOKENS_KEY = "config/app-tokens.json";

/** How stale `last_used_at` must be before verifyAppAccessToken rewrites it. */
const APP_ACCESS_TOKEN_LAST_USED_REFRESH_MS = 60_000;

/**
 * One stored app token: the metadata record every read answers, plus the
 * SHA-256 hex of the full token string — the one field that never leaves
 * this module.
 */
interface StoredAppAccessToken extends AccessTokenRecord {
	token_hash: string;
}

/**
 * A new app token as the API accepts it, before normalization. Fields are
 * typed `unknown` on purpose: the normalizers here are the validators, so a
 * route can hand over a parsed JSON body without pre-checking its shape.
 */
export interface AppAccessTokenInput {
	name?: unknown;
	scopes?: unknown;
}

/** Canonical stored token name: trimmed and bounded; null when unusable. */
function normalizeAppAccessTokenName(value: unknown): string | null {
	const name = typeof value === "string" ? value.trim() : "";
	if (!name || name.length > MAX_ACCESS_TOKEN_NAME_LENGTH) return null;
	return name;
}

/**
 * One stored entry, or null when the row is not a complete stored token. A
 * malformed row is dropped rather than guessed at, so a hand-edited object
 * cannot smuggle half a credential into a listing.
 */
function parseStoredAppAccessToken(value: unknown): StoredAppAccessToken | null {
	if (value === null || typeof value !== "object") return null;
	const row = value as Record<string, unknown>;
	const id = typeof row["id"] === "string" ? row["id"] : "";
	const name = normalizeAppAccessTokenName(row["name"]);
	const createdAt = typeof row["created_at"] === "string" ? row["created_at"] : "";
	const tokenHash = typeof row["token_hash"] === "string" ? row["token_hash"] : "";
	if (!id || name === null || !createdAt || !tokenHash) return null;
	return {
		id,
		name,
		// A malformed stored scopes value lists as an empty array, matching
		// the mailbox list (MailboxDO.listAccessTokens), not a throw.
		scopes: normalizeAccessTokenScopes(row["scopes"]) ?? [],
		created_at: createdAt,
		last_used_at: typeof row["last_used_at"] === "string" ? row["last_used_at"] : null,
		token_hash: tokenHash,
	};
}

/**
 * The list order both admin surfaces read in: newest first by created_at,
 * id (ascending) breaking a tie — the same order as the mailbox list
 * (MailboxDO.listAccessTokens), with plain string comparison so ISO
 * timestamps and UUIDs sort byte-for-byte like SQLite sorts them.
 */
function compareAppAccessTokens(
	a: StoredAppAccessToken,
	b: StoredAppAccessToken,
): number {
	if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
	if (a.id === b.id) return 0;
	return a.id < b.id ? -1 : 1;
}

/**
 * Every stored token, token_hash included — the internal read every
 * function below builds on. An absent, unparseable or malformed object
 * answers an empty list rather than throwing: token administration must not
 * be able to take the app down, and the next create repairs the object.
 */
async function readStoredAppAccessTokens(
	bucket: R2Bucket,
): Promise<StoredAppAccessToken[]> {
	const object = await bucket.get(APP_ACCESS_TOKENS_KEY);
	if (!object) return [];
	let raw: unknown;
	try {
		raw = await object.json();
	} catch {
		return [];
	}
	if (raw === null || typeof raw !== "object") return [];
	const rows: unknown = (raw as { tokens?: unknown }).tokens;
	if (!Array.isArray(rows)) return [];
	const entries: unknown[] = rows;
	return entries
		.map((row) => parseStoredAppAccessToken(row))
		.filter((row): row is StoredAppAccessToken => row !== null)
		.sort(compareAppAccessTokens);
}

/** The metadata record of a stored row — everything but `token_hash`. */
function appAccessTokenRecord(row: StoredAppAccessToken): AccessTokenRecord {
	return {
		id: row.id,
		name: row.name,
		scopes: row.scopes,
		created_at: row.created_at,
		last_used_at: row.last_used_at,
	};
}

/**
 * The deployment's app access tokens, newest first, as metadata records —
 * `token_hash` is dropped here and never leaves this module. An absent or
 * corrupt settings object answers an empty list (see
 * readStoredAppAccessTokens).
 */
export async function listAppAccessTokens(
	bucket: R2Bucket,
): Promise<AccessTokenRecord[]> {
	const stored = await readStoredAppAccessTokens(bucket);
	return stored.map(appAccessTokenRecord);
}

/**
 * Mint one app access token and store only its hash. The name is trimmed and
 * must be 1..MAX_ACCESS_TOKEN_NAME_LENGTH characters, the scopes are
 * canonicalized to a non-empty subset of read/draft/send, and a deployment
 * already holding MAX_APP_ACCESS_TOKENS refuses the write — tokens are kept
 * until revoked, never pruned, so a runaway caller cannot grow the store
 * without limit. Returns the plaintext token (a bearer credential: shown
 * once, never stored) with its metadata record; null when a value is
 * unusable or the cap has been reached (the route answers a 400 either way,
 * naming the reason from its own pre-check). The record carries no hash
 * fields.
 */
export async function createAppAccessToken(
	bucket: R2Bucket,
	input: AppAccessTokenInput | null,
): Promise<{ token: string; record: AccessTokenRecord } | null> {
	const name = normalizeAppAccessTokenName(input?.name);
	const scopes = normalizeAccessTokenScopes(input?.scopes);
	if (name === null || scopes === null) return null;
	const stored = await readStoredAppAccessTokens(bucket);
	if (stored.length >= MAX_APP_ACCESS_TOKENS) return null;
	const token = formatAppAccessToken(generateAccessTokenSecret());
	const record: AccessTokenRecord = {
		id: crypto.randomUUID(),
		name,
		scopes,
		created_at: new Date().toISOString(),
		last_used_at: null,
	};
	const tokenHash = await hashAccessToken(token);
	await bucket.put(
		APP_ACCESS_TOKENS_KEY,
		JSON.stringify({ tokens: [...stored, { ...record, token_hash: tokenHash }] }),
	);
	return { token, record };
}

/**
 * Revoke one app access token. Returns false when the id is unknown; nothing
 * else is touched, and the revoked token stops resolving immediately.
 */
export async function revokeAppAccessToken(
	bucket: R2Bucket,
	tokenId: string,
): Promise<boolean> {
	const stored = await readStoredAppAccessTokens(bucket);
	const remaining = stored.filter((row) => row.id !== tokenId);
	if (remaining.length === stored.length) return false;
	await bucket.put(APP_ACCESS_TOKENS_KEY, JSON.stringify({ tokens: remaining }));
	return true;
}

/**
 * Resolve one presented app token: hash match on `token_hash`. A hit bumps
 * `last_used_at`, but only when it is unset or at least a minute old (an
 * unparseable stamp counts as stale), so a hot token does not rewrite the
 * object on every request — writes stay rare. That bump is best-effort: a
 * failed write is logged and the verify still answers the record, because a
 * read that authenticated must not fail on a bookkeeping write. Returns the
 * metadata record (no hash), or null for an unknown hash.
 */
export async function verifyAppAccessToken(
	bucket: R2Bucket,
	token: string,
): Promise<AccessTokenRecord | null> {
	const tokenHash = await hashAccessToken(token);
	const stored = await readStoredAppAccessTokens(bucket);
	const found = stored.find((row) => row.token_hash === tokenHash);
	if (!found) return null;
	const lastUsedMs =
		found.last_used_at === null ? Number.NaN : Date.parse(found.last_used_at);
	const now = Date.now();
	if (
		found.last_used_at === null ||
		!Number.isFinite(lastUsedMs) ||
		now - lastUsedMs >= APP_ACCESS_TOKEN_LAST_USED_REFRESH_MS
	) {
		const previous = found.last_used_at;
		found.last_used_at = new Date(now).toISOString();
		try {
			await bucket.put(APP_ACCESS_TOKENS_KEY, JSON.stringify({ tokens: stored }));
		} catch (error) {
			// Best-effort bookkeeping: report the stamp that was actually
			// written (none), not one a failed write never committed.
			console.error("[app-tokens] could not record last_used_at:", error);
			found.last_used_at = previous;
		}
	}
	return appAccessTokenRecord(found);
}
