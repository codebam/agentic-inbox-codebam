// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Access tokens (bearer credentials) tests.
 *
 * Covers, in order: the shared wire helpers (format/parse round trips,
 * malformed rejections, scope normalization), the worker crypto helpers
 * (43-character secret, SHA-256 of the full token), migration 39's table on
 * a fresh DO, the Durable Object lifecycle (mint, list, revoke, verify with
 * its last_used_at throttle), and the routes' frozen answer shapes —
 * including the promise that the plaintext token appears in the 201 and
 * nowhere else.
 *
 * Nothing here sends mail: a token is a stored credential, and the routes
 * only mint, list and revoke rows.
 */

import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	ACCESS_TOKEN_PREFIX,
	ACCESS_TOKEN_SCOPES,
	MAX_ACCESS_TOKENS,
	MAX_ACCESS_TOKEN_NAME_LENGTH,
	formatAccessToken,
	isAccessTokenScope,
	normalizeAccessTokenScopes,
	parseAccessToken,
	type AccessTokenRecord,
} from "../shared/access-tokens";
import {
	generateAccessTokenSecret,
	hashAccessToken,
} from "../workers/lib/access-tokens";

type Stub = ReturnType<typeof stubFor>;

/** Answer shapes of the access-token routes. */
interface TokensResponse {
	tokens?: AccessTokenRecord[];
	token?: string;
	record?: AccessTokenRecord;
	error?: string;
	ok?: boolean;
}

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

