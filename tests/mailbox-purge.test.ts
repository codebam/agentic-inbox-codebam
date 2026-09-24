import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";

const MAILBOX = "purge@example.com";

function mailboxStub(mailbox = MAILBOX) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

function agentStub(mailbox = MAILBOX) {
	return env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailbox));
}

/** Register the R2 settings marker the mailbox list and DELETE route read. */
async function registerMailbox(mailbox = MAILBOX) {
	await env.BUCKET.put(
		`mailboxes/${mailbox}.json`,
		JSON.stringify({ fromName: "Purge Test" }),
	);
}

async function deleteMailbox(mailbox = MAILBOX) {
	return SELF.fetch(`http://example.com/api/v1/mailboxes/${mailbox}`, {
		method: "DELETE",
	});
}

/** One stored message with one attachment row (and its R2 blob). */
async function seedEmailWithAttachment(mailbox = MAILBOX) {
	const stub = mailboxStub(mailbox);
	await stub.createEmail(
		Folders.INBOX,
		{
			id: "purge-email-1",
			subject: "Has an attachment",
			sender: "sender@example.org",
			recipient: mailbox,
			date: new Date().toISOString(),
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: "purge-email-1",
		},
		[
			{
				id: "purge-att-1",
				email_id: "purge-email-1",
				filename: "notes.txt",
				mimetype: "text/plain",
				size: 5,
				content_id: null,
				disposition: "attachment",
			},
		],
	);
	await env.BUCKET.put("attachments/purge-email-1/purge-att-1/notes.txt", "hello");
}

describe("DELETE /api/v1/mailboxes/:mailboxId", () => {
	it("purges the marker, DO state, attachment blobs and agent history", async () => {
		const mailbox = "purge-full@example.com";
		await registerMailbox(mailbox);
		await seedEmailWithAttachment(mailbox);

		// Seed the agent DO so the purge has history to remove.
		await runInDurableObject(agentStub(mailbox), async (_instance, state) => {
			await state.storage.put("purge-seed", "present");
		});

		const res = await deleteMailbox(mailbox);
		expect(res.status).toBe(204);

		// Marker gone: the mailbox no longer appears in any listing.
		expect(await env.BUCKET.head(`mailboxes/${mailbox}.json`)).toBeNull();

		// Blob gone: nothing is left under the attachment key.
		expect(
			await env.BUCKET.head("attachments/purge-email-1/purge-att-1/notes.txt"),
		).toBeNull();

		// DO state gone, and the schema was re-applied so the instance is
		// usable again (the constructor does not re-run on a live instance).
		const counts = await runInDurableObject(
			mailboxStub(mailbox),
			async (_instance, state) => {
				const emails = [...state.storage.sql.exec("SELECT COUNT(*) AS c FROM emails")];
				const folders = [...state.storage.sql.exec("SELECT COUNT(*) AS c FROM folders")];
				return {
					emails: (emails[0] as { c: number }).c,
					folders: (folders[0] as { c: number }).c,
				};
			},
		);
		expect(counts.emails).toBe(0);
		expect(counts.folders).toBeGreaterThan(0);

		// Agent history gone.
		const seeded = await runInDurableObject(
			agentStub(mailbox),
			async (_instance, state) => state.storage.get("purge-seed"),
		);
		expect(seeded).toBeUndefined();
	});

	it("leaves the purged mailbox usable again (schema re-applied)", async () => {
		const mailbox = "purge-reuse@example.com";
		await registerMailbox(mailbox);
		await seedEmailWithAttachment(mailbox);

		expect((await deleteMailbox(mailbox)).status).toBe(204);

		// The same address re-registered and used again works normally.
		await registerMailbox(mailbox);
		const stub = mailboxStub(mailbox);
		await stub.createEmail(
			Folders.INBOX,
			{
				id: "after-purge-1",
				subject: "Fresh start",
				sender: "sender@example.org",
				recipient: mailbox,
				date: new Date().toISOString(),
				body: "<p>new</p>",
				in_reply_to: null,
				email_references: null,
				thread_id: "after-purge-1",
			},
			[],
		);
		const listed = (await stub.getEmails({ folder: Folders.INBOX })) as {
			id: string;
		}[];
		expect(listed.map((e) => e.id)).toContain("after-purge-1");
	});

	it("404s for an unknown mailbox and removes nothing", async () => {
		const res = await deleteMailbox("purge-missing@example.com");
		expect(res.status).toBe(404);
		expect(await env.BUCKET.head("mailboxes/purge-missing@example.com.json")).toBeNull();
	});
});
