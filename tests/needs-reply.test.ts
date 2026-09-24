// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * The list query's needs-reply and draft badges.
 *
 * `needs_reply` is true for a conversation whose newest message is not in
 * Sent or Draft and which has at least one read message; `has_draft` is true
 * when any message of the conversation sits in Drafts. Both predicates look
 * the folders up by name OR id — the folders table stores display names
 * ('Sent', 'Drafts'), so a bare `name = 'sent'` lookup returns NULL and
 * silently zeroed both flags.
 */


import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";


const MAILBOX = "needs-reply@example.com";

type Stub = ReturnType<typeof stubFor>;

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

interface SeedOptions {
	threadId?: string;
	date?: string;
	read?: boolean;
}

/** Seed one email into a folder (mirrors tests/digest.test.ts). */
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
			recipient: MAILBOX,
			date: options.date ?? "2026-09-24T09:00:00.000Z",
			read: options.read ?? false,
			starred: false,
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
	needs_reply: boolean;
	has_draft: boolean;
}

describe("list needs_reply and has_draft", () => {
	it("flags a read inbox conversation whose newest message is not Sent or Draft", async () => {
		const stub = stubFor(MAILBOX);
		await seedEmail(stub, "nr-1", Folders.INBOX, {
			threadId: "nr-t1",
			read: true,
			date: "2026-09-24T08:00:00.000Z",
		});
		await seedEmail(stub, "nr-2", Folders.INBOX, {
			threadId: "nr-t1",
			read: true,
			date: "2026-09-24T09:00:00.000Z",
		});

		const rows = (await stub.getThreadedEmails({
			folder: Folders.INBOX,
		})) as unknown as ListedRow[];
		const row = rows.find((candidate) => candidate.id === "nr-2");
		expect(row?.needs_reply).toBe(true);
		expect(row?.has_draft).toBe(false);
	});

	it("does not flag a conversation whose newest message is a Sent reply", async () => {
		const stub = stubFor(MAILBOX);
		await seedEmail(stub, "nr-3", Folders.INBOX, {
			threadId: "nr-t2",
			read: true,
			date: "2026-09-24T08:00:00.000Z",
		});
		await seedEmail(stub, "nr-4", Folders.SENT, {
			threadId: "nr-t2",
			read: true,
			date: "2026-09-24T09:00:00.000Z",
		});

		const rows = (await stub.getThreadedEmails({
			folder: Folders.INBOX,
		})) as unknown as ListedRow[];
		const row = rows.find((candidate) => candidate.id === "nr-3");
		expect(row?.needs_reply).toBe(false);
	});

	it("does not flag an unread conversation", async () => {
		const stub = stubFor(MAILBOX);
		await seedEmail(stub, "nr-5", Folders.INBOX, {
			threadId: "nr-t3",
			read: false,
			date: "2026-09-24T09:00:00.000Z",
		});

		const rows = (await stub.getThreadedEmails({
			folder: Folders.INBOX,
		})) as unknown as ListedRow[];
		const row = rows.find((candidate) => candidate.id === "nr-5");
		expect(row?.needs_reply).toBe(false);
	});

	it("flags has_draft when the conversation contains a draft", async () => {
		const stub = stubFor(MAILBOX);
		await seedEmail(stub, "nr-6", Folders.INBOX, {
			threadId: "nr-t4",
			read: true,
			date: "2026-09-24T08:00:00.000Z",
		});
		await seedEmail(stub, "nr-7", Folders.DRAFT, {
			threadId: "nr-t4",
			read: true,
			date: "2026-09-24T09:00:00.000Z",
		});

		const rows = (await stub.getThreadedEmails({
			folder: Folders.INBOX,
		})) as unknown as ListedRow[];
		const row = rows.find((candidate) => candidate.id === "nr-6");
		expect(row?.has_draft).toBe(true);
		expect(row?.needs_reply).toBe(false);
	});
});
