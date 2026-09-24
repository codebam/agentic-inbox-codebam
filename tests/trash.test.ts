import { runInDurableObject } from "cloudflare:test";
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
