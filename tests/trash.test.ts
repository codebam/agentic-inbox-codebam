import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";


const MAILBOX = "trash@example.com";


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


/** Seed one email (optionally with a single attachment) into a folder. */
async function seedEmail(
	stub: ReturnType<typeof stubFor>,
	id: string,
	folder: string,
	{ attachment = false }: { attachment?: boolean } = {},
) {
	await stub.createEmail(
		folder,
		{
			id,
			subject: `Subject ${id}`,
			sender: "sender@example.org",
			recipient: MAILBOX,
			date: new Date().toISOString(),
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: id,
		},
		attachment
			? [
					{
						id: `${id}-attachment`,
						email_id: id,
						filename: "notes.txt",
						mimetype: "text/plain",
						size: 5,
					},
				]
			: [],
	);
}


describe("Trash semantics", () => {
	it("moves an email to Trash and keeps its row and attachments", async () => {
		const stub = stubFor("trash-keep@example.com");
		await seedEmail(stub, "keep-1", Folders.INBOX, { attachment: true });


		const result = await stub.trashEmails(["keep-1"]);
		expect(result.trashed).toEqual(["keep-1"]);
		expect(result.alreadyInTrash).toEqual([]);


		const email = await stub.getEmail("keep-1");
		expect(email).not.toBeNull();
		expect(email?.folder_id).toBe(Folders.TRASH);
		expect(email?.attachments).toHaveLength(1);


		// The attachment row survives the move; only permanent deletion removes it.
		const attachmentCount = await runInDurableObject(stub, async (_instance, state) => {
			const rows = [
				...state.storage.sql.exec(
					"SELECT COUNT(*) AS c FROM attachments WHERE email_id = ?1",
					"keep-1",
				),
			];
			return (rows[0] as { c: number }).c;
		});
		expect(attachmentCount).toBe(1);
	});


	it("leaves already-trashed messages in place and reports the partition", async () => {
		const stub = stubFor("trash-partition@example.com");
		await seedEmail(stub, "inbox-1", Folders.INBOX);
		await seedEmail(stub, "trash-1", Folders.TRASH);


		const { trashed, alreadyInTrash } = await stub.trashEmails([
			"inbox-1",
			"trash-1",
			"missing-1",
		]);


		expect(trashed).toEqual(["inbox-1"]);
		expect(alreadyInTrash).toEqual(["trash-1"]);
		expect((await stub.getEmail("inbox-1"))?.folder_id).toBe(Folders.TRASH);
		expect((await stub.getEmail("trash-1"))?.folder_id).toBe(Folders.TRASH);
	});


	it("restoreEmails moves a message from Trash back to the inbox", async () => {
		const stub = stubFor("trash-restore@example.com");
		await seedEmail(stub, "restore-1", Folders.INBOX);
		await stub.trashEmails(["restore-1"]);
		expect((await stub.getEmail("restore-1"))?.folder_id).toBe(Folders.TRASH);


		const restored = await stub.restoreEmails(["restore-1"]);
		expect(restored).toEqual(["restore-1"]);
		expect((await stub.getEmail("restore-1"))?.folder_id).toBe(Folders.INBOX);


		// Restoring a message that is not in Trash is a no-op.
		expect(await stub.restoreEmails(["restore-1"])).toEqual([]);
	});


	it("emptyTrash purges trashed rows and reports their attachments", async () => {
		const stub = stubFor("trash-empty@example.com");
		await seedEmail(stub, "trash-a", Folders.TRASH, { attachment: true });
		await seedEmail(stub, "trash-b", Folders.TRASH);
		await seedEmail(stub, "inbox-a", Folders.INBOX);


		const { purged, attachments } = await stub.emptyTrash();
		expect(purged).toBe(2);
		expect(attachments.map((att) => att.email_id)).toEqual(["trash-a"]);


		expect(await stub.getEmail("trash-a")).toBeNull();
		expect(await stub.getEmail("trash-b")).toBeNull();
		expect(await stub.getEmail("inbox-a")).not.toBeNull();


		const attachmentCount = await runInDurableObject(stub, async (_instance, state) => {
			const rows = [...state.storage.sql.exec("SELECT COUNT(*) AS c FROM attachments")];
			return (rows[0] as { c: number }).c;
		});
		expect(attachmentCount).toBe(0);
	});
});


