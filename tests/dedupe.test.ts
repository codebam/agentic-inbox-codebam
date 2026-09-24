import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { receiveEmail } from "../workers/index";


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


type Stub = ReturnType<typeof stubFor>;


/** Deliver one email into a mailbox, optionally carrying an RFC 5322 Message-ID. */
async function deliver(
	stub: Stub,
	id: string,
	{
		folder = Folders.INBOX,
		messageId = null as string | null,
		subject = `Subject ${id}`,
		sender = "sender@example.org",
	}: { folder?: string; messageId?: string | null; subject?: string; sender?: string } = {},
) {
	return stub.createEmail(
		folder,
		{
			id,
			subject,
			sender,
			recipient: "dedupe@example.com",
			date: new Date().toISOString(),
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: id,
			message_id: messageId,
		},
		[],
	);
}


/** Count every row in this mailbox's emails table. */
async function countEmails(stub: Stub) {
	return runInDurableObject(stub, async (_instance, state) => {
		const rows = [...state.storage.sql.exec("SELECT COUNT(*) AS c FROM emails")];
		return (rows[0] as { c: number }).c;
	});
}


describe("Inbound dedupe", () => {
	it("stores the first delivery and reports the second as a duplicate", async () => {
		const stub = stubFor("dedupe-repeat@example.com");

		const first = await deliver(stub, "repeat-1", { messageId: "dup-1@example.org" });
		expect(first).toEqual({ id: "repeat-1", duplicate: false });

		const second = await deliver(stub, "repeat-2", { messageId: "dup-1@example.org" });
		expect(second).toEqual({ id: "repeat-1", duplicate: true });

		expect(await countEmails(stub)).toBe(1);
		expect(await stub.getEmail("repeat-2")).toBeNull();
	});

	it("keeps two rows when only subject and sender match (different Message-IDs)", async () => {
		const stub = stubFor("dedupe-distinct@example.com");

		const first = await deliver(stub, "distinct-1", {
			messageId: "distinct-a@example.org",
			subject: "Same subject",
			sender: "same@example.org",
		});
		const second = await deliver(stub, "distinct-2", {
			messageId: "distinct-b@example.org",
			subject: "Same subject",
			sender: "same@example.org",
		});

		expect(first.duplicate).toBe(false);
		expect(second.duplicate).toBe(false);
		expect(await countEmails(stub)).toBe(2);
	});

	it("never dedupes rows whose message_id is null", async () => {
		const stub = stubFor("dedupe-null@example.com");

		// Drafts omit message_id entirely and may legitimately look alike.
		const draftOne = await stub.createEmail(
			Folders.DRAFT,
			{
				id: "null-1",
				subject: "Same draft",
				sender: "dedupe-null@example.com",
				recipient: "someone@example.org",
				date: new Date().toISOString(),
				body: "<p>one</p>",
				in_reply_to: null,
				email_references: null,
				thread_id: "null-1",
			},
			[],
		);
		const draftTwo = await stub.createEmail(
			Folders.DRAFT,
			{
				id: "null-2",
				subject: "Same draft",
				sender: "dedupe-null@example.com",
				recipient: "someone@example.org",
				date: new Date().toISOString(),
				body: "<p>two</p>",
				in_reply_to: null,
				email_references: null,
				thread_id: "null-2",
			},
			[],
		);

		// Ingest passes an explicit null when the incoming message has no Message-ID.
		const nullOne = await deliver(stub, "null-3", { messageId: null });
		const nullTwo = await deliver(stub, "null-4", { messageId: null });

		expect([
			draftOne.duplicate,
			draftTwo.duplicate,
			nullOne.duplicate,
			nullTwo.duplicate,
		]).toEqual([false, false, false, false]);
		expect(await countEmails(stub)).toBe(4);
	});

	it("still reports a duplicate after the message moved to another folder", async () => {
		const stub = stubFor("dedupe-moved@example.com");

		await deliver(stub, "moved-1", { messageId: "moved-1@example.org" });
		await stub.moveEmail("moved-1", Folders.ARCHIVE);

		const redelivered = await deliver(stub, "moved-2", { messageId: "moved-1@example.org" });
		expect(redelivered).toEqual({ id: "moved-1", duplicate: true });

		// The archived row stays archived — it is never resurrected into Inbox.
		expect((await stub.getEmail("moved-1"))?.folder_id).toBe(Folders.ARCHIVE);
		expect(await stub.getEmail("moved-2")).toBeNull();
		expect(await countEmails(stub)).toBe(1);
	});

	it("still reports a duplicate after the message was trashed", async () => {
		const stub = stubFor("dedupe-trashed@example.com");

		await deliver(stub, "trashed-1", { messageId: "trashed-1@example.org" });
		await stub.trashEmails(["trashed-1"]);

		const redelivered = await deliver(stub, "trashed-2", { messageId: "trashed-1@example.org" });
		expect(redelivered).toEqual({ id: "trashed-1", duplicate: true });

		expect((await stub.getEmail("trashed-1"))?.folder_id).toBe(Folders.TRASH);
		expect(await stub.getEmail("trashed-2")).toBeNull();
		expect(await countEmails(stub)).toBe(1);
	});
});


