// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Priority streams: the threaded list's `stream` filter, the streamed and
 * unstreamed conversation counts, and the list route's `streamCounts`.
 *
 * A conversation is priority when its newest message in the folder is unread
 * or starred, or when it needs a reply (the list query's needs_reply
 * predicate: newest message anywhere not in Sent or Draft, and at least one
 * read message). `other` is the complement, and the two stream counts sum to
 * the unstreamed total.
 */


import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";


type Stub = ReturnType<typeof stubFor>;

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

/** Register a mailbox record so the API route's middleware lets it through. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
}

interface SeedOptions {
	threadId?: string;
	date?: string;
	read?: boolean;
	starred?: boolean;
}

/** Seed one email into a folder (mirrors tests/needs-reply.test.ts). */
async function seedEmail(
	stub: Stub,
	id: string,
	folder: string,
	options: SeedOptions = {},
) {
	await stub.createEmail(
		folder,
		{
			id,
			subject: `Subject ${id}`,
			sender: "sender@example.org",
			recipient: "split-inbox@example.com",
			date: options.date ?? "2026-09-24T09:00:00.000Z",
			read: options.read ?? false,
			starred: options.starred ?? false,
			category: null,
			classification: null,
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: options.threadId ?? id,
		},
		[],
	);
}

interface ListedRow {
	id: string;
	read: boolean;
	starred: boolean;
	needs_reply: boolean;
}

const ids = (rows: unknown) => (rows as ListedRow[]).map((row) => row.id);

/**
 * Four conversations in the inbox, one per way into a stream:
 *
 *   si-a  unread inbox message (priority: unread, and no read message so
 *         needs_reply stays false)
 *   si-b  read inbox message, nothing newer anywhere (priority: needs_reply)
 *   si-c  read and starred inbox message, newer Sent reply (priority:
 *         starred; the Sent message keeps needs_reply false)
 *   si-d  read inbox message, newer Sent reply (other)
 *
 * Dates order the list newest-first: si-d, si-c, si-b, si-a.
 */
async function seedFourConversations(stub: Stub) {
	await seedEmail(stub, "si-a", Folders.INBOX, {
		threadId: "si-ta",
		read: false,
		date: "2026-09-24T08:00:00.000Z",
	});
	await seedEmail(stub, "si-b", Folders.INBOX, {
		threadId: "si-tb",
		read: true,
		date: "2026-09-24T09:00:00.000Z",
	});
	await seedEmail(stub, "si-c", Folders.INBOX, {
		threadId: "si-tc",
		read: true,
		starred: true,
		date: "2026-09-24T10:00:00.000Z",
	});
	await seedEmail(stub, "si-c-sent", Folders.SENT, {
		threadId: "si-tc",
		read: true,
		date: "2026-09-24T11:00:00.000Z",
	});
	await seedEmail(stub, "si-d", Folders.INBOX, {
		threadId: "si-td",
		read: true,
		date: "2026-09-24T12:00:00.000Z",
	});
	await seedEmail(stub, "si-d-sent", Folders.SENT, {
		threadId: "si-td",
		read: true,
		date: "2026-09-24T13:00:00.000Z",
	});
}

