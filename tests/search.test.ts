// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Search tests: real Durable Object SQLite queries (body terms, operator
 * filters, the long-term LIKE pattern limit, pagination) plus focused unit
 * tests for the LIKE-pattern and query-parser helpers.
 *
 * Durable Object storage is shared by every test in this file, so each test
 * uses its own mailbox to keep its rows out of the others' result sets.
 */


import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { buildSearchQueryParams, parseSearchQuery } from "../shared/search-query";
import {
	LIKE_MAX_PATTERN_CHARS,
	escapeLikeTerm,
	likePatternsFor,
	splitLikeTerm,
} from "../workers/lib/like-terms";
import { searchAllMailboxes } from "../workers/lib/search-all";
import type { Env } from "../workers/types";


/** The test config omits account-level vars; the search code only needs BUCKET + MAILBOX. */
const appEnv = env as unknown as Env;


const BODY_MAILBOX = "search-body@example.com";
const OPS_MAILBOX = "search-ops@example.com";
const LONG_MAILBOX = "search-long@example.com";
const PAGE_MAILBOX = "search-page@example.com";


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


interface SeedEmail {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	date: string;
	body: string;
	read?: boolean;
	starred?: boolean;
	thread_id?: string | null;
}


interface SeedAttachment {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
}


async function seedEmails(
	stub: ReturnType<typeof stubFor>,
	folder: string,
	emails: SeedEmail[],
	attachments: SeedAttachment[] = [],
) {
	for (const email of emails) {
		await stub.createEmail(
			folder,
			{
				id: email.id,
				subject: email.subject,
				sender: email.sender,
				recipient: email.recipient,
				date: email.date,
				body: email.body,
				read: email.read,
				starred: email.starred,
				thread_id: email.thread_id ?? email.id,
			},
			attachments.filter((attachment) => attachment.email_id === email.id),
		);
	}
}


/** Extract result ids (rows come back ordered by date DESC). */
function ids(rows: unknown[]): string[] {
	return (rows as { id: string }[]).map((row) => row.id);
}


