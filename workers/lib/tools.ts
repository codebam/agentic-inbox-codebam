// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared tool business logic for the Agent and MCP server.
 *
 * Each function takes an `env: Env` (or a DO stub) and tool-specific params,
 * performs the business logic (DO calls, data fetching, formatting), and
 * returns a plain object. The Agent and MCP server wrap these results in
 * their own response formats.
 *
 * Functions that already exist in email-helpers.ts (getFullEmail, getFullThread)
 * are reused directly — this module covers the remaining shared operations.
 */

import { z } from "zod";
import type { EmailFull } from "./schemas";
import {
	hasActiveActions,
	hasOutboundActions,
	isRuleValidationError,
	normalizeRuleActions,
	stripOutboundActions,
	type MailRule,
	type RuleActions,
	type RuleDraft,
	type RulePatch,
} from "./rules";
import {
	isSenderPolicyValidationError,
	type SenderPolicy,
} from "./sender-policy";
import {
	getMailboxStub,
	getFullEmail,
	getFullThread,
	buildQuotedReplyBlock,
	textToHtml,
	listMailboxes,
	generateMessageId,
	buildReferencesChain,
	buildThreadingHeaders,
} from "./email-helpers";
import { verifyDraft } from "./ai";
import { applySignatureToBody } from "../../shared/signature";
import { loadMailboxSignature, resolveMailboxModels } from "./mailbox-settings";
import { sendEmail } from "../email-sender";
import { Folders } from "../../shared/folders";
import { isSpamMarkedEmail } from "../../shared/spam";
import { parseSearchQuery } from "../../shared/search-query";
import { searchAllMailboxes } from "./search-all";
import type { Env } from "../types";

// ── Type casts for DO methods not on the base stub type ────────────
type MailboxSearchStub = {
	searchEmails: (options: Record<string, unknown>) => Promise<
		Record<string, unknown>[]
	>;
};

type RateLimitStub = {
	checkSendRateLimit: () => Promise<string | null>;
};

// ── deletion helpers ───────────────────────────────────────────────

/**
 * Delete an email row and its R2 attachment blobs.
 *
 * Returns the deleted attachment rows, or null when the email did not exist.
 * The API route already cleans up R2; agent/MCP tool paths use this helper so
 * the permanent paths of delete_email and discard_draft cannot orphan
 * attachment objects.
 */
async function deleteEmailWithAttachments(
	env: Env,
	mailboxId: string,
	emailId: string,
): Promise<{ id: string; filename: string }[] | null> {
	const stub = getMailboxStub(env, mailboxId);
	const attachments = await stub.deleteEmail(emailId);
	if (attachments === null) return null;
	if (attachments.length > 0) {
		await env.BUCKET.delete(
			attachments.map(
				(att) => `attachments/${emailId}/${att.id}/${att.filename}`,
			),
		);
	}
	return attachments;
}

/**
 * Page through a mailbox folder/category and return every matching row.
 * The Durable Object caps `limit` at 100, so chunk until a short page arrives.
 */
interface SpamEmailRow {
	id: string;
	subject: string | null;
	sender: string | null;
	folder_id: string | null;
	category: string | null;
	classification: string | null;
}

type MailboxSpamReaderStub = {
	getSpamEmails: (options: {
		page?: number;
		limit?: number;
	}) => Promise<SpamEmailRow[]>;
};

/**
 * Page through a mailbox's spam-marked emails (Spam folder, `spam` category,
 * or `classification.is_spam === true`). The DO caps each page at 100 rows.
 */
async function listAllSpamRows(
	env: Env,
	mailboxId: string,
): Promise<SpamEmailRow[]> {
	const stub = getMailboxStub(env, mailboxId) as unknown as MailboxSpamReaderStub;
	const pageSize = 100;
	const rows: SpamEmailRow[] = [];
	for (let page = 1; ; page++) {
		const chunk = await stub.getSpamEmails({ page, limit: pageSize });
		rows.push(...chunk);
		if (chunk.length < pageSize) break;
	}
	return rows;
}

type MailboxThreadReaderStub = {
	getThreadEmails: (threadId: string) => Promise<
		Array<{
			folder_id?: string | null;
			category?: string | null;
			classification?: string | null;
		}>
	>;
};

