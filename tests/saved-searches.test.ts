/**
 * Saved searches (per-mailbox named queries) tests.
 *
 * Covers, in order: migration 37's table and index on a fresh DO, the
 * Durable Object CRUD (create with trimming, newest-first ordering with the
 * id tie-break, partial updates, delete semantics, the per-value bounds and
 * the 50-per-mailbox cap), and the saved-searches routes (GET/POST/PATCH/
 * DELETE with their 200/201/400/404 answers and their exact response
 * shapes).
 *
 * Nothing here sends mail: a saved search is a stored query, and the routes
 * only read and write that row.
 */

import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	MAX_SAVED_SEARCHES,
	MAX_SAVED_SEARCH_NAME_LENGTH,
	MAX_SAVED_SEARCH_QUERY_LENGTH,
	type SavedSearch,
} from "../workers/durableObject";

type Stub = ReturnType<typeof stubFor>;

/** Answer shape of the saved-searches routes. */
interface SearchesResponse {
	searches?: SavedSearch[];
	id?: string;
	name?: string;
	query?: string;
	created_at?: string;
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

/**
 * Replace the mailbox's saved searches with exactly these rows, directly —
 * the ordering and cap tests need controlled ids and timestamps. Idempotent:
 * a repeated call reseeds instead of accumulating, because Durable Object
 * storage is not isolated per test.
 */
async function insertSavedSearches(
	stub: Stub,
	rows: { id: string; name: string; query: string; createdAt: string }[],
) {
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec("DELETE FROM saved_searches");
		for (const row of rows) {
			state.storage.sql.exec(
				`INSERT INTO saved_searches (id, name, query, created_at)
				 VALUES (?1, ?2, ?3, ?4)`,
				row.id,
				row.name,
				row.query,
				row.createdAt,
			);
		}
	});
}

/** The mailbox's saved searches, as MailboxDO.listSavedSearches answers. */
async function listOf(stub: Stub): Promise<SavedSearch[]> {
	return (await stub.listSavedSearches()) as unknown as SavedSearch[];
}

/** Create one saved search through the Durable Object and answer the row. */
async function createOn(
	stub: Stub,
	input: { name?: unknown; query?: unknown },
): Promise<SavedSearch | null> {
	return (await stub.createSavedSearch(input)) as unknown as SavedSearch | null;
}

/** A fixed instant plus `offsetMs`, as an ISO string. */
function isoAt(offsetMs: number): string {
	return new Date(Date.parse("2026-01-01T00:00:00.000Z") + offsetMs).toISOString();
}

// ── Route helpers ──────────────────────────────────────────────────

async function getSavedSearches(
	mailbox: string,
): Promise<{ status: number; body: SearchesResponse }> {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/saved-searches`,
	);
	return { status: res.status, body: (await res.json()) as SearchesResponse };
}

async function postSavedSearch(mailbox: string, body: unknown) {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/saved-searches`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	return { status: res.status, body: (await res.json()) as SearchesResponse };
}

async function patchSavedSearch(mailbox: string, id: string, body: unknown) {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/saved-searches/${id}`,
		{
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	return { status: res.status, body: (await res.json()) as SearchesResponse };
}

async function deleteSavedSearchRoute(mailbox: string, id: string) {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/saved-searches/${id}`,
		{ method: "DELETE" },
	);
	return { status: res.status, body: (await res.json()) as SearchesResponse };
}

// ── Migration ──────────────────────────────────────────────────────

describe("migration 37_add_saved_searches", () => {
	it("creates the saved_searches table and its index on a fresh DO", async () => {
		const stub = stubFor("saved-searches-migration@example.com");

		const migration = await runInDurableObject(stub, async (_instance, state) => {
			const table = [
				...state.storage.sql.exec(
					"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'saved_searches'",
				),
			][0] as { sql: string } | undefined;
			const index = [
				...state.storage.sql.exec(
					"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_saved_searches_created'",
				),
			];
			const applied = [
				...state.storage.sql.exec(
					"SELECT name FROM d1_migrations WHERE name = '37_add_saved_searches'",
				),
			];
			return { sql: table?.sql ?? null, index: index.length, applied: applied.length };
		});

		expect(migration.applied).toBe(1);
		expect(migration.index).toBe(1);
		const sql = migration.sql ?? "";
		for (const column of [
			"id TEXT PRIMARY KEY",
			"name TEXT NOT NULL",
			"query TEXT NOT NULL",
			"created_at TEXT NOT NULL",
		]) {
			expect(sql).toContain(column);
		}
	});
});

