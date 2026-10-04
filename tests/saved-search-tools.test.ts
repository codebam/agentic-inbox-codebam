/**
 * Saved-search tools (list/create/update/delete) tests.
 *
 * These are the shared tool implementations behind the MCP server's and the
 * agent's saved-search tools. This file covers, in order: the create/list
 * round-trip over real Durable Object state, partial updates of the name
 * and the query, deletion and its missing-id path, duplicate names
 * (accepted, exactly like the web route — saved searches have no
 * uniqueness rule), the bound violations with the routes' exact messages,
 * the 50-per-mailbox cap, and the list answer compared against the web GET
 * route's body.
 *
 * Nothing here sends mail: a saved search is a stored query, and the tools
 * only read and write that row.
 */

import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	MAX_SAVED_SEARCHES,
	MAX_SAVED_SEARCH_NAME_LENGTH,
	MAX_SAVED_SEARCH_QUERY_LENGTH,
	type SavedSearch,
} from "../workers/durableObject";
import {
	toolCreateSavedSearch,
	toolDeleteSavedSearch,
	toolListSavedSearches,
	toolUpdateSavedSearch,
} from "../workers/lib/tools";

type Stub = ReturnType<typeof stubFor>;

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

/** Register the mailbox record the API middleware checks before routing. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
}

/**
 * Replace the mailbox's saved searches with exactly these rows, directly —
 * the cap test needs a controlled full mailbox. Idempotent: a repeated call
 * reseeds instead of accumulating, because Durable Object storage is not
 * isolated per test.
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

/** The mailbox's stored saved searches, straight from the Durable Object. */
async function storedSearches(stub: Stub): Promise<SavedSearch[]> {
	return (await stub.listSavedSearches()) as unknown as SavedSearch[];
}

/** The row keys the tools and the web route both answer with. */
const ROW_KEYS = ["created_at", "id", "name", "query"];

