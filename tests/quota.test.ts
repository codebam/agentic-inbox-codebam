// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Per-mailbox storage accounting: MailboxDO.getStorageUsage over an empty
 * and a seeded mailbox, and the frozen response shape of
 * GET /api/v1/mailboxes/:mailboxId/storage.
 *
 * Attachment bytes come from the attachments table's `size` column — the
 * source of truth the DO sums — while the route adds the size of the
 * mailbox's settings JSON object in R2.
 */


import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";


type Stub = ReturnType<typeof stubFor>;


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


/** Register a mailbox record in R2 so the HTTP routes accept its id. */
async function registerMailbox(mailbox: string, settings: Record<string, unknown> = {}) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify(settings));
}


/** One attachment row, in the shape createEmail stores it. */
interface SeedAttachment {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string | null;
}


/** Seed one email into a folder, optionally with attachment rows. */
async function seedEmail(
	stub: Stub,
	id: string,
	folder: string,
	attachments: SeedAttachment[] = [],
) {
	await stub.createEmail(
		folder,
		{
			id,
			subject: `Subject ${id}`,
			sender: "sender@example.org",
			recipient: "quota@example.com",
			date: "2026-09-24T09:00:00.000Z",
			read: false,
			starred: false,
			category: null,
			classification: null,
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: id,
		},
		attachments,
	);
}


/** 1 KiB + 2 KiB, the two attachment rows seedTwoMessages stores. */
const SEEDED_ATTACHMENT_BYTES = 1024 + 2048;


/** Seed two messages, one attachment each, into a mailbox's Inbox. */
async function seedTwoMessages(stub: Stub) {
	await seedEmail(stub, "quota-1", Folders.INBOX, [
		{
			id: "quota-att-1",
			email_id: "quota-1",
			filename: "invoice.pdf",
			mimetype: "application/pdf",
			size: 1024,
			content_id: null,
			disposition: "attachment",
		},
	]);
	await seedEmail(stub, "quota-2", Folders.INBOX, [
		{
			id: "quota-att-2",
			email_id: "quota-2",
			filename: "photo.png",
			mimetype: "image/png",
			size: 2048,
			content_id: "quota-cid-2",
			disposition: "inline",
		},
	]);
}


describe("MailboxDO.getStorageUsage", () => {
	it("reports zero content for an empty mailbox", async () => {
		const usage = await stubFor("quota-empty@example.com").getStorageUsage();

		expect(usage.attachment_bytes).toBe(0);
		expect(usage.attachment_count).toBe(0);
		expect(usage.email_count).toBe(0);
		// SQLite always owns at least its schema pages, so database_bytes is
		// the one field that cannot be zero even for an untouched mailbox.
		expect(usage.database_bytes).toBeGreaterThan(0);
	});


	it("sums seeded attachment sizes and counts emails", async () => {
		const stub = stubFor("quota-seeded@example.com");
		await seedTwoMessages(stub);

		const usage = await stub.getStorageUsage();

		expect(usage.email_count).toBe(2);
		expect(usage.attachment_count).toBe(2);
		expect(usage.attachment_bytes).toBe(SEEDED_ATTACHMENT_BYTES);
		expect(usage.database_bytes).toBeGreaterThan(0);
	});
});


describe("GET /api/v1/mailboxes/:mailboxId/storage", () => {
	it("returns the frozen storage shape for a seeded mailbox", async () => {
		const mailbox = "quota-route@example.com";
		await registerMailbox(mailbox, { fromName: "Quota" });
		await seedTwoMessages(stubFor(mailbox));

		const res = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/storage`,
		);

		expect(res.status).toBe(200);
		const { storage } = (await res.json()) as { storage: Record<string, number> };
		expect(Object.keys(storage).sort()).toEqual([
			"attachment_bytes",
			"attachment_count",
			"database_bytes",
			"email_count",
			"mailbox_json_bytes",
		]);
		for (const value of Object.values(storage)) expect(typeof value).toBe("number");
		expect(storage.email_count).toBe(2);
		expect(storage.attachment_count).toBe(2);
		expect(storage.attachment_bytes).toBe(SEEDED_ATTACHMENT_BYTES);
		expect(storage.database_bytes).toBeGreaterThan(0);
		// The route measures the settings object itself.
		const settingsObject = await env.BUCKET.head(`mailboxes/${mailbox}.json`);
		expect(storage.mailbox_json_bytes).toBe(settingsObject?.size);
	});


	it("404s for an unknown mailbox", async () => {
		const res = await SELF.fetch(
			"http://example.com/api/v1/mailboxes/quota-missing@example.com/storage",
		);
		expect(res.status).toBe(404);
	});
});