// ── Durable Object CRUD ────────────────────────────────────────────

describe("saved search CRUD", () => {
	it("stores trimmed values and answers the stored row", async () => {
		const stub = stubFor("saved-searches-create@example.com");
		await insertSavedSearches(stub, []);

		const row = await createOn(stub, {
			name: "  Unread billing  ",
			query: "  from:billing is:unread  ",
		});
		expect(row).toMatchObject({
			name: "Unread billing",
			query: "from:billing is:unread",
		});
		expect(row?.id).toEqual(expect.any(String));
		expect(row?.created_at).toEqual(expect.any(String));

		// Two different searches may share a name: only the cap bounds the list.
		const twin = await createOn(stub, {
			name: "Unread billing",
			query: "is:unread",
		});
		expect(twin?.id).not.toBe(row?.id);
	});

	it("orders newest first, id breaking a created_at tie", async () => {
		const stub = stubFor("saved-searches-order@example.com");
		await insertSavedSearches(stub, [
			{ id: "order-1", name: "Oldest", query: "one", createdAt: isoAt(0) },
			{ id: "order-2", name: "Middle", query: "two", createdAt: isoAt(1_000) },
			{ id: "order-3", name: "Newest", query: "three", createdAt: isoAt(2_000) },
			// The two rows below share a timestamp, so the id decides.
			{ id: "order-b", name: "Tie b", query: "four", createdAt: isoAt(3_000) },
			{ id: "order-a", name: "Tie a", query: "five", createdAt: isoAt(3_000) },
		]);

		expect((await listOf(stub)).map((row) => row.id)).toEqual([
			"order-a",
			"order-b",
			"order-3",
			"order-2",
			"order-1",
		]);
	});

	it("applies partial updates and reports a missing id as null", async () => {
		const stub = stubFor("saved-searches-update@example.com");
		await insertSavedSearches(stub, []);
		const created = await createOn(stub, { name: "Follow-up", query: "is:unread" });

		const renamed = (await stub.updateSavedSearch(created?.id as string, {
			name: "  Follow-up v2  ",
		})) as unknown as SavedSearch | null;
		expect(renamed).toMatchObject({
			id: created?.id,
			name: "Follow-up v2",
			query: "is:unread",
			created_at: created?.created_at,
		});

		const requeryed = (await stub.updateSavedSearch(created?.id as string, {
			query: "  has:attachment from:billing  ",
		})) as unknown as SavedSearch | null;
		expect(requeryed).toMatchObject({
			name: "Follow-up v2",
			query: "has:attachment from:billing",
		});

		// An update with no fields at all is a no-op, not a miss.
		const untouched = (await stub.updateSavedSearch(created?.id as string, {})) as
			unknown as SavedSearch | null;
		expect(untouched).toMatchObject({ name: "Follow-up v2" });

		expect(await stub.updateSavedSearch("missing", { name: "Nope" })).toBeNull();
		expect((await listOf(stub)).map((row) => row.name)).toEqual(["Follow-up v2"]);
	});

	it("deletes a saved search once and reports a missing id", async () => {
		const stub = stubFor("saved-searches-delete@example.com");
		await insertSavedSearches(stub, []);
		const created = await createOn(stub, { name: "Short-lived", query: "is:starred" });

		expect(await stub.deleteSavedSearch(created?.id as string)).toBe(true);
		expect(await listOf(stub)).toEqual([]);
		expect(await stub.deleteSavedSearch(created?.id as string)).toBe(false);
	});

	it("refuses unusable values and the cap instead of clipping them", async () => {
		const stub = stubFor("saved-searches-bounds@example.com");
		await insertSavedSearches(stub, []);

		await runInDurableObject(stub, async (instance) => {
			// Blank, non-string and over-long values are all refused (null),
			// never stored trimmed to fit.
			expect(instance.createSavedSearch({ name: "   ", query: "is:unread" })).toBeNull();
			expect(instance.createSavedSearch({ name: "Named", query: "   " })).toBeNull();
			expect(instance.createSavedSearch({ name: 12, query: "is:unread" })).toBeNull();
			expect(instance.createSavedSearch({ name: "Named", query: null })).toBeNull();
			expect(
				instance.createSavedSearch({
					name: "x".repeat(MAX_SAVED_SEARCH_NAME_LENGTH + 1),
					query: "is:unread",
				}),
			).toBeNull();
			expect(
				instance.createSavedSearch({
					name: "Named",
					query: "y".repeat(MAX_SAVED_SEARCH_QUERY_LENGTH + 1),
				}),
			).toBeNull();
			// A boundary value is accepted, so the bounds are inclusive.
			expect(
				instance.createSavedSearch({
					name: "x".repeat(MAX_SAVED_SEARCH_NAME_LENGTH),
					query: "y".repeat(MAX_SAVED_SEARCH_QUERY_LENGTH),
				}),
			).not.toBeNull();
		});

		// A partial update is validated with the same bounds.
		const created = (await listOf(stub))[0] as SavedSearch;
		expect(await stub.updateSavedSearch(created.id, { name: "   " })).toBeNull();
		expect(
			await stub.updateSavedSearch(created.id, {
				query: "z".repeat(MAX_SAVED_SEARCH_QUERY_LENGTH + 1),
			}),
		).toBeNull();
		expect((await listOf(stub))[0]).toMatchObject({
			name: created.name,
			query: created.query,
		});

		// The cap: 50 stored rows refuse a 51st, and removing one makes room.
		await insertSavedSearches(
			stub,
			Array.from({ length: MAX_SAVED_SEARCHES }, (_unused, index) => ({
				id: `cap-${index}`,
				name: `Search ${String(index).padStart(3, "0")}`,
				query: `term-${index}`,
				createdAt: isoAt(index * 1_000),
			})),
		);
		expect(
			await createOn(stub, { name: "One more", query: "is:unread" }),
		).toBeNull();
		expect(await listOf(stub)).toHaveLength(MAX_SAVED_SEARCHES);

		expect(await stub.deleteSavedSearch("cap-0")).toBe(true);
		const createdAfter = await createOn(stub, { name: "One more", query: "is:unread" });
		expect(createdAfter?.name).toBe("One more");
		expect(await listOf(stub)).toHaveLength(MAX_SAVED_SEARCHES);
	});
});