describe("MailboxDO search", () => {
	it("finds emails by a body term", async () => {
		const stub = stubFor(BODY_MAILBOX);
		await seedEmails(stub, Folders.INBOX, [
			{ id: "body-1", subject: "Weekly report", sender: "alice@example.org", recipient: BODY_MAILBOX, date: "2026-01-02T10:00:00.000Z", body: "<p>The quarterly projections look healthy.</p>" },
			{ id: "body-2", subject: "Lunch plans", sender: "bob@example.org", recipient: BODY_MAILBOX, date: "2026-01-03T10:00:00.000Z", body: "<p>Are we still on for pizza?</p>" },
		]);

		expect(ids(await stub.searchEmails({ query: "quarterly projections" }))).toEqual(["body-1"]);
		expect(await stub.countSearchResults({ query: "quarterly projections" })).toBe(1);

		// Subject and sender columns are searched too.
		expect(ids(await stub.searchEmails({ query: "Lunch" }))).toEqual(["body-2"]);
		expect(ids(await stub.searchEmails({ query: "alice@example.org" }))).toEqual(["body-1"]);

		// A miss returns nothing and never throws.
		expect(ids(await stub.searchEmails({ query: "no-such-term-anywhere" }))).toEqual([]);
		expect(await stub.countSearchResults({ query: "no-such-term-anywhere" })).toBe(0);
	});


	it("applies operator filters (from/to/subject/read/starred/attachment/dates/folder)", async () => {
		const stub = stubFor(OPS_MAILBOX);
		await seedEmails(
			stub,
			Folders.INBOX,
			[
				{ id: "op-1", subject: "Invoice 42", sender: "billing@vendor.com", recipient: OPS_MAILBOX, date: "2026-01-05T10:00:00.000Z", body: "<p>First invoice</p>", read: false, starred: true },
				{ id: "op-2", subject: "Invoice 43", sender: "billing@vendor.com", recipient: OPS_MAILBOX, date: "2026-02-05T10:00:00.000Z", body: "<p>Second invoice</p>", read: true, starred: false },
				{ id: "op-3", subject: "Newsletter", sender: "news@example.com", recipient: OPS_MAILBOX, date: "2026-02-06T10:00:00.000Z", body: "<p>Hello there</p>", read: false, starred: false },
			],
			[{ id: "op-att-1", email_id: "op-2", filename: "invoice.pdf", mimetype: "application/pdf", size: 128 }],
		);
		await seedEmails(stub, Folders.SENT, [
			{ id: "op-sent", subject: "Invoice 44", sender: OPS_MAILBOX, recipient: "billing@vendor.com", date: "2026-02-07T10:00:00.000Z", body: "<p>Paid</p>", read: true, starred: false },
		]);

		expect(ids(await stub.searchEmails({ query: "", from: "vendor.com" }))).toEqual(["op-2", "op-1"]);
		expect(ids(await stub.searchEmails({ query: "", to: "vendor.com" }))).toEqual(["op-sent"]);
		expect(ids(await stub.searchEmails({ query: "", subject: "Invoice 42" }))).toEqual(["op-1"]);
		expect(ids(await stub.searchEmails({ query: "", is_read: false }))).toEqual(["op-3", "op-1"]);
		expect(ids(await stub.searchEmails({ query: "", is_starred: true }))).toEqual(["op-1"]);
		expect(ids(await stub.searchEmails({ query: "", has_attachment: true }))).toEqual(["op-2"]);
		expect(ids(await stub.searchEmails({ query: "", date_start: "2026-02-01T00:00:00.000Z" }))).toEqual(["op-sent", "op-3", "op-2"]);
		expect(ids(await stub.searchEmails({ query: "", date_end: "2026-01-31T00:00:00.000Z" }))).toEqual(["op-1"]);
		expect(ids(await stub.searchEmails({ query: "", folder: Folders.SENT }))).toEqual(["op-sent"]);
		expect(await stub.countSearchResults({ query: "", from: "vendor.com" })).toBe(2);

		// A raw Gmail-style query parsed by the shared parser drives the same filters.
		const parsed = parseSearchQuery("from:vendor.com is:unread subject:Invoice");
		expect(ids(await stub.searchEmails({ query: parsed.query, from: parsed.from, subject: parsed.subject, is_read: parsed.is_read }))).toEqual(["op-1"]);
	});


	it("matches a term longer than the LIKE pattern limit", async () => {
		const stub = stubFor(LONG_MAILBOX);
		const longTerm = "abcdefghij".repeat(12); // 120 characters
		const nearMiss = `${longTerm.slice(0, -1)}z`;
		await seedEmails(stub, Folders.INBOX, [
			{ id: "long-1", subject: "Long token", sender: "long@example.org", recipient: LONG_MAILBOX, date: "2026-03-01T10:00:00.000Z", body: `<p>prefix ${longTerm} suffix</p>` },
			{ id: "long-2", subject: "Long token partial", sender: "long@example.org", recipient: LONG_MAILBOX, date: "2026-03-02T10:00:00.000Z", body: `<p>${longTerm.slice(0, 48)}</p>` },
		]);

		expect(ids(await stub.searchEmails({ query: longTerm }))).toEqual(["long-1"]);
		expect(await stub.countSearchResults({ query: longTerm })).toBe(1);
		// A 120-char miss returns no rows instead of failing the query.
		expect(ids(await stub.searchEmails({ query: nearMiss }))).toEqual([]);

		// The chunks are ANDed: matching only the first chunk is not a match.
		expect(ids(await stub.searchEmails({ query: longTerm }))).not.toContain("long-2");

		// Every generated pattern stays inside the limit workerd enforces.
		const patterns = likePatternsFor(longTerm);
		expect(patterns.length).toBeGreaterThan(1);
		for (const pattern of patterns) {
			expect(pattern.length).toBeLessThanOrEqual(LIKE_MAX_PATTERN_CHARS);
		}
	});


	it("confirms the DO SQLite LIKE pattern limit the chunker works around", async () => {
		const stub = stubFor("limits@example.com");
		const measured = await runInDurableObject(stub, async (_instance, state) => {
			const accepts = (pattern: string) => {
				try {
					[...state.storage.sql.exec("SELECT 1 WHERE 'abc' LIKE ?1", pattern)];
					return true;
				} catch {
					return false;
				}
			};
			return {
				atLimit: accepts(`%${"a".repeat(LIKE_MAX_PATTERN_CHARS - 2)}%`),
				overLimit: accepts(`%${"a".repeat(LIKE_MAX_PATTERN_CHARS - 1)}%`),
			};
		});
		expect(measured.atLimit).toBe(true);
		expect(measured.overLimit).toBe(false);
	});


	it("paginates matches and reports exact totals", async () => {
		const stub = stubFor(PAGE_MAILBOX);
		const total = 30;
		await seedEmails(
			stub,
			Folders.INBOX,
			Array.from({ length: total }, (_, index) => ({
				id: `page-${index + 1}`,
				subject: `Digest ${index + 1}`,
				sender: "digest@example.org",
				recipient: PAGE_MAILBOX,
				date: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
				body: `<p>pagination probe ${index + 1}</p>`,
			})),
		);

		const page1 = await stub.searchEmails({ query: "pagination probe", page: 1, limit: 10 });
		const page2 = await stub.searchEmails({ query: "pagination probe", page: 2, limit: 10 });
		const page4 = await stub.searchEmails({ query: "pagination probe", page: 4, limit: 10 });

		expect(await stub.countSearchResults({ query: "pagination probe" })).toBe(total);
		expect(page1).toHaveLength(10);
		expect(page2).toHaveLength(10);
		expect(page4).toHaveLength(0);
		expect(ids(page1)[0]).toBe("page-30"); // newest first
		expect(ids(page2)[0]).toBe("page-20");
		expect(new Set([...ids(page1), ...ids(page2)]).size).toBe(20); // pages don't overlap
	});
});