/** True when any message in the thread is marked as spam. */
async function threadHasSpamMarkedEmail(
	env: Env,
	mailboxId: string,
	threadId: string,
): Promise<boolean> {
	const stub = getMailboxStub(env, mailboxId) as unknown as MailboxThreadReaderStub;
	const emails = await stub.getThreadEmails(threadId);
	return emails.some((email) => isSpamMarkedEmail(email));
}

// ── list_mailboxes ─────────────────────────────────────────────────

export async function toolListMailboxes(env: Env) {
	return listMailboxes(env.BUCKET);
}

// ── list_emails ────────────────────────────────────────────────────

export async function toolListEmails(
	env: Env,
	mailboxId: string,
	params: { folder: string; limit: number; page: number; category?: string | undefined },
) {
	const stub = getMailboxStub(env, mailboxId);
	return stub.getEmails({
		folder: params.folder,
		category: params.category,
		limit: params.limit,
		page: params.page,
		sortColumn: "date",
		sortDirection: "DESC",
	});
}

// ── get_email ──────────────────────────────────────────────────────

export async function toolGetEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = await getFullEmail(stub, emailId);
	if (!email) return { error: "Email not found" };
	return email;
}

// ── get_thread ─────────────────────────────────────────────────────

export async function toolGetThread(
	env: Env,
	mailboxId: string,
	threadId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	return getFullThread(stub, threadId);
}

// ── search_emails ──────────────────────────────────────────────────

/** Filters accepted by the shared search tools (agent + MCP). */
export interface SearchEmailParams {
	/** Raw Gmail-style query, e.g. `from:bob is:unread has:attachment`. */
	query?: string | undefined;
	folder?: string | undefined;
	category?: string | undefined;
	from?: string | undefined;
	to?: string | undefined;
	subject?: string | undefined;
	isRead?: boolean | undefined;
	isStarred?: boolean | undefined;
	hasAttachment?: boolean | undefined;
	/** Only emails dated before this (ISO date or YYYY-MM-DD). */
	before?: string | undefined;
	/** Only emails dated after this (ISO date or YYYY-MM-DD). */
	after?: string | undefined;
	page?: number | undefined;
	limit?: number | undefined;
}


/**
 * Merge a raw Gmail-style query with explicit tool filters (explicit values
 * win) into the Durable Object's snake_case search options.
 */
function buildSearchFilters(params: SearchEmailParams) {
	const parsed = parseSearchQuery(params.query ?? "");
	return {
		query: parsed.query,
		folder: params.folder ?? parsed.folder,
		category: params.category,
		from: params.from ?? parsed.from,
		to: params.to ?? parsed.to,
		subject: params.subject ?? parsed.subject,
		date_start: params.after ?? parsed.date_start,
		date_end: params.before ?? parsed.date_end,
		is_read: params.isRead ?? parsed.is_read,
		is_starred: params.isStarred ?? parsed.is_starred,
		has_attachment: params.hasAttachment ?? parsed.has_attachment,
	};
}


export async function toolSearchEmails(
	env: Env,
	mailboxId: string,
	params: SearchEmailParams,
) {
	const stub = getMailboxStub(env, mailboxId) as unknown as MailboxSearchStub;
	return stub.searchEmails({
		...buildSearchFilters(params),
		page: params.page,
		limit: params.limit,
	});
}


// ── search_all_mailboxes ───────────────────────────────────────────


/**
 * Search every mailbox in the deployment and return the merged matches, each
 * row tagged with the mailboxId it came from. Same filters as search_emails.
 */
export async function toolSearchAllMailboxes(
	env: Env,
	params: SearchEmailParams,
) {
	return searchAllMailboxes(env, {
		...buildSearchFilters(params),
		page: params.page,
		limit: params.limit,
	});
}

// ── draft_reply ────────────────────────────────────────────────────

/**
 * Shared draft-reply logic.
 *
 * @param bodyInput - The reply body text. Can be plain text or HTML.
 * @param options.isPlainText - If true, body is treated as plain text and
 *   converted to HTML. If false, body is treated as HTML.
 * @param options.runVerifyDraft - If true, runs AI verifyDraft on the body.
 *   The agent and MCP both do this, but the agent does it on plain text
 *   while MCP does it on HTML.
 * @param options.applySignature - If true, appends the mailbox's enabled
 *   signature to the stored draft body (idempotent).
 */