// ── Routes ─────────────────────────────────────────────────────────

describe("saved searches routes", () => {
	it("creates, lists, updates and deletes one with the frozen shapes", async () => {
		const mailbox = "saved-searches-route@example.com";
		await registerMailbox(mailbox);
		await insertSavedSearches(stubFor(mailbox), []);

		const created = await postSavedSearch(mailbox, {
			name: "  Unread billing  ",
			query: "  from:billing is:unread  ",
		});
		expect(created.status).toBe(201);
		expect(created.body).toMatchObject({
			name: "Unread billing",
			query: "from:billing is:unread",
		});
		expect(created.body.id).toEqual(expect.any(String));
		expect(created.body.created_at).toEqual(expect.any(String));

		const list = await getSavedSearches(mailbox);
		expect(list.status).toBe(200);
		expect(list.body.searches).toHaveLength(1);
		expect(list.body.searches?.[0]).toMatchObject({
			id: created.body.id,
			name: "Unread billing",
			query: "from:billing is:unread",
			created_at: created.body.created_at,
		});
		// The row shape is frozen: id, name, query, created_at and nothing else.
		expect(Object.keys(list.body.searches?.[0] ?? {}).sort()).toEqual([
			"created_at",
			"id",
			"name",
			"query",
		]);

		const updated = await patchSavedSearch(mailbox, created.body.id as string, {
			name: "  Billing 2026  ",
		});
		expect(updated.status).toBe(200);
		expect(updated.body).toMatchObject({
			id: created.body.id,
			name: "Billing 2026",
			query: "from:billing is:unread",
			created_at: created.body.created_at,
		});

		const requeryed = await patchSavedSearch(mailbox, created.body.id as string, {
			query: "from:billing",
		});
		expect(requeryed.status).toBe(200);
		expect(requeryed.body).toMatchObject({
			name: "Billing 2026",
			query: "from:billing",
		});

		const deleted = await deleteSavedSearchRoute(mailbox, created.body.id as string);
		expect(deleted.status).toBe(200);
		expect(deleted.body).toEqual({ ok: true });
		expect((await getSavedSearches(mailbox)).body.searches).toEqual([]);
		expect((await deleteSavedSearchRoute(mailbox, created.body.id as string)).status).toBe(404);
	});

	it("lists newest first over the route", async () => {
		const mailbox = "saved-searches-route-order@example.com";
		await registerMailbox(mailbox);
		await insertSavedSearches(stubFor(mailbox), [
			{ id: "route-old", name: "Old", query: "one", createdAt: isoAt(0) },
			{ id: "route-new", name: "New", query: "two", createdAt: isoAt(2_000) },
			{ id: "route-mid", name: "Mid", query: "three", createdAt: isoAt(1_000) },
		]);

		const list = await getSavedSearches(mailbox);
		expect(list.status).toBe(200);
		expect(list.body.searches?.map((row) => row.id)).toEqual([
			"route-new",
			"route-mid",
			"route-old",
		]);
	});

	it("rejects empty, over-long and over-cap creates with a 400", async () => {
		const invalid = "saved-searches-route-invalid@example.com";
		await registerMailbox(invalid);
		await insertSavedSearches(stubFor(invalid), []);

		const noName = await postSavedSearch(invalid, { name: "   ", query: "is:unread" });
		expect(noName.status).toBe(400);
		expect(noName.body.error).toMatch(/saved search name is required/i);

		const noQuery = await postSavedSearch(invalid, { name: "Named", query: "" });
		expect(noQuery.status).toBe(400);
		expect(noQuery.body.error).toMatch(/saved search query is required/i);

		const longName = await postSavedSearch(invalid, {
			name: "x".repeat(MAX_SAVED_SEARCH_NAME_LENGTH + 1),
			query: "is:unread",
		});
		expect(longName.status).toBe(400);
		expect(longName.body.error).toMatch(/at most 120 characters/i);

		const longQuery = await postSavedSearch(invalid, {
			name: "Named",
			query: "y".repeat(MAX_SAVED_SEARCH_QUERY_LENGTH + 1),
		});
		expect(longQuery.status).toBe(400);
		expect(longQuery.body.error).toMatch(/at most 1000 characters/i);

		// Nothing was stored by any of the rejected writes.
		expect((await getSavedSearches(invalid)).body.searches).toEqual([]);

		// The 51st create on a full mailbox is the one path where the Durable
		// Object itself refuses, so it proves the route still answers a 400.
		const capped = "saved-searches-route-cap@example.com";
		await registerMailbox(capped);
		await insertSavedSearches(
			stubFor(capped),
			Array.from({ length: MAX_SAVED_SEARCHES }, (_unused, index) => ({
				id: `route-cap-${index}`,
				name: `Search ${String(index).padStart(3, "0")}`,
				query: `term-${index}`,
				createdAt: isoAt(index * 1_000),
			})),
		);
		const overCap = await postSavedSearch(capped, { name: "One more", query: "is:unread" });
		expect(overCap.status).toBe(400);
		expect(overCap.body.error).toMatch(/at most 50 saved searches/i);
		expect((await getSavedSearches(capped)).body.searches).toHaveLength(MAX_SAVED_SEARCHES);
	});

	it("400s an unusable patch and 404s an unknown id", async () => {
		const mailbox = "saved-searches-route-patch@example.com";
		await registerMailbox(mailbox);
		await insertSavedSearches(stubFor(mailbox), []);
		const created = await postSavedSearch(mailbox, { name: "Kept", query: "is:unread" });
		const id = created.body.id as string;

		const blankName = await patchSavedSearch(mailbox, id, { name: "   " });
		expect(blankName.status).toBe(400);
		expect(blankName.body.error).toMatch(/saved search name is required/i);

		const longQuery = await patchSavedSearch(mailbox, id, {
			query: "y".repeat(MAX_SAVED_SEARCH_QUERY_LENGTH + 1),
		});
		expect(longQuery.status).toBe(400);
		expect(longQuery.body.error).toMatch(/at most 1000 characters/i);

		expect((await patchSavedSearch(mailbox, "missing", { name: "Nope" })).status).toBe(404);
		expect((await patchSavedSearch(mailbox, "missing", { query: "is:unread" })).status).toBe(404);
		expect((await deleteSavedSearchRoute(mailbox, "missing")).status).toBe(404);

		// The rejected patches left the stored row alone.
		expect((await getSavedSearches(mailbox)).body.searches?.[0]).toMatchObject({
			name: "Kept",
			query: "is:unread",
		});
		expect((await deleteSavedSearchRoute(mailbox, id)).status).toBe(200);
	});

	it("404s for an unknown mailbox", async () => {
		const { status } = await getSavedSearches("no-such-mailbox@example.com");
		expect(status).toBe(404);
	});
});