describe("searchAllMailboxes", () => {
	it("merges every mailbox's matches and tags each row with its mailboxId", async () => {
		const alpha = "alpha-search@example.com";
		const beta = "beta-search@example.com";
		await env.BUCKET.put(`mailboxes/${alpha}.json`, JSON.stringify({ id: alpha, email: alpha, name: "Alpha" }));
		await env.BUCKET.put(`mailboxes/${beta}.json`, JSON.stringify({ id: beta, email: beta, name: "Beta" }));

		await seedEmails(stubFor(alpha), Folders.INBOX, [
			{ id: "x-1", subject: "Crossbox one", sender: "a@example.org", recipient: alpha, date: "2026-04-01T10:00:00.000Z", body: "<p>crossbox</p>" },
			{ id: "x-2", subject: "Crossbox two", sender: "a@example.org", recipient: alpha, date: "2026-04-03T10:00:00.000Z", body: "<p>crossbox</p>" },
		]);
		await seedEmails(stubFor(beta), Folders.INBOX, [
			{ id: "x-3", subject: "Crossbox three", sender: "b@example.org", recipient: beta, date: "2026-04-02T10:00:00.000Z", body: "<p>crossbox</p>" },
		]);

		const result = await searchAllMailboxes(appEnv, { query: "crossbox" });
		expect(result.totalCount).toBe(3);
		expect(result.emails.map((row) => `${row.mailboxId}:${row.id}`)).toEqual([
			`${alpha}:x-2`,
			`${beta}:x-3`,
			`${alpha}:x-1`,
		]);
	});
});