export async function toolDraftReply(
	env: Env,
	mailboxId: string,
	params: {
		originalEmailId: string;
		/** Reply target; defaults to the original's Reply-To, then its sender. */
		to?: string | undefined;
		subject: string;
		body: string;
		isPlainText?: boolean;
		runVerifyDraft?: boolean;
		/** Append the mailbox signature (when one is enabled) to the stored draft. */
		applySignature?: boolean;
	},
): Promise<
	| {
			status: "draft_saved";
			draftId: string;
			message: string;
			signatureApplied: boolean;
			draft: Record<string, string | null>;
	  }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	// Refuse to draft a reply to anything marked as spam before doing any
	// model work or writing a draft. This covers the Spam folder, the spam
	// category, and the stored classifier audit trail.
	const original = (await stub.getEmail(params.originalEmailId)) as EmailFull | null;
	if (!original) {
		return { error: "Original email not found" };
	}
	if (isSpamMarkedEmail(original)) {
		return {
			error:
				"Refusing to draft a reply: this email is marked as spam. Move it out of Spam or remove the spam category if this is a mistake.",
		};
	}

	// Reply-To replaces the sender as the reply target when the message sets
	// it (mailing lists, ticketing systems); an explicit `to` from the caller
	// still wins over both.
	const recipient = params.to?.trim() || original.reply_to?.trim() || original.sender;
	if (!recipient) {
		return { error: "Cannot draft a reply: no recipient address on the original email." };
	}

	// Model ids come from the mailbox settings, falling back to app-wide
	// settings and the built-in defaults.
	const models = await resolveMailboxModels(env, mailboxId);

	// Verify/sanitize if requested
	let processedBody = params.body.trim();
	if (params.runVerifyDraft) {
		const sanitized = await verifyDraft(env.AI, processedBody, models.draftVerify);
		if (!sanitized) {
			return { error: "Draft verification failed — body could not be verified. Please try again." };
		}
		processedBody = sanitized;
	}

	// Convert plain text to HTML if needed
	if (params.isPlainText) {
		processedBody = textToHtml(processedBody);
	}

	const draftId = crypto.randomUUID();
	const threadId = original?.thread_id || params.originalEmailId;

	// Append quoted original message
	const quotedBlock = original
		? buildQuotedReplyBlock({
				date: original.date,
				sender: original.sender || recipient,
				body: original.body ?? undefined,
			})
		: "";
	// Append the mailbox signature (when one is enabled) above the quoted
	// reply block, matching the composer's prefill. Idempotent: a body that
	// already carries the signature is left unchanged.
	const bodyWithQuote = processedBody + quotedBlock;
	const signature = params.applySignature
		? await loadMailboxSignature(env, mailboxId)
		: undefined;
	const bodyHtml = applySignatureToBody(bodyWithQuote, signature);
	const signatureApplied = bodyHtml !== bodyWithQuote;

	await stub.createEmail(
		Folders.DRAFT,
		{
			id: draftId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: recipient.toLowerCase(),
			date: new Date().toISOString(),
			body: bodyHtml,
			in_reply_to: params.originalEmailId,
			email_references: null,
			thread_id: threadId,
		},
		[],
	);

	return {
		status: "draft_saved",
		draftId,
		message: signatureApplied
			? "Draft saved to Drafts folder with the mailbox signature. Review it and confirm to send."
			: "Draft saved to Drafts folder. Review it and confirm to send.",
		signatureApplied,
		draft: {
			mailboxId,
			originalEmailId: params.originalEmailId,
			in_reply_to: params.originalEmailId,
			thread_id: threadId,
			to: recipient,
			subject: params.subject,
			body: params.isPlainText ? params.body.trim() : bodyHtml,
		},
	};
}

// ── draft_email (new email, not a reply) ───────────────────────────

