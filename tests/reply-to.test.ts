import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { receiveEmail, type InboundEmailEvent } from "../workers/index";
import { toolDraftReply } from "../workers/lib/tools";

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

/** Register the mailbox record the inbound pipeline checks. */
async function registerMailbox(mailbox: string, settings: Record<string, unknown>) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify(settings));
}

/** Delivery settings that keep the pipeline deterministic (no AI calls). */
const PIPELINE_SETTINGS = { categorization: { enabled: false } };

/** Push one raw message through the real receiveEmail path. */
async function deliver(
	mailbox: string,
	options: { from?: string; replyTo?: string; subject?: string } = {},
) {
	const raw = [
		`From: ${options.from ?? "sender@example.org"}`,
		`To: ${mailbox}`,
		`Subject: ${options.subject ?? "Hello"}`,
		...(options.replyTo ? [`Reply-To: ${options.replyTo}`] : []),
		"",
		"body",
		"",
	].join("\r\n");
	const bytes = new TextEncoder().encode(raw);
	const event: InboundEmailEvent = {
		raw: new Response(bytes).body as ReadableStream,
		rawSize: bytes.byteLength,
		to: mailbox,
	};
	await receiveEmail(event, env, createExecutionContext());
}

/** Seed one stored message with an explicit sender and optional Reply-To. */
async function seed(
	mailbox: string,
	id: string,
	options: { sender?: string; replyTo?: string | null } = {},
) {
	const stub = stubFor(mailbox);
	await stub.createEmail(
		Folders.INBOX,
		{
			id,
			subject: `Subject ${id}`,
			sender: options.sender ?? "sender@example.org",
			recipient: mailbox,
			reply_to: options.replyTo ?? null,
			date: new Date().toISOString(),
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: id,
		},
		[],
	);
	return stub;
}

describe("Reply-To", () => {
	it("migration 17 adds the reply_to column", async () => {
		const stub = stubFor("reply-to-migration@example.com");
		const columns = await runInDurableObject(stub, async (_instance, state) => {
			return [...state.storage.sql.exec("PRAGMA table_info(emails)")] as unknown as {
				name: string;
			}[];
		});
		expect(columns.map((c) => c.name)).toContain("reply_to");
	});

	it("stores the Reply-To header as a lowercased address list", async () => {
		const mailbox = "reply-to-ingest@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		await deliver(mailbox, {
			replyTo: "Mailing List <LIST@example.org>",
		});

		// The list rows stay lean; the detail row is where reply_to is read.
		const stub = stubFor(mailbox);
		const listed = (await stub.getEmails({ folder: Folders.INBOX })) as {
			id: string;
		}[];
		expect(listed).toHaveLength(1);
		const stored = (await stub.getEmail(listed[0]?.id ?? "")) as {
			reply_to: string | null;
		} | null;
		expect(stored?.reply_to).toBe("list@example.org");
	});

	it("keeps reply_to null when the message sets no Reply-To", async () => {
		const mailbox = "reply-to-absent@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		await deliver(mailbox, {});

		const stored = (await stubFor(mailbox).getEmail(
			((await stubFor(mailbox).getEmails({ folder: Folders.INBOX })) as {
				id: string;
			}[])[0]?.id ?? "",
		)) as { reply_to: string | null } | null;
		expect(stored?.reply_to).toBeNull();
	});

	it("draft_reply without a `to` targets the Reply-To address", async () => {
		const mailbox = "reply-to-draft@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const stub = await seed(mailbox, "rt-draft-1", {
			sender: "author@example.org",
			replyTo: "list@example.org",
		});

		const result = await toolDraftReply(env, mailbox, {
			originalEmailId: "rt-draft-1",
			subject: "Re: Subject",
			body: "Thanks!",
			isPlainText: true,
		});
		if (!("status" in result)) throw new Error(`draft failed: ${result.error}`);
		expect(result.draft["to"]).toBe("list@example.org");

		// The stored draft carries the same recipient.
		const draft = (await stub.getEmail(result.draftId)) as {
			recipient: string;
			folder_id: string;
		} | null;
		expect(draft?.folder_id).toBe(Folders.DRAFT);
		expect(draft?.recipient).toBe("list@example.org");
	});

	it("an explicit `to` wins over the Reply-To address", async () => {
		const mailbox = "reply-to-explicit@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		await seed(mailbox, "rt-explicit-1", {
			sender: "author@example.org",
			replyTo: "list@example.org",
		});

		const result = await toolDraftReply(env, mailbox, {
			originalEmailId: "rt-explicit-1",
			to: "someone-else@example.org",
			subject: "Re: Subject",
			body: "Thanks!",
			isPlainText: true,
		});
		if (!("status" in result)) throw new Error(`draft failed: ${result.error}`);
		expect(result.draft["to"]).toBe("someone-else@example.org");
	});

	it("falls back to the sender when there is no Reply-To", async () => {
		const mailbox = "reply-to-fallback@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		await seed(mailbox, "rt-fallback-1", {
			sender: "author@example.org",
			replyTo: null,
		});

		const result = await toolDraftReply(env, mailbox, {
			originalEmailId: "rt-fallback-1",
			subject: "Re: Subject",
			body: "Thanks!",
			isPlainText: true,
		});
		if (!("status" in result)) throw new Error(`draft failed: ${result.error}`);
		expect(result.draft["to"]).toBe("author@example.org");
	});
});