describe("priority streams", () => {
	it("lists every conversation when no stream is given", async () => {
		const stub = stubFor("split-inbox-all@example.com");
		await seedFourConversations(stub);

		const rows = await stub.getThreadedEmails({ folder: Folders.INBOX });

		expect(ids(rows)).toEqual(["si-d", "si-c", "si-b", "si-a"]);
		expect(await stub.countThreadedEmails(Folders.INBOX)).toBe(4);
	});

	it("puts unread, starred, and needs-reply conversations in priority", async () => {
		const stub = stubFor("split-inbox-priority@example.com");
		await seedFourConversations(stub);

		const rows = (await stub.getThreadedEmails({
			folder: Folders.INBOX,
			stream: "priority",
		})) as unknown as ListedRow[];

		expect(ids(rows)).toEqual(["si-c", "si-b", "si-a"]);
		// Every row justifies its membership from its own flags.
		const byId = new Map(rows.map((row) => [row.id, row]));
		expect(byId.get("si-a")?.read).toBe(false);
		expect(byId.get("si-b")?.needs_reply).toBe(true);
		expect(byId.get("si-c")?.starred).toBe(true);
	});

	it("puts the rest in other", async () => {
		const stub = stubFor("split-inbox-other@example.com");
		await seedFourConversations(stub);

		const rows = (await stub.getThreadedEmails({
			folder: Folders.INBOX,
			stream: "other",
		})) as unknown as ListedRow[];

		expect(ids(rows)).toEqual(["si-d"]);
		expect(rows[0]?.read).toBe(true);
		expect(rows[0]?.starred).toBe(false);
		expect(rows[0]?.needs_reply).toBe(false);
	});

	it("counts the streams so they sum to the unstreamed total", async () => {
		const stub = stubFor("split-inbox-counts@example.com");
		await seedFourConversations(stub);

		const counts = await stub.countThreadedStreams(Folders.INBOX);
		const total = await stub.countThreadedEmails(Folders.INBOX);

		expect(counts).toEqual({ priority: 3, other: 1 });
		expect(counts.priority + counts.other).toBe(total);
		expect(await stub.countThreadedEmails(Folders.INBOX, undefined, "priority")).toBe(3);
		expect(await stub.countThreadedEmails(Folders.INBOX, undefined, "other")).toBe(1);

		const priorityRows = await stub.getThreadedEmails({
			folder: Folders.INBOX,
			stream: "priority",
		});
		expect(counts.priority).toBe(priorityRows.length);
	});

	it("pages within a stream", async () => {
		const stub = stubFor("split-inbox-paging@example.com");
		await seedFourConversations(stub);

		const first = await stub.getThreadedEmails({
			folder: Folders.INBOX,
			stream: "priority",
			page: 1,
			limit: 2,
		});
		const second = await stub.getThreadedEmails({
			folder: Folders.INBOX,
			stream: "priority",
			page: 2,
			limit: 2,
		});
		const third = await stub.getThreadedEmails({
			folder: Folders.INBOX,
			stream: "priority",
			page: 3,
			limit: 2,
		});

		expect(ids(first)).toEqual(["si-c", "si-b"]);
		expect(ids(second)).toEqual(["si-a"]);
		expect(third).toEqual([]);
	});

	it("returns streamCounts and the streamed totalCount from the route", async () => {
		const mailbox = "split-inbox-route@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedFourConversations(stub);

		const url = (query: string) =>
			`http://example.com/api/v1/mailboxes/${mailbox}/emails?threaded=true&folder=inbox&${query}`;

		const streamed = await SELF.fetch(url("stream=priority"));
		expect(streamed.status).toBe(200);
		const streamedBody = (await streamed.json()) as {
			emails: ListedRow[];
			totalCount: number;
			streamCounts: { priority: number; other: number };
		};
		expect(streamedBody.emails.map((email) => email.id)).toEqual(["si-c", "si-b", "si-a"]);
		expect(streamedBody.totalCount).toBe(3);
		expect(streamedBody.streamCounts).toEqual({ priority: 3, other: 1 });

		// No stream: today's whole-folder list, same additive streamCounts.
		const all = await SELF.fetch(url("page=1"));
		const allBody = (await all.json()) as {
			emails: ListedRow[];
			totalCount: number;
			streamCounts: { priority: number; other: number };
		};
		expect(allBody.emails).toHaveLength(4);
		expect(allBody.totalCount).toBe(4);
		expect(allBody.streamCounts).toEqual({ priority: 3, other: 1 });

		// An unknown stream name falls back to no stream.
		const bogus = await SELF.fetch(url("stream=bogus"));
		const bogusBody = (await bogus.json()) as {
			emails: ListedRow[];
			totalCount: number;
		};
		expect(bogusBody.emails).toHaveLength(4);
		expect(bogusBody.totalCount).toBe(4);
	});
});