export async function toolDraftEmail(
	env: Env,
	mailboxId: string,
	params: {
		to: string;
		subject: string;
		body: string;
		isPlainText?: boolean;
		runVerifyDraft?: boolean;
		/** Append the mailbox signature (when one is enabled) to the stored draft. */
		applySignature?: boolean;
		/** Optional in_reply_to for create_draft style */
		in_reply_to?: string | undefined;
		/** Optional thread_id for create_draft style */
		thread_id?: string | undefined;
	},
): Promise<
	| {
			status: string;
			draftId: string;
			threadId?: string;
			message: string;
			signatureApplied: boolean;
			draft?: Record<string, string | null>;
	  }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	// A new-email draft that is threaded as a reply to a spam message is a
	// reply draft in disguise; refuse it for the same reason as draft_reply.
	let original: EmailFull | null = null;
	if (params.in_reply_to) {
		original = (await stub.getEmail(params.in_reply_to)) as EmailFull | null;
		if (!original) {
			return { error: "Original email not found" };
		}
		if (isSpamMarkedEmail(original)) {
			return {
				error:
					"Refusing to draft a reply: the original email is marked as spam. Move it out of Spam or remove the spam category if this is a mistake.",
			};
		}
	} else if (params.thread_id) {
		// MCP create_draft allows a thread_id without in_reply_to. Treat that
		// as a reply draft and refuse it if any message in the thread is spam.
		if (await threadHasSpamMarkedEmail(env, mailboxId, params.thread_id)) {
			return {
				error:
					"Refusing to draft a reply: the thread is marked as spam. Move it out of Spam or remove the spam category if this is a mistake.",
			};
		}
	}

	// Model ids come from the mailbox settings, falling back to app-wide
	// settings and the built-in defaults.
	const models = await resolveMailboxModels(env, mailboxId);

	let processedBody = params.body.trim();
	if (params.runVerifyDraft) {
		const sanitized = await verifyDraft(env.AI, processedBody, models.draftVerify);
		if (!sanitized) {
			return { error: "Draft verification failed — body could not be verified. Please try again." };
		}
		processedBody = sanitized;
	}

	if (params.isPlainText) {
		processedBody = textToHtml(processedBody);
	}

	const draftId = crypto.randomUUID();

	// Resolve thread ID
	let resolvedThreadId = params.thread_id;
	if (!resolvedThreadId && params.in_reply_to) {
		resolvedThreadId = original?.thread_id || params.in_reply_to;
	}
	if (!resolvedThreadId) {
		resolvedThreadId = draftId;
	}

	// Append the mailbox signature when the caller asked for it (the agent
	// and MCP draft paths do). Idempotent: a body that already carries the
	// signature is left unchanged.
	const signature = params.applySignature
		? await loadMailboxSignature(env, mailboxId)
		: undefined;
	const bodyWithSignature = applySignatureToBody(processedBody, signature);
	const signatureApplied = bodyWithSignature !== processedBody;

	await stub.createEmail(
		Folders.DRAFT,
		{
			id: draftId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: (params.to || "").toLowerCase(),
			date: new Date().toISOString(),
			body: bodyWithSignature,
			in_reply_to: params.in_reply_to || null,
			email_references: null,
			thread_id: resolvedThreadId,
		},
		[],
	);

	return {
		status: "draft_saved",
		draftId,
		threadId: resolvedThreadId,
		message: signatureApplied
			? "Draft saved to Drafts folder with the mailbox signature. Review it and confirm to send."
			: "Draft saved to Drafts folder. Review it and confirm to send.",
		signatureApplied,
		draft: {
			mailboxId,
			in_reply_to: params.in_reply_to || null,
			thread_id: resolvedThreadId,
			to: params.to,
			subject: params.subject,
			body: params.isPlainText ? params.body.trim() : processedBody,
		},
	};
}

// ── update_draft ───────────────────────────────────────────────────

