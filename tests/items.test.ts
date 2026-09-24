/**
 * Task / deadline extraction (roadmap item 16) tests.
 *
 * Covers, in order: parseExtractedItems (the defensive parser — code fences,
 * unusable shapes, the length clamps, the due-date horizon and normalization,
 * and the five-item cap), the Durable Object (insert stamping, listItems with
 * every filter plus ordering/totalCount/paging, listItemsForEmail,
 * updateItemStatus, and the prune rule that protects open rows), the items
 * routes (list shape and filters, the 400s, the per-email list, the PUT round
 * trip and its 400/404 answers), the read-only list_items tool, and
 * insertExtractedItems on the paths that never reach a working model.
 *
 * The pool cannot run models — `env.AI` answers "Binding AI needs to be run
 * remotely" — so nothing here asserts what a real model returns; the parser
 * is tested directly instead, and the extraction failure branch is exercised
 * with a throwing stub. Nothing in this file sends mail.
 */

import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createEmailTools } from "../workers/agent/index";
import {
	insertExtractedItems,
	parseExtractedItems,
	type ExtractedItem,
} from "../workers/lib/items";
import { toolListItems } from "../workers/lib/tools";

type Stub = ReturnType<typeof stubFor>;

/** Answer shapes of the items routes and the tool. */
interface ItemsResponse {
	items?: ExtractedItem[];
	totalCount?: number;
	page?: number;
	limit?: number;
	item?: ExtractedItem;
	error?: string;
}

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

/** Register the mailbox record the API middleware checks before routing. */
async function registerMailbox(
	mailbox: string,
	settings: Record<string, unknown> = {},
) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify(settings));
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const YEAR_MS = 365 * DAY_MS;

/** An ISO instant `offsetMs` away from now. */
function isoFromNow(offsetMs: number): string {
	return new Date(Date.now() + offsetMs).toISOString();
}

/**
 * An instant inside today's UTC day — the "due today" bucket — whatever time
 * of day the suite runs at. "Now plus an hour" would fall into tomorrow near
 * midnight UTC, so the candidate is clamped to the end of the day.
 */
function todayInstant(): string {
	const start = new Date();
	start.setUTCHours(0, 0, 0, 0);
	const endOfToday = start.getTime() + DAY_MS - 1;
	return new Date(Math.min(Date.now() + HOUR_MS, endOfToday)).toISOString();
}

/** The mailbox's items, as MailboxDO.listItems returns them. */
async function listOn(
	stub: Stub,
	filters: Record<string, unknown> = {},
): Promise<{ items: ExtractedItem[]; totalCount: number }> {
	return (await stub.listItems(filters)) as unknown as {
		items: ExtractedItem[];
		totalCount: number;
	};
}

/**
 * Replace the mailbox's items with exactly these rows, directly — the
 * ordering, filter and prune tests need controlled timestamps. Idempotent:
 * a repeated call reseeds instead of accumulating, because Durable Object
 * storage is not isolated per test.
 */
