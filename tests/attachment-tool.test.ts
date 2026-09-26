// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * get_attachment — the read-only attachment-content tool shared by the agent
 * and the MCP server.
 *
 * The attachment row comes from the mailbox Durable Object; the bytes come
 * from R2 at attachments/<email id>/<attachment id>/<filename>. Metadata is
 * always returned for an attachment that exists; content comes back only for
 * text-ish mimetypes at or below 1 MiB. Binary, oversized and missing blobs
 * come back as an omission reason, and an unknown attachment id follows the
 * tools' not-found convention.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { toolGetAttachment } from "../workers/lib/tools";

const MAILBOX = "attachment-tool@example.com";

type Stub = ReturnType<typeof stubFor>;

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

interface SeedAttachment {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

/** Seed one email (with the given attachment rows) into the Inbox. */
async function seedEmail(
	stub: Stub,
	id: string,
	attachments: SeedAttachment[] = [],
) {
	await stub.createEmail(
		Folders.INBOX,
		{
			id,
			subject: `Subject ${id}`,
			sender: "sender@example.org",
			recipient: MAILBOX,
			date: "2026-09-25T09:00:00.000Z",
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: id,
		},
		attachments.map((attachment) => ({ ...attachment, email_id: id })),
	);
}

/** R2 key the tool reads — the same shape deleteEmailWithAttachments uses. */
function attachmentKey(emailId: string, attachment: SeedAttachment) {
	return `attachments/${emailId}/${attachment.id}/${attachment.filename}`;
}

/** The metadata block every existing attachment comes back with. */
function metadataFor(emailId: string, attachment: SeedAttachment) {
	return {
		id: attachment.id,
		emailId,
		filename: attachment.filename,
		mimetype: attachment.mimetype,
		size: attachment.size,
		disposition: attachment.disposition ?? null,
		contentId: attachment.content_id ?? null,
	};
}

describe("get_attachment", () => {
	it("returns the decoded text of a text attachment", async () => {
		const stub = stubFor(MAILBOX);
		const text = "col1,col2\n1,2\n";
		const attachment: SeedAttachment = {
			id: "att-csv",
			filename: "report.csv",
			mimetype: "text/csv",
			size: text.length,
		};
		await seedEmail(stub, "email-csv", [attachment]);
		await env.BUCKET.put(attachmentKey("email-csv", attachment), text);

		expect(
			await toolGetAttachment(env, MAILBOX, { attachmentId: "att-csv" }),
		).toEqual({
			mailboxId: MAILBOX,
			attachment: metadataFor("email-csv", attachment),
			content: { kind: "text", text, truncated: false },
		});
	});

	it("omits content for a binary attachment and keeps its metadata", async () => {
		const stub = stubFor(MAILBOX);
		const attachment: SeedAttachment = {
			id: "att-logo",
			filename: "logo.png",
			mimetype: "image/png",
			size: 512,
			content_id: "<logo@example.com>",
			disposition: "inline",
		};
		await seedEmail(stub, "email-logo", [attachment]);
		// Deliberately no R2 object: the mimetype check must omit before any read.

		expect(
			await toolGetAttachment(env, MAILBOX, { attachmentId: "att-logo" }),
		).toEqual({
			mailboxId: MAILBOX,
			attachment: metadataFor("email-logo", attachment),
			content: {
				kind: "omitted",
				reason:
					'Attachment mimetype "image/png" is not text; content is omitted.',
			},
		});
	});

	it("omits an oversized text attachment without reading it", async () => {
		const stub = stubFor(MAILBOX);
		const attachment: SeedAttachment = {
			id: "att-huge",
			filename: "app.log",
			mimetype: "text/plain",
			size: 1048577,
		};
		await seedEmail(stub, "email-huge", [attachment]);

		expect(
			await toolGetAttachment(env, MAILBOX, { attachmentId: "att-huge" }),
		).toEqual({
			mailboxId: MAILBOX,
			attachment: metadataFor("email-huge", attachment),
			content: {
				kind: "omitted",
				reason:
					"Attachment size 1048577 bytes exceeds the 1048576-byte text limit; content is omitted.",
			},
		});
	});

	it("omits a text attachment whose blob is missing from storage", async () => {
		const stub = stubFor(MAILBOX);
		const attachment: SeedAttachment = {
			id: "att-gone",
			filename: "notes.txt",
			mimetype: "text/plain",
			size: 14,
		};
		await seedEmail(stub, "email-gone", [attachment]);
		// The row exists but the blob was never written (or was already purged).

		expect(
			await toolGetAttachment(env, MAILBOX, { attachmentId: "att-gone" }),
		).toEqual({
			mailboxId: MAILBOX,
			attachment: metadataFor("email-gone", attachment),
			content: { kind: "omitted", reason: "file not found in storage" },
		});
	});

	it("clips text past the 200000-character cap and flags it", async () => {
		const stub = stubFor(MAILBOX);
		const longText = "x".repeat(250000);
		const attachment: SeedAttachment = {
			id: "att-long",
			filename: "long.txt",
			mimetype: "text/plain",
			size: longText.length,
		};
		await seedEmail(stub, "email-long", [attachment]);
		await env.BUCKET.put(attachmentKey("email-long", attachment), longText);

		expect(
			await toolGetAttachment(env, MAILBOX, { attachmentId: "att-long" }),
		).toEqual({
			mailboxId: MAILBOX,
			attachment: metadataFor("email-long", attachment),
			content: { kind: "text", text: "x".repeat(200000), truncated: true },
		});
	});

	it("reports an unknown attachment with the not-found convention", async () => {
		const stub = stubFor(MAILBOX);
		await seedEmail(stub, "email-plain");

		expect(
			await toolGetAttachment(env, MAILBOX, { attachmentId: "att-missing" }),
		).toEqual({ error: "Attachment not found" });
	});
});
