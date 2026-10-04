// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * The search label filter, the list stream filter and the sender-policy
 * tools: each shared tool runs against real Durable Object state, and every
 * filter is read back through the originating web route so the two surfaces
 * cannot drift.
 */


import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import {
	toolGetSenderPolicy,
	toolListEmails,
	toolRemoveSenderPolicy,
	toolSearchEmails,
} from "../workers/lib/tools";


type Stub = ReturnType<typeof stubFor>;


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


/** Register the mailbox record the API middleware checks before routing. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
}


interface SeedOptions {
	threadId?: string;
	date?: string;
	read?: boolean;
	starred?: boolean;
}


/** Seed one email into a folder (mirrors tests/split-inbox.test.ts). */
async function seedEmail(
	stub: Stub,
	mailbox: string,
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
			recipient: mailbox,
			date: options.date ?? "2026-10-01T09:00:00.000Z",
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


/** The sorted id column of a list of email rows. */
function ids(rows: unknown): string[] {
	return (rows as { id: string }[]).map((row) => row.id).sort();
}


describe("search_emails label filter", () => {
	it("narrows to the exact label, case-insensitively, and matches the web search", async () => {
		const mailbox = "policy-search-label@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, mailbox, "lbl-1", Folders.INBOX);
		await seedEmail(stub, mailbox, "lbl-2", Folders.INBOX);
		await seedEmail(stub, mailbox, "lbl-3", Folders.ARCHIVE);
		const work = (await stub.createLabel({ name: "Work" })) as unknown as {
			id: string;
		};
		await stub.addLabelToEmail("lbl-1", work.id);
		await stub.addLabelToEmail("lbl-3", work.id);

		const toolRows = await toolSearchEmails(env, mailbox, { label: "work" });
		expect(ids(toolRows)).toEqual(["lbl-1", "lbl-3"]);

		// The web search route answers the same rows for the same label.
		const response = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/search?label=work`,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { emails: unknown };
		expect(ids(body.emails)).toEqual(["lbl-1", "lbl-3"]);
	});

	it("answers a label no email carries with no rows, exactly like the web", async () => {
		const mailbox = "policy-search-unknown-label@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, mailbox, "lbl-u1", Folders.INBOX);
		const receipts = (await stub.createLabel({ name: "Receipts" })) as unknown as {
			id: string;
		};
		await stub.addLabelToEmail("lbl-u1", receipts.id);

		const rows = await toolSearchEmails(env, mailbox, { label: "Nonexistent" });
		expect(rows).toEqual([]);

		const response = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/search?label=Nonexistent`,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { emails: unknown };
		expect(body.emails).toEqual([]);
	});
});


describe("list_emails stream filter", () => {
	it("returns the priority and other conversation partitions the web tabs show", async () => {
		const mailbox = "policy-search-stream@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		// Unread inbox message: priority.
		await seedEmail(stub, mailbox, "ps-unread", Folders.INBOX, {
			date: "2026-10-01T08:00:00.000Z",
		});
		// Read inbox message with a newer Sent reply: nothing to reply to, so other.
		await seedEmail(stub, mailbox, "ps-read", Folders.INBOX, {
			threadId: "ps-thread",
			read: true,
			date: "2026-10-01T09:00:00.000Z",
		});
		await seedEmail(stub, mailbox, "ps-read-sent", Folders.SENT, {
			threadId: "ps-thread",
			read: true,
			date: "2026-10-01T10:00:00.000Z",
		});

		const priority = await toolListEmails(env, mailbox, {
			folder: Folders.INBOX,
			limit: 20,
			page: 1,
			stream: "priority",
		});
		expect(ids(priority)).toEqual(["ps-unread"]);

		const other = await toolListEmails(env, mailbox, {
			folder: Folders.INBOX,
			limit: 20,
			page: 1,
			stream: "other",
		});
		expect(ids(other)).toEqual(["ps-read"]);

		// Without a stream the whole folder lists, as before.
		const all = await toolListEmails(env, mailbox, {
			folder: Folders.INBOX,
			limit: 20,
			page: 1,
		});
		expect(ids(all)).toEqual(["ps-read", "ps-unread"]);

		// The web's threaded tabs answer the same partition for the same filter.
		const response = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/emails?threaded=true&folder=inbox&stream=priority`,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { emails: unknown };
		expect(ids(body.emails)).toEqual(["ps-unread"]);
	});
});


describe("sender policy tools", () => {
	it("lists entries, removes one, and reports the route's not-found error", async () => {
		const mailbox = "policy-search-sender@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await stub.setSenderPolicy("Alice@Example.com", "allow");
		await stub.setSenderPolicy("bob@example.com", "block");

		const entries = await toolGetSenderPolicy(env, mailbox);
		expect(entries).toEqual([
			{ address: "alice@example.com", policy: "allow", created_at: expect.any(String) },
			{ address: "bob@example.com", policy: "block", created_at: expect.any(String) },
		]);

		// The address is matched case-insensitively, like the stored entry.
		const removed = await toolRemoveSenderPolicy(env, mailbox, {
			address: "ALICE@example.com",
		});
		expect(removed).toEqual({ status: "removed", address: "ALICE@example.com" });

		// Real DO state: alice is gone and bob is untouched.
		expect(await toolGetSenderPolicy(env, mailbox)).toEqual([
			{ address: "bob@example.com", policy: "block", created_at: expect.any(String) },
		]);
		expect(await stub.getSenderPolicy("alice@example.com")).toBeNull();
		expect((await stub.getSenderPolicy("bob@example.com"))?.policy).toBe("block");

		// A missing entry is the DELETE route's exact not-found error, and
		// the stored entries do not change.
		const missing = await toolRemoveSenderPolicy(env, mailbox, {
			address: "nobody@example.com",
		});
		expect(missing).toEqual({ error: "Sender policy entry not found" });

		const response = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/sender-policy?address=nobody@example.com`,
			{ method: "DELETE" },
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Sender policy entry not found" });
		expect(await toolGetSenderPolicy(env, mailbox)).toHaveLength(1);
	});
});