export async function toolUpdateDraft(
	env: Env,
	mailboxId: string,
	params: {
		draftId: string;
		to?: string | undefined;
		subject?: string | undefined;
		bodyHtml?: string | undefined;
	},
): Promise<
	| { status: string; newDraftId: string; oldDraftId: string; message: string }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	const oldDraft = (await stub.getEmail(params.draftId)) as EmailFull | null;
	if (!oldDraft || oldDraft.folder_id !== Folders.DRAFT) {
		return { error: "Draft not found" };
	}
	if (isSpamMarkedEmail(oldDraft)) {
		return {
			error:
				"Refusing to update this draft: the draft itself is marked as spam.",
		};
	}

	// Updating a reply draft whose original is marked spam would reintroduce
	// the draft the spam guard is meant to keep out of the mailbox.
	if (oldDraft.in_reply_to) {
		const original = (await stub.getEmail(oldDraft.in_reply_to)) as EmailFull | null;
		if (!original) {
			return { error: "Original email not found" };
		}
		if (isSpamMarkedEmail(original)) {
			return {
				error:
					"Refusing to update this draft: the original email is marked as spam. Move it out of Spam or remove the spam category if this is a mistake.",
			};
		}
	} else if (oldDraft.thread_id) {
		if (await threadHasSpamMarkedEmail(env, mailboxId, oldDraft.thread_id)) {
			return {
				error:
					"Refusing to update this draft: the thread is marked as spam. Move it out of Spam or remove the spam category if this is a mistake.",
			};
		}
	}

	// Verify the body BEFORE deleting the old draft to prevent data loss
	const newDraftId = crypto.randomUUID();
	const rawBody = params.bodyHtml ?? oldDraft.body ?? "";
	const verifiedBody = await verifyDraft(env.AI, rawBody);

	if (!verifiedBody) {
		return { error: "Draft verification failed — keeping existing draft unchanged. Please try again." };
	}

	// Delete the old draft (and its attachments) only after the new body is verified.
	await deleteEmailWithAttachments(env, mailboxId, params.draftId);
	await stub.createEmail(
		Folders.DRAFT,
		{
			id: newDraftId,
			subject: params.subject ?? oldDraft.subject,
			sender: mailboxId.toLowerCase(),
			recipient: (params.to ?? oldDraft.recipient).toLowerCase(),
			date: new Date().toISOString(),
			body: verifiedBody,
			in_reply_to: oldDraft.in_reply_to || null,
			email_references: oldDraft.email_references || null,
			thread_id: oldDraft.thread_id || newDraftId,
		},
		[],
	);

	return {
		status: "draft_updated",
		newDraftId,
		oldDraftId: params.draftId,
		message: "Draft updated in Drafts folder.",
	};
}

// ── mark_email_read ────────────────────────────────────────────────

export async function toolMarkEmailRead(
	env: Env,
	mailboxId: string,
	emailId: string,
	read: boolean,
) {
	const stub = getMailboxStub(env, mailboxId);
	await stub.updateEmail(emailId, { read });
	return { status: "updated", emailId, read };
}

// ── star_email ─────────────────────────────────────────────────────

export async function toolStarEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
	starred: boolean,
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = await stub.updateEmail(emailId, { starred });
	if (!email) return { error: "Email not found" };
	return { status: "updated", emailId, starred };
}

// ── set_sender_policy ──────────────────────────────────────────────

/**
 * Record an allow/block decision for the sender of an email.
 *
 * `allow` also moves the message back to the Inbox and clears its spam
 * markings; `block` moves it to Spam. Neither deletes anything.
 */
export async function toolSetSenderPolicy(
	env: Env,
	mailboxId: string,
	emailId: string,
	policy: SenderPolicy,
) {
	const stub = getMailboxStub(env, mailboxId);
	try {
		const entry = await stub.applySenderPolicyFeedback(emailId, policy);
		if (!entry) return { error: "Email not found" };
		return { status: "updated", action: policy, entry };
	} catch (e) {
		if (isSenderPolicyValidationError(e)) return { error: (e as Error).message };
		throw e;
	}
}

// ── move_email ─────────────────────────────────────────────────────

export async function toolMoveEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
	folderId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const success = await stub.moveEmail(emailId, folderId);
	if (success) {
		return { status: "moved", emailId, folder: folderId };
	}
	return { error: "Failed to move email" };
}

// ── discard_draft ──────────────────────────────────────────────────

export async function toolDiscardDraft(
	env: Env,
	mailboxId: string,
	draftId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = (await stub.getEmail(draftId)) as { folder_id?: string } | null;
	if (!email) {
		return { error: "Draft not found" };
	}
	if (email.folder_id !== Folders.DRAFT) {
		return { error: "Cannot discard: email is not a draft" };
	}
	const deleted = await deleteEmailWithAttachments(env, mailboxId, draftId);
	if (deleted === null) {
		return { error: "Draft not found" };
	}
	return { status: "discarded", draftId };
}

// ── delete_email ───────────────────────────────────────────────────

/**
 * Delete an email.
 *
 * Without `permanent` the email is moved to the Trash folder and can still be
 * restored; an email already in Trash is left there. With `permanent: true`
 * the row and its R2 attachment blobs are removed irreversibly.
 */
export async function toolDeleteEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
	permanent = false,
) {
	const stub = getMailboxStub(env, mailboxId);
	if (!permanent) {
		const { trashed, alreadyInTrash } = await stub.trashEmails([emailId]);
		if (trashed.length > 0) return { status: "trashed", emailId };
		if (alreadyInTrash.length > 0) return { status: "already_in_trash", emailId };
		return { error: "Email not found", emailId };
	}
	const result = await deleteEmailWithAttachments(env, mailboxId, emailId);
	if (result === null) {
		return { error: "Email not found", emailId };
	}
	return { status: "deleted_permanently", emailId };
}

