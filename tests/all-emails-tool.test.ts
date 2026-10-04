// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * All Accounts listing tests: the shared cross-mailbox fan-out behind
 * GET /api/v1/all-emails and the `list_all_emails` agent/MCP tool.
 *
 * The route and the tool answer the same merged page (they call the same
 * function), rows carry their source mailbox, a folder applies to every
 * mailbox, "all" is the same as omitting it, and an out-of-range page
 * clamps instead of failing.
 *
 * Seeds carry far-future dates so the pages this file asserts on are
 * deterministic no matter what the rest of the pool has stored.
 */

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { toolListAllEmails } from "../workers/lib/tools";

interface MergedPage {
	emails: { id: string; mailboxId: string }[];
	totalCount: number;
}

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

/** Register the mailbox record the listing checks before routing. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
}

/** Seed one stored message in a chosen folder and date. */
async function seed(
	mailbox: string,
	id: string,
	options: { folder?: string; date: string },
) {
	await stubFor(mailbox).createEmail(
		options.folder ?? Folders.INBOX,
		{
			id,
			subject: `Subject ${id}`,
			sender: "sender@example.org",
			recipient: mailbox,
			date: options.date,
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: id,
		},
		[],
	);
}

describe("all-accounts listing", () => {
	it("answers the same merged page from the route and the tool", async () => {
		const alpha = "all-tool-alpha@example.com";
		const beta = "all-tool-beta@example.com";
		await registerMailbox(alpha);
		await registerMailbox(beta);
		await seed(alpha, "all-tool-a1", { date: "2099-01-03T12:00:00.000Z" });
		await seed(alpha, "all-tool-a2", { date: "2099-01-01T12:00:00.000Z" });
		await seed(beta, "all-tool-b1", { date: "2099-01-02T12:00:00.000Z" });

		const response = await SELF.fetch(
			"http://example.com/api/v1/all-emails?limit=3",
		);
		expect(response.status).toBe(200);
		const route = (await response.json()) as MergedPage;
		const tool = await toolListAllEmails(env, { limit: 3 });

		// The future dates put these three rows on top of the merged page,
		// so the comparison is exact: newest first, tagged per mailbox.
		expect(route.emails).toEqual(tool.emails);
		expect(tool.emails.map((row) => row.id)).toEqual([
			"all-tool-a1",
			"all-tool-b1",
			"all-tool-a2",
		]);
		expect(tool.emails.map((row) => row.mailboxId)).toEqual([
			alpha,
			beta,
			alpha,
		]);
		expect(route.totalCount).toBeGreaterThanOrEqual(3);
	});

	it("applies a folder to every mailbox and clamps out-of-range pages", async () => {
		const gamma = "all-tool-gamma@example.com";
		const delta = "all-tool-delta@example.com";
		await registerMailbox(gamma);
		await registerMailbox(delta);
		await seed(gamma, "all-tool-g1", { date: "2099-02-03T12:00:00.000Z" });
		await seed(gamma, "all-tool-g2", {
			folder: Folders.ARCHIVE,
			date: "2099-02-04T12:00:00.000Z",
		});
		await seed(delta, "all-tool-d1", { date: "2099-02-02T12:00:00.000Z" });

		const inbox = await toolListAllEmails(env, {
			folder: "inbox",
			limit: 100,
		});
		const inboxIds = inbox.emails.map((row) => row.id);
		expect(inboxIds).toContain("all-tool-g1");
		expect(inboxIds).toContain("all-tool-d1");
		expect(inboxIds).not.toContain("all-tool-g2");
		expect(inbox.emails.map((row) => row.mailboxId)).toEqual(
			expect.arrayContaining([gamma, delta]),
		);
		// Newest first among the rows this file owns.
		expect(inboxIds.slice(0, 2)).toEqual(["all-tool-g1", "all-tool-d1"]);

		// "all" merges every folder, exactly like omitting the parameter.
		const all = await toolListAllEmails(env, { folder: "all", limit: 100 });
		expect(all.emails.map((row) => row.id)).toContain("all-tool-g2");

		// An out-of-range page clamps to the last real page, not an error.
		const clamped = await toolListAllEmails(env, { page: 999, limit: 1 });
		expect(clamped.emails).toHaveLength(1);
		expect(clamped.totalCount).toBeGreaterThanOrEqual(1);
	});
});
