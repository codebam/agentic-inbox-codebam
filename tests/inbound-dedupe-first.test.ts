// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Dedupe-first ingest (workers/index.ts receiveEmail): the duplicate
 * lookup runs before any R2 put or attachment extraction, so a redelivery
 * leaves no orphan blobs or search rows; attachment-text extraction runs
 * in ctx.waitUntil after createEmail; R2 puts run in bounded chunks of
 * five.
 */
import {
	createExecutionContext,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { receiveEmail } from "../workers/index";
import { encodeBase64Bytes } from "../workers/lib/attachments";


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(
		`mailboxes/${mailbox}.json`,
		JSON.stringify({
			categorization: { enabled: false },
			items: { enabled: false },
			autoDraft: false,
		}),
	);
}

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

const encoder = new TextEncoder();

function inboundWithTextAttachments(
	to: string,
	messageId: string,
	files: { filename: string; text: string }[],
) {
	const boundary = "BOUNDARY-DEDUPE-FIRST";
	const parts: string[] = [
		"From: Sender <sender@example.org>",
		`To: ${to}`,
		"Subject: Dedupe-first check",
		`Message-ID: ${messageId}`,
		"MIME-Version: 1.0",
		`Content-Type: multipart/mixed; boundary="${boundary}"`,
		"",
		`--${boundary}`,
		'Content-Type: text/plain; charset="utf-8"',
		"",
		"Body text.",
		"",
	];
	for (const file of files) {
		parts.push(
			`--${boundary}`,
			`Content-Type: text/plain; charset="utf-8"; name="${file.filename}"`,
			"Content-Transfer-Encoding: base64",
			`Content-Disposition: attachment; filename="${file.filename}"`,
			"",
			encodeBase64Bytes(encoder.encode(file.text)),
			"",
		);
	}
	parts.push(`--${boundary}--`, "");
	const mime = parts.join("\r\n");
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

async function storedTextCount(
	stub: ReturnType<typeof stubFor>,
	emailId: string,
) {
	return (
		await runInDurableObject(stub, async (_instance, state) => [
			...state.storage.sql.exec(
				"SELECT COUNT(*) AS c FROM attachment_text WHERE email_id = ?1",
				emailId,
			),
		])
	) as unknown as { c: number }[];
}

describe("dedupe-first ingest", () => {
	it("exposes the duplicate lookup over RPC", async () => {
		const mailbox = "dedupe-first-rpc@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await stub.createEmail(
			Folders.INBOX,
			{
				id: "rpc-seed",
				subject: "Seed",
				sender: "sender@example.org",
				recipient: mailbox,
				date: new Date().toISOString(),
				body: "<p>seed</p>",
				thread_id: "rpc-seed",
				message_id: "rpc-dup@example.org",
			},
			[],
		);
		expect(await stub.findDuplicateEmailId("rpc-dup@example.org")).toBe(
			"rpc-seed",
		);
		expect(await stub.findDuplicateEmailId("missing@example.org")).toBeNull();
		expect(await stub.findDuplicateEmailId(null)).toBeNull();
	});

	it("skips R2 uploads and schedules no extraction on a duplicate", async () => {
		const mailbox = "dedupe-first-orphan@example.com";
		await registerMailbox(mailbox);

		const first = recordingContext();
		await receiveEmail(
			inboundWithTextAttachments(mailbox, "<dup-first@example.org>", [
				{ filename: "notes.txt", text: "orphan token lives here" },
			]),
			env,
			first.ctx,
		);
		// Only the attachment-text step is scheduled (auto-draft and items
		// are off, semantic is off, no webhook/push configured). Inline
		// extraction would schedule nothing.
		expect(first.pending).toHaveLength(1);
		await Promise.all(first.pending);

		const stub = stubFor(mailbox);
		const inbox = (await stub.getEmails({ folder: Folders.INBOX })) as {
			id: string;
		}[];
		expect(inbox).toHaveLength(1);
		const emailId = inbox[0]!.id;
		expect(await stub.findDuplicateEmailId("dup-first@example.org")).toBe(
			emailId,
		);

		const firstBlobs = await env.BUCKET.list({
			prefix: `attachments/${emailId}/`,
		});
		expect(firstBlobs.objects).toHaveLength(1);
		expect(
			(await storedTextCount(stub, emailId))[0]?.c,
		).toBe(1);

		const second = recordingContext();
		await receiveEmail(
			inboundWithTextAttachments(mailbox, "<dup-first@example.org>", [
				{ filename: "notes.txt", text: "orphan token lives here" },
			]),
			env,
			second.ctx,
		);
		// The redelivery returns at the early check: no extraction work
		// scheduled, no second row, no second blob set.
		expect(second.pending).toHaveLength(0);
		expect(
			(await stub.getEmails({ folder: Folders.INBOX })) as unknown[],
		).toHaveLength(1);
		const secondBlobs = await env.BUCKET.list({
			prefix: `attachments/${emailId}/`,
		});
		expect(secondBlobs.objects).toHaveLength(1);
		expect(
			(await storedTextCount(stub, emailId))[0]?.c,
		).toBe(1);
	});
});

describe("chunked R2 uploads", () => {
	it("stores every attachment when uploads run in chunks of five", async () => {
		const mailbox = "dedupe-first-chunked@example.com";
		await registerMailbox(mailbox);

		const files = Array.from({ length: 6 }, (_, index) => ({
			filename: `file-${index}.txt`,
			text: `chunk token ${index}`,
		}));
		const event = inboundWithTextAttachments(
			mailbox,
			"<chunked@example.org>",
			files,
		) as unknown as Parameters<typeof receiveEmail>[0];

		const ctx = createExecutionContext();
		await receiveEmail(event, env, ctx);
		await waitOnExecutionContext(ctx);

		const stub = stubFor(mailbox);
		const inbox = (await stub.getEmails({ folder: Folders.INBOX })) as {
			id: string;
		}[];
		expect(inbox).toHaveLength(1);
		const email = (await stub.getEmail(inbox[0]!.id)) as {
			attachments: { filename: string }[];
		} | null;
		expect(email?.attachments.map((a) => a.filename)).toEqual(
			files.map((f) => f.filename),
		);

		const blobs = await env.BUCKET.list({
			prefix: `attachments/${inbox[0]!.id}/`,
		});
		expect(blobs.objects).toHaveLength(6);
	});
});