// ── delete_spam_emails ─────────────────────────────────────────────

export interface DeleteSpamMailboxResult {
	mailboxId: string;
	deletedCount: number;
	deleted: { id: string; subject: string | null; sender: string | null; folder: string | null }[];
}

/**
 * Permanently delete every email marked as spam: messages in the Spam folder,
 * messages carrying the `spam` category (e.g. when a mailbox has `moveToSpam`
 * disabled), and rows whose classification audit says `is_spam: true`.
 * Rows are de-duplicated, so a message with several spam markers is deleted
 * once.
 *
 * If `mailboxId` is omitted, every mailbox in the deployment is purged.
 */
export async function toolDeleteSpamEmails(
	env: Env,
	mailboxId?: string,
): Promise<{
	status: "spam_deleted";
	deletedCount: number;
	mailboxes: DeleteSpamMailboxResult[];
} | {
	status: "no_spam_found";
	deletedCount: number;
	mailboxes: DeleteSpamMailboxResult[];
} | { error: string }> {
	const mailboxIds = mailboxId
		? [mailboxId]
		: (await listMailboxes(env.BUCKET)).map((mailbox) => mailbox.id);

	if (mailboxIds.length === 0) {
		return { error: "No mailboxes found" };
	}

	const mailboxResults: DeleteSpamMailboxResult[] = [];
	let deletedCount = 0;

	for (const currentMailboxId of mailboxIds) {
		const candidates = new Map<string, SpamEmailRow>();
		for (const row of await listAllSpamRows(env, currentMailboxId)) {
			// Re-check in JS as well: the SQL path is the index, the helper is the
			// source of truth for what "marked as spam" means.
			if (!isSpamMarkedEmail(row)) continue;
			if (!candidates.has(row.id)) candidates.set(row.id, row);
		}

		// Keep the tool result small enough for a model context: report every
		// count, but only the first 25 deleted rows per mailbox.
		const MAX_REPORTED_DELETIONS = 25;
		const deleted: DeleteSpamMailboxResult["deleted"] = [];
		let mailboxDeletedCount = 0;
		for (const row of candidates.values()) {
			// Re-read immediately before deleting so mail moved out of Spam (or
			// re-classified) after the initial query is not destroyed.
			const current = (await getMailboxStub(
				env,
				currentMailboxId,
			).getEmail(row.id)) as EmailFull | null;
			if (!current || !isSpamMarkedEmail(current)) continue;
			const result = await deleteEmailWithAttachments(
				env,
				currentMailboxId,
				row.id,
			);
			if (result !== null) {
				deletedCount++;
				mailboxDeletedCount++;
				if (deleted.length < MAX_REPORTED_DELETIONS) {
					deleted.push({
						id: row.id,
						subject: row.subject,
						sender: row.sender,
						folder: row.folder_id,
					});
				}
			}
		}

		mailboxResults.push({
			mailboxId: currentMailboxId,
			deletedCount: mailboxDeletedCount,
			deleted,
		});
	}

	if (deletedCount === 0) {
		return { status: "no_spam_found", deletedCount, mailboxes: mailboxResults };
	}
	return { status: "spam_deleted", deletedCount, mailboxes: mailboxResults };
}

// ── send_reply ─────────────────────────────────────────────────────

export async function toolSendReply(
	env: Env,
	mailboxId: string,
	params: {
		originalEmailId: string;
		to: string;
		subject: string;
		bodyHtml: string;
	},
): Promise<
	| { status: "sent"; messageId: string; message: string }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	// Check send rate limit
	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit();
	if (rateLimitError) {
		return { error: rateLimitError };
	}

	const originalEmail = (await stub.getEmail(params.originalEmailId)) as EmailFull | null;
	if (!originalEmail) {
		return { error: "Original email not found" };
	}

	const { originalMsgId, references, threadId } = buildReferencesChain(originalEmail);
	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error("Invalid mailbox email address");
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	// Verify and append quoted original message
	const sanitizedBody = await verifyDraft(env.AI, params.bodyHtml);
	if (!sanitizedBody) {
		return { error: "Draft verification failed — refusing to send unverified content. Please try again." };
	}
	const quotedBlock = buildQuotedReplyBlock({
		date: originalEmail.date,
		sender: originalEmail.sender || params.to,
		body: originalEmail.body ?? undefined,
	});
	const fullBodyHtml = sanitizedBody + quotedBlock;

	try {
		await sendEmail(env.EMAIL, {
			to: params.to,
			from: mailboxId,
			subject: params.subject,
			html: fullBodyHtml,
			headers: buildThreadingHeaders(originalMsgId, references),
		});
	} catch (e) {
		console.error("Email send failed:", (e as Error).message);
		return { error: `Failed to send reply: ${(e as Error).message}` };
	}

	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: fullBodyHtml,
			in_reply_to: originalMsgId,
			email_references:
				references.length > 0 ? JSON.stringify(references) : null,
			thread_id: threadId,
			message_id: outgoingMessageId,
		},
		[],
	);

	return { status: "sent", messageId, message: `Reply sent to ${params.to}` };
}

