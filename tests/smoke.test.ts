import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";

const MAILBOX = "smoke@example.com";

function stubFor(mailbox = MAILBOX) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

describe("MailboxDO", () => {
	it("boots with the system folders", async () => {
		const stub = stubFor();
		const folders = (await stub.getFolders()) as { id: string; name: string }[];
		expect(folders.map((f) => f.id)).toEqual(
			expect.arrayContaining([Folders.INBOX, Folders.SENT, Folders.DRAFT]),
		);
	});

	it("stores an email and reads it back", async () => {
		const stub = stubFor("roundtrip@example.com");
		const id = "email-1";
		await stub.createEmail(
			Folders.INBOX,
			{
				id,
				subject: "Hello",
				sender: "sender@example.org",
				recipient: "roundtrip@example.com",
				date: new Date().toISOString(),
				body: "<p>hi</p>",
				in_reply_to: null,
				email_references: null,
				thread_id: id,
			},
			[],
		);
		const listed = (await stub.getEmails({ folder: Folders.INBOX })) as {
			id: string;
		}[];
		expect(listed.map((e) => e.id)).toContain(id);
	});

	it("exposes internal state through runInDurableObject", async () => {
		const stub = stubFor("internal@example.com");
		const count = await runInDurableObject(stub, async (_instance, state) => {
			const rows = [...state.storage.sql.exec("SELECT COUNT(*) AS c FROM folders")];
			return (rows[0] as { c: number }).c;
		});
		expect(count).toBeGreaterThan(0);
	});
});
