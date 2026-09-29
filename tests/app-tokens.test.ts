// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * App-level (all-mailbox) access tokens tests.
 *
 * Covers, in order: the shared wire helpers (format/parse round trips, the
 * two kinds never parsing as each other, malformed rejections), the R2 store
 * (create/list/verify/revoke lifecycle, the hash never in a read, the
 * last_used_at throttle read back from the stored object, best-effort
 * bookkeeping, cap refusal), and the routes' frozen answer shapes —
 * including the promise that the plaintext token appears in the 201 and
 * nowhere else.
 *
 * Nothing here sends mail: an app token is a stored credential, and the
 * routes only mint, list and revoke rows.
 */

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	APP_ACCESS_TOKEN_PREFIX,
	MAX_ACCESS_TOKEN_NAME_LENGTH,
	MAX_APP_ACCESS_TOKENS,
	formatAccessToken,
	formatAppAccessToken,
	parseAccessToken,
	parseAppAccessToken,
	type AccessTokenRecord,
} from "../shared/access-tokens";
import { hashAccessToken } from "../workers/lib/access-tokens";
import {
	APP_ACCESS_TOKENS_KEY,
	createAppAccessToken,
	listAppAccessTokens,
	revokeAppAccessToken,
	verifyAppAccessToken,
} from "../workers/lib/app-tokens";

/** Answer shapes of the app-token routes. */
interface AppTokensResponse {
	tokens?: AccessTokenRecord[];
	token?: string;
	record?: AccessTokenRecord;
	error?: string;
	ok?: boolean;
}

/** One stored row as config/app-tokens.json keeps it (metadata + hash). */
interface StoredRow {
	id: string;
	name: string;
	scopes?: string[];
	created_at: string;
	last_used_at?: string | null;
	token_hash: string;
}

/** SHA-256 hex of a string, computed here so the token_hash checks stand alone. */
async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** A syntactically valid 43-character base64url secret for hand-built tokens. */
const VALID_SECRET = "A".repeat(42) + "-";

