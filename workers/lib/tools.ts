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
	PreviewRuleSchema,
	ReorderRulesSchema,
	ScheduleSendRequestSchema,
} from "./schemas";
import type { MailboxDO } from "../durableObject";
import {
	hasActiveActions,
	hasOutboundActions,
	isRuleValidationError,
	normalizeRuleActions,
	resolveRuleFolderId,
	stripOutboundActions,
	type MailRule,
	type RuleActions,
	type RuleDraft,
	type RuleMatchSpec,
	type RulePatch,
	type RulePreviewDraft,
	type RulePreviewResult,
} from "./rules";
import {
	isSenderPolicyValidationError,
	type SenderPolicy,
} from "./sender-policy";
import { isLabelValidationError } from "./labels";
import { isTemplateValidationError } from "./templates";
import { performOneClickUnsubscribe } from "./unsubscribe";
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
	validateSender,
	SenderValidationError,
} from "./email-helpers";
import { captureSendMessageId } from "./delivery-match";
import { verifyDraft } from "./ai";
import { applySignatureToBody } from "../../shared/signature";
import { ensureMessageBody } from "../../shared/compose-body";
import { loadMailboxSignature, resolveMailboxModels } from "./mailbox-settings";
import { sendEmail, type SendEmailParams } from "../email-sender";
import { decodeBase64Bytes, storeAttachments } from "./attachments";
import { proxyImage } from "./image-proxy";
import { formatFileSize } from "../../app/lib/attachments";
import { Folders, slugify } from "../../shared/folders";
import { isSpamMarkedEmail } from "../../shared/spam";
import { parseSearchQuery } from "../../shared/search-query";
import { searchAllMailboxes } from "./search-all";
import { semanticSearch } from "./semantic";
import { DEFAULT_CONTACT_SEARCH_LIMIT } from "./contacts";
import {
	isItemStatus,
	type ItemDueFilter,
	type ItemListFilters,
	type ItemStatus,
} from "./items";
import { digestWindow } from "./digest";
import { reconstructedMessage } from "./eml-export";
import {
	DEFAULT_SCHEDULED_SEND_LIMIT,
	serializeScheduledSendPayload,
	type ScheduledSendActionResult,
	type ScheduledSendRow,
} from "./scheduled-sends";
import { runThreadSummary } from "./thread-summary";
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
	params: {
		folder: string;
		limit: number;
		page: number;
		category?: string | undefined;
		/**
		 * Priority/other split, as the web list's tabs: a conversation is
		 * priority when its newest in-folder message is unread or starred, or
		 * when it needs a reply; other is the complement.
		 */
		stream?: "priority" | "other" | undefined;
	},
) {
	const stub = getMailboxStub(env, mailboxId);
	// The split is a property of a conversation, so a streamed list is the
	// threaded list the web's tabs render: the same RPC (and option) the
	// emails route uses for `threaded=true&stream=...`. The plain getEmails
	// query takes no stream, so with one the threaded RPC answers instead.
	if (params.stream) {
		return stub.getThreadedEmails({
			folder: params.folder,
			category: params.category,
			stream: params.stream,
			limit: params.limit,
			page: params.page,
		});
	}
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

/**
 * Get every message in a conversation thread, plus whether the thread is
 * muted (notification bookkeeping). Read-only.
 */
export async function toolGetThread(
	env: Env,
	mailboxId: string,
	threadId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const [thread, muted] = await Promise.all([
		getFullThread(stub, threadId),
		stub.isThreadMuted(threadId),
	]);
	return { ...thread, muted };
}

// ── get_attachment ─────────────────────────────────────────────────

/** Text-ish mimetypes whose bytes get_attachment decodes and returns. */
const ATTACHMENT_TEXT_MIMETYPES = new Set([
	"application/json",
	"application/xml",
	"application/javascript",
	"application/x-ndjson",
	"message/rfc822",
]);

/** Characters of attachment text returned before the content is clipped. */
const ATTACHMENT_TEXT_MAX_CHARS = 200000;

/** Stored attachment sizes above this are never read (bytes). */
const ATTACHMENT_TEXT_MAX_BYTES = 1048576;

/** True for the text-ish mimetypes whose content the tool returns as text. */
function isTextAttachmentMimetype(mimetype: string): boolean {
	const base = mimetype.split(";")[0]?.trim().toLowerCase() ?? "";
	return base.startsWith("text/") || ATTACHMENT_TEXT_MIMETYPES.has(base);
}

/** Content of a get_attachment result: decoded text, or why it was omitted. */
type AttachmentToolContent =
	| { kind: "text"; text: string; truncated: boolean }
	| { kind: "omitted"; reason: string };

/** One stored attachment row, as MailboxDO.getAttachment returns it. */
type MailboxAttachmentRow = {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string | null;
};

/**
 * The attachment RPC the get_attachment tool calls. Declared structurally for
 * the same reason as the contacts and template tools: the stub's own RPC
 * result types carry `& Disposable`, which the MCP result wrapper cannot
 * accept.
 */
type MailboxAttachmentStub = {
	getAttachment: (id: string) => Promise<MailboxAttachmentRow | null>;
};

function mailboxAttachmentStub(
	env: Env,
	mailboxId: string,
): MailboxAttachmentStub {
	return getMailboxStub(env, mailboxId);
}

/** Result of the get_attachment tool: metadata plus content, or not found. */
type AttachmentToolResult =
	| {
			mailboxId: string;
			attachment: {
				id: string;
				emailId: string;
				filename: string;
				mimetype: string;
				size: number;
				disposition: string | null;
				contentId: string | null;
			};
			content: AttachmentToolContent;
	  }
	| { error: string };

/**
 * Read one attachment's metadata and, when it is text-ish, its content.
 *
 * Read-only and bounded: metadata always comes back for an attachment that
 * exists; content comes back only for text-ish mimetypes, only for stored
 * sizes at or below 1 MiB, and only when the R2 object exists. Text is
 * decoded as UTF-8 and clipped to 200000 characters (`truncated: true`).
 * Binary and oversized attachments, and blobs missing from storage, come
 * back as an omission reason — this tool never returns raw bytes, never
 * sends mail, and never writes state.
 */
export async function toolGetAttachment(
	env: Env,
	mailboxId: string,
	params: { attachmentId: string },
): Promise<AttachmentToolResult> {
	const attachment = await mailboxAttachmentStub(env, mailboxId).getAttachment(
		params.attachmentId,
	);
	if (!attachment) return { error: "Attachment not found" };

	const metadata = {
		id: attachment.id,
		emailId: attachment.email_id,
		filename: attachment.filename,
		mimetype: attachment.mimetype,
		size: attachment.size,
		disposition: attachment.disposition,
		contentId: attachment.content_id,
	};

	let content: AttachmentToolContent;
	if (!isTextAttachmentMimetype(attachment.mimetype)) {
		content = {
			kind: "omitted",
			reason: `Attachment mimetype "${attachment.mimetype}" is not text; content is omitted.`,
		};
	} else if (attachment.size > ATTACHMENT_TEXT_MAX_BYTES) {
		content = {
			kind: "omitted",
			reason: `Attachment size ${attachment.size} bytes exceeds the ${ATTACHMENT_TEXT_MAX_BYTES}-byte text limit; content is omitted.`,
		};
	} else {
		// Same key shape as deleteEmailWithAttachments and the download route:
		// attachments/<email id>/<attachment id>/<filename>.
		const object = await env.BUCKET.get(
			`attachments/${attachment.email_id}/${attachment.id}/${attachment.filename}`,
		);
		if (!object) {
			content = { kind: "omitted", reason: "file not found in storage" };
		} else {
			const text = await object.text();
			const truncated = text.length > ATTACHMENT_TEXT_MAX_CHARS;
			content = {
				kind: "text",
				text: truncated ? text.slice(0, ATTACHMENT_TEXT_MAX_CHARS) : text,
				truncated,
			};
		}
	}

	return { mailboxId, attachment: metadata, content };
}

// ── get_image ──────────────────────────────────────────────────────

/**
 * Base64 for one image's bytes: the platform's native encoder when the
 * runtime carries it, a chunked btoa otherwise.
 */
function base64OfBytes(bytes: ArrayBuffer): string {
	const view = new Uint8Array(bytes);
	const fast = (view as unknown as { toBase64?: () => string }).toBase64;
	if (typeof fast === "function") return fast.call(view);
	let binary = "";
	for (let offset = 0; offset < view.length; offset += 0x8000) {
		binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

/** One proxied image, ready for a token-authenticated client to inline. */
export interface ImageToolResult {
	contentType: string;
	bytes: number;
	cached: boolean;
	dataBase64: string;
}

/**
 * One remote image of a message, fetched through the shared SSRF guard
 * and R2 cache (workers/lib/image-proxy.ts) and answered as base64 so a
 * token-authenticated client can render it without ever talking to the
 * sender's server itself. On-demand only: it runs when a caller names one
 * URL from a message it is rendering — never on ingestion, never
 * autonomously — and the URL is the same sender-controlled string the
 * image-proxy route accepts, so the same guard applies (https only,
 * public hosts only, no redirects, an image content-type allowlist, a
 * hard byte cap). The name lives in SCOPED_SURFACE_ONLY_TOOL_SCOPES, so
 * an operator-minted scoped token is the only credential that can reach
 * it and no agent or MCP session ever can.
 */
export async function toolGetImage(
	env: Env,
	params: { url: string },
): Promise<ImageToolResult | { error: string }> {
	const url = params.url.trim();
	if (!url) return { error: "url is required" };
	const result = await proxyImage(env, url);
	if (!result.ok) return { error: result.error };
	return {
		contentType: result.contentType,
		bytes: result.bytes.byteLength,
		cached: result.cached,
		dataBase64: base64OfBytes(result.bytes),
	};
}

// ── search_emails ──────────────────────────────────────────────────

/** Filters accepted by the shared search tools (agent + MCP). */
export interface SearchEmailParams {
	/** Raw Gmail-style query, e.g. `from:bob is:unread has:attachment`. */
	query?: string | undefined;
	folder?: string | undefined;
	category?: string | undefined;
	/** Exact, case-insensitive match on one label name the message carries. */
	label?: string | undefined;
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
		label: params.label,
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

// ── semantic_search ────────────────────────────────────────────────

/**
 * Semantic (vector) search over one mailbox's stored mail: the query text is
 * embedded and the mailbox's Vectorize index answers the closest messages,
 * ranked by similarity. Each hit carries the message id, subject, sender,
 * date, a snippet and the score. Read-only — it reads the mailbox and writes
 * nothing, and nothing here sends mail.
 *
 * A deployment without the AI + Vectorize bindings answers the
 * not-configured result instead of throwing, so the agent and MCP surfaces
 * report it as a plain error field rather than failing the call.
 */
export async function toolSemanticSearch(
	env: Env,
	mailboxId: string,
	params: { query: string; limit?: number | undefined },
) {
	return semanticSearch(env, mailboxId, params.query, params.limit);
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

// ── folders (list / create / update / delete) ──────────────────────

/** A folder row as MailboxDO.getFolders returns it. */
export interface MailboxFolderRow {
	id: string;
	name: string;
	unreadCount: number;
}

/** DO methods the folder tools use (RPC stub surface). */
type MailboxFoldersStub = {
	getFolders: () => Promise<MailboxFolderRow[]>;
	createFolder: (
		id: string,
		name: string,
	) => Promise<MailboxFolderRow | null>;
	updateFolder: (
		id: string,
		name: string,
	) => Promise<{ id: string; name: string } | null>;
	deleteFolder: (id: string) => Promise<boolean>;
};

function mailboxFoldersStub(env: Env, mailboxId: string): MailboxFoldersStub {
	return getMailboxStub(env, mailboxId);
}

/**
 * The mailbox's folders — the system set (inbox, sent, draft, archive,
 * snoozed, spam, trash) plus every user folder — each with its name and
 * unread count, the same rows the sidebar renders and the GET /folders
 * route serves. Read-only: it changes nothing.
 */
export async function toolListFolders(env: Env, mailboxId: string) {
	const folders = await mailboxFoldersStub(env, mailboxId).getFolders();
	return { mailboxId, folders };
}

/**
 * Create a user folder. The id is the slug of the name — lowercase,
 * whitespace to hyphens, non-alphanumerics stripped — exactly like the
 * POST /folders route. A name with no alphanumeric characters is refused
 * with the route's message, and an id or name that already exists answers
 * the route's duplicate error. Nothing is moved.
 */
export async function toolCreateFolder(
	env: Env,
	mailboxId: string,
	params: { name: string },
) {
	const slug = slugify(params.name);
	if (!slug) {
		return { error: "Folder name must contain alphanumeric characters" };
	}
	const folder = await mailboxFoldersStub(env, mailboxId).createFolder(
		slug,
		params.name,
	);
	return folder ? { folder } : { error: "Folder with this name already exists" };
}

/**
 * Rename a folder by id. The id never changes — only the display name —
 * and an unknown id answers the route's `Folder not found`. Nothing is
 * moved.
 */
export async function toolUpdateFolder(
	env: Env,
	mailboxId: string,
	params: { folderId: string; name: string },
) {
	const folder = await mailboxFoldersStub(env, mailboxId).updateFolder(
		params.folderId,
		params.name,
	);
	return folder ? { folder } : { error: "Folder not found" };
}

/**
 * Delete a user folder by id. System folders (inbox, sent, draft, archive,
 * snoozed, spam, trash) carry is_deletable = 0 and refuse, and so does an
 * unknown id — both answer the route's exact
 * `Folder not found or cannot be deleted`. Nothing else is deleted by this
 * call.
 */
export async function toolDeleteFolder(
	env: Env,
	mailboxId: string,
	params: { folderId: string },
) {
	const deleted = await mailboxFoldersStub(env, mailboxId).deleteFolder(
		params.folderId,
	);
	return deleted
		? { status: "deleted", folderId: params.folderId }
		: { error: "Folder not found or cannot be deleted" };
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

// ── get_sender_policy ──────────────────────────────────────────────

/**
 * Every allow/block entry for the mailbox, oldest first — the same entries
 * array GET /api/v1/mailboxes/:mailboxId/sender-policy answers with.
 * Read-only.
 */
export async function toolGetSenderPolicy(env: Env, mailboxId: string) {
	const stub = getMailboxStub(env, mailboxId);
	return stub.listSenderPolicy();
}

// ── remove_sender_policy ───────────────────────────────────────────

/**
 * Remove one entry by address, mirroring the DELETE sender-policy route:
 * an address with no entry changes nothing and answers the route's
 * not-found error.
 */
export async function toolRemoveSenderPolicy(
	env: Env,
	mailboxId: string,
	params: { address: string },
) {
	const stub = getMailboxStub(env, mailboxId);
	const removed = await stub.removeSenderPolicy(params.address);
	if (!removed) return { error: "Sender policy entry not found" };
	return { status: "removed", address: params.address };
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

// ── unsubscribe_email ──────────────────────────────────────────────

/**
 * One-click unsubscribe (RFC 8058) for one stored message, through the
 * shared flow (workers/lib/unsubscribe.ts): read the stored headers, POST
 * the one-click body through the SSRF guard, and stamp `unsubscribed_at`
 * only after the sender's endpoint answered 2xx.
 *
 * The caller is an operator-action surface (the scoped token's explicit
 * unsubscribe_email call); no agent or MCP tool exposes it. A failure
 * comes back as `{ error }` — the same shape every tool here uses — with
 * the upstream reason in the message.
 */
export async function toolUnsubscribeEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const outcome = await performOneClickUnsubscribe(stub, emailId);
	if (!outcome.ok) {
		return { error: outcome.error };
	}
	return { status: "unsubscribed", emailId, unsubscribedAt: outcome.unsubscribedAt };
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

// ── snooze & reminders ─────────────────────────────────────────────

/** One email row as the Durable Object's mutators return it (`getEmail` shape). */
type MailboxSnoozeRow = NonNullable<Awaited<ReturnType<MailboxDO["getEmail"]>>>;

/** One row of the Snoozed list, in the same shape as a folder listing. */
type MailboxSnoozedListRow = Awaited<ReturnType<MailboxDO["getSnoozed"]>>[number];

/**
 * The snooze/reminder RPCs these tools call. Declared structurally so the
 * mutators read as the plain `getEmail` row shape — the stub's own RPC
 * result types carry `& Disposable`, which the MCP result wrapper cannot
 * accept — the same way workers/index.ts declares its RPC surfaces.
 */
type MailboxSnoozeStub = {
	setSnooze: (id: string, until: string) => Promise<MailboxSnoozeRow | null>;
	clearSnooze: (id: string) => Promise<MailboxSnoozeRow | null>;
	setReminder: (id: string, at: string) => Promise<MailboxSnoozeRow | null>;
	clearReminder: (id: string) => Promise<MailboxSnoozeRow | null>;
	getSnoozed: () => Promise<MailboxSnoozedListRow[]>;
};

function mailboxSnoozeStub(env: Env, mailboxId: string): MailboxSnoozeStub {
	return getMailboxStub(env, mailboxId);
}

/** Relative shorthand accepted by the snooze/reminder tools: `30m`, `4h`, `3d`, `1w`. */
const RELATIVE_TIME_PATTERN = /^(\d+)([mhdw])$/;

/** Milliseconds per shorthand unit: minutes, hours, days, weeks. */
const RELATIVE_TIME_UNIT_MS: Record<string, number> = {
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 604_800_000,
};

/**
 * Resolve a caller-supplied due time into a future UTC instant.
 *
 * Accepts an ISO 8601 timestamp or a relative shorthand of the form
 * `<number><unit>` where the unit is one of `m`, `h`, `d`, `w` (`30m`,
 * `4h`, `3d`, `1w`), resolved against the current time. Only this tool
 * layer understands the shorthand — the Durable Object and the HTTP routes
 * keep taking ISO 8601 strings. Returns null when the input is neither
 * form, or when the instant is not in the future.
 */
function resolveFutureInstant(value: string): string | null {
	const trimmed = value.trim();
	const relative = RELATIVE_TIME_PATTERN.exec(trimmed);
	const parsed = relative
		? Date.now() +
			Number(relative[1]) * (RELATIVE_TIME_UNIT_MS[relative[2] ?? ""] ?? 0)
		: Date.parse(trimmed);
	if (Number.isNaN(parsed) || parsed <= Date.now()) return null;
	return new Date(parsed).toISOString();
}

/** Error for a due time that is malformed, or not in the future. */
function invalidDueTimeError(label: string, value: string): { error: string } {
	return {
		error: `Invalid ${label} "${value}": pass a future ISO 8601 timestamp (e.g. 2026-09-25T09:00:00Z) or a relative shorthand like 30m, 4h, 3d or 1w.`,
	};
}

/**
 * Snooze an email until a future time: the message moves to the Snoozed
 * folder now and returns to the folder it came from by itself when the time
 * arrives. `until` is an ISO 8601 timestamp or a relative shorthand (`30m`,
 * `4h`, `3d`, `1w`). Nothing is deleted.
 *
 * Returns the updated email row, or `{ error }` for an unusable time or an
 * unknown id.
 */
export async function toolSnoozeEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
	until: string,
) {
	const at = resolveFutureInstant(until);
	if (!at) return invalidDueTimeError("snooze time", until);
	const email = await mailboxSnoozeStub(env, mailboxId).setSnooze(emailId, at);
	if (!email) return { error: "Email not found" };
	return email;
}

/**
 * Wake a snoozed email now: cancel its snooze and put the message back in
 * the folder it came from (the Inbox when that folder is gone). Nothing is
 * deleted.
 *
 * Returns the updated email row, or `{ error: "Email not found" }` for an
 * unknown id.
 */
export async function toolUnsnoozeEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
) {
	const email = await mailboxSnoozeStub(env, mailboxId).clearSnooze(emailId);
	if (!email) return { error: "Email not found" };
	return email;
}

/**
 * Set (or re-set) a follow-up reminder for an email. The message stays where
 * it is; when the reminder fires it is flagged and pulled back to the Inbox
 * when the thread still expects a reply. `at` is an ISO 8601 timestamp or a
 * relative shorthand (`30m`, `4h`, `3d`, `1w`). Nothing is deleted.
 *
 * Returns the updated email row, or `{ error }` for an unusable time or an
 * unknown id.
 */
export async function toolSetReminder(
	env: Env,
	mailboxId: string,
	emailId: string,
	at: string,
) {
	const remindAt = resolveFutureInstant(at);
	if (!remindAt) return invalidDueTimeError("reminder time", at);
	const email = await mailboxSnoozeStub(env, mailboxId).setReminder(
		emailId,
		remindAt,
	);
	if (!email) return { error: "Email not found" };
	return email;
}

/**
 * Cancel an email's follow-up reminder, pending or already fired, and clear
 * both reminder columns. Nothing is deleted.
 *
 * Returns the updated email row, or `{ error: "Email not found" }` for an
 * unknown id.
 */
export async function toolClearReminder(
	env: Env,
	mailboxId: string,
	emailId: string,
) {
	const email = await mailboxSnoozeStub(env, mailboxId).clearReminder(emailId);
	if (!email) return { error: "Email not found" };
	return email;
}

/**
 * List the messages currently snoozed in a mailbox, earliest wake time
 * first. Read-only — it changes nothing. Rows carry the same fields as a
 * folder listing.
 */
export async function toolListSnoozed(env: Env, mailboxId: string) {
	const emails = await mailboxSnoozeStub(env, mailboxId).getSnoozed();
	return { mailboxId, emails, totalCount: emails.length };
}

// ── thread tools (mute / unmute / mark read / summarize) ────────────

/**
 * Mute a thread: new mail in it is skipped by the push and webhook
 * notification fan-outs (workers/lib/webpush.ts, workers/lib/webhook.ts).
 * The mute is a row keyed by the thread id alone, so muting an id that has
 * no messages is allowed and muting twice is idempotent. Notification
 * bookkeeping only: nothing is deleted.
 *
 * Mirrors the web route (POST .../threads/:threadId/mute): the trimmed id
 * must be 1 to 320 characters, and a bad one answers the same error the
 * route answers.
 */
export async function toolMuteThread(
	env: Env,
	mailboxId: string,
	params: { threadId: string },
) {
	const threadId = params.threadId.trim();
	// Mirrors MailboxDO.muteThread's bound, so an id it would reject answers
	// an error object here instead of a rebuilt RPC failure.
	if (threadId.length < 1 || threadId.length > 320) {
		return { error: "threadId must be 1 to 320 characters" };
	}
	await getMailboxStub(env, mailboxId).muteThread(threadId);
	return { muted: true };
}

/**
 * Unmute a thread so its new mail notifies again. Idempotent: an already
 * unmuted thread answers the same `{ muted: false }`. Nothing is deleted.
 */
export async function toolUnmuteThread(
	env: Env,
	mailboxId: string,
	params: { threadId: string },
) {
	await getMailboxStub(env, mailboxId).unmuteThread(params.threadId);
	return { muted: false };
}

/**
 * Mark every message in a thread as read, in one Durable Object call — the
 * same write the web route's "mark thread read" action makes. Read state
 * only: nothing is deleted and nothing is sent.
 */
export async function toolMarkThreadRead(
	env: Env,
	mailboxId: string,
	params: { threadId: string },
) {
	await getMailboxStub(env, mailboxId).markThreadRead(params.threadId);
	return { status: "marked_read" };
}

/**
 * Summarize one conversation thread with the mailbox's summarizer model,
 * built per request and never stored (workers/lib/thread-summary.ts).
 *
 * Returns the summary object (`text`, `message_count`, `truncated`,
 * `model`), or `{ error }` for an unknown/empty thread or a model that
 * cannot answer right now.
 */
export async function toolSummarizeThread(
	env: Env,
	mailboxId: string,
	params: { threadId: string },
) {
	const result = await runThreadSummary(env, mailboxId, params.threadId);
	if (result.status === "not_found") return { error: "Thread not found" };
	if (result.status === "unavailable") {
		return { error: "Thread summarization is unavailable right now." };
	}
	return result.summary;
}

// ── scheduled sends (list_scheduled_sends / cancel_scheduled_send) ──

/**
 * The scheduled-send RPCs these tools call. Declared structurally for the
 * same reason as the snooze tools: the stub's own RPC result types carry
 * `& Disposable`, which the MCP result wrapper cannot accept.
 *
 * Sending is operator-only. These tools can read the queue and cancel a
 * pending send — there is deliberately no tool that schedules or sends one.
 */
type MailboxScheduledSendsStub = {
	listScheduledSends: (limit?: number) => Promise<ScheduledSendRow[]>;
	countScheduledSends: () => Promise<number>;
	cancelScheduledSend: (id: string) => Promise<ScheduledSendActionResult>;
};

function mailboxScheduledSendsStub(
	env: Env,
	mailboxId: string,
): MailboxScheduledSendsStub {
	return getMailboxStub(env, mailboxId);
}

/**
 * List a mailbox's scheduled sends, newest first, with the parsed send
 * parameters and the outcome of terminal rows (sent, failed, cancelled).
 * Read-only — nothing is sent and nothing is deleted.
 */
export async function toolListScheduledSends(
	env: Env,
	mailboxId: string,
	limit = DEFAULT_SCHEDULED_SEND_LIMIT,
) {
	const stub = mailboxScheduledSendsStub(env, mailboxId);
	const [sends, totalCount] = await Promise.all([
		stub.listScheduledSends(limit),
		stub.countScheduledSends(),
	]);
	return { mailboxId, sends, totalCount };
}

/**
 * Cancel one pending scheduled send so it never fires. Only a pending send
 * can be cancelled; an unknown id or an already-terminal row answers
 * `{ error }`. Nothing is sent and nothing is deleted — the cancelled row
 * stays for the operator to see.
 */
export async function toolCancelScheduledSend(
	env: Env,
	mailboxId: string,
	id: string,
) {
	const result = await mailboxScheduledSendsStub(env, mailboxId).cancelScheduledSend(id);
	if (!result.ok) return { error: result.error };
	return { status: "cancelled", send: result.send };
}

// ── schedule_send / retry_scheduled_send ───────────────────────────

/**
 * The scheduled-send write RPCs these tools call, declared structurally for
 * the same reason as the read tools above: the stub's own RPC result types
 * carry `& Disposable`, which the MCP result wrapper cannot accept.
 */
type MailboxScheduledSendWriteStub = {
	scheduleSend: (input: {
		sendAt: string;
		payload: string;
	}) => Promise<ScheduledSendRow>;
	retryScheduledSend: (id: string) => Promise<ScheduledSendActionResult>;
};

function mailboxScheduledSendWriteStub(
	env: Env,
	mailboxId: string,
): MailboxScheduledSendWriteStub {
	return getMailboxStub(env, mailboxId);
}

/**
 * Queue a new outbound message for a future instant, mirroring
 * POST /api/v1/mailboxes/:mailboxId/scheduled-sends (workers/index.ts): the
 * same sender validation and send rate limit run here, `sendAt` must be a
 * future ISO 8601 instant, and attachments are never queued — a stored
 * payload holds the send parameters only. The MCP body arrives as
 * `bodyHtml` and is verified the way send_email verifies MCP bodies; the
 * plain-text alternative is derived the way the composer derives it for
 * every message it queues (shared/compose-body). Nothing is sent here: the
 * mailbox's alarm (or the cron sweep) fires the send when it comes due.
 * Returns the stored row, exactly as the route's 201 answers.
 */
export async function toolScheduleSend(
	env: Env,
	mailboxId: string,
	params: {
		to: string;
		subject: string;
		bodyHtml: string;
		cc?: string | string[] | undefined;
		bcc?: string | string[] | undefined;
		sendAt: string;
	},
) {
	// The sender is the mailbox itself — the MCP surface has no `from`
	// field — checked exactly like the route checks it. It runs before the
	// schema below so a mailbox that cannot be a sender is reported the way
	// the route reports it.
	try {
		validateSender(
			typeof params.to === "string" ? params.to : "",
			mailboxId,
			mailboxId,
		);
	} catch (e) {
		if (e instanceof SenderValidationError) return { error: e.message };
		throw e;
	}

	const parsed = ScheduleSendRequestSchema.safeParse({
		to: params.to,
		cc: params.cc,
		bcc: params.bcc,
		from: mailboxId,
		subject: params.subject,
		html: params.bodyHtml,
		send_at: params.sendAt,
	});
	if (!parsed.success) return { error: "Invalid scheduled send request" };

	// `sendAt` mirrors the route's futureTimestamp: a past or unusable
	// instant is refused, never treated as "due immediately".
	const parsedSendAt = Date.parse(parsed.data.send_at);
	if (Number.isNaN(parsedSendAt) || parsedSendAt <= Date.now()) {
		return { error: "`sendAt` must be a future ISO 8601 timestamp" };
	}
	const sendAt = new Date(parsedSendAt).toISOString();

	// The same rate limit the immediate and queued send paths run.
	const stub = mailboxScheduledSendWriteStub(env, mailboxId);
	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit();
	if (rateLimitError) return { error: rateLimitError };

	// The body is verified the way send_email verifies MCP bodies, then the
	// html/text pair is derived the way the composer derives it for every
	// queued message; no signature is applied — the route stores the body
	// as given, like the immediate tool send paths.
	const sanitizedBody = await verifyDraft(env.AI, params.bodyHtml);
	if (!sanitizedBody) {
		return {
			error:
				"Draft verification failed — refusing to send unverified content. Please try again.",
		};
	}
	const { html, text } = ensureMessageBody(sanitizedBody);

	const payload = serializeScheduledSendPayload({
		to: parsed.data.to,
		cc: parsed.data.cc,
		bcc: parsed.data.bcc,
		from: mailboxId,
		subject: parsed.data.subject,
		html,
		text,
	});
	if ("error" in payload) return { error: payload.error };

	const send = await stub.scheduleSend({ sendAt, payload: payload.payload });
	return { ...send };
}

/**
 * Re-arm one failed scheduled send: it becomes pending and due immediately,
 * so the mailbox's alarm (or the sweep) retries it. Only a failed send can
 * be retried; an unknown id or an already-terminal row answers `{ error }`.
 * The queued message is resent exactly as it was stored — the payload is
 * never touched.
 */
export async function toolRetryScheduledSend(
	env: Env,
	mailboxId: string,
	sendId: string,
) {
	const result = await mailboxScheduledSendWriteStub(env, mailboxId)
		.retryScheduledSend(sendId);
	if (!result.ok) return { error: result.error };
	return { status: "pending", send: result.send };
}

// ── agent action audit (list_agent_actions / undo_action) ──────────

/** One stored audit row, as MailboxDO.listAgentActions returns it. */
type MailboxAgentActionRow = Awaited<ReturnType<MailboxDO["listAgentActions"]>>[number];

/** The undo answer MailboxDO.undoAgentAction returns; null marks an unknown id. */
type MailboxAgentActionUndo = NonNullable<Awaited<ReturnType<MailboxDO["undoAgentAction"]>>>;

/**
 * The audit RPCs these two tools call. Declared structurally so the rows
 * read as plain objects — the stub's own RPC result types carry
 * `& Disposable`, which the MCP result wrapper cannot accept — the same way
 * the snooze tools declare their surface.
 */
type MailboxAgentActionsStub = {
	listAgentActions: (limit?: number) => Promise<MailboxAgentActionRow[]>;
	countAgentActions: () => Promise<number>;
	undoAgentAction: (id: string) => Promise<MailboxAgentActionUndo | null>;
};

function mailboxAgentActionsStub(
	env: Env,
	mailboxId: string,
): MailboxAgentActionsStub {
	return getMailboxStub(env, mailboxId);
}

/**
 * List a mailbox's most recent mutating agent/MCP tool calls, newest first,
 * with the total number stored. Read-only — it changes nothing. The log is
 * metadata only: no message bodies, no attachment bytes.
 */
export async function toolListAgentActions(
	env: Env,
	mailboxId: string,
	limit = 50,
) {
	const stub = mailboxAgentActionsStub(env, mailboxId);
	const [actions, totalCount] = await Promise.all([
		stub.listAgentActions(limit),
		stub.countAgentActions(),
	]);
	return { mailboxId, actions, totalCount };
}

/**
 * Undo one recorded agent/MCP action: restore the message's read state, star
 * state and folder from the recorded before-state. It never sends and never
 * deletes mail, and an action can be undone once.
 *
 * Returns the restored action plus the updated email row, or `{ error }`
 * when the id is unknown, the action is not undoable, or it has already been
 * undone.
 */
export async function toolUndoAgentAction(
	env: Env,
	mailboxId: string,
	actionId: string,
) {
	const result = await mailboxAgentActionsStub(env, mailboxId).undoAgentAction(
		actionId,
	);
	if (!result) return { error: "Agent action not found" };
	if (!result.ok) return { error: result.error };
	return { action: result.action, email: result.email };
}

// ── contacts (search_contacts) ─────────────────────────────────────

/** One stored contact row, as MailboxDO.searchContacts returns it. */
type MailboxContactRow = Awaited<ReturnType<MailboxDO["searchContacts"]>>[number];

/**
 * The contact RPCs the search_contacts tool calls. Declared structurally so
 * the rows read as plain objects — the stub's own RPC result types carry
 * `& Disposable`, which the MCP result wrapper cannot accept — the same way
 * the audit and snooze tools declare their surface.
 */
type MailboxContactsStub = {
	searchContacts: (query: string, limit?: number) => Promise<MailboxContactRow[]>;
	countContacts: (query: string) => Promise<number>;
};

function mailboxContactsStub(env: Env, mailboxId: string): MailboxContactsStub {
	return getMailboxStub(env, mailboxId);
}

/**
 * Search the mailbox's contacts — the addresses it has exchanged mail with
 * — ranked by sent count, then received count, then recency. `query` is an
 * optional case-insensitive prefix matched against the address or the
 * display name; an empty query returns the top-ranked contacts. Read-only
 * and metadata only (address, display name, counts, timestamps): this is
 * how the agent resolves a recipient address before send_email or
 * send_reply.
 */
export async function toolSearchContacts(
	env: Env,
	mailboxId: string,
	query = "",
	limit = DEFAULT_CONTACT_SEARCH_LIMIT,
) {
	const stub = mailboxContactsStub(env, mailboxId);
	const [contacts, totalCount] = await Promise.all([
		stub.searchContacts(query, limit),
		stub.countContacts(query),
	]);
	return { mailboxId, query, contacts, totalCount };
}

// ── saved searches (list/create/update/delete_saved_search) ────────

/** One stored saved search row, as MailboxDO.listSavedSearches answers it. */
type MailboxSavedSearchRow = {
	id: string;
	name: string;
	query: string;
	created_at: string;
};

/**
 * The saved-search RPCs these tools call. Declared structurally for the
 * same reason as the audit, snooze and contact tools: the stub's own RPC
 * result types carry `& Disposable`, which the MCP result wrapper cannot
 * accept.
 */
type MailboxSavedSearchesStub = {
	listSavedSearches: () => Promise<MailboxSavedSearchRow[]>;
	createSavedSearch: (
		input: { name?: unknown; query?: unknown } | null,
	) => Promise<MailboxSavedSearchRow | null>;
	updateSavedSearch: (
		id: string,
		patch: { name?: unknown; query?: unknown } | null,
	) => Promise<MailboxSavedSearchRow | null>;
	deleteSavedSearch: (id: string) => Promise<boolean>;
};

function mailboxSavedSearchesStub(
	env: Env,
	mailboxId: string,
): MailboxSavedSearchesStub {
	return getMailboxStub(env, mailboxId);
}

/** Longest saved-search name accepted, after trimming (mirrors the DO). */
const MAX_SAVED_SEARCH_NAME_LENGTH = 120;

/** Longest saved-search query accepted, after trimming (mirrors the DO). */
const MAX_SAVED_SEARCH_QUERY_LENGTH = 1000;

/** Most saved searches one mailbox can hold (mirrors the DO). */
const MAX_SAVED_SEARCHES = 50;

/**
 * The reason one saved-search field is unusable, or null when it is fine.
 * The bounds mirror the Durable Object's own validators, exactly like the
 * web route's pre-check, which is what lets these tools name the field.
 */
function savedSearchFieldError(
	field: "name" | "query",
	value: unknown,
	max: number,
): string | null {
	if (typeof value !== "string" || !value.trim()) {
		return `A saved search ${field} is required`;
	}
	if (value.trim().length > max) {
		return `A saved search ${field} can be at most ${max} characters`;
	}
	return null;
}

/** The reason a create input is unusable, the name checked before the query. */
function savedSearchCreateError(input: unknown): string | null {
	if (input === null || typeof input !== "object") return "Invalid saved search";
	const body = input as { name?: unknown; query?: unknown };
	return (
		savedSearchFieldError("name", body.name, MAX_SAVED_SEARCH_NAME_LENGTH) ??
		savedSearchFieldError("query", body.query, MAX_SAVED_SEARCH_QUERY_LENGTH)
	);
}

/** The reason a patch input is unusable; omitted fields are never checked. */
function savedSearchPatchError(input: unknown): string | null {
	if (input === null || typeof input !== "object") return "Invalid saved search";
	const patch = input as { name?: unknown; query?: unknown };
	if (patch.name !== undefined) {
		const error = savedSearchFieldError(
			"name",
			patch.name,
			MAX_SAVED_SEARCH_NAME_LENGTH,
		);
		if (error) return error;
	}
	if (patch.query !== undefined) {
		const error = savedSearchFieldError(
			"query",
			patch.query,
			MAX_SAVED_SEARCH_QUERY_LENGTH,
		);
		if (error) return error;
	}
	return null;
}

/**
 * The mailbox's saved searches — named queries the operator re-runs from
 * the sidebar or saves from the search page — newest first. Read-only, and
 * answers the same `{ searches }` shape as the web GET route; every entry
 * carries its id, name, query and created_at.
 */
export async function toolListSavedSearches(env: Env, mailboxId: string) {
	const searches = await mailboxSavedSearchesStub(env, mailboxId).listSavedSearches();
	return { searches };
}

/**
 * Store one saved search for the mailbox. The name (1..120 characters,
 * trimmed) and the query (1..1000 characters, trimmed) are validated here
 * with the same bounds and messages as the web route, and the
 * 50-per-mailbox cap is enforced by the Durable Object. Returns the stored
 * row, or `{ error }` — an unusable field or the cap — never a silently
 * clipped row. Names need not be unique, exactly like the route.
 */
export async function toolCreateSavedSearch(
	env: Env,
	mailboxId: string,
	input: { name?: unknown; query?: unknown } | null,
) {
	const error = savedSearchCreateError(input);
	if (error) return { error };
	const search = await mailboxSavedSearchesStub(env, mailboxId).createSavedSearch(input);
	if (!search) {
		return { error: `A mailbox can hold at most ${MAX_SAVED_SEARCHES} saved searches` };
	}
	return search;
}

/**
 * Apply a partial change to one saved search (name and/or query). Omitted
 * fields keep their stored value, and a provided value is validated with
 * the same bounds and messages as the web route. Returns the updated row;
 * `{ error }` when the id is unknown ("Saved search not found") or a
 * provided value is unusable.
 */
export async function toolUpdateSavedSearch(
	env: Env,
	mailboxId: string,
	input: { searchId: string; name?: unknown; query?: unknown },
) {
	const error = savedSearchPatchError(input);
	if (error) return { error };
	const search = await mailboxSavedSearchesStub(env, mailboxId).updateSavedSearch(
		input.searchId,
		{ name: input.name, query: input.query },
	);
	if (!search) return { error: "Saved search not found" };
	return search;
}

/**
 * Remove one saved search. Returns `{ ok: true }` — the same shape as the
 * web DELETE route — or `{ error: "Saved search not found" }` when the id
 * is unknown. Nothing else is touched.
 */
export async function toolDeleteSavedSearch(
	env: Env,
	mailboxId: string,
	input: { searchId: string },
) {
	const deleted = await mailboxSavedSearchesStub(env, mailboxId).deleteSavedSearch(
		input.searchId,
	);
	return deleted ? { ok: true } : { error: "Saved search not found" };
}

// ── templates (list_templates) ─────────────────────────────────────

/** One stored template row, as MailboxDO.listTemplates returns it. */
type MailboxTemplateRow = Awaited<ReturnType<MailboxDO["listTemplates"]>>[number];

/**
 * The template RPC the list_templates tool calls. Declared structurally for
 * the same reason as the contacts and snooze tools: the stub's own RPC
 * result types carry `& Disposable`, which the MCP result wrapper cannot
 * accept.
 */
type MailboxTemplatesStub = {
	listTemplates: () => Promise<MailboxTemplateRow[]>;
};

function mailboxTemplatesStub(env: Env, mailboxId: string): MailboxTemplatesStub {
	return getMailboxStub(env, mailboxId);
}

/**
 * The mailbox's templates — operator-authored reusable snippets — ordered by
 * name. Read-only, and deliberately the only template surface the agent and
 * the MCP server have: nothing here creates, edits or deletes a template,
 * and nothing sends mail. Each entry carries the template's id, name,
 * optional subject and body, so the agent can use one as a starting point
 * for a draft.
 */
export async function toolListTemplates(env: Env, mailboxId: string) {
	const templates = await mailboxTemplatesStub(env, mailboxId).listTemplates();
	return {
		mailboxId,
		templates: templates.map((template) => ({
			id: template.id,
			name: template.name,
			subject: template.subject,
			body: template.body,
		})),
		note:
			"Templates are operator-authored snippets. This tool is read-only: templates can only be created, edited or deleted by the operator in the app.",
	};
}


// ── template management (create_template, update_template, delete_template) ──

/**
 * The template-administration RPCs the template management tools call.
 * Declared structurally for the same reason as the read-only template list:
 * the stub's own RPC result types carry `& Disposable`, which the MCP result
 * wrapper cannot accept.
 */
type MailboxTemplateAdminStub = {
	createTemplate(input: {
		name?: unknown;
		subject?: unknown;
		body?: unknown;
	}): Promise<MailboxTemplateRow>;
	updateTemplate(
		id: string,
		patch: { name?: unknown; subject?: unknown; body?: unknown },
	): Promise<MailboxTemplateRow | null>;
	deleteTemplate(id: string): Promise<boolean>;
};

function mailboxTemplateAdminStub(
	env: Env,
	mailboxId: string,
): MailboxTemplateAdminStub {
	return getMailboxStub(env, mailboxId);
}

/**
 * The stored row a template write answers with — the same shape the web
 * routes return. Mapped out field by field so the result is a plain object
 * the MCP result wrapper accepts.
 */
function templateToolRow(template: MailboxTemplateRow) {
	return {
		id: template.id,
		name: template.name,
		subject: template.subject,
		body: template.body,
		created_at: template.created_at,
		updated_at: template.updated_at,
	};
}

/**
 * Create one template. The name (1..120 characters, trimmed), the optional
 * subject (at most 500) and the body (1..100000) are validated and bounded
 * by the Durable Object, which also refuses a mailbox already holding 200
 * templates; an unusable payload comes back as `{ error }` carrying the same
 * message the web route answers with. Nothing here sends mail.
 */
export async function toolCreateTemplate(
	env: Env,
	mailboxId: string,
	input: { name?: unknown; subject?: unknown; body?: unknown },
) {
	const stub = mailboxTemplateAdminStub(env, mailboxId);
	try {
		return templateToolRow(await stub.createTemplate(input));
	} catch (e) {
		if (isTemplateValidationError(e)) return { error: (e as Error).message };
		throw e;
	}
}

/**
 * Apply a partial change to one template: omitted fields keep their stored
 * value, an explicit null (or blank) subject clears it, and every supplied
 * field is validated and bounded by the Durable Object. An unknown id is
 * `{ error: "Template not found" }` and a refused write carries the same
 * message the web route answers with. Nothing here sends mail.
 */
export async function toolUpdateTemplate(
	env: Env,
	mailboxId: string,
	input: {
		templateId: string;
		name?: unknown;
		subject?: unknown;
		body?: unknown;
	},
) {
	const stub = mailboxTemplateAdminStub(env, mailboxId);
	const patch: { name?: unknown; subject?: unknown; body?: unknown } = {};
	if (input.name !== undefined) patch.name = input.name;
	if (input.subject !== undefined) patch.subject = input.subject;
	if (input.body !== undefined) patch.body = input.body;
	try {
		const template = await stub.updateTemplate(input.templateId, patch);
		if (!template) return { error: "Template not found" };
		return templateToolRow(template);
	} catch (e) {
		if (isTemplateValidationError(e)) return { error: (e as Error).message };
		throw e;
	}
}

/**
 * Remove one template by id. The row is deleted and nothing else changes;
 * nothing here sends mail. An unknown id is `{ error: "Template not found" }`
 * — the same message the web route answers with.
 */
export async function toolDeleteTemplate(
	env: Env,
	mailboxId: string,
	input: { templateId: string },
) {
	const stub = mailboxTemplateAdminStub(env, mailboxId);
	const deleted = await stub.deleteTemplate(input.templateId);
	if (!deleted) return { error: "Template not found" };
	return { ok: true };
}


// ── labels (list_labels, add_label, remove_label) ──────────────────

/** One stored label row, as MailboxDO.listLabels returns it. */
type MailboxLabelRow = Awaited<ReturnType<MailboxDO["listLabels"]>>[number];

/** What attaching or detaching a label on an email answers with. */
type MailboxLabelMutation = Awaited<ReturnType<MailboxDO["addLabelToEmail"]>>;

/**
 * The label RPCs the label tools call. Declared structurally for the same
 * reason as the contacts and template tools: the stub's own RPC result
 * types carry `& Disposable`, which the MCP result wrapper cannot accept.
 */
type MailboxLabelsStub = {
	listLabels: () => Promise<MailboxLabelRow[]>;
	addLabelToEmail: (emailId: string, labelId: string) => Promise<MailboxLabelMutation>;
	removeLabelFromEmail: (emailId: string, labelId: string) => Promise<MailboxLabelMutation>;
};

function mailboxLabelsStub(env: Env, mailboxId: string): MailboxLabelsStub {
	return getMailboxStub(env, mailboxId);
}

/**
 * Find one of the mailbox's labels by id or by name, case-insensitively —
 * how add_label and remove_label resolve their `label` argument.
 */
function findLabel(labels: MailboxLabelRow[], wanted: string): MailboxLabelRow | null {
	const query = wanted.trim();
	if (!query) return null;
	const byId = labels.find((label) => label.id === query);
	if (byId) return byId;
	const lower = query.toLowerCase();
	return labels.find((label) => label.name.toLowerCase() === lower) ?? null;
}

/**
 * The mailbox's labels, ordered by name (case-insensitive), each with its
 * id, name, color and created_at. Read-only: this tool changes nothing —
 * labels are created or deleted by the operator in the app — and nothing
 * here sends mail. Use a label's name (or id) with add_label/remove_label
 * to tag a message.
 */
export async function toolListLabels(env: Env, mailboxId: string) {
	const labels = await mailboxLabelsStub(env, mailboxId).listLabels();
	return {
		mailboxId,
		labels: labels.map((label) => ({
			id: label.id,
			name: label.name,
			color: label.color,
			created_at: label.created_at,
		})),
		note:
			"Read-only: labels are created and removed by the operator in the app. Use a label's name (or id) with add_label or remove_label to tag a message — unlike the AI-assigned category, a label is only ever set by an explicit action.",
	};
}

/**
 * Attach one label to one message. `label` is a label name (matched
 * case-insensitively) or its id; the label must already exist — labels are
 * created by the operator in the app. Answers the message's labels after
 * the change, or an error when the message or the label is missing.
 */
export async function toolAddLabel(
	env: Env,
	mailboxId: string,
	emailId: string,
	label: string,
) {
	const stub = mailboxLabelsStub(env, mailboxId);
	const existing = findLabel(await stub.listLabels(), label);
	if (!existing) return { error: "Label not found" };
	const result = await stub.addLabelToEmail(emailId, existing.id);
	if (!result.ok) return { error: result.error };
	return {
		status: "updated",
		emailId,
		label: { id: existing.id, name: existing.name, color: existing.color },
		labels: result.labels,
	};
}

/**
 * Detach one label from one message. `label` is a label name (matched
 * case-insensitively) or its id; detaching a label the message does not
 * carry is a no-op. Answers the message's labels after the change, or an
 * error when the message or the label is missing.
 */
export async function toolRemoveLabel(
	env: Env,
	mailboxId: string,
	emailId: string,
	label: string,
) {
	const stub = mailboxLabelsStub(env, mailboxId);
	const existing = findLabel(await stub.listLabels(), label);
	if (!existing) return { error: "Label not found" };
	const result = await stub.removeLabelFromEmail(emailId, existing.id);
	if (!result.ok) return { error: result.error };
	return {
		status: "updated",
		emailId,
		label: { id: existing.id, name: existing.name, color: existing.color },
		labels: result.labels,
	};
}


// ── label management (create_label, update_label, delete_label) ────

/**
 * The label-administration RPCs the label management tools call. Declared
 * structurally for the same reason as the read-only label list: the stub's
 * own RPC result types carry `& Disposable`, which the MCP result wrapper
 * cannot accept.
 */
type MailboxLabelAdminStub = {
	listLabels(): Promise<MailboxLabelRow[]>;
	createLabel(input: {
		name?: unknown;
		color?: unknown;
	}): Promise<MailboxLabelRow>;
	updateLabel(
		id: string,
		patch: { name?: unknown; color?: unknown },
	): Promise<MailboxLabelRow | null>;
	deleteLabel(id: string): Promise<boolean>;
};

function mailboxLabelAdminStub(env: Env, mailboxId: string): MailboxLabelAdminStub {
	return getMailboxStub(env, mailboxId);
}

/**
 * The stored row a label write answers with — the same shape the web routes
 * return. Mapped out field by field so the result is a plain object the MCP
 * result wrapper accepts.
 */
function labelToolRow(label: MailboxLabelRow) {
	return {
		id: label.id,
		name: label.name,
		color: label.color,
		created_at: label.created_at,
	};
}

/**
 * Create one label. The name (1..50 characters, trimmed, unique per mailbox
 * case-insensitively) and the color (at most 32 characters) are validated by
 * the Durable Object, which also refuses a mailbox already holding 100
 * labels; an unusable payload comes back as `{ error }` carrying the same
 * message the web route answers with. Nothing here sends mail.
 */
export async function toolCreateLabel(
	env: Env,
	mailboxId: string,
	input: { name?: unknown; color?: unknown },
) {
	const stub = mailboxLabelAdminStub(env, mailboxId);
	try {
		return labelToolRow(await stub.createLabel(input));
	} catch (e) {
		if (isLabelValidationError(e)) return { error: (e as Error).message };
		throw e;
	}
}

/**
 * Apply a partial change to one label, resolved by its current name (matched
 * case-insensitively) or its id. Omitted fields keep their stored value; an
 * explicit null (or blank) color clears it. A rename that collides with
 * another label's name and every other refused write comes back as
 * `{ error }` with the same message the web route answers with; an unknown
 * label is `{ error: "Label not found" }`. Nothing here sends mail.
 */
export async function toolUpdateLabel(
	env: Env,
	mailboxId: string,
	input: { label: string; name?: unknown; color?: unknown },
) {
	const stub = mailboxLabelAdminStub(env, mailboxId);
	const existing = findLabel(await stub.listLabels(), input.label);
	if (!existing) return { error: "Label not found" };
	const patch: { name?: unknown; color?: unknown } = {};
	if (input.name !== undefined) patch.name = input.name;
	if (input.color !== undefined) patch.color = input.color;
	try {
		const label = await stub.updateLabel(existing.id, patch);
		if (!label) return { error: "Label not found" };
		return labelToolRow(label);
	} catch (e) {
		if (isLabelValidationError(e)) return { error: (e as Error).message };
		throw e;
	}
}

/**
 * Remove one label, resolved by its name (matched case-insensitively) or its
 * id, and every assignment of it; the messages it tagged are never touched.
 * An unknown label is `{ error: "Label not found" }` — the same message the
 * web route answers with. Nothing here sends mail.
 */
export async function toolDeleteLabel(
	env: Env,
	mailboxId: string,
	input: { label: string },
) {
	const stub = mailboxLabelAdminStub(env, mailboxId);
	const existing = findLabel(await stub.listLabels(), input.label);
	if (!existing) return { error: "Label not found" };
	const deleted = await stub.deleteLabel(existing.id);
	if (!deleted) return { error: "Label not found" };
	return { ok: true };
}


// ── items (list_items) ─────────────────────────────────────────────

/** One stored item, as MailboxDO.listItems returns it. */
type MailboxExtractedItem = Awaited<
	ReturnType<MailboxDO["listItems"]>
>["items"][number];

/**
 * The items RPC the list_items tool calls. Declared structurally for the
 * same reason as the contacts and template tools: the stub's own RPC result
 * types carry `& Disposable`, which the MCP result wrapper cannot accept.
 */
type MailboxItemsStub = {
	listItems: (
		filters: ItemListFilters,
	) => Promise<{ items: MailboxExtractedItem[]; totalCount: number }>;
};

function mailboxItemsStub(env: Env, mailboxId: string): MailboxItemsStub {
	return getMailboxStub(env, mailboxId);
}

/**
 * The mailbox's extracted tasks and deadlines, newest first, with the total
 * matching the filters. Read-only, and deliberately the only items surface
 * the agent and the MCP server have: nothing here creates, closes or
 * dismisses an item, and nothing sends mail. Each entry carries the source
 * message id, kind, title, details, due date and status, so the agent can
 * answer "what is due?" without reading the mailbox again.
 */
export async function toolListItems(
	env: Env,
	mailboxId: string,
	options: {
		status?: ItemStatus | undefined;
		due?: ItemDueFilter | undefined;
		limit?: number | undefined;
	} = {},
) {
	const { items, totalCount } = await mailboxItemsStub(env, mailboxId).listItems(
		{
			status: options.status,
			due: options.due,
			limit: options.limit,
			page: 1,
		},
	);
	return { items, totalCount };
}

// ── update_item ────────────────────────────────────────────────────

/**
 * The items RPC update_item calls. Declared structurally like the
 * list_items stub for the same reason: the stub's own RPC result types
 * carry `& Disposable`, which the MCP result wrapper cannot accept.
 */
type MailboxItemStatusStub = {
	updateItemStatus: (
		id: string,
		status: ItemStatus,
	) => Promise<MailboxExtractedItem | null>;
};

function mailboxItemStatusStub(
	env: Env,
	mailboxId: string,
): MailboxItemStatusStub {
	return getMailboxStub(env, mailboxId);
}

/**
 * Move one extracted item to a new lifecycle state (open | done |
 * dismissed) and answer the stored row. Mirrors the PUT
 * /api/v1/mailboxes/:mailboxId/items/:itemId route: an unknown id is an
 * error, and a status outside the stored vocabulary is rejected with the
 * route's 400 message rather than silently written. Nothing is sent.
 */
export async function toolUpdateItem(
	env: Env,
	mailboxId: string,
	params: { itemId: string; status: string },
) {
	if (!isItemStatus(params.status)) {
		return { error: "Invalid item status" };
	}
	const item = await mailboxItemStatusStub(env, mailboxId).updateItemStatus(
		params.itemId,
		params.status,
	);
	return item ? { item } : { error: "Item not found" };
}

// ── empty_trash ────────────────────────────────────────────────────

/**
 * Permanently delete every message in the Trash folder, including its R2
 * attachment blobs — the exact work of the POST /trash/empty route, so an
 * explicit "empty the trash" request goes through the same path. Answers
 * the number of purged messages. Irreversible. Nothing is sent.
 */
export async function toolEmptyTrash(env: Env, mailboxId: string) {
	const stub = getMailboxStub(env, mailboxId);
	const { purged, attachments } = await stub.emptyTrash();
	if (attachments.length > 0) {
		await env.BUCKET.delete(
			attachments.map(
				(att) => `attachments/${att.email_id}/${att.id}/${att.filename}`,
			),
		);
	}
	return { purged };
}

// ── restore_email ──────────────────────────────────────────────────

/**
 * Move a trashed message back to the Inbox, mirroring the web restore
 * route: only rows still in Trash move, and an id that is missing or not
 * trashed answers an error rather than a silent no-op. Answers the
 * restored count. Nothing is sent.
 */
export async function toolRestoreEmail(
	env: Env,
	mailboxId: string,
	params: { emailId: string },
) {
	const stub = getMailboxStub(env, mailboxId);
	const restored = (await stub.restoreEmails([params.emailId])) as string[];
	if (restored.length === 0) {
		return { error: "Email is not in Trash" };
	}
	return { restored: restored.length };
}

// ── get_digest ─────────────────────────────────────────────────────

/**
 * The mailbox's morning brief for the trailing 24 hours: arrivals, what
 * still needs a reply, the category breakdown, fired reminders and the
 * due items — the same digest the GET /digest route serves, built on
 * demand by the Durable Object. Read-only: nothing is stored, cached or
 * sent.
 */
export async function toolGetDigest(env: Env, mailboxId: string) {
	const stub = getMailboxStub(env, mailboxId);
	return stub.buildDigest(digestWindow(new Date()));
}

// ── get_storage ────────────────────────────────────────────────────

/**
 * The mailbox's storage footprint: SQLite database bytes, attachment
 * bytes/count, stored message count and the size of the mailbox's
 * settings JSON in R2 — the same storage object the GET /storage route
 * returns. Read-only: nothing is cached and no limit is enforced.
 */
export async function toolGetStorage(env: Env, mailboxId: string) {
	const stub = getMailboxStub(env, mailboxId);
	const usage = await stub.getStorageUsage();
	const settingsObject = await env.BUCKET.head(`mailboxes/${mailboxId}.json`);
	return { ...usage, mailbox_json_bytes: settingsObject?.size ?? 0 };
}

// ── export_email ───────────────────────────────────────────────────

/**
 * One stored message as a reconstructed RFC 5322 (EML) block, under the
 * `eml` key — the same text the GET /emails/:emailId/eml download
 * carries. The mailbox never stores the wire source, so the block is
 * rebuilt from the stored fields (workers/lib/eml-export.ts); an unknown
 * id is an error. Read-only. Nothing is sent or deleted.
 */
export async function toolExportEmail(
	env: Env,
	mailboxId: string,
	params: { emailId: string },
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = await stub.getEmail(params.emailId);
	if (!email) return { error: "Email not found" };
	return { eml: reconstructedMessage(email) };
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

	let sendResult: { messageId: string };
	try {
		sendResult = await sendEmail(env.EMAIL, {
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

	// Best-effort: the id the binding returned, on the Sent copy, so a bounce
	// can be matched to it (workers/lib/delivery-match.ts).
	await captureSendMessageId(stub, messageId, sendResult);

	return { status: "sent", messageId, message: `Reply sent to ${params.to}` };
}

// ── send_email ─────────────────────────────────────────────────────

/**
 * One inline file a send_email tool call carries: the base64 bytes and the
 * name/type the recipient sees. Field names match the MCP tool schema.
 */
export interface ToolSendEmailAttachment {
	filename: string;
	mimetype: string;
	content_base64: string;
}

/**
 * Caps a send_email tool call enforces on inline attachments, checked before
 * anything is written or sent: at most five files and 5 MiB of decoded bytes
 * in total. Deliberately tighter than the composer's own caps
 * (app/lib/attachments.ts) — a tool call carries its files through the
 * caller's context, so this surface stays bounded well below an upload.
 */
export const MAX_TOOL_ATTACHMENT_FILES = 5;
export const MAX_TOOL_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** The cap sentence the MCP tool schema and description both carry. */
export const TOOL_ATTACHMENT_CAP_NOTE = `up to ${MAX_TOOL_ATTACHMENT_FILES} files and ${formatFileSize(MAX_TOOL_ATTACHMENT_BYTES)} of decoded bytes in total`;

/**
 * The attachment cap error for one call, or null when it is within the caps.
 * Decoded lengths are the measure — a caller cannot get past the cap by
 * lying about a declared size — and every entry is decoded here, so
 * malformed base64 is refused before anything is sent.
 */
function toolAttachmentCapError(
	attachments: ToolSendEmailAttachment[],
): string | null {
	if (attachments.length > MAX_TOOL_ATTACHMENT_FILES) {
		return `Up to ${MAX_TOOL_ATTACHMENT_FILES} files can be attached to one email — ${attachments.length} were provided.`;
	}
	let totalBytes = 0;
	for (const attachment of attachments) {
		try {
			totalBytes += decodeBase64Bytes(attachment.content_base64).byteLength;
		} catch {
			return `Attachment "${attachment.filename}" is not valid base64.`;
		}
	}
	if (totalBytes > MAX_TOOL_ATTACHMENT_BYTES) {
		return `Attachments total ${formatFileSize(totalBytes)} — over the ${formatFileSize(MAX_TOOL_ATTACHMENT_BYTES)} limit.`;
	}
	return null;
}

export async function toolSendEmail(
	env: Env,
	mailboxId: string,
	params: {
		to: string;
		subject: string;
		bodyHtml: string;
		cc?: string | string[] | undefined;
		bcc?: string | string[] | undefined;
		attachments?: ToolSendEmailAttachment[] | undefined;
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

	// The attachment caps are checked before anything is written or sent, so
	// an over-cap call refuses whole instead of half-storing a message.
	const attachments = params.attachments ?? [];
	const attachmentCapError = toolAttachmentCapError(attachments);
	if (attachmentCapError) {
		return { error: attachmentCapError };
	}

	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error("Invalid mailbox email address");
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const sanitizedBody = await verifyDraft(env.AI, params.bodyHtml);
	if (!sanitizedBody) {
		return { error: "Draft verification failed — refusing to send unverified content. Please try again." };
	}

	// The binding's own attachment shape (SendEmailParams): the stored field
	// names the HTTP send route maps to.
	const bindingAttachments: NonNullable<SendEmailParams["attachments"]> = attachments.map(
		(attachment) => ({
			content: attachment.content_base64,
			filename: attachment.filename,
			type: attachment.mimetype,
			disposition: "attachment",
		}),
	);

	let sendResult: { messageId: string };
	try {
		sendResult = await resolveToolSendEmailSender(env).send({
			to: params.to,
			from: mailboxId,
			subject: params.subject,
			html: sanitizedBody,
			...(params.cc ? { cc: params.cc } : {}),
			...(params.bcc ? { bcc: params.bcc } : {}),
			...(bindingAttachments.length > 0
				? { attachments: bindingAttachments }
				: {}),
		});
	} catch (e) {
		console.error("Email send failed:", (e as Error).message);
		return { error: `Failed to send email: ${(e as Error).message}` };
	}

	// The Sent copy carries exactly what was sent: the same bytes under the
	// route's R2 key shape, then the attachment rows createEmail stores.
	const storedAttachments = await storeAttachments(
		env.BUCKET,
		messageId,
		attachments.map((attachment) => ({
			content: attachment.content_base64,
			filename: attachment.filename,
			type: attachment.mimetype,
			disposition: "attachment",
		})),
	);

	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			cc: params.cc ? (Array.isArray(params.cc) ? params.cc.join(", ") : params.cc).toLowerCase() : null,
			bcc: params.bcc ? (Array.isArray(params.bcc) ? params.bcc.join(", ") : params.bcc).toLowerCase() : null,
			date: new Date().toISOString(),
			body: sanitizedBody,
			in_reply_to: null,
			email_references: null,
			thread_id: messageId,
			message_id: outgoingMessageId,
		},
		storedAttachments,
	);

	// Best-effort: the id the binding returned, on the Sent copy, so a bounce
	// can be matched to it (workers/lib/delivery-match.ts).
	await captureSendMessageId(stub, messageId, sendResult);

	return { status: "sent", messageId, message: `Email sent to ${params.to}` };
}

// ── send_email sender seam ─────────────────────────────────────────

/** Anything that can deliver one send_email tool call. Tests inject a fake. */
export interface ToolSendEmailSender {
	send(params: SendEmailParams): Promise<{ messageId: string }>;
}

let toolSendEmailSenderFactoryOverride: (() => ToolSendEmailSender | null) | null = null;

/**
 * Test seam: replace the sender toolSendEmail uses. Passing null restores
 * the real Cloudflare Email Service binding path.
 */
export function setToolSendEmailSenderFactory(
	factory: (() => ToolSendEmailSender | null) | null,
): void {
	toolSendEmailSenderFactoryOverride = factory;
}

/** The real sender: the Cloudflare Email Service binding. */
export function createToolSendEmailSender(env: Env): ToolSendEmailSender {
	return { send: (params: SendEmailParams) => sendEmail(env.EMAIL, params) };
}

/** The sender toolSendEmail should use (honours the test override). */
export function resolveToolSendEmailSender(env: Env): ToolSendEmailSender {
	return toolSendEmailSenderFactoryOverride?.() ?? createToolSendEmailSender(env);
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

// ── delete_rule / preview_rule / reorder_rules ─────────────────────

/** DO methods the rule admin tools use, on top of the shared rule CRUD. */
type MailboxRuleAdminStub = MailboxRuleStub & {
	deleteRule: (id: string) => Promise<boolean>;
	reorderRules: (orderedIds: string[]) => Promise<MailRule[]>;
	previewRule: (draft: RulePreviewDraft) => Promise<RulePreviewResult>;
};

function mailboxRuleAdminStub(
	env: Env,
	mailboxId: string,
): MailboxRuleAdminStub {
	return getMailboxStub(env, mailboxId);
}

/**
 * The route's 400 message for a failed rule body parse (the route-local
 * `ruleErrorMessage` in workers/index.ts): `Invalid rule — <path>: <reason>`.
 * Kept here because that helper is not exported; the agent and MCP rule
 * tools answer the same strings the API does.
 */
function ruleToolErrorMessage(error: z.ZodError): string {
	const issue = error.issues[0];
	if (!issue) return "Invalid rule";
	const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
	return `Invalid rule — ${path}${issue.message}`;
}

/**
 * The folder-target validation the rule routes run before writing anything
 * (the route-local `unknownRuleFolder` in workers/index.ts): an action whose
 * move target names no folder answers `Unknown folder: <target>` here
 * instead of a rejected RPC surfacing as a 500. Returns the error message,
 * or null when the target is fine or absent.
 */
async function unknownRuleFolder(
	env: Env,
	mailboxId: string,
	actions: { move_to_folder?: string | undefined } | undefined,
): Promise<string | null> {
	const folder = actions?.move_to_folder;
	if (!folder) return null;
	const folders = await mailboxFoldersStub(env, mailboxId).getFolders();
	if (resolveRuleFolderId(folder, folders)) return null;
	return `Unknown folder: ${folder}`;
}

/**
 * Delete one deterministic rule by id. An unknown id answers the route's
 * `Rule not found`. Nothing is sent and no mail is changed; the rule's
 * firing statistics go with it.
 */
export async function toolDeleteRule(
	env: Env,
	mailboxId: string,
	params: { ruleId: string },
) {
	const deleted = await mailboxRuleAdminStub(env, mailboxId).deleteRule(
		params.ruleId,
	);
	if (!deleted) return { error: "Rule not found" };
	return { status: "deleted", ruleId: params.ruleId };
}

/**
 * Dry-run a rule draft: the same matcher the live engine uses runs over the
 * mailbox's stored mail and nothing is written, sent or fired. The draft is
 * the create_rule shape (name, match, actions) with actions optional, the
 * same body the POST /rules/preview route accepts.
 *
 * Validation mirrors the route: the draft must parse against
 * PreviewRuleSchema and a move target must name a real folder, with the
 * route's exact error strings. Outbound actions (forward_to and
 * auto_reply_text) are operator-only — the same strip toolCreateRule
 * applies keeps them out of everything this tool passes on, so a preview
 * can never validate sending automation for the agent.
 */
export async function toolPreviewRule(
	env: Env,
	mailboxId: string,
	draft: {
		name?: string | undefined;
		match: RuleMatchSpec;
		actions?: RuleActions | undefined;
	},
): Promise<RulePreviewResult | { error: string }> {
	// Route parity first: the same body schema the route parses, so an
	// unusable draft answers the route's 400 message.
	const parsed = PreviewRuleSchema.safeParse({
		name: draft.name,
		match: draft.match,
		actions: draft.actions,
	});
	if (!parsed.success) return { error: ruleToolErrorMessage(parsed.error) };

	// Then the create_rule action restriction and the route's folder check.
	const { actions } = stripAgentRuleActions(parsed.data.actions);
	const folderError = await unknownRuleFolder(env, mailboxId, actions);
	if (folderError) return { error: folderError };

	try {
		return await mailboxRuleAdminStub(env, mailboxId).previewRule({
			name: parsed.data.name,
			match: parsed.data.match,
		});
	} catch (e) {
		if (isRuleValidationError(e)) return { error: (e as Error).message };
		throw e;
	}
}

/**
 * Rewrite rule priorities so they follow the given id order (index 0
 * evaluates first), mirroring POST /rules/reorder. Unknown or duplicate ids
 * are ignored by the Durable Object, and rules missing from the list keep
 * their relative order after the listed ones. Returns the route's 400
 * message for an unusable id list, or the reordered list as stored.
 */
export async function toolReorderRules(
	env: Env,
	mailboxId: string,
	params: { ruleIds: string[] },
): Promise<{ mailboxId: string; rules: MailRule[] } | { error: string }> {
	const parsed = ReorderRulesSchema.safeParse({ ids: params.ruleIds });
	if (!parsed.success) return { error: ruleToolErrorMessage(parsed.error) };
	const rules = await mailboxRuleAdminStub(env, mailboxId).reorderRules(
		parsed.data.ids,
	);
	return { mailboxId, rules };
}