/** Register the mailbox record the API middleware checks before routing. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
}


/** POST a bulk action to the real route through the worker under test. */
async function postBulk(mailbox: string, body: unknown) {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/emails/bulk`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}


/** R2 key for the single attachment seedEmail can create. */
function attachmentKey(emailId: string) {
	return `attachments/${emailId}/${emailId}-attachment/notes.txt`;
}


describe("Trash routes", () => {
	it("bulk delete trashes inbox messages and purges messages already in Trash", async () => {
		const mailbox = "trash-bulk@example.com";
		const stub = stubFor(mailbox);
		await registerMailbox(mailbox);
		await seedEmail(stub, "bulk-inbox", Folders.INBOX, { attachment: true });
		await seedEmail(stub, "bulk-trashed", Folders.TRASH, { attachment: true });
		// Seed both attachment blobs so the purge path is observable in R2.
		await env.BUCKET.put(attachmentKey("bulk-inbox"), "inbox blob");
		await env.BUCKET.put(attachmentKey("bulk-trashed"), "trash blob");


		const res = await postBulk(mailbox, {
			action: "delete",
			ids: ["bulk-inbox", "bulk-trashed"],
		});
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ trashed: 1, purged: 1, restored: 0 });


		// The inbox message moved to Trash and kept its row and blob.
		expect((await stub.getEmail("bulk-inbox"))?.folder_id).toBe(Folders.TRASH);
		expect(await env.BUCKET.head(attachmentKey("bulk-inbox"))).not.toBeNull();


		// The message already in Trash is gone for good, blob included.
		expect(await stub.getEmail("bulk-trashed")).toBeNull();
		expect(await env.BUCKET.head(attachmentKey("bulk-trashed"))).toBeNull();
	});


	it("bulk trash and restore move messages between folders and report counts", async () => {
		const mailbox = "trash-bulk-actions@example.com";
		const stub = stubFor(mailbox);
		await registerMailbox(mailbox);
		await seedEmail(stub, "action-1", Folders.INBOX);


		const trashed = await postBulk(mailbox, { action: "trash", ids: ["action-1"] });
		expect(trashed.body).toEqual({ trashed: 1, purged: 0, restored: 0 });
		expect((await stub.getEmail("action-1"))?.folder_id).toBe(Folders.TRASH);


		// Trashing an already-trashed message is a no-op, never a purge.
		const again = await postBulk(mailbox, { action: "trash", ids: ["action-1"] });
		expect(again.body).toEqual({ trashed: 0, purged: 0, restored: 0 });
		expect(await stub.getEmail("action-1")).not.toBeNull();


		const restored = await postBulk(mailbox, { action: "restore", ids: ["action-1"] });
		expect(restored.body).toEqual({ trashed: 0, purged: 0, restored: 1 });
		expect((await stub.getEmail("action-1"))?.folder_id).toBe(Folders.INBOX);
	});


	it("the delete route trashes an inbox email, then purges it from Trash", async () => {
		const mailbox = "trash-delete-route@example.com";
		const stub = stubFor(mailbox);
		await registerMailbox(mailbox);
		await seedEmail(stub, "route-delete-1", Folders.INBOX, { attachment: true });
		await env.BUCKET.put(attachmentKey("route-delete-1"), "blob");


		const url = `http://example.com/api/v1/mailboxes/${mailbox}/emails/route-delete-1`;


		const first = await SELF.fetch(url, { method: "DELETE" });
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ status: "trashed", trashed: 1, purged: 0 });
		expect((await stub.getEmail("route-delete-1"))?.folder_id).toBe(Folders.TRASH);
		expect(await env.BUCKET.head(attachmentKey("route-delete-1"))).not.toBeNull();


		const second = await SELF.fetch(url, { method: "DELETE" });
		expect(second.status).toBe(200);
		expect(await second.json()).toEqual({ status: "deleted", trashed: 0, purged: 1 });
		expect(await stub.getEmail("route-delete-1")).toBeNull();
		expect(await env.BUCKET.head(attachmentKey("route-delete-1"))).toBeNull();
	});


	it("the restore route moves a trashed email back to the inbox", async () => {
		const mailbox = "trash-restore-route@example.com";
		const stub = stubFor(mailbox);
		await registerMailbox(mailbox);
		await seedEmail(stub, "route-restore-1", Folders.INBOX);
		await stub.trashEmails(["route-restore-1"]);


		const res = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/emails/route-restore-1/restore`,
			{ method: "POST" },
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ restored: 1 });
		expect((await stub.getEmail("route-restore-1"))?.folder_id).toBe(Folders.INBOX);
	});


	it("the empty-trash route purges trashed rows and their R2 blobs", async () => {
		const mailbox = "trash-empty-route@example.com";
		const stub = stubFor(mailbox);
		await registerMailbox(mailbox);
		await seedEmail(stub, "empty-route-1", Folders.TRASH, { attachment: true });
		await seedEmail(stub, "empty-route-keep", Folders.INBOX);
		await env.BUCKET.put(attachmentKey("empty-route-1"), "blob");


		const res = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/trash/empty`,
			{ method: "POST" },
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ purged: 1 });
		expect(await stub.getEmail("empty-route-1")).toBeNull();
		expect(await stub.getEmail("empty-route-keep")).not.toBeNull();
		expect(await env.BUCKET.head(attachmentKey("empty-route-1"))).toBeNull();
	});
});