/** Register the mailbox record the API middleware checks before routing. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
}

/** Lowercase hex of a string's UTF-8 bytes (the token's mailbox-id segment). */
function utf8ToHex(value: string): string {
	return [...new TextEncoder().encode(value)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
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

/**
 * Replace the mailbox's access tokens with exactly these rows, directly —
 * the ordering and cap tests need controlled ids and timestamps. Idempotent:
 * a repeated call reseeds instead of accumulating, because Durable Object
 * storage is not isolated per test.
 */
async function insertAccessTokens(
	stub: Stub,
	rows: {
		id: string;
		name: string;
		tokenHash: string;
		scopes?: string;
		createdAt: string;
		lastUsedAt?: string | null;
	}[],
) {
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec("DELETE FROM access_tokens");
		for (const row of rows) {
			state.storage.sql.exec(
				`INSERT INTO access_tokens (id, name, token_hash, scopes, created_at, last_used_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
				row.id,
				row.name,
				row.tokenHash,
				row.scopes ?? JSON.stringify(["read"]),
				row.createdAt,
				row.lastUsedAt ?? null,
			);
		}
	});
}

/** The raw stored last_used_at for one token, read straight from SQL. */
async function rawLastUsed(stub: Stub, id: string): Promise<string | null> {
	return runInDurableObject(stub, async (_instance, state) => {
		const row = [
			...state.storage.sql.exec(
				"SELECT last_used_at FROM access_tokens WHERE id = ?1",
				id,
			),
		][0] as { last_used_at: string | null } | undefined;
		return row?.last_used_at ?? null;
	});
}

/** The raw stored token_hash for one token, read straight from SQL. */
async function rawTokenHash(stub: Stub, id: string): Promise<string | null> {
	return runInDurableObject(stub, async (_instance, state) => {
		const row = [
			...state.storage.sql.exec(
				"SELECT token_hash FROM access_tokens WHERE id = ?1",
				id,
			),
		][0] as { token_hash: string } | undefined;
		return row?.token_hash ?? null;
	});
}

/** A fixed instant plus `offsetMs`, as an ISO string. */
function isoAt(offsetMs: number): string {
	return new Date(Date.parse("2026-01-01T00:00:00.000Z") + offsetMs).toISOString();
}

// ── Route helpers ──────────────────────────────────────────────────

async function getAccessTokens(
	mailbox: string,
): Promise<{ status: number; body: TokensResponse }> {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/access-tokens`,
	);
	return { status: res.status, body: (await res.json()) as TokensResponse };
}

async function postAccessToken(mailbox: string, body: unknown) {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/access-tokens`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	return { status: res.status, body: (await res.json()) as TokensResponse };
}

async function deleteAccessToken(mailbox: string, id: string) {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/access-tokens/${id}`,
		{ method: "DELETE" },
	);
	return { status: res.status, body: (await res.json()) as TokensResponse };
}

// ── Wire format and scopes (shared/access-tokens.ts) ───────────────

describe("access token wire format", () => {
	it("keeps the frozen prefix and constants", () => {
		expect(ACCESS_TOKEN_PREFIX).toBe("ain1");
		expect(ACCESS_TOKEN_SCOPES).toEqual(["read", "draft", "send", "manage"]);
		expect(MAX_ACCESS_TOKENS).toBe(20);
		expect(MAX_ACCESS_TOKEN_NAME_LENGTH).toBe(120);
	});

	it("round-trips mailbox ids through format and parse", () => {
		for (const mailboxId of [
			"user+tag@example.com",
			"First.Last@Example.COM",
			"plain@example.com",
			"wéird+アドレス@example.com",
		]) {
			const token = formatAccessToken(mailboxId, VALID_SECRET);
			expect(token).toBe(
				`${ACCESS_TOKEN_PREFIX}_${utf8ToHex(mailboxId)}_${VALID_SECRET}`,
			);
			expect(parseAccessToken(token)).toEqual({
				mailboxId,
				secret: VALID_SECRET,
			});
		}
	});

	it("rejects tokens that are not exactly the expected shape", () => {
		const hex = utf8ToHex("user@example.com");
		const good = formatAccessToken("user@example.com", VALID_SECRET);
		expect(parseAccessToken(good)).not.toBeNull();
		for (const bad of [
			"",
			"not-a-token",
			// wrong prefix
			`ain0_${hex}_${VALID_SECRET}`,
			`xain1_${hex}_${VALID_SECRET}`,
			// empty mailbox segment
			`${ACCESS_TOKEN_PREFIX}__${VALID_SECRET}`,
			// odd-length hex
			`${ACCESS_TOKEN_PREFIX}_abc_${VALID_SECRET}`,
			// uppercase hex is not the wire encoding
			`${ACCESS_TOKEN_PREFIX}_${hex.toUpperCase()}_${VALID_SECRET}`,
			// 42- and 44-character secrets
			`${ACCESS_TOKEN_PREFIX}_${hex}_${VALID_SECRET.slice(0, 42)}`,
			`${ACCESS_TOKEN_PREFIX}_${hex}_${VALID_SECRET}x`,
			// a secret character outside the base64url alphabet
			`${ACCESS_TOKEN_PREFIX}_${hex}_${VALID_SECRET.slice(0, 42)}+`,
			// missing and extra segments
			`${ACCESS_TOKEN_PREFIX}_${VALID_SECRET}`,
			`${ACCESS_TOKEN_PREFIX}_${hex}`,
			`${ACCESS_TOKEN_PREFIX}_${hex}_${VALID_SECRET}_extra`,
			// trailing junk
			`${good}x`,
			// even-length hex that is not valid UTF-8
			`${ACCESS_TOKEN_PREFIX}_ff_${VALID_SECRET}`,
		]) {
			expect(parseAccessToken(bad)).toBeNull();
		}
	});

	it("normalizes scopes to a deduped canonical non-empty subset", () => {
		expect(normalizeAccessTokenScopes(["send", "read"])).toEqual([
			"read",
			"send",
		]);
		expect(normalizeAccessTokenScopes(["draft"])).toEqual(["draft"]);
		expect(
			normalizeAccessTokenScopes(["manage", "send", "read", "draft"]),
		).toEqual(["read", "draft", "send", "manage"]);
		expect(
			normalizeAccessTokenScopes(["send", "read", "draft", "read"]),
		).toEqual(["read", "draft", "send"]);
		expect(normalizeAccessTokenScopes(["read", "read"])).toEqual(["read"]);
		for (const bad of [
			[],
			["admin"],
			["read", "admin"],
			["Read"],
			"read",
			12,
			null,
			undefined,
			{},
			[1],
		]) {
			expect(normalizeAccessTokenScopes(bad)).toBeNull();
		}
	});

	it("guards scope strings", () => {
		expect(isAccessTokenScope("read")).toBe(true);
		expect(isAccessTokenScope("draft")).toBe(true);
		expect(isAccessTokenScope("send")).toBe(true);
		expect(isAccessTokenScope("admin")).toBe(false);
		expect(isAccessTokenScope("Read")).toBe(false);
		expect(isAccessTokenScope(1)).toBe(false);
		expect(isAccessTokenScope(null)).toBe(false);
	});
});

// ── Crypto helpers (workers/lib/access-tokens.ts) ──────────────────

describe("access token crypto helpers", () => {
	it("mints 32 bytes as a 43-character unpadded base64url secret", () => {
		const seen = new Set<string>();
		for (let index = 0; index < 8; index++) {
			const secret = generateAccessTokenSecret();
			expect(secret).toHaveLength(43);
			expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
			seen.add(secret);
		}
		expect(seen.size).toBe(8);
	});

	it("hashes the full token string as SHA-256 hex", async () => {
		const token = formatAccessToken("hash@example.com", VALID_SECRET);
		const digest = await hashAccessToken(token);
		expect(digest).toBe(await sha256Hex(token));
		expect(digest).toHaveLength(64);
		expect(digest).not.toBe(await hashAccessToken(VALID_SECRET));
		expect(digest).not.toBe(
			await hashAccessToken(
				formatAccessToken("other@example.com", VALID_SECRET),
			),
		);
	});
});

// ── Migration ──────────────────────────────────────────────────────

describe("migration 39_add_access_tokens", () => {
	it("creates the access_tokens table on a fresh DO", async () => {
		const stub = stubFor("access-tokens-migration@example.com");

		const migration = await runInDurableObject(
			stub,
			async (_instance, state) => {
				const table = [
					...state.storage.sql.exec(
						"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'access_tokens'",
					),
				][0] as { sql: string } | undefined;
				const applied = [
					...state.storage.sql.exec(
						"SELECT name FROM d1_migrations WHERE name = '39_add_access_tokens'",
					),
				];
				return { sql: table?.sql ?? null, applied: applied.length };
			},
		);

		expect(migration.applied).toBe(1);
		const sql = migration.sql ?? "";
		for (const column of [
			"id TEXT PRIMARY KEY",
			"name TEXT NOT NULL",
			"token_hash TEXT NOT NULL UNIQUE",
			"scopes TEXT NOT NULL",
			"created_at TEXT NOT NULL",
			"last_used_at TEXT",
		]) {
			expect(sql).toContain(column);
		}
	});
});

// ── Durable Object lifecycle ───────────────────────────────────────

describe("access token CRUD", () => {
	it("mints a token, stores only its hash and answers the record", async () => {
		const mailbox = "access-tokens-create@example.com";
		const stub = stubFor(mailbox);
		await insertAccessTokens(stub, []);

		const created = await stub.createAccessToken(mailbox, {
			name: "  CLI token  ",
			scopes: ["send", "read", "read"],
		});
		expect(created).not.toBeNull();
		const { record, token } = created!;
		expect(record).toEqual({
			id: expect.any(String),
			name: "CLI token",
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
		// The plaintext carries the wire format with this mailbox's id.
		expect(parseAccessToken(token)).toEqual({
			mailboxId: mailbox,
			secret: expect.any(String),
		});
		expect(token.startsWith(`${ACCESS_TOKEN_PREFIX}_${utf8ToHex(mailbox)}_`)).toBe(
			true,
		);
		// Stored is the SHA-256 hex of the full token, and never the token.
		expect(await rawTokenHash(stub, record.id)).toBe(await sha256Hex(token));
	});

	it("refuses unusable input and the cap instead of clipping", async () => {
		const mailbox = "access-tokens-bounds@example.com";
		const stub = stubFor(mailbox);
		await insertAccessTokens(stub, []);

		await runInDurableObject(stub, async (instance) => {
			// Blank, non-string, over-long names and unusable scope lists are
			// all refused (null), never stored trimmed to fit.
			expect(await instance.createAccessToken(mailbox, null)).toBeNull();
			expect(
				await instance.createAccessToken(mailbox, { name: "   ", scopes: ["read"] }),
			).toBeNull();
			expect(
				await instance.createAccessToken(mailbox, { name: 12, scopes: ["read"] }),
			).toBeNull();
			expect(
				await instance.createAccessToken(mailbox, {
					name: "x".repeat(MAX_ACCESS_TOKEN_NAME_LENGTH + 1),
					scopes: ["read"],
				}),
			).toBeNull();
			expect(await instance.createAccessToken(mailbox, { name: "Named" })).toBeNull();
			expect(
				await instance.createAccessToken(mailbox, { name: "Named", scopes: [] }),
			).toBeNull();
			expect(
				await instance.createAccessToken(mailbox, { name: "Named", scopes: ["admin"] }),
			).toBeNull();
			expect(
				await instance.createAccessToken(mailbox, { name: "Named", scopes: "read" }),
			).toBeNull();
			// A boundary name is accepted, so the bound is inclusive.
			expect(
				await instance.createAccessToken(mailbox, {
					name: "x".repeat(MAX_ACCESS_TOKEN_NAME_LENGTH),
					scopes: ["read"],
				}),
			).not.toBeNull();
		});
		expect(await stub.listAccessTokens()).toHaveLength(1);

		// The cap: 20 stored rows refuse a 21st, and revoking one makes room.
		await insertAccessTokens(
			stub,
			Array.from({ length: MAX_ACCESS_TOKENS }, (_unused, index) => ({
				id: `cap-${index}`,
				name: `Token ${String(index).padStart(2, "0")}`,
				tokenHash: `cap-hash-${index}`,
				createdAt: isoAt(index * 1_000),
			})),
		);
		expect(
			await stub.createAccessToken(mailbox, { name: "One more", scopes: ["read"] }),
		).toBeNull();
		expect(await stub.listAccessTokens()).toHaveLength(MAX_ACCESS_TOKENS);

		expect(await stub.revokeAccessToken("cap-0")).toBe(true);
		const createdAfter = await stub.createAccessToken(mailbox, {
			name: "One more",
			scopes: ["read"],
		});
		expect(createdAfter?.record.name).toBe("One more");
		expect(await stub.listAccessTokens()).toHaveLength(MAX_ACCESS_TOKENS);
	});

	it("lists newest first, id breaking a created_at tie, and never a hash", async () => {
		const mailbox = "access-tokens-order@example.com";
		const stub = stubFor(mailbox);
		await insertAccessTokens(stub, [
			{ id: "order-1", name: "Oldest", tokenHash: "order-hash-1", createdAt: isoAt(0) },
			{
				id: "order-2",
				name: "Middle",
				tokenHash: "order-hash-2",
				scopes: JSON.stringify(["draft", "read"]),
				createdAt: isoAt(1_000),
			},
			{
				id: "order-3",
				name: "Newest",
				tokenHash: "order-hash-3",
				scopes: JSON.stringify(["send"]),
				createdAt: isoAt(2_000),
				lastUsedAt: isoAt(3_000),
			},
			// The two rows below share a timestamp, so the id decides.
			{ id: "order-b", name: "Tie b", tokenHash: "order-hash-b", createdAt: isoAt(3_000) },
			{ id: "order-a", name: "Tie a", tokenHash: "order-hash-a", createdAt: isoAt(3_000) },
			// A malformed stored scopes value lists as an empty array, not a throw.
			{
				id: "order-bad",
				name: "Broken",
				tokenHash: "order-hash-bad",
				scopes: "not json",
				createdAt: isoAt(1_500),
			},
		]);

		const list = await stub.listAccessTokens();
		expect(list.map((row) => row.id)).toEqual([
			"order-a",
			"order-b",
			"order-3",
			"order-bad",
			"order-2",
			"order-1",
		]);
		expect(list.find((row) => row.id === "order-2")?.scopes).toEqual([
			"read",
			"draft",
		]);
		expect(list.find((row) => row.id === "order-1")?.scopes).toEqual(["read"]);
		expect(list.find((row) => row.id === "order-bad")?.scopes).toEqual([]);
		expect(list.find((row) => row.id === "order-3")?.last_used_at).toBe(isoAt(3_000));
		expect(list.find((row) => row.id === "order-1")?.last_used_at).toBeNull();
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
		const mailbox = "access-tokens-revoke@example.com";
		const stub = stubFor(mailbox);
		await insertAccessTokens(stub, []);
		const created = await stub.createAccessToken(mailbox, {
			name: "Short-lived",
			scopes: ["read"],
		});

		expect(await stub.revokeAccessToken(created!.record.id)).toBe(true);
		expect(await stub.listAccessTokens()).toEqual([]);
		expect(await stub.revokeAccessToken(created!.record.id)).toBe(false);
		expect(await stub.revokeAccessToken("missing")).toBe(false);
	});

	it("verifies a hash and throttles the last_used_at bump past a minute", async () => {
		const mailbox = "access-tokens-verify@example.com";
		const stub = stubFor(mailbox);
		await insertAccessTokens(stub, []);
		const created = await stub.createAccessToken(mailbox, {
			name: "Verify me",
			scopes: ["read", "send"],
		});
		const { record, token } = created!;
		const tokenHash = await sha256Hex(token);

		// An unknown hash is null — including a hash of an edited token.
		expect(await stub.verifyAccessToken("0".repeat(64))).toBeNull();
		expect(await stub.verifyAccessToken(await sha256Hex(`${token}x`))).toBeNull();
		expect(await rawLastUsed(stub, record.id)).toBeNull();

		// The first verify stamps last_used_at and answers the metadata record.
		const first = await stub.verifyAccessToken(tokenHash);
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
		const storedFirst = await rawLastUsed(stub, record.id);
		expect(storedFirst).not.toBeNull();
		expect(storedFirst).toBe(first?.last_used_at ?? null);

		// A second verify within the minute leaves the stamp alone.
		expect(await stub.verifyAccessToken(tokenHash)).not.toBeNull();
		expect(await rawLastUsed(stub, record.id)).toBe(storedFirst);

		// Aged past the refresh window, the next verify bumps it again.
		const aged = new Date(Date.now() - 5 * 60_000).toISOString();
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE access_tokens SET last_used_at = ?1 WHERE id = ?2",
				aged,
				record.id,
			);
		});
		expect(await rawLastUsed(stub, record.id)).toBe(aged);
		const third = await stub.verifyAccessToken(tokenHash);
		const bumped = await rawLastUsed(stub, record.id);
		expect(bumped).not.toBe(aged);
		expect(Date.parse(bumped ?? "")).toBeGreaterThan(Date.parse(aged));
		expect(third?.last_used_at).toBe(bumped);
	});
});

// ── Routes ─────────────────────────────────────────────────────────

describe("access token routes", () => {
	it("mints, lists and revokes one with the frozen shapes", async () => {
		const mailbox = "access-tokens-route@example.com";
		await registerMailbox(mailbox);
		await insertAccessTokens(stubFor(mailbox), []);

		const created = await postAccessToken(mailbox, {
			name: "  CLI token  ",
			scopes: ["send", "read", "read"],
		});
		expect(created.status).toBe(201);
		// The 201 is the only answer that ever carries the plaintext token.
		expect(Object.keys(created.body).sort()).toEqual(["record", "token"]);
		const token = created.body.token as string;
		expect(parseAccessToken(token)).toEqual({
			mailboxId: mailbox,
			secret: expect.any(String),
		});
		expect(created.body.record).toEqual({
			id: expect.any(String),
			name: "CLI token",
			scopes: ["read", "send"],
			created_at: expect.any(String),
			last_used_at: null,
		});
		expect(Object.keys(created.body.record ?? {}).sort()).toEqual([
			"created_at",
			"id",
			"last_used_at",
			"name",
			"scopes",
		]);
		expect(JSON.stringify(created.body.record)).not.toContain("token_hash");

		// Stored is the full token's SHA-256 hex, computed here.
		const record = created.body.record as AccessTokenRecord;
		expect(await rawTokenHash(stubFor(mailbox), record.id)).toBe(
			await sha256Hex(token),
		);

		const list = await getAccessTokens(mailbox);
		expect(list.status).toBe(200);
		expect(Object.keys(list.body).sort()).toEqual(["tokens"]);
		expect(list.body.tokens).toHaveLength(1);
		expect(list.body.tokens?.[0]).toEqual({
			id: record.id,
			name: "CLI token",
			scopes: ["read", "send"],
			created_at: record.created_at,
			last_used_at: null,
		});
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

		const deleted = await deleteAccessToken(mailbox, record.id);
		expect(deleted.status).toBe(200);
		expect(deleted.body).toEqual({ ok: true });
		expect((await getAccessTokens(mailbox)).body.tokens).toEqual([]);
		// The stored row is gone, so the plaintext can never resolve again.
		expect(await rawTokenHash(stubFor(mailbox), record.id)).toBeNull();
		expect((await deleteAccessToken(mailbox, record.id)).status).toBe(404);
		expect((await deleteAccessToken(mailbox, "missing")).status).toBe(404);
	});

	it("400s missing, over-long and bad-scope creates and the cap, naming the reason", async () => {
		const mailbox = "access-tokens-route-invalid@example.com";
		await registerMailbox(mailbox);
		await insertAccessTokens(stubFor(mailbox), []);

		const noName = await postAccessToken(mailbox, { scopes: ["read"] });
		expect(noName.status).toBe(400);
		expect(noName.body.error).toMatch(/name is required/i);

		const blankName = await postAccessToken(mailbox, { name: "   ", scopes: ["read"] });
		expect(blankName.status).toBe(400);
		expect(blankName.body.error).toMatch(/name is required/i);

		const longName = await postAccessToken(mailbox, {
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
			const badScopes = await postAccessToken(mailbox, body);
			expect(badScopes.status).toBe(400);
			expect(badScopes.body.error).toMatch(/read, draft, send/);
		}

		const notAnObject = await postAccessToken(mailbox, "read");
		expect(notAnObject.status).toBe(400);

		// Nothing was stored by any of the rejected writes.
		expect((await getAccessTokens(mailbox)).body.tokens).toEqual([]);

		// The 21st create on a full mailbox is refused by the Durable Object,
		// so it proves the route still answers a 400 with the cap named.
		const capped = "access-tokens-route-cap@example.com";
		await registerMailbox(capped);
		await insertAccessTokens(
			stubFor(capped),
			Array.from({ length: MAX_ACCESS_TOKENS }, (_unused, index) => ({
				id: `route-cap-${index}`,
				name: `Token ${String(index).padStart(2, "0")}`,
				tokenHash: `route-hash-${index}`,
				createdAt: isoAt(index * 1_000),
			})),
		);
		const overCap = await postAccessToken(capped, { name: "One more", scopes: ["read"] });
		expect(overCap.status).toBe(400);
		expect(overCap.body.error).toMatch(/at most 20 access tokens/i);
		expect((await getAccessTokens(capped)).body.tokens).toHaveLength(
			MAX_ACCESS_TOKENS,
		);
	});

	it("404s for an unknown mailbox", async () => {
		const { status } = await getAccessTokens("no-such-mailbox@example.com");
		expect(status).toBe(404);
	});
});