async function seedItems(
	stub: Stub,
	rows: {
		id: string;
		emailId: string;
		kind?: string;
		title?: string;
		details?: string | null;
		dueAt?: string | null;
		status?: string;
		createdAt: string;
	}[],
) {
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec("DELETE FROM extracted_items");
		for (const row of rows) {
			state.storage.sql.exec(
				`INSERT INTO extracted_items
				 (id, email_id, thread_id, kind, title, details, due_at, status, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
				row.id,
				row.emailId,
				null,
				row.kind ?? "task",
				row.title ?? `Title ${row.id}`,
				row.details ?? null,
				row.dueAt ?? null,
				row.status ?? "open",
				row.createdAt,
			);
		}
	});
}

/**
 * Run COUNT(*) queries against the items table directly, keyed by name — the
 * prune tests need counts, not the newest page of rows.
 */
async function itemCounts(
	stub: Stub,
	queries: Record<string, string>,
): Promise<Record<string, number>> {
	return runInDurableObject(stub, async (_instance, state) => {
		const counts: Record<string, number> = {};
		for (const [name, sql] of Object.entries(queries)) {
			const rows = [...state.storage.sql.exec(sql)] as { c: number }[];
			counts[name] = rows[0]?.c ?? 0;
		}
		return counts;
	});
}

/** GET the mailbox's items with optional query values. */
async function getItems(
	mailbox: string,
	query = "",
): Promise<{ status: number; body: ItemsResponse }> {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/items${query}`,
	);
	return { status: res.status, body: (await res.json()) as ItemsResponse };
}

describe("parseExtractedItems", () => {
	it("reads a fenced JSON answer and a bare one", () => {
		const fenced = parseExtractedItems(
			'```json\n{"items":[{"kind":"task","title":"Send the report","details":"by Friday","due_at":null}]}\n```',
		);
		expect(fenced).toEqual([
			{
				kind: "task",
				title: "Send the report",
				details: "by Friday",
				due_at: null,
			},
		]);

		expect(
			parseExtractedItems(
				'{"items":[{"kind":"deadline","title":"Renew the domain"}]}',
			),
		).toEqual([
			{ kind: "deadline", title: "Renew the domain", details: null, due_at: null },
		]);
	});

	it("reads an answer wrapped in a sentence", () => {
		expect(
			parseExtractedItems(
				'Sure! Here is the JSON:\n{"items":[{"title":"Pay the invoice"}]}\nHope that helps.',
			),
		).toEqual([
			{ kind: "task", title: "Pay the invoice", details: null, due_at: null },
		]);
	});

	it("answers [] for anything it cannot read as { items: [...] }", () => {
		expect(parseExtractedItems("")).toEqual([]);
		expect(parseExtractedItems("not json at all")).toEqual([]);
		expect(parseExtractedItems('{"items":[{"title":"x"')).toEqual([]);
		expect(parseExtractedItems('{"tasks":[{"title":"x"}]}')).toEqual([]);
		expect(parseExtractedItems('{"items":"nope"}')).toEqual([]);
		expect(parseExtractedItems('{"items":[]}')).toEqual([]);
		expect(parseExtractedItems("[]")).toEqual([]);
		expect(parseExtractedItems('"a string"')).toEqual([]);
	});

	it("drops entries without a usable title and defaults the kind", () => {
		const items = parseExtractedItems(
			JSON.stringify({
				items: [
					{ title: "   " },
					{ kind: "reminder", title: "Keep the kind in the vocabulary" },
					{ title: 42 },
					{ kind: "deadline", title: "File the taxes" },
					{ title: "  Trim me  " },
				],
			}),
		);
		expect(items).toEqual([
			{ kind: "task", title: "Keep the kind in the vocabulary", details: null, due_at: null },
			{ kind: "deadline", title: "File the taxes", details: null, due_at: null },
			{ kind: "task", title: "Trim me", details: null, due_at: null },
		]);
	});

	it("clamps titles to 200 and details to 1000 characters", () => {
		const items = parseExtractedItems(
			JSON.stringify({
				items: [{ title: "t".repeat(300), details: "d".repeat(1500) }],
			}),
		);
		expect(items).toHaveLength(1);
		expect(items[0]?.title).toHaveLength(200);
		expect(items[0]?.details).toHaveLength(1000);
	});

	it("keeps a stated due date within the horizon and normalizes it to UTC", () => {
		const inAMonth = isoFromNow(30 * DAY_MS);
		const yesterday = isoFromNow(-DAY_MS);
		const items = parseExtractedItems(
			JSON.stringify({
				items: [
					{ title: "Due next month", due_at: inAMonth },
					{ title: "Overdue yesterday", due_at: yesterday },
					{ title: "Offset date", due_at: "2027-01-05T10:00:00+02:00" },
					{ title: "Date only", due_at: "2027-03-01" },
				],
			}),
		);
		expect(items.map((item) => item.due_at)).toEqual([
			inAMonth,
			yesterday,
			"2027-01-05T08:00:00.000Z",
			"2027-03-01T00:00:00.000Z",
		]);
	});

	it("drops a due date that is unparseable or beyond the horizon", () => {
		const items = parseExtractedItems(
			JSON.stringify({
				items: [
					{ title: "Way out", due_at: isoFromNow(3 * YEAR_MS) },
					{ title: "Way back", due_at: isoFromNow(-3 * YEAR_MS) },
					{ title: "Not a date", due_at: "sometime soon" },
					{ title: "Not a string", due_at: 20270105 },
					{ title: "Blank", due_at: "   " },
				],
			}),
		);
		expect(items).toHaveLength(5);
		expect(items.every((item) => item.due_at === null)).toBe(true);
	});

	it("keeps at most five items", () => {
		const items = parseExtractedItems(
			JSON.stringify({
				items: Array.from({ length: 9 }, (_value, index) => ({
					title: `Task ${index}`,
				})),
			}),
		);
		expect(items).toHaveLength(5);
		expect(items.map((item) => item.title)).toEqual([
			"Task 0",
			"Task 1",
			"Task 2",
			"Task 3",
			"Task 4",
		]);
	});
});

describe("MailboxDO items", () => {
	it("stamps ids, timestamps and the open status on insert", async () => {
		const mailbox = "items-do-insert@example.com";
		const stub = stubFor(mailbox);
		const rows = (await stub.insertItems("do-insert-1", "thread-9", [
			{ kind: "deadline", title: "Pay the invoice", details: "NET 30", due_at: isoFromNow(DAY_MS) },
			{ kind: "task", title: "Send the receipt", details: null, due_at: null },
		])) as unknown as ExtractedItem[];

		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
			expect(row.email_id).toBe("do-insert-1");
			expect(row.thread_id).toBe("thread-9");
			expect(row.status).toBe("open");
			expect(Date.parse(row.created_at)).not.toBeNaN();
			expect(row.updated_at).toBe(row.created_at);
		}
		expect(rows.map((row) => row.title)).toEqual([
			"Pay the invoice",
			"Send the receipt",
		]);

		// listItems is newest first, so the two rows come back in reverse
		// insert order.
		const listed = await listOn(stub, {});
		expect(listed.totalCount).toBe(2);
		expect(listed.items).toHaveLength(2);
		expect(listed.items.map((item) => item.id)).toEqual(
			rows.map((row) => row.id).reverse(),
		);
	});

	it("orders newest first and filters by status", async () => {
		const mailbox = "items-do-status@example.com";
		const stub = stubFor(mailbox);
		await seedItems(stub, [
			{ id: "s-1", emailId: "m-1", createdAt: "2026-01-01T00:00:00.000Z", status: "open" },
			{ id: "s-2", emailId: "m-1", createdAt: "2026-01-02T00:00:00.000Z", status: "done" },
			{ id: "s-3", emailId: "m-2", createdAt: "2026-01-03T00:00:00.000Z", status: "dismissed" },
			{ id: "s-4", emailId: "m-2", createdAt: "2026-01-04T00:00:00.000Z", status: "open" },
		]);

		const all = await listOn(stub, {});
		expect(all.totalCount).toBe(4);
		expect(all.items.map((item) => item.id)).toEqual(["s-4", "s-3", "s-2", "s-1"]);

		const open = await listOn(stub, { status: "open" });
		expect(open.totalCount).toBe(2);
		expect(open.items.map((item) => item.id)).toEqual(["s-4", "s-1"]);

		const done = await listOn(stub, { status: "done" });
		expect(done.items.map((item) => item.id)).toEqual(["s-2"]);

		const dismissed = await listOn(stub, { status: "dismissed" });
		expect(dismissed.items.map((item) => item.id)).toEqual(["s-3"]);

		// A status outside the vocabulary is ignored, not rejected.
		const bogus = await listOn(stub, { status: "archived" });
		expect(bogus.totalCount).toBe(4);
	});

	it("filters by due bucket", async () => {
		const mailbox = "items-do-due@example.com";
		const stub = stubFor(mailbox);
		await seedItems(stub, [
			{ id: "d-overdue", emailId: "m-1", dueAt: isoFromNow(-DAY_MS), createdAt: "2026-01-01T00:00:00.000Z" },
			{ id: "d-today", emailId: "m-1", dueAt: todayInstant(), createdAt: "2026-01-02T00:00:00.000Z" },
			{ id: "d-upcoming", emailId: "m-2", dueAt: isoFromNow(2 * DAY_MS), createdAt: "2026-01-03T00:00:00.000Z" },
			{ id: "d-none", emailId: "m-2", dueAt: null, createdAt: "2026-01-04T00:00:00.000Z" },
		]);

		const overdue = await listOn(stub, { due: "overdue" });
		expect(overdue.items.map((item) => item.id)).toEqual(["d-overdue"]);

		const today = await listOn(stub, { due: "today" });
		expect(today.items.map((item) => item.id)).toEqual(["d-today"]);

		const upcoming = await listOn(stub, { due: "upcoming" });
		expect(upcoming.items.map((item) => item.id)).toEqual(["d-upcoming"]);

		const none = await listOn(stub, { due: "none" });
		expect(none.items.map((item) => item.id)).toEqual(["d-none"]);

		// A bucket outside the vocabulary is ignored, not rejected.
		const bogus = await listOn(stub, { due: "later" });
		expect(bogus.totalCount).toBe(4);

		// Buckets combine with the status filter.
		const combined = await listOn(stub, { status: "open", due: "none" });
		expect(combined.items.map((item) => item.id)).toEqual(["d-none"]);
	});

	it("caps the page size, floors the page and counts the filtered total", async () => {
		const mailbox = "items-do-page@example.com";
		const stub = stubFor(mailbox);
		await seedItems(
			stub,
			Array.from({ length: 7 }, (_value, index) => ({
				id: `p-${index}`,
				emailId: "m-1",
				createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
			})),
		);

		const firstPage = await listOn(stub, { limit: 3 });
		expect(firstPage.totalCount).toBe(7);
		expect(firstPage.items.map((item) => item.id)).toEqual(["p-6", "p-5", "p-4"]);

		const secondPage = await listOn(stub, { limit: 3, page: 2 });
		expect(secondPage.items.map((item) => item.id)).toEqual(["p-3", "p-2", "p-1"]);

		// A page below 1 is read as the first page, and the limit is capped.
		const floored = await listOn(stub, { limit: 500, page: 0 });
		expect(floored.items).toHaveLength(7);
		const zeroLimit = await listOn(stub, { limit: 0 });
		expect(zeroLimit.items).toHaveLength(1);
	});

	it("answers one message's items, newest first", async () => {
		const mailbox = "items-do-email@example.com";
		const stub = stubFor(mailbox);
		await seedItems(stub, [
			{ id: "e-1", emailId: "mail-1", createdAt: "2026-01-01T00:00:00.000Z" },
			{ id: "e-2", emailId: "mail-2", createdAt: "2026-01-02T00:00:00.000Z" },
			{ id: "e-3", emailId: "mail-1", createdAt: "2026-01-03T00:00:00.000Z" },
		]);

		const forMail1 = (await stub.listItemsForEmail("mail-1")) as unknown as ExtractedItem[];
		expect(forMail1.map((item) => item.id)).toEqual(["e-3", "e-1"]);
		expect(
			(await stub.listItemsForEmail("missing")) as unknown as ExtractedItem[],
		).toEqual([]);
	});

	it("moves an item through every status and reports unknown ids", async () => {
		const mailbox = "items-do-update@example.com";
		const stub = stubFor(mailbox);
		await seedItems(stub, [
			{ id: "u-1", emailId: "m-1", createdAt: "2026-01-01T00:00:00.000Z" },
		]);

		const done = (await stub.updateItemStatus("u-1", "done")) as unknown as ExtractedItem;
		expect(done.status).toBe("done");
		expect(done.id).toBe("u-1");

		const dismissed = (await stub.updateItemStatus("u-1", "dismissed")) as unknown as ExtractedItem;
		expect(dismissed.status).toBe("dismissed");

		const reopened = (await stub.updateItemStatus("u-1", "open")) as unknown as ExtractedItem;
		expect(reopened.status).toBe("open");

		expect(await stub.updateItemStatus("missing", "done")).toBeNull();
		// A status outside the vocabulary never reaches storage.
		expect(await stub.updateItemStatus("u-1", "archived")).toBeNull();
		const stored = await listOn(stub, {});
		expect(stored.items[0]?.status).toBe("open");
	});

	it("prunes the oldest closed rows and never an open one", async () => {
		const mailbox = "items-do-prune@example.com";
		const stub = stubFor(mailbox);

		// 1999 closed rows plus one open row: already at the cap.
		const seeded = [
			...Array.from({ length: 1999 }, (_value, index) => ({
				id: `closed-${String(index).padStart(4, "0")}`,
				emailId: "m-closed",
				status: index % 2 === 0 ? "done" : "dismissed",
				createdAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 1000).toISOString(),
			})),
			{
				id: "open-keep",
				emailId: "m-open",
				status: "open",
				createdAt: "2026-06-01T00:00:00.000Z",
			},
		];
		await seedItems(stub, seeded);
		expect((await listOn(stub, {})).totalCount).toBe(2000);

		// One more message's items push the mailbox over the cap by one: the
		// single oldest closed row goes, and every open row stays.
		await stub.insertItems("m-new", null, [
			{ kind: "task", title: "Fresh task", details: null, due_at: null },
		]);

		// Counts come from the table itself: one list page would only show the
		// newest 50 rows.
		const counts = await itemCounts(stub, {
			total: "SELECT COUNT(*) AS c FROM extracted_items",
			open: "SELECT COUNT(*) AS c FROM extracted_items WHERE status = 'open'",
			pruned: "SELECT COUNT(*) AS c FROM extracted_items WHERE id = 'closed-0000'",
			next: "SELECT COUNT(*) AS c FROM extracted_items WHERE id = 'closed-0001'",
		});
		expect(counts["total"]).toBe(2000);
		expect(counts["pruned"]).toBe(0);
		expect(counts["next"]).toBe(1);
		expect(counts["open"]).toBe(2);
	});

	it("leaves a mailbox whose excess is all open rows above the cap", async () => {
		const mailbox = "items-do-prune-open@example.com";
		const stub = stubFor(mailbox);
		await seedItems(stub, [
			...Array.from({ length: 2000 }, (_value, index) => ({
				id: `open-${String(index).padStart(4, "0")}`,
				emailId: "m-open",
				status: "open",
				createdAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 1000).toISOString(),
			})),
			{
				id: "closed-old",
				emailId: "m-closed",
				status: "done",
				createdAt: "2025-12-01T00:00:00.000Z",
			},
		]);

		await stub.insertItems("m-new", null, [
			{ kind: "task", title: "Another open task", details: null, due_at: null },
		]);

		// The one closed row goes; the 2001 open rows all survive.
		const counts = await itemCounts(stub, {
			total: "SELECT COUNT(*) AS c FROM extracted_items",
			open: "SELECT COUNT(*) AS c FROM extracted_items WHERE status = 'open'",
			pruned: "SELECT COUNT(*) AS c FROM extracted_items WHERE id = 'closed-old'",
		});
		expect(counts["pruned"]).toBe(0);
		expect(counts["open"]).toBe(2001);
		expect(counts["total"]).toBe(2001);
	});
});