describe("likePatternsFor", () => {
	it("escapes LIKE metacharacters and the escape character itself", () => {
		expect(escapeLikeTerm("50%")).toBe("50\\%");
		expect(escapeLikeTerm("a_b")).toBe("a\\_b");
		expect(escapeLikeTerm("c:\\path")).toBe("c:\\\\path");
		expect(likePatternsFor("50%")).toEqual(["%50\\%%"]);
		expect(likePatternsFor("a_b")).toEqual(["%a\\_b%"]);
	});


	it("returns no patterns for blank terms", () => {
		expect(likePatternsFor("")).toEqual([]);
		expect(likePatternsFor("   ")).toEqual([]);
	});


	it("chunks long terms and keeps every pattern within the limit", () => {
		const term = "abcdefghij".repeat(12); // 120 chars
		const patterns = likePatternsFor(term);
		expect(patterns.length).toBe(3);
		for (const pattern of patterns) {
			expect(pattern.length).toBeLessThanOrEqual(LIKE_MAX_PATTERN_CHARS);
		}
		// Stripping the wrapping wildcards and rejoining rebuilds the term.
		expect(patterns.map((pattern) => pattern.slice(1, -1)).join("")).toBe(term);
	});


	it("never splits an escape sequence across chunks", () => {
		const term = `${"a".repeat(47)}%${"b".repeat(60)}`;
		const patterns = likePatternsFor(term);
		expect(patterns.length).toBeGreaterThan(1);
		for (const pattern of patterns) {
			const chunk = pattern.slice(1, -1);
			const trailingBackslashes = chunk.match(/\\+$/)?.[0].length ?? 0;
			expect(trailingBackslashes % 2).toBe(0);
			expect(chunk.length).toBeLessThanOrEqual(LIKE_MAX_PATTERN_CHARS - 2);
		}
	});


	it("honours a custom chunk size", () => {
		expect(splitLikeTerm("abcdef", 2)).toEqual(["ab", "cd", "ef"]);
		expect(splitLikeTerm("", 2)).toEqual([]);
	});
});


describe("parseSearchQuery", () => {
	it("extracts operators and keeps the free text", () => {
		expect(parseSearchQuery("hello from:bob@example.com is:unread")).toEqual({
			query: "hello",
			from: "bob@example.com",
			is_read: false,
		});
		expect(parseSearchQuery("report subject:budget has:attachment")).toEqual({
			query: "report",
			subject: "budget",
			has_attachment: true,
		});
	});


	it("supports quoted operator values", () => {
		expect(parseSearchQuery('subject:"Re: Hello" from:"John Doe"')).toEqual({
			query: "",
			subject: "Re: Hello",
			from: "John Doe",
		});
	});


	it("normalizes before/after dates to ISO", () => {
		const parsed = parseSearchQuery("before:2025-01-01 after:2024-12-31");
		expect(parsed.date_end).toBe("2025-01-01T00:00:00.000Z");
		expect(parsed.date_start).toBe("2024-12-31T00:00:00.000Z");
	});


	it("ignores values an operator does not understand", () => {
		const parsed = parseSearchQuery("is:maybe has:photos in:sent");
		expect(parsed.is_read).toBeUndefined();
		expect(parsed.is_starred).toBeUndefined();
		expect(parsed.has_attachment).toBeUndefined();
		expect(parsed.folder).toBe("sent");
		expect(parsed.query).toBe("");
	});


	it("leaves non-operator colons in the free text", () => {
		expect(parseSearchQuery("re: meeting notes")).toEqual({ query: "re: meeting notes" });
		expect(parseSearchQuery("photo:album")).toEqual({ query: "photo:album" });
	});


	it("builds per-mailbox API params", () => {
		expect(buildSearchQueryParams("from:bob is:unread", 2, 25)).toEqual({
			page: "2",
			limit: "25",
			from: "bob",
			is_read: "false",
		});
	});
});
