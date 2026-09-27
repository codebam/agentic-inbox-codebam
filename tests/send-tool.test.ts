import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { formatFileSize } from "../app/lib/attachments";
import { attachmentR2Key, encodeBase64Bytes } from "../workers/lib/attachments";
import {
	MAX_TOOL_ATTACHMENT_BYTES,
	MAX_TOOL_ATTACHMENT_FILES,
	setToolSendEmailSenderFactory,
	toolSendEmail,
} from "../workers/lib/tools";
import type { SendEmailParams } from "../workers/email-sender";


type Stub = ReturnType<typeof stubFor>;


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


/** Register a mailbox record in R2 so the MCP layer's mailbox check passes. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(
		`mailboxes/${mailbox}.json`,
		JSON.stringify({ categorization: { enabled: false } }),
	);
}


/** A sender that records what it was asked to deliver. */
function fakeSender() {
	const sent: SendEmailParams[] = [];
	const sender = {
		send: async (params: SendEmailParams) => {
			sent.push(params);
			return { messageId: `fake-${sent.length}` };
		},
	};
	return { sender, sent };
}


/** The Sent folder's rows, typed loosely: the assertions name the fields. */
async function sentRows(stub: Stub) {
	return (await stub.getEmails({ folder: Folders.SENT })) as {
		id: string;
		recipient: string;
		subject: string;
		cc: string | null;
		bcc: string | null;
	}[];
}


