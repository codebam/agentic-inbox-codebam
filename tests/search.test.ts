// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Search tests: real Durable Object SQLite queries (body terms, operator
 * filters, the long-term LIKE pattern limit, the FTS index, pagination) plus
 * focused unit tests for the LIKE-pattern, FTS-term and query-parser helpers.
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
import {
	FTS_MAX_TERMS,
	FTS_MIN_TERM_LENGTH,
	ftsPhrase,
	splitFtsTerms,
} from "../workers/lib/fts-terms";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";
import { searchAllMailboxes } from "../workers/lib/search-all";
import type { Env } from "../workers/types";


/** The test config omits account-level vars; the search code only needs BUCKET + MAILBOX. */
const appEnv = env as unknown as Env;


const BODY_MAILBOX = "search-body@example.com";
const OPS_MAILBOX = "search-ops@example.com";
const LONG_MAILBOX = "search-long@example.com";
const PAGE_MAILBOX = "search-page@example.com";
const FTS_MAILBOX = "search-fts@example.com";
const AND_MAILBOX = "search-and@example.com";
const COLUMNS_MAILBOX = "search-columns@example.com";
const SYNC_MAILBOX = "search-sync@example.com";
const NASTY_MAILBOX = "search-nasty@example.com";
const PURGE_FTS_MAILBOX = "search-purge-fts@example.com";
const LONG_TERM_MAILBOX = "search-long-fts@example.com";
const UPGRADE_MAILBOX = "search-upgrade@example.com";


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
	envelope_recipient?: string | null;
	cc?: string | null;
	bcc?: string | null;
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
				envelope_recipient: email.envelope_recipient ?? null,
				cc: email.cc ?? null,
				bcc: email.bcc ?? null,
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
					state.storage.sql.exec("SELECT 1 WHERE 'abc' LIKE ?1", pattern).toArray();
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

		// A mid-word substring ('ation' inside every 'pagination') is answered
		// by the FTS index, and paginates with the same exact totals.
		expect(await stub.countSearchResults({ query: "ation" })).toBe(total);
		expect(ids(await stub.searchEmails({ query: "ation", page: 1, limit: 10 }))[0]).toBe("page-30");
		expect(ids(await stub.searchEmails({ query: "ation", page: 3, limit: 10 }))).toContain("page-10");
		expect(ids(await stub.searchEmails({ query: "ation", page: 4, limit: 10 }))).toHaveLength(0);
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

		// A mid-word substring resolves through every mailbox's own FTS index.
		const substring = await searchAllMailboxes(appEnv, { query: "rossbox" });
		expect(substring.totalCount).toBe(3);
		expect(substring.emails.map((row) => row.id)).toContain("x-1");
	});
});


// ── FTS index (migration 23) ───────────────────────────────────────