/** Lowercase hex of a string's UTF-8 bytes (a mailbox token's id segment). */
function utf8ToHex(value: string): string {
	return [...new TextEncoder().encode(value)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** A fixed instant plus `offsetMs`, as an ISO string. */
function isoAt(offsetMs: number): string {
	return new Date(Date.parse("2026-01-01T00:00:00.000Z") + offsetMs).toISOString();
}

/** Empty the app-token store so each test starts from a known object. */
async function resetAppTokens(): Promise<void> {
	await env.BUCKET.delete(APP_ACCESS_TOKENS_KEY);
}

/** Replace the stored object with exactly these rows, directly. */
async function seedAppTokens(rows: StoredRow[]): Promise<void> {
	await env.BUCKET.put(
		APP_ACCESS_TOKENS_KEY,
		JSON.stringify({
			tokens: rows.map((row) => ({ scopes: ["read"], last_used_at: null, ...row })),
		}),
	);
}

/** The stored object as parsed JSON, or null when it is absent. */
async function readStoredAppTokens(): Promise<StoredRow[] | null> {
	const object = await env.BUCKET.get(APP_ACCESS_TOKENS_KEY);
	if (!object) return null;
	const parsed = (await object.json()) as { tokens?: StoredRow[] };
	return parsed.tokens ?? null;
}

/** Register the mailbox record the API middleware checks before routing. */
async function registerMailbox(mailbox: string): Promise<void> {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
}

// ── Route helpers ──────────────────────────────────────────────────

const APP_TOKENS_URL = "http://example.com/api/v1/app-tokens";

async function getAppTokens(): Promise<{
	status: number;
	body: AppTokensResponse;
}> {
	const res = await SELF.fetch(APP_TOKENS_URL);
	return { status: res.status, body: (await res.json()) as AppTokensResponse };
}

async function postAppToken(body: unknown): Promise<{
	status: number;
	body: AppTokensResponse;
}> {
	const res = await SELF.fetch(APP_TOKENS_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as AppTokensResponse };
}

async function deleteAppToken(id: string): Promise<{
	status: number;
	body: AppTokensResponse;
}> {
	const res = await SELF.fetch(`${APP_TOKENS_URL}/${id}`, { method: "DELETE" });
	return { status: res.status, body: (await res.json()) as AppTokensResponse };
}

// ── Wire format and scopes (shared/access-tokens.ts) ───────────────

describe("app access token wire format", () => {
	it("keeps the frozen prefix and cap", () => {
		expect(APP_ACCESS_TOKEN_PREFIX).toBe("ain2");
		expect(MAX_APP_ACCESS_TOKENS).toBe(20);
		// The mailbox constants are untouched by the second kind.
		expect(formatAccessToken("user@example.com", VALID_SECRET)).toMatch(/^ain1_/);
	});

	it("round-trips a secret through format and parse", () => {
		const token = formatAppAccessToken(VALID_SECRET);
		expect(token).toBe(`${APP_ACCESS_TOKEN_PREFIX}_${VALID_SECRET}`);
		expect(parseAppAccessToken(token)).toEqual({ secret: VALID_SECRET });
	});

	it("never confuses the two kinds", () => {
		const mailboxToken = formatAccessToken("user@example.com", VALID_SECRET);
		const appToken = formatAppAccessToken(VALID_SECRET);

		expect(parseAccessToken(mailboxToken)).not.toBeNull();
		expect(parseAccessToken(appToken)).toBeNull();
		expect(parseAppAccessToken(appToken)).toEqual({ secret: VALID_SECRET });
		expect(parseAppAccessToken(mailboxToken)).toBeNull();

		// A mailbox-shaped token wearing the app prefix is still refused:
		// the app kind has no room for the id segment.
		expect(
			parseAppAccessToken(`ain2_${utf8ToHex("user@example.com")}_${VALID_SECRET}`),
		).toBeNull();
	});

	it("rejects tokens that are not exactly the expected shape", () => {
		const good = formatAppAccessToken(VALID_SECRET);
		expect(parseAppAccessToken(good)).not.toBeNull();
		for (const bad of [
			"",
			"not-a-token",
			// no separator, empty and doubled separator
			"ain2",
			`${APP_ACCESS_TOKEN_PREFIX}_`,
			`${APP_ACCESS_TOKEN_PREFIX}__${VALID_SECRET}`,
			// wrong digit, unanchored prefix
			`ain3_${VALID_SECRET}`,
			`xain2_${VALID_SECRET}`,
			// the mailbox kind never parses as an app token
			formatAccessToken("user@example.com", VALID_SECRET),
			// 42- and 44-character secrets
			`${APP_ACCESS_TOKEN_PREFIX}_${VALID_SECRET.slice(0, 42)}`,
			`${APP_ACCESS_TOKEN_PREFIX}_${VALID_SECRET}x`,
			// a secret character outside the base64url alphabet
			`${APP_ACCESS_TOKEN_PREFIX}_${VALID_SECRET.slice(0, 42)}+`,
			`${APP_ACCESS_TOKEN_PREFIX}_${VALID_SECRET.slice(0, 42)}.`,
			// extra segments, trailing and leading junk, whitespace
			`${APP_ACCESS_TOKEN_PREFIX}_${VALID_SECRET}_extra`,
			`${good}x`,
			`x${good}`,
			` ${good}`,
			`${good}\n`,
		]) {
			expect(parseAppAccessToken(bad)).toBeNull();
		}
	});
});

// ── R2 store (workers/lib/app-tokens.ts) ───────────────────────────

describe("app access token store", () => {
	it("lists nothing for a missing or corrupt object", async () => {
		await resetAppTokens();
		expect(await listAppAccessTokens(env.BUCKET)).toEqual([]);

		for (const raw of [
			"not json",
			JSON.stringify(null),
			JSON.stringify("a string"),
			JSON.stringify({}),
			JSON.stringify({ tokens: "nope" }),
			JSON.stringify({ tokens: [null, 7, "x", {}] }),
		]) {
			await env.BUCKET.put(APP_ACCESS_TOKENS_KEY, raw);
			expect(await listAppAccessTokens(env.BUCKET)).toEqual([]);
		}

		// A readable row beside a broken one is still listed.
		await seedAppTokens([
			{ id: "good", name: "Good", token_hash: "good-hash", created_at: isoAt(0) },
		]);
		const stored = (await readStoredAppTokens()) ?? [];
		await env.BUCKET.put(
			APP_ACCESS_TOKENS_KEY,
			JSON.stringify({ tokens: [{ broken: true }, ...stored] }),
		);
		expect(await listAppAccessTokens(env.BUCKET)).toEqual([
			{
				id: "good",
				name: "Good",
				scopes: ["read"],
				created_at: isoAt(0),
				last_used_at: null,
			},
		]);
	});

	it("mints a token, stores only its hash, and lists it without the hash", async () => {
		await resetAppTokens();
		const created = await createAppAccessToken(env.BUCKET, {
			name: "  Global token  ",
			scopes: ["send", "read", "read"],
		});
		expect(created).not.toBeNull();
		const { record, token } = created!;
		expect(record).toEqual({
			id: expect.any(String),
			name: "Global token",
			scopes: ["read", "send"],
			created_at: expect.any(String),
			last_used_at: null,
		});
		// The record is metadata only — no hash, no secret.
		expect(Object.keys(record).sort()).toEqual([
			"created_at",
			"id",
			"last_used_at",
			"name",
			"scopes",
		]);
		// The plaintext carries the app wire format: the prefix and a secret.
		expect(parseAppAccessToken(token)).toEqual({ secret: expect.any(String) });
		expect(token.startsWith(`${APP_ACCESS_TOKEN_PREFIX}_`)).toBe(true);
		// Stored is the SHA-256 hex of the full token, and never the token.
		// sha256Hex is computed here so the check stands alone; the worker's
		// own helper has to agree with it.
		const stored = await readStoredAppTokens();
		expect(stored).toHaveLength(1);
		expect(await hashAccessToken(token)).toBe(await sha256Hex(token));
		expect(stored?.[0]?.token_hash).toBe(await sha256Hex(token));
		expect(JSON.stringify(stored)).not.toContain(token);

		const list = await listAppAccessTokens(env.BUCKET);
		expect(list).toEqual([record]);
		expect(Object.keys(list[0] ?? {}).sort()).toEqual([
			"created_at",
			"id",
			"last_used_at",
			"name",
			"scopes",
		]);
		expect(JSON.stringify(list)).not.toContain("token_hash");
		expect(JSON.stringify(list)).not.toContain(token);
	});

	it("refuses unusable input and the cap instead of clipping", async () => {
		await resetAppTokens();
		expect(await createAppAccessToken(env.BUCKET, null)).toBeNull();
		for (const input of [
			{ name: "   ", scopes: ["read"] },
			{ name: 12, scopes: ["read"] },
			{ name: "x".repeat(MAX_ACCESS_TOKEN_NAME_LENGTH + 1), scopes: ["read"] },
			{ name: "Named" },
			{ name: "Named", scopes: [] },
			{ name: "Named", scopes: ["admin"] },
			{ name: "Named", scopes: "read" },
		]) {
			expect(await createAppAccessToken(env.BUCKET, input)).toBeNull();
		}
		expect(await listAppAccessTokens(env.BUCKET)).toEqual([]);
		// A boundary name is accepted, so the bound is inclusive.
		const boundary = await createAppAccessToken(env.BUCKET, {
			name: "x".repeat(MAX_ACCESS_TOKEN_NAME_LENGTH),
			scopes: ["read"],
		});
		expect(boundary?.record.name).toHaveLength(MAX_ACCESS_TOKEN_NAME_LENGTH);

		// The cap: 20 stored rows refuse a 21st, and revoking one makes room.
		await seedAppTokens(
			Array.from({ length: MAX_APP_ACCESS_TOKENS }, (_unused, index) => ({
				id: `cap-${index}`,
				name: `Token ${String(index).padStart(2, "0")}`,
				token_hash: `cap-hash-${index}`,
				created_at: isoAt(index * 1_000),
			})),
		);
		expect(
			await createAppAccessToken(env.BUCKET, { name: "One more", scopes: ["read"] }),
		).toBeNull();
		expect(await listAppAccessTokens(env.BUCKET)).toHaveLength(MAX_APP_ACCESS_TOKENS);

		// Refuse, never prune: nothing was dropped by the refused create.
		expect(await revokeAppAccessToken(env.BUCKET, "cap-0")).toBe(true);
		const after = await createAppAccessToken(env.BUCKET, {
			name: "One more",
			scopes: ["read"],
		});
		expect(after?.record.name).toBe("One more");
		const ids = (await listAppAccessTokens(env.BUCKET)).map((row) => row.id);
		expect(ids).toHaveLength(MAX_APP_ACCESS_TOKENS);
		for (let index = 1; index < MAX_APP_ACCESS_TOKENS; index++) {
			expect(ids).toContain(`cap-${index}`);
		}
	});

	it("lists newest first, id breaking a created_at tie, and never a hash", async () => {
		await seedAppTokens([
			{ id: "app-1", name: "Oldest", token_hash: "hash-1", created_at: isoAt(0) },
			{
				id: "app-2",
				name: "Middle",
				token_hash: "hash-2",
				scopes: ["draft", "read"],
				created_at: isoAt(1_000),
			},
			{
				id: "app-3",
				name: "Newest",
				token_hash: "hash-3",
				scopes: ["send"],
				created_at: isoAt(2_000),
				last_used_at: isoAt(3_000),
			},
			// The two rows below share a timestamp, so the id decides.
			{ id: "app-b", name: "Tie b", token_hash: "hash-b", created_at: isoAt(3_000) },
			{ id: "app-a", name: "Tie a", token_hash: "hash-a", created_at: isoAt(3_000) },
		]);

		const list = await listAppAccessTokens(env.BUCKET);
		expect(list.map((row) => row.id)).toEqual([
			"app-a",
			"app-b",
			"app-3",
			"app-2",
			"app-1",
		]);
		expect(list.find((row) => row.id === "app-3")?.last_used_at).toBe(isoAt(3_000));
		// Never a hash: every row carries exactly the five metadata keys.
		for (const row of list) {
			expect(Object.keys(row).sort()).toEqual([
				"created_at",
				"id",
				"last_used_at",
				"name",
				"scopes",
			]);
		}
		expect(JSON.stringify(list)).not.toContain("hash");
	});

	it("revokes a token once and reports a missing id", async () => {
		await resetAppTokens();
		const created = await createAppAccessToken(env.BUCKET, {
			name: "Short-lived",
			scopes: ["read"],
		});
		expect(await revokeAppAccessToken(env.BUCKET, created!.record.id)).toBe(true);
		expect(await listAppAccessTokens(env.BUCKET)).toEqual([]);
		expect(await revokeAppAccessToken(env.BUCKET, created!.record.id)).toBe(false);
		expect(await revokeAppAccessToken(env.BUCKET, "missing")).toBe(false);
		// The stored object is present but empty, not deleted.
		expect(await readStoredAppTokens()).toEqual([]);
	});

	it("verifies a token and throttles the last_used_at bump past a minute", async () => {
		await resetAppTokens();
		const created = await createAppAccessToken(env.BUCKET, {
			name: "Verify me",
			scopes: ["read", "send"],
		});
		expect(created).not.toBeNull();
		const { record, token } = created!;

		// No oracle: garbage, a right-shaped never-minted secret and a
		// revoked token all answer the same null — and none of them writes
		// a usage stamp.
		const neverMinted = formatAppAccessToken("A".repeat(43));
		expect(await verifyAppAccessToken(env.BUCKET, "garbage")).toBeNull();
		expect(await verifyAppAccessToken(env.BUCKET, neverMinted)).toBeNull();
		expect((await readStoredAppTokens())?.[0]?.last_used_at ?? null).toBeNull();

		// The first verify stamps last_used_at and answers the metadata record.
		const first = await verifyAppAccessToken(env.BUCKET, token);
		expect(first).toEqual({
			id: record.id,
			name: "Verify me",
			scopes: ["read", "send"],
			created_at: record.created_at,
			last_used_at: expect.any(String),
		});
		expect(Object.keys(first ?? {}).sort()).toEqual([
			"created_at",
			"id",
			"last_used_at",
			"name",
			"scopes",
		]);
		const storedFirst = (await readStoredAppTokens())?.[0]?.last_used_at ?? null;
		expect(storedFirst).toBe(first?.last_used_at ?? null);
		// The matching hash is the digest of the full token, computed here.
		expect((await readStoredAppTokens())?.[0]?.token_hash).toBe(await sha256Hex(token));

		// A second verify within the minute leaves the stamp alone.
		expect(await verifyAppAccessToken(env.BUCKET, token)).not.toBeNull();
		expect((await readStoredAppTokens())?.[0]?.last_used_at).toBe(storedFirst);

		// Aged past the refresh window, the next verify bumps it again.
		const aged = new Date(Date.now() - 5 * 60_000).toISOString();
		await seedAppTokens(
			((await readStoredAppTokens()) ?? []).map((row) => ({
				...row,
				last_used_at: aged,
			})),
		);
		expect((await readStoredAppTokens())?.[0]?.last_used_at).toBe(aged);
		const third = await verifyAppAccessToken(env.BUCKET, token);
		const bumped = (await readStoredAppTokens())?.[0]?.last_used_at ?? null;
		expect(bumped).not.toBe(aged);
		expect(Date.parse(bumped ?? "")).toBeGreaterThan(Date.parse(aged));
		expect(third?.last_used_at).toBe(bumped);

		// An unparseable stored stamp counts as stale and is repaired.
		const [storedRow] = (await readStoredAppTokens()) ?? [];
		expect(storedRow).toBeDefined();
		await seedAppTokens([{ ...storedRow!, last_used_at: "not a date" }]);
		expect(await verifyAppAccessToken(env.BUCKET, token)).not.toBeNull();
		expect((await readStoredAppTokens())?.[0]?.last_used_at).not.toBe("not a date");

		// A revoked token answers the same null as garbage.
		expect(await revokeAppAccessToken(env.BUCKET, record.id)).toBe(true);
		expect(await verifyAppAccessToken(env.BUCKET, token)).toBeNull();
	});

	it("keeps answering a verify when the last_used_at write fails", async () => {
		await resetAppTokens();
		const created = await createAppAccessToken(env.BUCKET, {
			name: "Flaky writes",
			scopes: ["read"],
		});
		expect(created).not.toBeNull();
		const { record, token } = created!;
		// A bucket whose only write fails: the read must still resolve.
		const failingWrites = {
			get: (key: string) => env.BUCKET.get(key),
			put: () => Promise.reject(new Error("simulated R2 write failure")),
		} as unknown as R2Bucket;

		const verified = await verifyAppAccessToken(failingWrites, token);
		expect(verified).toEqual({
			id: record.id,
			name: "Flaky writes",
			scopes: ["read"],
			created_at: record.created_at,
			last_used_at: null,
		});
		// The failed write left the stored stamp alone.
		expect((await readStoredAppTokens())?.[0]?.last_used_at ?? null).toBeNull();
	});
});

// ── Routes ─────────────────────────────────────────────────────────

describe("app access token routes", () => {
	it("mints, lists and revokes with the frozen shapes", async () => {
		await resetAppTokens();

		const empty = await getAppTokens();
		expect(empty.status).toBe(200);
		expect(empty.body).toEqual({ tokens: [] });
		expect(Object.keys(empty.body)).toEqual(["tokens"]);

		const created = await postAppToken({
			name: "  Global Settings token  ",
			scopes: ["send", "read", "read"],
		});
		expect(created.status).toBe(201);
		// The 201 is the only answer that ever carries the plaintext token.
		expect(Object.keys(created.body).sort()).toEqual(["record", "token"]);
		const token = created.body.token as string;
		expect(parseAppAccessToken(token)).toEqual({ secret: expect.any(String) });
		expect(token.startsWith(`${APP_ACCESS_TOKEN_PREFIX}_`)).toBe(true);
		const record = created.body.record as AccessTokenRecord;
		expect(record).toEqual({
			id: expect.any(String),
			name: "Global Settings token",
			scopes: ["read", "send"],
			created_at: expect.any(String),
			last_used_at: null,
		});
		expect(Object.keys(record).sort()).toEqual([
			"created_at",
			"id",
			"last_used_at",
			"name",
			"scopes",
		]);
		expect(JSON.stringify(record)).not.toContain("token_hash");

		// Stored is the full token's SHA-256 hex, computed here.
		expect((await readStoredAppTokens())?.[0]?.token_hash).toBe(
			await sha256Hex(token),
		);

		const list = await getAppTokens();
		expect(list.status).toBe(200);
		expect(list.body.tokens).toEqual([record]);
		expect(Object.keys(list.body.tokens?.[0] ?? {}).sort()).toEqual([
			"created_at",
			"id",
			"last_used_at",
			"name",
			"scopes",
		]);
		// Never a token, a secret or a hash anywhere in the list answer.
		const serialized = JSON.stringify(list.body);
		expect(serialized).not.toContain("token_hash");
		expect(serialized).not.toContain(token);
		expect(serialized).not.toContain("secret");

		const deleted = await deleteAppToken(record.id);
		expect(deleted.status).toBe(200);
		expect(deleted.body).toEqual({ ok: true });
		expect((await getAppTokens()).body.tokens).toEqual([]);
		expect((await readStoredAppTokens())?.length).toBe(0);

		// The unknown-id answer mirrors the mailbox route's exactly.
		const mailbox = "app-tokens-route-mirror@example.com";
		await registerMailbox(mailbox);
		const mailboxMissing = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/access-tokens/missing`,
			{ method: "DELETE" },
		);
		expect(mailboxMissing.status).toBe(404);
		const appMissing = await deleteAppToken("missing");
		expect(appMissing.status).toBe(mailboxMissing.status);
		expect(appMissing.body).toEqual(await mailboxMissing.json());
	});

	it("400s missing, over-long and bad-scope creates and the cap, naming the reason", async () => {
		await resetAppTokens();

		const noName = await postAppToken({ scopes: ["read"] });
		expect(noName.status).toBe(400);
		expect(noName.body.error).toMatch(/name is required/i);

		const blankName = await postAppToken({ name: "   ", scopes: ["read"] });
		expect(blankName.status).toBe(400);
		expect(blankName.body.error).toMatch(/name is required/i);

		const longName = await postAppToken({
			name: "x".repeat(MAX_ACCESS_TOKEN_NAME_LENGTH + 1),
			scopes: ["read"],
		});
		expect(longName.status).toBe(400);
		expect(longName.body.error).toMatch(/at most 120 characters/i);

		for (const body of [
			{ name: "Named", scopes: ["admin"] },
			{ name: "Named" },
			{ name: "Named", scopes: [] },
			{ name: "Named", scopes: "read" },
		]) {
			const badScopes = await postAppToken(body);
			expect(badScopes.status).toBe(400);
			expect(badScopes.body.error).toMatch(/read, draft, send/);
		}

		const notAnObject = await postAppToken("read");
		expect(notAnObject.status).toBe(400);

		// Nothing was stored by any of the rejected writes.
		expect((await getAppTokens()).body.tokens).toEqual([]);

		// The 21st create on a full store is refused by the store, so it
		// proves the route still answers a 400 with the cap named.
		await seedAppTokens(
			Array.from({ length: MAX_APP_ACCESS_TOKENS }, (_unused, index) => ({
				id: `route-cap-${index}`,
				name: `Token ${String(index).padStart(2, "0")}`,
				token_hash: `route-hash-${index}`,
				created_at: isoAt(index * 1_000),
			})),
		);
		const overCap = await postAppToken({ name: "One more", scopes: ["read"] });
		expect(overCap.status).toBe(400);
		expect(overCap.body.error).toMatch(/at most 20 app access tokens/i);
		expect((await getAppTokens()).body.tokens).toHaveLength(MAX_APP_ACCESS_TOKENS);
		// The refused create stored nothing, so no plaintext was minted.
		expect(overCap.body.token).toBeUndefined();
	});
});