/** ExecutionContext stand-in that records (instead of awaiting) waitUntil work. */
function recordingContext() {
	const pending: Promise<unknown>[] = [];
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			pending.push(promise);
		},
		passThroughOnException() {},
	} as unknown as ExecutionContext;
	return { ctx, pending };
}


/** Build the raw inbound event Cloudflare Email Routing hands to receiveEmail. */
function inboundEvent(to: string, messageId: string) {
	const mime = [
		"From: Sender <sender@example.org>",
		`To: ${to}`,
		"Subject: Duplicate delivery",
		`Message-ID: ${messageId}`,
		"Date: Tue, 23 Sep 2026 03:00:00 +0000",
		"",
		"hello",
	].join("\r\n");
	const bytes = new TextEncoder().encode(mime);
	return {
		raw: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		}),
		rawSize: bytes.byteLength,
		to,
	};
}


describe("Inbound dedupe ingest", () => {
	it("stores one row and skips the auto-draft trigger on a duplicate delivery", async () => {
		const mailbox = "dedupe-ingest@example.com";
		// Categorization off keeps the ingest path deterministic (no AI call).
		await env.BUCKET.put(
			`mailboxes/${mailbox}.json`,
			JSON.stringify({ categorization: { enabled: false } }),
		);

		const first = recordingContext();
		await receiveEmail(inboundEvent(mailbox, "<ingest-dup@example.org>"), env, first.ctx);
		// The first delivery is stored and schedules the auto-draft.
		expect(first.pending).toHaveLength(1);

		const second = recordingContext();
		await receiveEmail(inboundEvent(mailbox, "<ingest-dup@example.org>"), env, second.ctx);
		// The redelivery is dropped: no downstream side effect is scheduled.
		expect(second.pending).toHaveLength(0);

		const rows = await runInDurableObject(stubFor(mailbox), async (_instance, state) => {
			return [
				...state.storage.sql.exec(
					"SELECT id, message_id, folder_id FROM emails WHERE folder_id = 'inbox'",
				),
			] as unknown as { id: string; message_id: string | null; folder_id: string }[];
		});
		expect(rows).toHaveLength(1);
		expect(rows[0].message_id).toBe("ingest-dup@example.org");
		expect(rows[0].folder_id).toBe(Folders.INBOX);
	});
});


describe("Inbound dedupe schema", () => {
	it("ships a non-unique message_id index", async () => {
		const stub = stubFor("dedupe-index@example.com");

		const indexSql = await runInDurableObject(stub, async (_instance, state) => {
			const rows = [
				...state.storage.sql.exec(
					"SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_emails_message_id'",
				),
			];
			return (rows[0] as { sql: string } | undefined)?.sql ?? null;
		});

		expect(indexSql).toContain("idx_emails_message_id");
		// Non-unique on purpose: pre-existing duplicate rows must not block it.
		expect(indexSql).not.toContain("UNIQUE");
	});
});