describe("MailboxDO search (FTS index)", () => {
	it("matches substrings inside words and keeps % and _ literal", async () => {
		const stub = stubFor(FTS_MAILBOX);
		await seedEmails(stub, Folders.INBOX, [
			{ id: "fts-1", subject: "Weekly report", sender: "alice@example.org", recipient: FTS_MAILBOX, date: "2026-01-02T10:00:00.000Z", body: "<p>The quarterly projections look healthy.</p>" },
			{ id: "fts-2", subject: "Progress notes", sender: "bob@example.org", recipient: FTS_MAILBOX, date: "2026-01-03T10:00:00.000Z", body: "<p>50% done with the migration</p>" },
			{ id: "fts-3", subject: "Flag naming", sender: "carol@example.org", recipient: FTS_MAILBOX, date: "2026-01-04T10:00:00.000Z", body: "<p>the a_b flag and 5012 rows</p>" },
			{ id: "fts-4", subject: "Flag naming two", sender: "dave@example.org", recipient: FTS_MAILBOX, date: "2026-01-05T10:00:00.000Z", body: "<p>the axb flag</p>" },
		]);

		// Substring inside a word: 'arter' is not a word of its own anywhere.
		expect(ids(await stub.searchEmails({ query: "arter" }))).toEqual(["fts-1"]);
		expect(await stub.countSearchResults({ query: "arter" })).toBe(1);
		// The whole word still matches the whole word.
		expect(ids(await stub.searchEmails({ query: "quarterly" }))).toEqual(["fts-1"]);

		// % and _ stay literal inside a quoted FTS phrase: '50%' matches the
		// message holding it and not the 5012 one, and 'a_b' is the underscore
		// rather than a LIKE wildcard.
		expect(ids(await stub.searchEmails({ query: "50%" }))).toEqual(["fts-2"]);
		expect(ids(await stub.searchEmails({ query: "a_b" }))).toEqual(["fts-3"]);
		// Terms under the trigram minimum keep the same escaping on the LIKE path.
		expect(ids(await stub.searchEmails({ query: "%" }))).toEqual(["fts-2"]);
		expect(ids(await stub.searchEmails({ query: "_" }))).toEqual(["fts-3"]);

		// A miss stays empty and totals stay exact.
		expect(ids(await stub.searchEmails({ query: "no-such-term-anywhere" }))).toEqual([]);
		expect(await stub.countSearchResults({ query: "no-such-term-anywhere" })).toBe(0);
	});


	it("ANDs multi-term queries across the whole message", async () => {
		const stub = stubFor(AND_MAILBOX);
		await seedEmails(stub, Folders.INBOX, [
			{ id: "and-1", subject: "Both words", sender: "joint@example.org", recipient: AND_MAILBOX, date: "2026-01-02T10:00:00.000Z", body: "<p>alpha beta together</p>" },
			{ id: "and-2", subject: "Only alpha", sender: "alpha-only@example.org", recipient: AND_MAILBOX, date: "2026-01-03T10:00:00.000Z", body: "<p>alpha appears here</p>" },
			{ id: "and-3", subject: "Only beta", sender: "beta-only@example.org", recipient: AND_MAILBOX, date: "2026-01-04T10:00:00.000Z", body: "<p>beta appears here</p>" },
		]);

		expect(ids(await stub.searchEmails({ query: "alpha beta" }))).toEqual(["and-1"]);
		expect(await stub.countSearchResults({ query: "alpha beta" })).toBe(1);

		// Either term on its own matches both messages carrying it, newest
		// first — the ordering of the LIKE-era search is unchanged.
		expect(ids(await stub.searchEmails({ query: "alpha" }))).toEqual(["and-2", "and-1"]);
		expect(ids(await stub.searchEmails({ query: "beta" }))).toEqual(["and-3", "and-1"]);

		// One matching term is not enough...
		expect(ids(await stub.searchEmails({ query: "alpha gamma" }))).toEqual([]);
		expect(await stub.countSearchResults({ query: "alpha gamma" })).toBe(0);
		// ...and the terms may live in different columns of one message.
		expect(ids(await stub.searchEmails({ query: "alpha Only" }))).toEqual(["and-2"]);
	});


	it("indexes the same seven columns the LIKE path searched", async () => {
		const stub = stubFor(COLUMNS_MAILBOX);
		await seedEmails(stub, Folders.INBOX, [
			// One message per column, each with a token no other column holds.
			{ id: "col-subject", subject: "zebracol in the subject", sender: "one@example.org", recipient: COLUMNS_MAILBOX, date: "2026-01-02T10:00:00.000Z", body: "<p>plain body</p>" },
			{ id: "col-body", subject: "plain subject", sender: "two@example.org", recipient: COLUMNS_MAILBOX, date: "2026-01-03T10:00:00.000Z", body: "<p>yachtcol in the body</p>" },
			{ id: "col-sender", subject: "plain subject", sender: "xenoncol@example.org", recipient: COLUMNS_MAILBOX, date: "2026-01-04T10:00:00.000Z", body: "<p>plain body</p>" },
			{ id: "col-recipient", subject: "plain subject", sender: "three@example.org", recipient: "walnutcol@example.com", date: "2026-01-05T10:00:00.000Z", body: "<p>plain body</p>" },
			{ id: "col-envelope", subject: "plain subject", sender: "four@example.org", recipient: COLUMNS_MAILBOX, envelope_recipient: "vipercol@example.com", date: "2026-01-06T10:00:00.000Z", body: "<p>plain body</p>" },
			{ id: "col-cc", subject: "plain subject", sender: "five@example.org", recipient: COLUMNS_MAILBOX, cc: "umbracol@example.com", date: "2026-01-07T10:00:00.000Z", body: "<p>plain body</p>" },
			{ id: "col-bcc", subject: "plain subject", sender: "six@example.org", recipient: COLUMNS_MAILBOX, bcc: "tapircol@example.com", date: "2026-01-08T10:00:00.000Z", body: "<p>plain body</p>" },
		]);

		for (const [id, token] of [
			["col-subject", "zebracol"],
			["col-body", "yachtcol"],
			["col-sender", "xenoncol"],
			["col-recipient", "walnutcol"],
			["col-envelope", "vipercol"],
			["col-cc", "umbracol"],
			["col-bcc", "tapircol"],
		] as const) {
			expect(ids(await stub.searchEmails({ query: token }))).toEqual([id]);
			expect(await stub.countSearchResults({ query: token })).toBe(1);
		}
	});


	it("keeps the index in sync through create, update and delete", async () => {
		const stub = stubFor(SYNC_MAILBOX);
		await seedEmails(stub, Folders.INBOX, [
			{ id: "sync-1", subject: "Sync subject", sender: "sync@example.org", recipient: SYNC_MAILBOX, date: "2026-01-02T10:00:00.000Z", body: "<p>oldbodytoken stays here</p>" },
		]);

		// Created mail is indexed at once (AFTER INSERT trigger).
		expect(ids(await stub.searchEmails({ query: "oldbodytoken" }))).toEqual(["sync-1"]);

		// The index is external-content, so a rewrite of an indexed column has
		// to be mirrored by the UPDATE trigger. Raw SQL is what every update
		// path compiles to, and no production path rewrites body/subject today
		// — this keeps a future one covered.
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE emails SET subject = ?1, body = ?2 WHERE id = 'sync-1'",
				"Renamed subject",
				"<p>newbodytoken stays here</p>",
			);
		});
		expect(ids(await stub.searchEmails({ query: "newbodytoken" }))).toEqual(["sync-1"]);
		expect(ids(await stub.searchEmails({ query: "Renamed" }))).toEqual(["sync-1"]);
		// The replaced text is gone, from both arrays and the total.
		expect(ids(await stub.searchEmails({ query: "oldbodytoken" }))).toEqual([]);
		expect(await stub.countSearchResults({ query: "oldbodytoken" })).toBe(0);

		// Updates to columns outside the index (read flags) leave it alone.
		await stub.bulkUpdateEmails(["sync-1"], { read: true });
		expect(ids(await stub.searchEmails({ query: "newbodytoken" }))).toEqual(["sync-1"]);

		// Deleting the message drops its postings (AFTER DELETE trigger).
		expect(await stub.deleteEmail("sync-1")).not.toBeNull();
		expect(ids(await stub.searchEmails({ query: "newbodytoken" }))).toEqual([]);
		expect(await stub.countSearchResults({ query: "newbodytoken" })).toBe(0);
	});


	it("backfills mail stored before the index existed", async () => {
		const stub = stubFor(UPGRADE_MAILBOX);
		await seedEmails(stub, Folders.INBOX, [
			{ id: "upgrade-1", subject: "Stored before the index", sender: "old@example.org", recipient: UPGRADE_MAILBOX, date: "2026-01-02T10:00:00.000Z", body: "<p>preexistingtoken</p>" },
		]);

		// Reproduce the upgrade of a mailbox that stored mail before this
		// migration existed: drop the index objects, forget the migration, and
		// re-apply. The 'rebuild' in the migration is what indexes the rows
		// that are already in place.
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(`
				DROP TRIGGER emails_fts_ai;
				DROP TRIGGER emails_fts_ad;
				DROP TRIGGER emails_fts_au;
				DROP TABLE emails_fts;
				DELETE FROM d1_migrations WHERE name = '23_add_email_fts';
			`);
			applyMigrations(state.storage.sql, mailboxMigrations, state.storage);
		});

		expect(ids(await stub.searchEmails({ query: "preexistingtoken" }))).toEqual(["upgrade-1"]);
		// The re-created triggers keep indexing whatever is written next.
		await seedEmails(stub, Folders.INBOX, [
			{ id: "upgrade-2", subject: "After the upgrade", sender: "new@example.org", recipient: UPGRADE_MAILBOX, date: "2026-01-03T10:00:00.000Z", body: "<p>freshlyindexedtoken</p>" },
		]);
		expect(ids(await stub.searchEmails({ query: "freshlyindexedtoken" }))).toEqual(["upgrade-2"]);
	});


	it("keeps a working index after the mailbox purge path", async () => {
		const stub = stubFor(PURGE_FTS_MAILBOX);
		await seedEmails(stub, Folders.INBOX, [
			{ id: "purge-fts-1", subject: "Before purge", sender: "purge@example.org", recipient: PURGE_FTS_MAILBOX, date: "2026-01-02T10:00:00.000Z", body: "<p>prepurgetoken</p>" },
		]);
		expect(ids(await stub.searchEmails({ query: "prepurgetoken" }))).toEqual(["purge-fts-1"]);

		// purgeAll empties storage and re-applies mailboxMigrations, so the
		// virtual table and its triggers have to come back with the rest of
		// the schema — otherwise the live instance keeps serving searches
		// against a table that no longer exists.
		await stub.purgeAll();
		const schemaObjects = await runInDurableObject(
			stub,
			async (_instance, state) =>
				[
					...state.storage.sql.exec(
						"SELECT name, type FROM sqlite_master WHERE name LIKE 'emails_fts%' ORDER BY type, name",
					),
				].map((row) => `${(row as { type: string }).type}:${(row as { name: string }).name}`),
		);
		expect(schemaObjects).toEqual([
			"table:emails_fts",
			"table:emails_fts_config",
			"table:emails_fts_data",
			"table:emails_fts_docsize",
			"table:emails_fts_idx",
			"trigger:emails_fts_ad",
			"trigger:emails_fts_ai",
			"trigger:emails_fts_au",
		]);

		// The re-applied index is empty, and it indexes new mail again.
		expect(ids(await stub.searchEmails({ query: "prepurgetoken" }))).toEqual([]);
		await seedEmails(stub, Folders.INBOX, [
			{ id: "purge-fts-2", subject: "After purge", sender: "purge@example.org", recipient: PURGE_FTS_MAILBOX, date: "2026-01-03T10:00:00.000Z", body: "<p>postpurgetoken</p>" },
		]);
		expect(ids(await stub.searchEmails({ query: "postpurgetoken" }))).toEqual(["purge-fts-2"]);
	});


	it("answers very long terms through the index, not the LIKE chunker", async () => {
		const stub = stubFor(LONG_TERM_MAILBOX);
		const longTerm = "zygomorphic".repeat(500); // 5500 characters
		await seedEmails(stub, Folders.INBOX, [
			{ id: "long-fts-1", subject: "Long index hit", sender: "long@example.org", recipient: LONG_TERM_MAILBOX, date: "2026-01-02T10:00:00.000Z", body: `<p>${longTerm}</p>` },
		]);

		// The same term on the LIKE path would spend ~115 bound parameters on
		// its 48-character chunks — past the 100-parameter statement limit
		// Durable Object SQLite enforces — so this can only pass as a single
		// FTS phrase.
		expect(ids(await stub.searchEmails({ query: longTerm }))).toEqual(["long-fts-1"]);
		expect(await stub.countSearchResults({ query: longTerm })).toBe(1);
		expect(ids(await stub.searchEmails({ query: `${longTerm.slice(0, -1)}z` }))).toEqual([]);
	});


	it("never throws on operator input of any shape", async () => {
		const stub = stubFor(NASTY_MAILBOX);
		await seedEmails(stub, Folders.INBOX, [
			{ id: "nasty-1", subject: "Literal punctuation", sender: "nasty@example.org", recipient: NASTY_MAILBOX, date: "2026-01-02T10:00:00.000Z", body: "<p>a (paren) and star* and dash- and % and _ and \"quoted\" text</p>" },
		]);

		// Every one of these is FTS5 syntax (or a LIKE metacharacter) in raw
		// form; all of them have to survive quoting and escaping.
		const nastyQueries = [
			'"', '""', '"""', 'a"b', "'", "\\", "(", "(((", ")))", "*", "**", "-", "-x", "--",
			"NOT", "AND", "OR", "NEAR", "col:value", "subject:foo", "a:b", "100%", "a_b", "%%%",
			"((a OR b))", "a*b(c)d-e", "; DROP TABLE emails; --", "' OR 1=1 --",
			"日本語", "👍👍", "👍👍👍", "a\u0000b", "\u0000", "\u0001\u0002\u0003",
		];
		for (const query of nastyQueries) {
			expect(Array.isArray(await stub.searchEmails({ query }))).toBe(true);
			expect(typeof (await stub.countSearchResults({ query }))).toBe("number");
		}

		// Quoting makes the punctuation literal, so the message holding it is
		// found by exactly the shapes an FTS5 parser would otherwise reject.
		expect(ids(await stub.searchEmails({ query: "(paren)" }))).toEqual(["nasty-1"]);
		expect(ids(await stub.searchEmails({ query: "star*" }))).toEqual(["nasty-1"]);
		expect(ids(await stub.searchEmails({ query: "dash-" }))).toEqual(["nasty-1"]);
		expect(ids(await stub.searchEmails({ query: '"quoted"' }))).toEqual(["nasty-1"]);
		expect(ids(await stub.searchEmails({ query: "and" }))).toEqual(["nasty-1"]);

		// An injection-shaped query is a literal phrase that matches nothing.
		expect(ids(await stub.searchEmails({ query: "'; DROP TABLE emails; --" }))).toEqual([]);
		// ...and the table is still there for the next search.
		expect(await stub.countSearchResults({ query: "(paren)" })).toBe(1);
	});
});