// ── send_email ─────────────────────────────────────────────────────

export async function toolSendEmail(
	env: Env,
	mailboxId: string,
	params: {
		to: string;
		subject: string;
		bodyHtml: string;
	},
): Promise<
	| { status: "sent"; messageId: string; message: string }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	// Check send rate limit
	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit();
	if (rateLimitError) {
		return { error: rateLimitError };
	}

	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error("Invalid mailbox email address");
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const sanitizedBody = await verifyDraft(env.AI, params.bodyHtml);
	if (!sanitizedBody) {
		return { error: "Draft verification failed — refusing to send unverified content. Please try again." };
	}

	try {
		await sendEmail(env.EMAIL, {
			to: params.to,
			from: mailboxId,
			subject: params.subject,
			html: sanitizedBody,
		});
	} catch (e) {
		console.error("Email send failed:", (e as Error).message);
		return { error: `Failed to send email: ${(e as Error).message}` };
	}

	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: sanitizedBody,
			in_reply_to: null,
			email_references: null,
			thread_id: messageId,
			message_id: outgoingMessageId,
		},
		[],
	);

	return { status: "sent", messageId, message: `Email sent to ${params.to}` };
}


// ── Rules (deterministic per-mailbox filters) ──────────────────────


/**
 * Agent/MCP rule tooling.
 *
 * Rules are user-configured automation, and an operator-authored rule may send
 * mail (`forward_to`, `auto_reply_text`). These tools are the only rule write
 * path the agent and the MCP server have, and they deliberately cannot create,
 * edit, or enable that automation:
 *   - outbound actions are stripped from every draft and patch;
 *   - a stored rule that carries them can never be enabled from here.
 * The operator's rules settings is the only place that authors them.
 */


/** Message returned whenever a tool had to strip outbound actions. */
export const RULE_OUTBOUND_ACTIONS_NOTE =
	"forward_to and auto_reply_text are operator-only: rules created through the agent or MCP tools cannot send mail. Author sending rules in the mailbox's rules settings.";


/** Raw input shape shared by the agent and MCP rule tools. */
export const ruleToolMatchSchema = z.object({
	mode: z
		.enum(["all", "any"])
		.default("all")
		.describe("'all' = every condition must hold, 'any' = at least one"),
	conditions: z
		.object({
			from_contains: z.string().optional(),
			to_contains: z.string().optional(),
			subject_contains: z.string().optional(),
			body_contains: z.string().optional(),
			has_attachment: z.boolean().optional(),
			category_equals: z.string().optional(),
		})
		.describe("At least one condition is required, or the rule never matches"),
});


export const ruleToolActionsSchema = z.object({
	move_to_folder: z.string().optional().describe("Folder id or display name"),
	set_category: z.string().optional().describe("Category id to stamp"),
	mark_read: z.boolean().optional(),
	mark_unread: z.boolean().optional(),
	star: z.boolean().optional(),
	unstar: z.boolean().optional(),
	discard: z.boolean().optional().describe("Drop matching mail entirely"),
	forward_to: z
		.string()
		.optional()
		.describe("Operator-only: stripped from agent/MCP rule drafts"),
	auto_reply_text: z
		.string()
		.optional()
		.describe("Operator-only: stripped from agent/MCP rule drafts"),
});


/** Raw input shape for create_rule / update_rule. */
export const ruleToolDraftShape = {
	name: z.string().describe("Short human-readable rule name"),
	enabled: z.boolean().optional().describe("Defaults to true"),
	priority: z
		.number()
		.int()
		.optional()
		.describe("Lower runs first; omit to append at the end"),
	match: ruleToolMatchSchema,
	actions: ruleToolActionsSchema,
};