describe("send_email tool", () => {
	it("stores a Sent copy in the Sent folder and reports sent", async () => {
		const mailbox = "send-tool-plain@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		const { sender, sent } = fakeSender();
		setToolSendEmailSenderFactory(() => sender);
		try {
			const result = await toolSendEmail(env, mailbox, {
				to: "recipient@example.org",
				subject: "Hello from the tool",
				bodyHtml: "<p>hi</p>",
			});
			if ("error" in result) throw new Error(result.error);

			expect(result.status).toBe("sent");
			expect(result.message).toBe("Email sent to recipient@example.org");

			// The injected sender got the binding parameters, not a live binding.
			expect(sent).toHaveLength(1);
			expect(sent[0]).toMatchObject({
				to: "recipient@example.org",
				from: mailbox,
				subject: "Hello from the tool",
				html: "<p>hi</p>",
			});
			expect(sent[0]?.cc).toBeUndefined();
			expect(sent[0]?.bcc).toBeUndefined();
			expect(sent[0]?.attachments).toBeUndefined();

			// The Sent copy is stored exactly like the immediate path's.
			const sentFolder = await sentRows(stub);
			expect(sentFolder).toHaveLength(1);
			expect(sentFolder[0]).toMatchObject({
				id: result.messageId,
				recipient: "recipient@example.org",
				subject: "Hello from the tool",
				cc: null,
				bcc: null,
			});
		} finally {
			setToolSendEmailSenderFactory(null);
		}
	});


	it("passes cc and bcc to the binding and stores them on the Sent copy", async () => {
		const mailbox = "send-tool-copies@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		const { sender, sent } = fakeSender();
		setToolSendEmailSenderFactory(() => sender);
		try {
			const result = await toolSendEmail(env, mailbox, {
				to: "recipient@example.org",
				cc: ["cc-one@example.org", "cc-two@example.org"],
				bcc: "bcc@example.org",
				subject: "With copies",
				bodyHtml: "<p>hi</p>",
			});
			if ("error" in result) throw new Error(result.error);

			// The binding call carries the copies as given.
			expect(sent).toHaveLength(1);
			expect(sent[0]?.cc).toEqual(["cc-one@example.org", "cc-two@example.org"]);
			expect(sent[0]?.bcc).toBe("bcc@example.org");

			// The Sent copy records them, joined and lowercased like the
			// HTTP send route's own Sent copy.
			const copy = (await stub.getEmail(result.messageId)) as {
				cc: string | null;
				bcc: string | null;
			} | null;
			expect(copy?.cc).toBe("cc-one@example.org, cc-two@example.org");
			expect(copy?.bcc).toBe("bcc@example.org");
		} finally {
			setToolSendEmailSenderFactory(null);
		}
	});


	it("stores an attachment in R2 under the route's key shape and on the Sent copy", async () => {
		const mailbox = "send-tool-attachment@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		// "hello attachment", 16 bytes.
		const content = "aGVsbG8gYXR0YWNobWVudA==";
		const { sender, sent } = fakeSender();
		setToolSendEmailSenderFactory(() => sender);
		try {
			const result = await toolSendEmail(env, mailbox, {
				to: "recipient@example.org",
				subject: "With a file",
				bodyHtml: "<p>hi</p>",
				attachments: [
					{
						filename: "hello.txt",
						mimetype: "text/plain",
						content_base64: content,
					},
				],
			});
			if ("error" in result) throw new Error(result.error);

			// The binding call gets the file in the shape sendEmail maps.
			expect(sent).toHaveLength(1);
			expect(sent[0]?.attachments).toEqual([
				{
					content,
					filename: "hello.txt",
					type: "text/plain",
					disposition: "attachment",
				},
			]);

			// The Sent copy names the file, and its bytes sit under the
			// attachment key the download routes read.
			const copy = (await stub.getEmail(result.messageId)) as {
				attachments: {
					id: string;
					email_id: string;
					filename: string;
					mimetype: string;
					size: number;
				}[];
			} | null;
			expect(copy?.attachments).toHaveLength(1);
			const attachment = copy!.attachments[0]!;
			expect(attachment).toMatchObject({
				email_id: result.messageId,
				filename: "hello.txt",
				mimetype: "text/plain",
				size: 16,
			});

			const object = await env.BUCKET.get(
				attachmentR2Key({
					email_id: attachment.email_id,
					id: attachment.id,
					filename: attachment.filename,
				}),
			);
			expect(object).not.toBeNull();
			expect(await object!.text()).toBe("hello attachment");
		} finally {
			setToolSendEmailSenderFactory(null);
		}
	});


	it("accepts exactly the file-count cap", async () => {
		const mailbox = "send-tool-at-cap@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		const { sender, sent } = fakeSender();
		setToolSendEmailSenderFactory(() => sender);
		try {
			const result = await toolSendEmail(env, mailbox, {
				to: "recipient@example.org",
				subject: "Five files",
				bodyHtml: "<p>hi</p>",
				attachments: Array.from(
					{ length: MAX_TOOL_ATTACHMENT_FILES },
					(_, i) => ({
						filename: `file-${i}.txt`,
						mimetype: "text/plain",
						content_base64: "aGk=",
					}),
				),
			});
			if ("error" in result) throw new Error(result.error);

			expect(sent[0]?.attachments).toHaveLength(MAX_TOOL_ATTACHMENT_FILES);
			const copy = (await stub.getEmail(result.messageId)) as {
				attachments: unknown[];
			} | null;
			expect(copy?.attachments).toHaveLength(MAX_TOOL_ATTACHMENT_FILES);
		} finally {
			setToolSendEmailSenderFactory(null);
		}
	});


	it("refuses attachments over the caps, names the cap and sends nothing", async () => {
		const mailbox = "send-tool-over-cap@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		const { sender, sent } = fakeSender();
		setToolSendEmailSenderFactory(() => sender);
		try {
			// One file over the five-file cap.
			const tooMany = await toolSendEmail(env, mailbox, {
				to: "recipient@example.org",
				subject: "Too many files",
				bodyHtml: "<p>hi</p>",
				attachments: Array.from(
					{ length: MAX_TOOL_ATTACHMENT_FILES + 1 },
					(_, i) => ({
						filename: `file-${i}.txt`,
						mimetype: "text/plain",
						content_base64: "aGk=",
					}),
				),
			});
			expect(tooMany).toEqual({
				error: expect.stringContaining(`${MAX_TOOL_ATTACHMENT_FILES} files`),
			});

			// Two files that each decode to just over half the byte cap:
			// together they decode to more than the cap in total.
			const chunk = encodeBase64Bytes(
				new Uint8Array(Math.ceil(MAX_TOOL_ATTACHMENT_BYTES / 2) + 1),
			);
			const tooLarge = await toolSendEmail(env, mailbox, {
				to: "recipient@example.org",
				subject: "Too big",
				bodyHtml: "<p>hi</p>",
				attachments: [
					{
						filename: "big-one.bin",
						mimetype: "application/octet-stream",
						content_base64: chunk,
					},
					{
						filename: "big-two.bin",
						mimetype: "application/octet-stream",
						content_base64: chunk,
					},
				],
			});
			expect(tooLarge).toEqual({
				error: expect.stringContaining(
					`over the ${formatFileSize(MAX_TOOL_ATTACHMENT_BYTES)} limit`,
				),
			});
		} finally {
			setToolSendEmailSenderFactory(null);
		}

		// Nothing was delivered and no Sent copy was stored.
		expect(sent).toHaveLength(0);
		expect(await sentRows(stub)).toHaveLength(0);
	});


	it("still fails closed when the draft verifier cannot run", async () => {
		const mailbox = "send-tool-verifier@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		const { sender, sent } = fakeSender();
		setToolSendEmailSenderFactory(() => sender);
		try {
			// Twenty or more characters of reply text reaches the verifier.
			// The pool's AI binding cannot run remotely, so verifyDraft
			// returns "" and the send must refuse rather than deliver.
			const result = await toolSendEmail(env, mailbox, {
				to: "recipient@example.org",
				subject: "Unverifiable",
				bodyHtml: "<p>This body is comfortably longer than twenty characters.</p>",
			});
			expect(result).toEqual({
				error: expect.stringContaining("Draft verification failed"),
			});
		} finally {
			setToolSendEmailSenderFactory(null);
		}

		expect(sent).toHaveLength(0);
		expect(await sentRows(stub)).toHaveLength(0);
	});
});