describe("splitFtsTerms", () => {
	it("splits on whitespace and drops blank input", () => {
		expect(splitFtsTerms("  quarterly \t projections \n between ")).toEqual({
			ftsPhrases: ['"quarterly"', '"projections"', '"between"'],
			shortTerms: [],
		});
		expect(splitFtsTerms("")).toEqual({ ftsPhrases: [], shortTerms: [] });
		expect(splitFtsTerms("   \t\n ")).toEqual({ ftsPhrases: [], shortTerms: [] });
		expect(splitFtsTerms(null)).toEqual({ ftsPhrases: [], shortTerms: [] });
		expect(splitFtsTerms(undefined)).toEqual({ ftsPhrases: [], shortTerms: [] });
	});


	it("routes terms the trigram index cannot match to the LIKE path", () => {
		expect(FTS_MIN_TERM_LENGTH).toBe(3);
		expect(splitFtsTerms("ab abc")).toEqual({ ftsPhrases: ['"abc"'], shortTerms: ["ab"] });
		expect(splitFtsTerms("50% a_b % _")).toEqual({
			ftsPhrases: ['"50%"', '"a_b"'],
			shortTerms: ["%", "_"],
		});
	});


	it("counts code points, not UTF-16 units", () => {
		// Two emoji are four UTF-16 units but two characters to the tokenizer,
		// which is below the trigram minimum — LIKE still finds them.
		expect(splitFtsTerms("👍👍")).toEqual({ ftsPhrases: [], shortTerms: ["👍👍"] });
		expect(splitFtsTerms("👍👍👍")).toEqual({ ftsPhrases: ['"👍👍👍"'], shortTerms: [] });
		expect(splitFtsTerms("日本 日本語")).toEqual({
			ftsPhrases: ['"日本語"'],
			shortTerms: ["日本"],
		});
	});


	it("quotes every term so FTS5 syntax cannot be injected", () => {
		expect(ftsPhrase('a"b')).toBe('"a""b"');
		expect(splitFtsTerms('"')).toEqual({ ftsPhrases: [], shortTerms: ['"'] });
		// Three literal quotes become eight: each is doubled, then quoted.
		expect(splitFtsTerms('"""')).toEqual({ ftsPhrases: ['""""""""'], shortTerms: [] });
		expect(splitFtsTerms('"quoted" (paren) *star*')).toEqual({
			ftsPhrases: ['"""quoted"""', '"(paren)"', '"*star*"'],
			shortTerms: [],
		});
		expect(splitFtsTerms("AND NOT NEAR")).toEqual({
			ftsPhrases: ['"AND"', '"NOT"', '"NEAR"'],
			shortTerms: [],
		});
	});


	it("treats NUL as a separator instead of letting it truncate a phrase", () => {
		// workerd hands bound parameters to SQLite as C strings, so a NUL used
		// to reach the FTS5 parser as an unterminated string.
		expect(splitFtsTerms("a\u0000b")).toEqual({ ftsPhrases: [], shortTerms: ["a", "b"] });
		expect(splitFtsTerms("abc\u0000def")).toEqual({
			ftsPhrases: ['"abc"', '"def"'],
			shortTerms: [],
		});
		expect(splitFtsTerms("\u0000")).toEqual({ ftsPhrases: [], shortTerms: [] });
	});


	it("keeps at most FTS_MAX_TERMS terms, in query order", () => {
		const terms = Array.from({ length: FTS_MAX_TERMS + 1 }, (_, index) => `word${index}`);
		const { ftsPhrases } = splitFtsTerms(terms.join(" "));
		expect(ftsPhrases).toHaveLength(FTS_MAX_TERMS);
		expect(ftsPhrases[0]).toBe('"word0"');
		expect(ftsPhrases.at(-1)).toBe(`"word${FTS_MAX_TERMS - 1}"`);
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