describe("saved search tools", () => {
	it("creates and lists a saved search over real DO state", async () => {
		const mailbox = "saved-search-tools-create@example.com";
		const stub = stubFor(mailbox);
		await insertSavedSearches(stub, []);

		const created = (await toolCreateSavedSearch(env, mailbox, {
			name: "  Unread billing  ",
			query: "  from:billing is:unread  ",
		})) as unknown as SavedSearch;
		expect(created).toMatchObject({
			name: "Unread billing",
			query: "from:billing is:unread",
		});
		expect(created.id).toEqual(expect.any(String));
		expect(created.created_at).toEqual(expect.any(String));

		// Real DO state: the row the tool answered is the row stored.
		const stored = await storedSearches(stub);
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({
			id: created.id,
			name: "Unread billing",
			query: "from:billing is:unread",
			created_at: created.created_at,
		});

		const listed = await toolListSavedSearches(env, mailbox);
		expect(listed.searches).toHaveLength(1);
		expect(listed.searches[0]).toMatchObject({ id: created.id });
		// The row shape is frozen: id, name, query, created_at and nothing else.
		expect(Object.keys(listed.searches[0] ?? {}).sort()).toEqual(ROW_KEYS);
	});

	it("updates the name and the query, keeping the other fields", async () => {
		const mailbox = "saved-search-tools-update@example.com";
		const stub = stubFor(mailbox);
		await insertSavedSearches(stub, []);
		const created = (await toolCreateSavedSearch(env, mailbox, {
			name: "Follow-up",
			query: "is:unread",
		})) as unknown as SavedSearch;

		const renamed = (await toolUpdateSavedSearch(env, mailbox, {
			searchId: created.id,
			name: "  Follow-up v2  ",
		})) as unknown as SavedSearch;
		expect(renamed).toMatchObject({
			id: created.id,
			name: "Follow-up v2",
			query: "is:unread",
			created_at: created.created_at,
		});

		const requeryed = (await toolUpdateSavedSearch(env, mailbox, {
			searchId: created.id,
			query: "  has:attachment from:billing  ",
		})) as unknown as SavedSearch;
		expect(requeryed).toMatchObject({
			name: "Follow-up v2",
			query: "has:attachment from:billing",
		});

		// Real DO state agrees with both answers, and an update with no
		// fields at all is a no-op, not a miss.
		expect(await storedSearches(stub)).toMatchObject([
			{
				id: created.id,
				name: "Follow-up v2",
				query: "has:attachment from:billing",
				created_at: created.created_at,
			},
		]);
		const untouched = (await toolUpdateSavedSearch(env, mailbox, {
			searchId: created.id,
		})) as unknown as SavedSearch;
		expect(untouched).toMatchObject({ name: "Follow-up v2" });
	});

	it("deletes once and answers the route's missing-id error", async () => {
		const mailbox = "saved-search-tools-delete@example.com";
		const stub = stubFor(mailbox);
		await insertSavedSearches(stub, []);
		const created = (await toolCreateSavedSearch(env, mailbox, {
			name: "Short-lived",
			query: "is:starred",
		})) as unknown as SavedSearch;

		expect(
			await toolDeleteSavedSearch(env, mailbox, { searchId: created.id }),
		).toEqual({ ok: true });
		expect(await storedSearches(stub)).toEqual([]);
		expect((await toolListSavedSearches(env, mailbox)).searches).toEqual([]);

		// A second delete and an unknown id both mirror the route's 404 body.
		expect(
			await toolDeleteSavedSearch(env, mailbox, { searchId: created.id }),
		).toEqual({ error: "Saved search not found" });
		expect(
			await toolUpdateSavedSearch(env, mailbox, { searchId: "missing", name: "Nope" }),
		).toEqual({ error: "Saved search not found" });
	});

	it("accepts duplicate names, exactly like the web route", async () => {
		const mailbox = "saved-search-tools-duplicate@example.com";
		const stub = stubFor(mailbox);
		await insertSavedSearches(stub, []);
		await registerMailbox(mailbox);

		const first = (await toolCreateSavedSearch(env, mailbox, {
			name: "Unread billing",
			query: "is:unread",
		})) as unknown as SavedSearch;
		const second = (await toolCreateSavedSearch(env, mailbox, {
			name: "Unread billing",
			query: "from:billing",
		})) as unknown as SavedSearch;
		expect(second.id).not.toBe(first.id);

		// The web route stores the twin too — a duplicate name is not an error.
		const route = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/saved-searches`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "Unread billing", query: "is:starred" }),
			},
		);
		expect(route.status).toBe(201);
		expect(await storedSearches(stub)).toHaveLength(3);
	});

	it("refuses unusable values with the routes' exact messages", async () => {
		const mailbox = "saved-search-tools-bounds@example.com";
		const stub = stubFor(mailbox);
		await insertSavedSearches(stub, []);

		// A null input is the route's malformed-body answer.
		expect(await toolCreateSavedSearch(env, mailbox, null)).toEqual({
			error: "Invalid saved search",
		});
		expect(
			await toolCreateSavedSearch(env, mailbox, { name: "   ", query: "is:unread" }),
		).toEqual({ error: "A saved search name is required" });
		expect(
			await toolCreateSavedSearch(env, mailbox, { name: "Named", query: "" }),
		).toEqual({ error: "A saved search query is required" });
		// A non-string value is "required", the same verdict the route gives.
		expect(
			await toolCreateSavedSearch(env, mailbox, { name: 12, query: "is:unread" }),
		).toEqual({ error: "A saved search name is required" });
		expect(
			await toolCreateSavedSearch(env, mailbox, {
				name: "x".repeat(MAX_SAVED_SEARCH_NAME_LENGTH + 1),
				query: "is:unread",
			}),
		).toEqual({
			error: `A saved search name can be at most ${MAX_SAVED_SEARCH_NAME_LENGTH} characters`,
		});
		expect(
			await toolCreateSavedSearch(env, mailbox, {
				name: "Named",
				query: "y".repeat(MAX_SAVED_SEARCH_QUERY_LENGTH + 1),
			}),
		).toEqual({
			error: `A saved search query can be at most ${MAX_SAVED_SEARCH_QUERY_LENGTH} characters`,
		});

		// Nothing was stored by any rejected write.
		expect(await storedSearches(stub)).toEqual([]);

		// A boundary value is accepted, so the bounds are inclusive.
		const boundary = (await toolCreateSavedSearch(env, mailbox, {
			name: "x".repeat(MAX_SAVED_SEARCH_NAME_LENGTH),
			query: "y".repeat(MAX_SAVED_SEARCH_QUERY_LENGTH),
		})) as unknown as SavedSearch;
		expect(boundary.name).toHaveLength(MAX_SAVED_SEARCH_NAME_LENGTH);

		// A partial update is validated with the same bounds and messages.
		expect(
			await toolUpdateSavedSearch(env, mailbox, { searchId: boundary.id, name: "   " }),
		).toEqual({ error: "A saved search name is required" });
		expect(
			await toolUpdateSavedSearch(env, mailbox, {
				searchId: boundary.id,
				query: "z".repeat(MAX_SAVED_SEARCH_QUERY_LENGTH + 1),
			}),
		).toEqual({
			error: `A saved search query can be at most ${MAX_SAVED_SEARCH_QUERY_LENGTH} characters`,
		});
		// The rejected patches left the stored row alone.
		expect((await storedSearches(stub))[0]).toMatchObject({
			name: boundary.name,
			query: boundary.query,
		});
	});

	it("refuses the 51st saved search and makes room after a delete", async () => {
		const mailbox = "saved-search-tools-cap@example.com";
		const stub = stubFor(mailbox);
		await insertSavedSearches(
			stub,
			Array.from({ length: MAX_SAVED_SEARCHES }, (_unused, index) => ({
				id: `cap-${index}`,
				name: `Search ${String(index).padStart(3, "0")}`,
				query: `term-${index}`,
				createdAt: new Date(
					Date.parse("2026-01-01T00:00:00.000Z") + index * 1_000,
				).toISOString(),
			})),
		);

		expect(
			await toolCreateSavedSearch(env, mailbox, { name: "One more", query: "is:unread" }),
		).toEqual({
			error: `A mailbox can hold at most ${MAX_SAVED_SEARCHES} saved searches`,
		});
		expect(await storedSearches(stub)).toHaveLength(MAX_SAVED_SEARCHES);

		expect(
			await toolDeleteSavedSearch(env, mailbox, { searchId: "cap-0" }),
		).toEqual({ ok: true });
		const created = (await toolCreateSavedSearch(env, mailbox, {
			name: "One more",
			query: "is:unread",
		})) as unknown as SavedSearch;
		expect(created.name).toBe("One more");
		expect(await storedSearches(stub)).toHaveLength(MAX_SAVED_SEARCHES);
	});

	it("answers the same searches shape as the web GET route", async () => {
		const mailbox = "saved-search-tools-route@example.com";
		const stub = stubFor(mailbox);
		await insertSavedSearches(stub, []);
		await registerMailbox(mailbox);

		// Two stored searches, both created through the tool.
		await toolCreateSavedSearch(env, mailbox, {
			name: "Unread billing",
			query: "from:billing is:unread",
		});
		await toolCreateSavedSearch(env, mailbox, {
			name: "Starred",
			query: "is:starred",
		});

		const listed = await toolListSavedSearches(env, mailbox);
		const route = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/saved-searches`,
		);
		expect(route.status).toBe(200);
		const body = (await route.json()) as { searches: SavedSearch[] };

		// The tool answers exactly the route's body — same array, same rows,
		// same order — and nothing else.
		expect(listed).toEqual({ searches: body.searches });
		expect(Object.keys(listed).sort()).toEqual(["searches"]);
		expect(body.searches).toHaveLength(2);
		for (const row of body.searches) {
			expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
		}
	});
});