describe("items routes", () => {
	it("lists a mailbox's items with the paging values it applied", async () => {
		const mailbox = "items-route-list@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await stub.insertItems("route-mail-1", null, [
			{ kind: "deadline", title: "Renew the domain", details: "before it lapses", due_at: isoFromNow(DAY_MS) },
		]);

		const { status, body } = await getItems(mailbox);
		expect(status).toBe(200);
		expect(body.page).toBe(1);
		expect(body.limit).toBe(50);
		expect(body.totalCount).toBe(1);
		expect(body.items).toHaveLength(1);
		expect(body.items?.[0]).toEqual({
			id: expect.any(String),
			email_id: "route-mail-1",
			thread_id: null,
			kind: "deadline",
			title: "Renew the domain",
			details: "before it lapses",
			due_at: expect.any(String),
			status: "open",
			created_at: expect.any(String),
			updated_at: expect.any(String),
		});
	});

	it("applies the status and due filters and clamps the paging", async () => {
		const mailbox = "items-route-filters@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedItems(stub, [
			{ id: "r-1", emailId: "m-1", dueAt: isoFromNow(-DAY_MS), createdAt: "2026-01-01T00:00:00.000Z" },
			{ id: "r-2", emailId: "m-1", dueAt: isoFromNow(2 * DAY_MS), createdAt: "2026-01-02T00:00:00.000Z", status: "done" },
			{ id: "r-3", emailId: "m-2", dueAt: null, createdAt: "2026-01-03T00:00:00.000Z" },
		]);

		const overdue = await getItems(mailbox, "?status=open&due=overdue");
		expect(overdue.status).toBe(200);
		expect(overdue.body.items?.map((item) => item.id)).toEqual(["r-1"]);
		expect(overdue.body.totalCount).toBe(1);

		const none = await getItems(mailbox, "?due=none");
		expect(none.body.items?.map((item) => item.id)).toEqual(["r-3"]);

		const done = await getItems(mailbox, "?status=done");
		expect(done.body.items?.map((item) => item.id)).toEqual(["r-2"]);

		const clamped = await getItems(mailbox, "?limit=500&page=0");
		expect(clamped.body.limit).toBe(50);
		expect(clamped.body.page).toBe(1);
		expect(clamped.body.totalCount).toBe(3);
	});

	it("rejects an unknown status or due bucket with a 400", async () => {
		const mailbox = "items-route-400@example.com";
		await registerMailbox(mailbox);

		const badStatus = await getItems(mailbox, "?status=archived");
		expect(badStatus.status).toBe(400);
		expect(badStatus.body.error).toContain("open, done, dismissed");

		const badDue = await getItems(mailbox, "?due=later");
		expect(badDue.status).toBe(400);
		expect(badDue.body.error).toContain("overdue, today, upcoming, none");
	});

	it("answers one message's items, empty for a message without any", async () => {
		const mailbox = "items-route-email@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await stub.insertItems("route-mail-2", null, [
			{ kind: "task", title: "Reply to the landlord", details: null, due_at: null },
		]);

		const res = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/emails/route-mail-2/items`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as ItemsResponse;
		expect(body.items?.map((item) => item.title)).toEqual([
			"Reply to the landlord",
		]);

		const empty = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/emails/nothing-here/items`,
		);
		expect(empty.status).toBe(200);
		expect(((await empty.json()) as ItemsResponse).items).toEqual([]);
	});

	it("round-trips a status change through the PUT route", async () => {
		const mailbox = "items-route-put@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		const [stored] = (await stub.insertItems("route-mail-3", null, [
			{ kind: "task", title: "Close the loop", details: null, due_at: null },
		])) as unknown as ExtractedItem[];

		const put = async (body: unknown, itemId = stored?.id) => {
			const res = await SELF.fetch(
				`http://example.com/api/v1/mailboxes/${mailbox}/items/${itemId}`,
				{
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				},
			);
			return { status: res.status, body: (await res.json()) as ItemsResponse };
		};

		const closed = await put({ status: "done" });
		expect(closed.status).toBe(200);
		expect(closed.body.item?.status).toBe("done");
		expect(closed.body.item?.id).toBe(stored?.id);

		const reopened = await put({ status: "open" });
		expect(reopened.body.item?.status).toBe("open");

		const missing = await put({ status: "done" }, "no-such-item");
		expect(missing.status).toBe(404);
		expect(missing.body.error).toBeTruthy();

		const badStatus = await put({ status: "archived" });
		expect(badStatus.status).toBe(400);
		expect(badStatus.body.error).toContain("Invalid item status");

		const emptyBody = await put({});
		expect(emptyBody.status).toBe(400);
		expect(emptyBody.body.error).toBeTruthy();
	});

	it("rejects a PUT body that is not JSON", async () => {
		const mailbox = "items-route-badjson@example.com";
		await registerMailbox(mailbox);
		const res = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/items/anything`,
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: "not json",
			},
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as ItemsResponse;
		expect(body.error).toContain("Invalid item status");
	});
});

describe("list_items tool", () => {
	it("answers the mailbox's items and total, honouring the filters", async () => {
		const mailbox = "items-tool@example.com";
		const stub = stubFor(mailbox);
		await seedItems(stub, [
			{ id: "t-1", emailId: "m-1", dueAt: isoFromNow(-DAY_MS), createdAt: "2026-01-01T00:00:00.000Z" },
			{ id: "t-2", emailId: "m-1", dueAt: isoFromNow(2 * DAY_MS), createdAt: "2026-01-02T00:00:00.000Z", status: "done" },
			{ id: "t-3", emailId: "m-2", dueAt: null, createdAt: "2026-01-03T00:00:00.000Z" },
		]);

		const all = await toolListItems(env, mailbox);
		expect(Object.keys(all).sort()).toEqual(["items", "totalCount"]);
		expect(all.totalCount).toBe(3);
		expect(all.items.map((item) => item.id)).toEqual(["t-3", "t-2", "t-1"]);

		const open = await toolListItems(env, mailbox, { status: "open" });
		expect(open.totalCount).toBe(2);
		expect(open.items.map((item) => item.id)).toEqual(["t-3", "t-1"]);

		const overdue = await toolListItems(env, mailbox, { due: "overdue" });
		expect(overdue.items.map((item) => item.id)).toEqual(["t-1"]);

		const limited = await toolListItems(env, mailbox, { limit: 1 });
		expect(limited.totalCount).toBe(3);
		expect(limited.items).toHaveLength(1);
		expect(limited.items[0]?.id).toBe("t-3");
	});

	it("is read-only: the answer carries no send path and no writes", async () => {
		const mailbox = "items-tool-readonly@example.com";
		const stub = stubFor(mailbox);
		await seedItems(stub, [
			{ id: "ro-1", emailId: "m-1", createdAt: "2026-01-01T00:00:00.000Z" },
		]);

		const before = await listOn(stub, {});
		const answer = await toolListItems(env, mailbox, {});
		expect(answer.items).toHaveLength(1);
		expect(Object.keys(answer)).not.toContain("send");
		expect(await listOn(stub, {})).toEqual(before);
	});

	it("is exposed on the agent tool map", () => {
		const tools = createEmailTools(env, "items-tool-agent@example.com");
		expect(Object.keys(tools)).toContain("list_items");
	});
});

describe("insertExtractedItems", () => {
	it("skips a mailbox whose switch is off, without touching the model", async () => {
		const mailbox = "items-off@example.com";
		await registerMailbox(mailbox, { items: { enabled: false } });
		const stub = stubFor(mailbox);

		const stored = await insertExtractedItems(env, mailbox, {
			emailId: "off-1",
			subject: "Invoice",
			sender: "billing@example.org",
			body: "<p>Please pay by Friday.</p>",
		});
		expect(stored).toBe(0);
		expect(await listOn(stub, {})).toEqual({ items: [], totalCount: 0 });

		// The same answer when the caller passes the settings it already read.
		const storedAgain = await insertExtractedItems(
			env,
			mailbox,
			{
				emailId: "off-2",
				subject: "Invoice",
				sender: "billing@example.org",
				body: "Please pay by Friday.",
			},
			{ items: { enabled: false } },
		);
		expect(storedAgain).toBe(0);
		expect((await listOn(stub, {})).totalCount).toBe(0);
	});

	it("skips a message that already has items", async () => {
		const mailbox = "items-existing@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await stub.insertItems("existing-1", null, [
			{ kind: "task", title: "Already stored", details: null, due_at: null },
		]);

		const stored = await insertExtractedItems(env, mailbox, {
			emailId: "existing-1",
			subject: "Re: the thing",
			sender: "someone@example.org",
			body: "Reminder about the thing.",
		});
		expect(stored).toBe(0);
		expect((await listOn(stub, {})).totalCount).toBe(1);
	});

	it("logs and swallows a failing extraction instead of storing junk", async () => {
		const mailbox = "items-no-model@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		// The pool cannot run models, so a throwing run is the failure branch
		// the receive path relies on: nothing is stored and nothing throws.
		const failingEnv = {
			MAILBOX: env.MAILBOX,
			BUCKET: env.BUCKET,
			AI: {
				run: async () => {
					throw new Error("model unavailable");
				},
			},
		} as unknown as Parameters<typeof insertExtractedItems>[0];

		const stored = await insertExtractedItems(failingEnv, mailbox, {
			emailId: "no-model-1",
			subject: "Renew the domain",
			sender: "registrar@example.org",
			body: "<p>Your domain lapses next week.</p>",
		});
		expect(stored).toBe(0);
		expect((await listOn(stub, {})).totalCount).toBe(0);
	});
});