export type RuleToolResult =
	| { rule: MailRule; note?: string; error?: never }
	| { error: string; note?: string; rule?: never };


/** DO methods the rule tools use (RPC stub surface). */
type MailboxRuleStub = {
	listRules: () => Promise<MailRule[]>;
	createRule: (draft: RuleDraft) => Promise<MailRule>;
	updateRule: (ruleId: string, patch: RulePatch) => Promise<MailRule | null>;
};


function mailboxRuleStub(env: Env, mailboxId: string): MailboxRuleStub {
	return getMailboxStub(env, mailboxId);
}


/** Strip the outbound actions an agent/MCP draft tried to set. */
function stripAgentRuleActions(raw: unknown): {
	actions: RuleActions;
	stripped: boolean;
} {
	const normalized = normalizeRuleActions(raw);
	return {
		actions: stripOutboundActions(normalized),
		stripped: hasOutboundActions(normalized),
	};
}


export async function toolListRules(env: Env, mailboxId: string) {
	const rules = await mailboxRuleStub(env, mailboxId).listRules();
	return {
		mailboxId,
		rules: rules.map((rule) => ({
			id: rule.id,
			name: rule.name,
			enabled: rule.enabled,
			priority: rule.priority,
			match: rule.match,
			actions: rule.actions,
			fired_count: rule.fired_count ?? 0,
			last_fired_at: rule.last_fired_at ?? null,
		})),
		note:
			"Rules may file, label, star, mark read, or discard mail. Rules that forward or auto-reply are operator-only: they are listed but cannot be created, edited, or enabled through tools.",
	};
}


export async function toolCreateRule(
	env: Env,
	mailboxId: string,
	draft: RuleDraft,
): Promise<RuleToolResult> {
	const { actions, stripped } = stripAgentRuleActions(draft?.actions);
	if (!hasActiveActions(actions)) {
		return {
			error: stripped
				? RULE_OUTBOUND_ACTIONS_NOTE
				: "A rule needs at least one action.",
		};
	}
	try {
		const rule = await mailboxRuleStub(env, mailboxId).createRule({
			...draft,
			actions,
		});
		return stripped ? { rule, note: RULE_OUTBOUND_ACTIONS_NOTE } : { rule };
	} catch (e) {
		if (isRuleValidationError(e)) return { error: (e as Error).message };
		throw e;
	}
}


export async function toolUpdateRule(
	env: Env,
	mailboxId: string,
	ruleId: string,
	patch: RulePatch,
): Promise<RuleToolResult> {
	const stub = mailboxRuleStub(env, mailboxId);
	const existing = (await stub.listRules()).find((rule) => rule.id === ruleId);
	if (!existing) return { error: `Rule ${ruleId} not found in ${mailboxId}.` };

	// A rule the operator gave sending powers to is off-limits here: agent/MCP
	// tooling must not be able to enable it, rewrite its actions, or widen its
	// conditions (which would send more mail). The single allowed edit is
	// `enabled: false`, so an agent can still stop noise.
	if (hasOutboundActions(existing.actions)) {
		const onlyDisabling =
			patch.enabled === false &&
			patch.actions === undefined &&
			patch.match === undefined &&
			patch.name === undefined &&
			patch.priority === undefined;
		if (!onlyDisabling) {
			return {
				error: `Rule "${existing.name}" sends mail automatically (forward or auto-reply). It can only be changed by the operator in the mailbox's rules settings; tools may only pause it (enabled: false).`,
			};
		}
	}

	const next: RulePatch = { ...patch };
	let stripped = false;
	if (patch.actions !== undefined) {
		const result = stripAgentRuleActions(patch.actions);
		next.actions = result.actions;
		stripped = result.stripped;
		if (!hasActiveActions(result.actions)) {
			return {
				error: stripped
					? RULE_OUTBOUND_ACTIONS_NOTE
					: "A rule needs at least one action.",
			};
		}
	}

	try {
		const rule = await stub.updateRule(ruleId, next);
		if (!rule) return { error: `Rule ${ruleId} not found in ${mailboxId}.` };
		return stripped ? { rule, note: RULE_OUTBOUND_ACTIONS_NOTE } : { rule };
	} catch (e) {
		if (isRuleValidationError(e)) return { error: (e as Error).message };
		throw e;
	}
}
