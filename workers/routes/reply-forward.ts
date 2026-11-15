// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Context } from "hono";
import { resolveSendEmailSender } from "../email-sender";
import { storeAttachments, attachmentR2Key } from "../lib/attachments";
import type { EmailFull } from "../lib/schemas";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildReferencesChain,
	buildThreadingHeaders,
	resolveOriginalEmail,
} from "../lib/email-helpers";
import { captureSendMessageId } from "../lib/delivery-match";
import { SendEmailRequestSchema } from "../lib/schemas";
import { Folders } from "../../shared/folders";
import { isSpamMarkedEmail } from "../../shared/spam";
import type { MailboxContext } from "../lib/mailbox";

type AppContext = Context<MailboxContext>;
type RateLimitStub = { checkSendRateLimit: () => Promise<string | null> };

export async function handleReplyEmail(c: AppContext) {
	const mailboxId = c.req.param("mailboxId") ?? "";
	const id = c.req.param("id") ?? "";
	const body = SendEmailRequestSchema.parse(await c.req.json());
	// Linked attachments are only offered for new messages — the composer
	// never sends the field here, and the reply/forward paths store every
	// attachment in the message itself. Refuse rather than drop it.
	if (body.linked_attachments) {
		return c.json(
			{ error: "Linked attachments are only supported on new messages." },
			400,
		);
	}
	const { to, cc, bcc, from, subject, html, text, attachments } = body;

	const stub = c.var.mailboxStub;
	const rawOriginal = (await stub.getEmail(id)) as EmailFull | null;

	if (!rawOriginal) {
		return c.json({ error: "Original email not found" }, 404);
	}

	// Replying to spam is refused like saving a draft reply to it (the
	// drafts route): the Spam folder, the spam category and the classifier
	// audit trail all count.
	if (isSpamMarkedEmail(rawOriginal)) {
		return c.json(
			{
				error:
					"Cannot send a reply to an email marked as spam. Move the original out of Spam or remove the spam category first.",
			},
			409,
		);
	}

	const originalEmail = await resolveOriginalEmail(stub, rawOriginal);
	const { originalMsgId, references, threadId: thread_id } = buildReferencesChain(originalEmail);

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const rateLimitError = await (stub as unknown as RateLimitStub)
		.checkSendRateLimit();
	if (rateLimitError) {
		return c.json({ error: rateLimitError }, 429);
	}

	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	// Await the send so a binding rejection is reported to the caller instead
	// of being swallowed in waitUntil and filed as "sent" (upstream #84).
	let sendResult: { messageId: string };
	try {
		sendResult = await resolveSendEmailSender(c.env).send({
			to,
			cc,
			bcc,
			from,
			subject,
			html,
			text,
			attachments: attachments?.map((att) => ({
				content: att.content,
				filename: att.filename,
				type: att.type,
				disposition: att.disposition,
				contentId: att.contentId,
			})),
			headers: buildThreadingHeaders(originalMsgId, references),
		});
	} catch (e) {
		await c.env.BUCKET.delete(attachmentData.map(attachmentR2Key));
		return c.json({ error: `Failed to send email: ${(e as Error).message}` }, 502);
	}

	// The stored Message-ID is the one the binding assigned (upstream #83).
	const deliveredMessageId = sendResult.messageId || outgoingMessageId;
	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject,
			sender: fromEmail,
			recipient: toStr,
			cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
			bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
			date: new Date().toISOString(),
			body: html || text || "",
			in_reply_to: originalMsgId,
			email_references: JSON.stringify(references),
			thread_id: thread_id,
			message_id: deliveredMessageId,
			raw_headers: JSON.stringify([
				{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
				{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
				...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
				...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
				{ key: "subject", value: subject },
				{ key: "date", value: new Date().toISOString() },
				{ key: "message-id", value: `<${deliveredMessageId}>` },
				...(originalMsgId ? [{ key: "in-reply-to", value: `<${originalMsgId}>` }] : []),
				...(references.length > 0 ? [{ key: "references", value: references.map((r: string) => `<${r}>`).join(" ") }] : []),
			]),
		},
		attachmentData,
	);

	await stub.markThreadRead(thread_id);

	// Best-effort: the id the binding returned, on the Sent copy, so a bounce
	// can be matched to it (workers/lib/delivery-match.ts).
	await captureSendMessageId(stub, messageId, sendResult);

	return c.json({ id: messageId, status: "sent" }, 202);
}

export async function handleForwardEmail(c: AppContext) {
	const mailboxId = c.req.param("mailboxId") ?? "";
	const id = c.req.param("id") ?? "";
	const body = SendEmailRequestSchema.parse(await c.req.json());
	// Linked attachments are only offered for new messages — the composer
	// never sends the field here, and the reply/forward paths store every
	// attachment in the message itself. Refuse rather than drop it.
	if (body.linked_attachments) {
		return c.json(
			{ error: "Linked attachments are only supported on new messages." },
			400,
		);
	}
	const { to, cc, bcc, from, subject, html, text, attachments } = body;

	const stub = c.var.mailboxStub;
	const rawOriginal = (await stub.getEmail(id)) as EmailFull | null;

	if (!rawOriginal) {
		return c.json({ error: "Original email not found" }, 404);
	}

	// Forwarding spam is refused like replying to it (handleReplyEmail):
	// the Spam folder, the spam category and the classifier audit trail all
	// count.
	if (isSpamMarkedEmail(rawOriginal)) {
		return c.json(
			{
				error:
					"Cannot forward an email marked as spam. Move the original out of Spam or remove the spam category first.",
			},
			409,
		);
	}

	await resolveOriginalEmail(stub, rawOriginal);

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const rateLimitError = await (stub as unknown as RateLimitStub)
		.checkSendRateLimit();
	if (rateLimitError) {
		return c.json({ error: rateLimitError }, 429);
	}

	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	// Await the send so a binding rejection is reported to the caller instead
	// of being swallowed in waitUntil and filed as "sent" (upstream #84).
	let sendResult: { messageId: string };
	try {
		sendResult = await resolveSendEmailSender(c.env).send({
			to,
			cc,
			bcc,
			from,
			subject,
			html,
			text,
			attachments: attachments?.map((att) => ({
				content: att.content,
				filename: att.filename,
				type: att.type,
				disposition: att.disposition,
				contentId: att.contentId,
			})),
		});
	} catch (e) {
		await c.env.BUCKET.delete(attachmentData.map(attachmentR2Key));
		return c.json({ error: `Failed to send email: ${(e as Error).message}` }, 502);
	}

	// The stored Message-ID is the one the binding assigned (upstream #83).
	const deliveredMessageId = sendResult.messageId || outgoingMessageId;
	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject,
			sender: fromEmail,
			recipient: toStr,
			cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
			bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
			date: new Date().toISOString(),
			body: html || text || "",
			in_reply_to: null,
			email_references: null,
			thread_id: messageId,
			message_id: deliveredMessageId,
			raw_headers: JSON.stringify([
				{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
				{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
				...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
				...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
				{ key: "subject", value: subject },
				{ key: "date", value: new Date().toISOString() },
				{ key: "message-id", value: `<${deliveredMessageId}>` },
			]),
		},
		attachmentData,
	);

	// Best-effort: the id the binding returned, on the Sent copy, so a bounce
	// can be matched to it (workers/lib/delivery-match.ts).
	await captureSendMessageId(stub, messageId, sendResult);

	return c.json({ id: messageId, status: "sent" }, 202);
}
