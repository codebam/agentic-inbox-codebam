// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, and, or, asc, desc, sql, inArray, ne, isNotNull, isNull, lt, lte, gte, getTableColumns } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import { Folders } from "../../shared/folders";
import { SPAM_CATEGORY_ID } from "../../shared/categories";
import {
	hasActiveActions,
	hasActiveConditions,
	hasLocalRuleActions,
	localRuleActions,
	matchRule,
	normalizeRuleActions,
	normalizeRuleMatch,
	RuleValidationError,
	resolveRuleFolderId,
	ruleNeedsChange,
	MAX_RULE_NAME_LENGTH,
	MAX_RULE_PRIORITY,
	RULE_APPLY_LIMIT_DEFAULT,
	RULE_APPLY_LIMIT_MAX,
	RULE_PREVIEW_MAX_MATCHES,
	RULE_PREVIEW_SCAN_LIMIT,
	type MailRule,
	type RuleActions,
	type RuleApplyResult,
	type RuleDraft,
	type RuleEmail,
	type RuleLocalActions,
	type RuleMatchSpec,
	type RulePatch,
	type RulePreviewDraft,
	type RulePreviewMatch,
	type RulePreviewResult,
} from "../lib/rules";
import {
	isSenderPolicy,
	normalizeSenderAddress,
	SenderPolicyValidationError,
	type SenderPolicy,
	type SenderPolicyEntry,
} from "../lib/sender-policy";
import type { StorageUsage } from "../lib/quota";
import type { Env } from "../types";
import { applyMigrations, mailboxMigrations } from "./migrations";
import { findDuplicateEmailId, type CreateEmailResult } from "./dedupe";
import { likePatternsFor } from "../lib/like-terms";
import { attachmentR2Key } from "../lib/attachments";
import {
	DEFAULT_IMPORT_JOB_LIMIT,
	IMPORT_JOB_NOT_FOUND,
	IMPORT_MAX_MESSAGES_PER_TICK,
	IMPORT_MAX_SLICE_BYTES,
	IMPORT_SLICE_BYTES,
	MAX_IMPORT_JOB_LIST,
	MAX_IMPORT_MESSAGES,
	importJobRow,
	isImportJobActive,
	isMboxFramed,
	parseImportMessage,
	splitMboxSlice,
	type CreateImportJobInput,
	type ImportJobBatch,
	type ImportJobCancelResult,
	type ImportJobDbRow,
	type ImportJobRow,
	type ImportedMessage,
} from "../lib/mbox-import";
import { splitFtsTerms } from "../lib/fts-terms";
import {
	MAX_ATTACHMENT_TEXT_CHARS,
	MAX_ATTACHMENT_TEXT_ROWS,
	extractAttachmentText,
	type AttachmentTextInput,
} from "../lib/attachment-text";
import {
	contactDeltasForEmail,
	normalizeContactAddress,
	normalizeContactName,
	type ContactDelta,
	MAX_CONTACTS,
	MAX_CONTACT_SEARCH_LIMIT,
	DEFAULT_CONTACT_SEARCH_LIMIT,
} from "../lib/contacts";
import {
	normalizeTemplateBody,
	normalizeTemplateName,
	normalizeTemplateSubject,
	TemplateValidationError,
	MAX_TEMPLATES,
	type Template,
	type TemplateInput,
	type TemplatePatch,
} from "../lib/templates";
import {
	LabelValidationError,
	MAX_LABELS,
	normalizeLabelColor,
	normalizeLabelName,
	type Label,
	type LabelInput,
	type LabelPatch,
} from "../lib/labels";
import {
	isItemDueFilter,
	isItemKind,
	isItemStatus,
	ITEM_LIST_LIMIT_DEFAULT,
	ITEM_LIST_LIMIT_MAX,
	MAX_EXTRACTED_ITEMS,
	MAX_ITEM_DETAILS_LENGTH,
	MAX_ITEM_TITLE_LENGTH,
	type ExtractedItem,
	type ExtractedItemInput,
	type ItemListFilters,
	type ItemListPage,
	type ItemStatus,
} from "../lib/items";
import {
	generateMessageId,
	validateSender,
} from "../lib/email-helpers";
import type {
	CalendarInviteFields,
	CalendarInviteRow,
	CalendarResponse,
} from "../lib/calendar";
import { verifyDraft } from "../lib/ai";
import { resolveMailboxModels } from "../lib/mailbox-settings";
import { DEFAULT_MODELS } from "../../shared/models";
import { isSpamMarkedEmail } from "../../shared/spam";
import {
	DEFAULT_SCHEDULED_SEND_LIMIT,
	MAX_SCHEDULED_SENDS,
	SCHEDULED_SEND_NOT_FOUND,
	buildScheduledSendParams,
	parseScheduledSendPayload,
	resolveScheduledSendSender,
	scheduledSendRow,
	type ScheduledSendActionResult,
	type ScheduledSendDbRow,
	type ScheduledSendPayload,
	type ScheduledSendRow,
	type ScheduleSendInput,
} from "../lib/scheduled-sends";
import {
	captureSendMessageId,
	deliveryMatchWindow,
	pickDeliveryFallbackCandidate,
	type DeliveryMatchCandidate,
} from "../lib/delivery-match";
import {
	PENDING_UPLOAD_SWEEP_BATCH,
	resolveScheduledSendUploads,
	scheduledUploadInlineAttachments,
	scheduledUploadLinkedSection,
	scheduledUploadSentAttachments,
	scheduledUploadSentCopies,
	type CreatePendingUploadInput,
	type PendingUploadRow,
	type ResolvedScheduledUpload,
} from "../lib/pending-uploads";
import {
	DIGEST_CATEGORY_LIMIT,
	DIGEST_ITEM_LIMIT,
	DIGEST_NEEDS_REPLY_LIMIT,
	DIGEST_RECENT_LIMIT,
	DIGEST_REMINDER_LIMIT,
	MAX_DIGEST_DELIVERIES,
	type Digest,
	type DigestDeliveryResult,
	type DigestEmailRef,
} from "../lib/digest";
import {
	MAX_PUSH_SUBSCRIPTIONS,
	type PushSubscriptionInput,
	type PushSubscriptionRecord,
} from "../../shared/push";

/**
 * SQL expression to normalize email subjects by stripping common
 * reply/forward prefixes (Re:, Fwd:, FW:, AW:, WG:, Réf:, SV:).
 * Used for conversation grouping. Hardcoded to the `subject` column.
 */
const NORMALIZED_SUBJECT_SQL = `LOWER(TRIM(
	REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
		LOWER(subject),
		'aw: ', ''), 'wg: ', ''), 'réf: ', ''), 'sv: ', ''),
		're: ', ''), 'fwd: ', ''), 'fw: ', '')
))`;

/**
 * SQL predicate marking a spam-marked row, mirroring `getSpamEmails`: the
 * Spam folder, the built-in `spam` category, or a classifier audit trail
 * that recorded `is_spam: true`. Takes the table alias the predicate applies
 * to; the caller binds the spam folder name and category id as ?1 and ?2
 * (place them first among its parameters).
 */
function spamMarkedSql(alias: string): string {
	return `(${alias}.folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
					OR ${alias}.category = ?2
					OR (json_valid(${alias}.classification)
						AND json_extract(${alias}.classification, '$.is_spam') = 1))`;
}

/**
 * NULL-safe negation of `spamMarkedSql` for WHERE clauses: its
 * `json_valid(classification)` arm evaluates to NULL for the common case of
 * an unclassified row, and `NOT NULL` is NULL — which silently drops every
 * such row. The CASE collapses that arm to 0, so "not spam" keeps rows the
 * predicate cannot positively identify as spam.
 */
function notSpamSql(alias: string): string {
	return `(CASE WHEN ${spamMarkedSql(alias)} THEN 1 ELSE 0 END) = 0`;
}

/**
 * The list query's Sent/Draft exclusion (`folder_id != (SELECT id FROM
 * folders WHERE name = 'sent' LIMIT 1)`), written with the id fallback this
 * file already uses for folder lookups. The bare name lookup matches nothing
 * against the capitalized seeded folders ('Sent'), and a `!= NULL` comparison
 * is NULL — which quietly zeroes needs_reply inside the list query's CASE and
 * would drop every row from a WHERE clause — so the fallback keeps the
 * predicate's intent. `column` is the folder_id column or alias to test.
 */
function notSentSql(column: string): string {
	return `${column} != (SELECT id FROM folders WHERE name = 'sent' OR id = 'sent' LIMIT 1)`;
}

function notDraftSql(column: string): string {
	return `${column} != (SELECT id FROM folders WHERE name = 'draft' OR id = 'draft' LIMIT 1)`;
}

/**
 * The threaded conversation CTE the digest's needs-reply count and list
 * share. It mirrors the non-draft list query's conversation grouping and its
 * `needs_reply` predicate exactly (see getThreadedEmails): a conversation
 * needs a reply when its newest message is not in Sent or Draft and the
 * conversation contains at least one read message.
 *
 * `digest_candidates` holds the window arrivals with the conversation
 * aggregates that predicate reads; the callers filter `rn = 1` (newest in
 * the window per conversation) plus the predicate itself. Bindings: ?1 spam
 * folder name, ?2 spam category id, ?3 window from, ?4 window to.
 */
const DIGEST_NEEDS_REPLY_CTE = `WITH
	folder_emails AS (
		SELECT *,
			COALESCE(thread_id, id) as raw_thread_id,
			${NORMALIZED_SUBJECT_SQL} as normalized_subject
		FROM emails
	),
	thread_to_conversation AS (
		SELECT
			raw_thread_id,
			normalized_subject,
			CASE
				WHEN thread_id IS NOT NULL THEN raw_thread_id
				ELSE MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
			END as conversation_id
		FROM folder_emails
		GROUP BY raw_thread_id, normalized_subject, thread_id
	),
	all_emails_with_conversation AS (
		SELECT
			e.*,
			COALESCE(tc.conversation_id, COALESCE(e.thread_id, e.id)) as conversation_id
		FROM emails e
		LEFT JOIN thread_to_conversation tc
			ON COALESCE(e.thread_id, e.id) = tc.raw_thread_id
	),
	conversation_stats AS (
		SELECT
			conversation_id,
			SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) as thread_read_count
		FROM all_emails_with_conversation
		GROUP BY conversation_id
	),
	latest_message_per_conversation AS (
		SELECT
			conversation_id,
			folder_id,
			ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY date DESC, id DESC) as rn
		FROM all_emails_with_conversation
	),
	digest_candidates AS (
		SELECT
			a.*,
			cs.thread_read_count,
			lmc.folder_id as latest_folder_id,
			ROW_NUMBER() OVER (PARTITION BY a.conversation_id ORDER BY a.date DESC, a.id DESC) as rn
		FROM all_emails_with_conversation a
		JOIN conversation_stats cs ON cs.conversation_id = a.conversation_id
		LEFT JOIN latest_message_per_conversation lmc
			ON lmc.conversation_id = a.conversation_id AND lmc.rn = 1
		WHERE a.date >= ?3 AND a.date <= ?4
			AND ${notSentSql("a.folder_id")}
			AND ${notDraftSql("a.folder_id")}
			AND ${notSpamSql("a")}
	)`;

/**
 * The list-query predicate itself, over `digest_candidates`: newest window
 * arrival of a conversation that still expects a reply.
 */
const DIGEST_NEEDS_REPLY_WHERE = `WHERE rn = 1
		AND ${notSentSql("latest_folder_id")}
		AND ${notDraftSql("latest_folder_id")}
		AND thread_read_count > 0`;


const ALLOWED_SORT_COLUMNS = [
	"id",
	"subject",
	"sender",
	"recipient",
	"date",
	"read",
	"starred",
] as const;

type SortColumn = (typeof ALLOWED_SORT_COLUMNS)[number];

/**
 * Map SortColumn string names to Drizzle column references for safe
 * ORDER BY construction (no string interpolation into SQL).
 */
const SORT_COLUMN_MAP = {
	id: schema.emails.id,
	subject: schema.emails.subject,
	sender: schema.emails.sender,
	recipient: schema.emails.recipient,
	date: schema.emails.date,
	read: schema.emails.read,
	starred: schema.emails.starred,
} satisfies Record<SortColumn, typeof schema.emails[keyof typeof schema.emails]>;

/**
 * Columns every write that moves a message between folders must set.
 *
 * Entering Trash stamps `trashed_at` — the clock the retention sweep reads —
 * and every other folder clears it. Centralised here so no move path can
 * leave the stamp behind: a stale stamp would let the sweep purge a message
 * that was restored, and a missing one would make Trash immortal.
 */
export function folderMoveFields(
	folderId: string,
	now: string = new Date().toISOString(),
): { folder_id: string; trashed_at: string | null } {
	return {
		folder_id: folderId,
		trashed_at: folderId === Folders.TRASH ? now : null,
	};
}

/**
 * Case-insensitive prefix condition for the contacts search: the stored
 * value, lowercased, starts with the term (already lowercased). Written with
 * substr/eq rather than LIKE so a long search term cannot trip Durable
 * Object SQLite's LIKE pattern-length cap, and so `%`/`_` in the term stay
 * literal characters instead of wildcards.
 */
function contactPrefixCondition(
	column: typeof schema.contacts.email | typeof schema.contacts.name,
	term: string,
): SQL {
	return sql`substr(LOWER(${column}), 1, length(${term})) = ${term}`;
}

interface SearchFilterOptions {
	query: string;
	folder?: string;
	category?: string;
	/** Exact, case-insensitive match on one label name the message carries. */
	label?: string;
	from?: string;
	to?: string;
	subject?: string;
	date_start?: string;
	date_end?: string;
	is_read?: boolean;
	is_starred?: boolean;
	has_attachment?: boolean;
}

/** The priority streams a folder list can be split into. */
type EmailStream = "priority" | "other";

interface GetEmailsOptions {
	folder?: string | undefined;
	thread_id?: string | undefined;
	category?: string | undefined;
	page?: number | undefined;
	limit?: number | undefined;
	stream?: EmailStream | undefined;
	sortColumn?: SortColumn;
	sortDirection?: "ASC" | "DESC" | undefined;
}

interface EmailData {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	/** Display name from the sender's From header, when the message carries one. */
	sender_name?: string | null;
	envelope_recipient?: string | null;
	cc?: string | null;
	bcc?: string | null;
	reply_to?: string | null;
	date: string;
	body: string;
	/** The message's text/plain alternative, when the sender included one. */
	body_text?: string | null;
	read?: boolean | undefined;
	starred?: boolean | undefined;
	in_reply_to?: string | null | undefined;
	email_references?: string | null;
	thread_id?: string | null;
	message_id?: string | null | undefined;
	raw_headers?: string | null;
	category?: string | null;
	category_confidence?: number | null;
	classification?: string | null;
	/** Rule that routed or acted on this message, when a rule fired. */
	matched_rule_id?: string | null;
	matched_rule_name?: string | null;
	/** Raw List-Unsubscribe header from the sender; NULL when it set none. */
	list_unsubscribe?: string | null;
	/** Raw List-Unsubscribe-Post header (RFC 8058 marker); NULL when absent. */
	list_unsubscribe_post?: string | null;
}

interface AttachmentData {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
	/** Public download link token; set only for linked attachments (migration 28). */
	link_token?: string | null;
	/** ISO 8601 instant that link stops working; NULL when there is no link. */
	link_expires_at?: string | null;
}

/** Most recent agent actions kept per mailbox; older rows are pruned on write. */
export const MAX_AGENT_ACTIONS = 500;

/**
 * A mutating agent/MCP tool call to record. Metadata only — ids, flags,
 * folder names, a subject and a thread id; `args`/`beforeState`/`afterState`
 * are JSON strings the caller has already bounded (see
 * workers/lib/agent-actions.ts).
 */
export interface AgentActionInput {
	id: string;
	source: "agent" | "mcp";
	tool: string;
	emailId?: string | null;
	emailSubject?: string | null;
	threadId?: string | null;
	args?: string | null;
	beforeState?: string | null;
	afterState?: string | null;
	undoable: boolean;
	createdAt?: string;
}

/** One stored audit row; `undoable` reads back as a boolean. */
export interface AgentActionRow {
	id: string;
	source: string;
	tool: string;
	email_id: string | null;
	email_subject: string | null;
	thread_id: string | null;
	args: string | null;
	before_state: string | null;
	after_state: string | null;
	undoable: boolean;
	undone_at: string | null;
	created_at: string;
}

/** The three reversible fields undo restores from `before_state`. */
interface AgentActionState {
	read?: unknown;
	starred?: unknown;
	folder_id?: unknown;
}

/**
 * The threaded list's needs-reply expression, kept in one place: the
 * conversation's newest message anywhere is not in Sent or Draft and the
 * conversation holds at least one read message. The row's own `needs_reply`
 * field and the priority stream membership both read this fragment, so the
 * two can never drift.
 */
const NEEDS_REPLY_SQL = `CASE WHEN lmc.folder_id != (SELECT id FROM folders WHERE name = 'sent' OR id = 'sent' LIMIT 1)
	AND lmc.folder_id != (SELECT id FROM folders WHERE name = 'draft' OR id = 'draft' LIMIT 1)
	AND cs.thread_read_count > 0
	THEN 1 ELSE 0 END`;

/**
 * Priority stream membership, over a relation that carries the newest
 * in-folder message's `read`/`starred` flags and its computed `needs_reply`:
 * unread, starred, or awaiting a reply. `other` is its complement. The list
 * filter and the stream counts share this fragment.
 */
const PRIORITY_STREAM_SQL = "(read = 0 OR starred = 1 OR needs_reply = 1)";

/**
 * The WHERE fragment that narrows a streamed relation to one stream, or ""
 * when no stream was asked for. `indent` is the tab depth of the caller's
 * SQL block, so the fragment lands on its own line.
 */
function streamFilterSql(stream: EmailStream | undefined, indent: string): string {
	if (stream === "priority") return `\n${indent}WHERE ${PRIORITY_STREAM_SQL}`;
	if (stream === "other") return `\n${indent}WHERE NOT ${PRIORITY_STREAM_SQL}`;
	return "";
}

/**
 * The conversation derivation the threaded list and the stream counts share:
 * `latest_in_folder` holds the folder's newest message per conversation,
 * `conversation_stats` the per-conversation aggregates (`thread_read_count`,
 * `has_draft`) and `latest_message_per_conversation` the newest message of
 * each conversation anywhere in the mailbox. One row per conversation once
 * `rn = 1` is applied. Bindings: ?1 is the folder (name or id); whatever
 * `categoryClause` adds follows the caller's numbering.
 */
function threadedConversationCtes(categoryClause: string): string {
	return `WITH
	folder_emails AS (
		SELECT *,
			COALESCE(thread_id, id) as raw_thread_id,
			${NORMALIZED_SUBJECT_SQL} as normalized_subject
		FROM emails
		WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
		${categoryClause}
	),
	thread_to_conversation AS (
		SELECT
			raw_thread_id,
			normalized_subject,
			CASE
				WHEN thread_id IS NOT NULL THEN raw_thread_id
				ELSE MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
			END as conversation_id
		FROM folder_emails
		GROUP BY raw_thread_id, normalized_subject, thread_id
	),
	all_emails_with_conversation AS (
		SELECT
			e.*,
			COALESCE(tc.conversation_id, COALESCE(e.thread_id, e.id)) as conversation_id
		FROM emails e
		LEFT JOIN thread_to_conversation tc
			ON COALESCE(e.thread_id, e.id) = tc.raw_thread_id
	),
	conversation_stats AS (
		SELECT
			conversation_id,
			COUNT(*) as thread_count,
			SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
			SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) as thread_read_count,
			GROUP_CONCAT(DISTINCT sender) as participants,
			SUM(CASE WHEN folder_id = (SELECT id FROM folders WHERE name = 'draft' OR id = 'draft' LIMIT 1) THEN 1 ELSE 0 END) as has_draft
		FROM all_emails_with_conversation
		WHERE conversation_id IN (
			SELECT DISTINCT conversation_id FROM all_emails_with_conversation
			WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
		)
		GROUP BY conversation_id
	),
	latest_message_per_conversation AS (
		SELECT
			conversation_id,
			folder_id,
			ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY date DESC) as rn
		FROM all_emails_with_conversation
	),
	latest_in_folder AS (
		SELECT
			fe.*,
			COALESCE(tc.conversation_id, fe.raw_thread_id) as conversation_id,
			ROW_NUMBER() OVER (
				PARTITION BY COALESCE(tc.conversation_id, fe.raw_thread_id)
				ORDER BY fe.date DESC
			) as rn
		FROM folder_emails fe
		LEFT JOIN thread_to_conversation tc
			ON fe.raw_thread_id = tc.raw_thread_id
	)
	`;
}

/**
 * Result of attaching or detaching a label on one email: the email's labels
 * after the change, or which side of the pair was missing, so the routes can
 * answer a 404 that names it.
 */
export type LabelEmailResult =
	| { ok: true; labels: Label[] }
	| { ok: false; error: "Email not found" | "Label not found" };


export class MailboxDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	db: ReturnType<typeof drizzle>;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.db = drizzle(this.ctx.storage, { schema });
		applyMigrations(this.ctx.storage.sql, mailboxMigrations, this.ctx.storage);
	}

	// ── Email CRUD (Drizzle) ───────────────────────────────────────

	/**
	 * The column set every list row carries: the list-card fields plus the
	 * snooze/reminder state, so a row can render its badge from any listing
	 * (folder, Snoozed, Reminders). `getEmail` returns the whole row instead.
	 */
	#listRowSelection() {
		return {
			id: schema.emails.id,
			subject: schema.emails.subject,
			sender: schema.emails.sender,
			recipient: schema.emails.recipient,
			envelope_recipient: schema.emails.envelope_recipient,
			cc: schema.emails.cc,
			bcc: schema.emails.bcc,
			date: schema.emails.date,
			read: schema.emails.read,
			starred: schema.emails.starred,
			in_reply_to: schema.emails.in_reply_to,
			email_references: schema.emails.email_references,
			thread_id: schema.emails.thread_id,
			folder_id: schema.emails.folder_id,
			category: schema.emails.category,
			category_confidence: schema.emails.category_confidence,
			snooze_until: schema.emails.snooze_until,
			snoozed_from_folder: schema.emails.snoozed_from_folder,
			remind_at: schema.emails.remind_at,
			reminded_at: schema.emails.reminded_at,
			snippet: sql<string>`SUBSTR(${schema.emails.body}, 1, 300)`,
		};
	}

	getEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			thread_id,
			category,
			page = 1,
			limit: rawLimit = 25,
			sortColumn: rawSortColumn = "date",
			sortDirection = "DESC",
		} = options;

		// Cap pagination limit to prevent unbounded queries
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		const sortColumn: SortColumn = ALLOWED_SORT_COLUMNS.includes(rawSortColumn)
			? rawSortColumn
			: "date";

		const offset = (page - 1) * limit;

		const conditions: SQL[] = [];
		if (folder) {
			conditions.push(
				sql`${schema.emails.folder_id} = (SELECT id FROM folders WHERE name = ${folder} OR id = ${folder} LIMIT 1)`,
			);
		}
		if (thread_id) {
			conditions.push(eq(schema.emails.thread_id, thread_id));
		}
		if (category) {
			conditions.push(eq(schema.emails.category, category));
		}

		const orderCol = SORT_COLUMN_MAP[sortColumn];
		const orderDir = sortDirection === "ASC" ? asc(orderCol) : desc(orderCol);

		const result = this.db
			.select(this.#listRowSelection())
			.from(schema.emails)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(orderDir)
			.limit(limit)
			.offset(offset)
			.all();

		return result.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
		}));
	}

	/**
	 * Count total emails matching the given filters (for pagination).
	 */
	/**
	 * Return emails marked as spam: the Spam folder, the `spam` category, or
	 * rows the classifier recorded with `is_spam: true` in the audit JSON.
	 * Used by the bulk spam-delete tool so classification-only rows are not
	 * missed when a mailbox had `moveToSpam` disabled.
	 */
	getSpamEmails(options: { page?: number; limit?: number } = {}) {
		const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
		const offset = ((options.page ?? 1) - 1) * limit;
		return [
			...this.ctx.storage.sql.exec(
				`SELECT id, subject, sender, folder_id, category, classification
				 FROM emails
				 WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				    OR category = ?2
				    OR (json_valid(classification)
				        AND json_extract(classification, '$.is_spam') = 1)
				 ORDER BY date DESC, id DESC
				 LIMIT ?3 OFFSET ?4`,
				Folders.SPAM,
				SPAM_CATEGORY_ID,
				limit,
				offset,
			),
		] as {
			id: string;
			subject: string | null;
			sender: string | null;
			folder_id: string | null;
			category: string | null;
			classification: string | null;
		}[];
	}

	countEmails(
		options: {
			folder?: string | undefined;
			thread_id?: string | undefined;
			category?: string | undefined;
		} = {},
	) {
		const { folder, thread_id, category } = options;
		const conditions: string[] = [];
		const params: (string | number)[] = [];

		if (folder) {
			conditions.push(
				"folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)",
			);
			params.push(folder);
		}

		if (thread_id) {
			conditions.push(`thread_id = ?${params.length + 1}`);
			params.push(thread_id);
		}

		if (category) {
			conditions.push(`category = ?${params.length + 1}`);
			params.push(category);
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) as total FROM emails ${where}`,
				...params,
			),
		][0] as { total: number } | undefined;

		return row?.total ?? 0;
	}

	// ── Threaded queries (raw SQL — too complex for Drizzle's builder) ──

	getThreadedEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			category,
			stream,
			page = 1,
			limit: rawLimit = 25,
		} = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		if (!folder) {
			// Fallback to regular getEmails if no folder specified
			return this.getEmails(options);
		}

		const offset = (page - 1) * limit;

		// Thread grouping strategy:
		// For DRAFT folder: group by in_reply_to (the email being replied to).
		//   This ensures reply-drafts to different emails stay separate, even if
		//   they share a thread_id or subject. New drafts (no in_reply_to) each
		//   get their own group via their unique id.
		// For other folders:
		//   1. Primary: group by thread_id (from email threading headers)
		//   2. Fallback: group by normalized subject (strips Re:/Fwd:/FW: prefixes)
		//      for legacy emails that lack threading headers (thread_id IS NULL).
		const isDraftFolder = folder === Folders.DRAFT;
		// Draft groups are keyed by the draft they reply to rather than by
		// conversation and carry no conversation stats, so `stream` does not
		// apply to them: the draft list is always the whole list.
		const categoryClause = category ? "AND category = ?4" : "";
		const categoryArgs: (string | number)[] = category
			? [folder, limit, offset, category]
			: [folder, limit, offset];

		if (isDraftFolder) {
			const result = this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT *,
						COALESCE(in_reply_to, id) as draft_group_key
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
					${categoryClause}
				),
				draft_stats AS (
					SELECT
						draft_group_key,
						COUNT(*) as thread_count,
						SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
						GROUP_CONCAT(DISTINCT sender) as participants
					FROM folder_emails
					GROUP BY draft_group_key
				),
				latest_per_group AS (
					SELECT
						fe.*,
						ROW_NUMBER() OVER (
							PARTITION BY fe.draft_group_key
							ORDER BY fe.date DESC
						) as rn
					FROM folder_emails fe
				)
				SELECT
					lp.id, lp.subject, lp.sender, lp.recipient, lp.envelope_recipient, lp.date,
					lp.read, lp.starred, lp.thread_id, lp.folder_id,
					lp.in_reply_to, lp.email_references,
					lp.category, lp.category_confidence,
					SUBSTR(lp.body, 1, 300) as snippet,
					ds.thread_count, ds.thread_unread_count, ds.participants
				FROM latest_per_group lp
				JOIN draft_stats ds ON lp.draft_group_key = ds.draft_group_key
				WHERE lp.rn = 1
				ORDER BY lp.date DESC
				LIMIT ?2 OFFSET ?3`,
				...categoryArgs
			);

			const rows = [...result] as unknown as ThreadedEmailRow[];
			return rows.map((row) => ({
				...row,
				read: !!row.read,
				starred: !!row.starred,
				thread_count: row.thread_count || 1,
				thread_unread_count: row.thread_unread_count || 0,
				participants: row.participants || row.sender,
			}));
		}

		// Non-draft folders: full threading logic
		const streamFilter = streamFilterSql(stream, "\t\t\t");
		const result = this.ctx.storage.sql.exec(
			`${threadedConversationCtes(categoryClause)},
			threaded AS (
				SELECT
					lif.id, lif.subject, lif.sender, lif.recipient, lif.envelope_recipient, lif.date,
					lif.read, lif.starred, lif.thread_id, lif.folder_id,
					lif.in_reply_to, lif.email_references,
					lif.category, lif.category_confidence,
					SUBSTR(lif.body, 1, 300) as snippet,
					cs.thread_count, cs.thread_unread_count, cs.participants,
					${NEEDS_REPLY_SQL} as needs_reply,
					CASE WHEN cs.has_draft > 0 THEN 1 ELSE 0 END as has_draft
				FROM latest_in_folder lif
				JOIN conversation_stats cs ON lif.conversation_id = cs.conversation_id
				LEFT JOIN latest_message_per_conversation lmc
					ON lmc.conversation_id = lif.conversation_id AND lmc.rn = 1
				WHERE lif.rn = 1
			)
			SELECT * FROM threaded${streamFilter}
			ORDER BY date DESC
			LIMIT ?2 OFFSET ?3`,
			...categoryArgs
		);

		const rows = [...result] as unknown as ThreadedEmailRow[];
		return rows.map((row) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
			thread_count: row.thread_count || 1,
			thread_unread_count: row.thread_unread_count || 0,
			participants: row.participants || row.sender,
			needs_reply: !!row.needs_reply,
			has_draft: !!row.has_draft,
		}));
	}

	/**
	 * Count threaded conversations in a folder (for pagination).
	 * Returns the number of conversation groups, not individual emails. With
	 * a `stream`, counts the conversations that stream holds — the same rows
	 * getThreadedEmails returns for it.
	 */
	countThreadedEmails(folder: string, category?: string, stream?: EmailStream) {
		const isDraftFolder = folder === Folders.DRAFT;
		const categoryClause = category ? "AND category = ?2" : "";
		const countArgs: (string | number)[] = category
			? [folder, category]
			: [folder];

		if (isDraftFolder) {
			// Draft groups are keyed by the draft they reply to rather than by
			// conversation and carry no conversation stats, so a stream does
			// not apply: the count is always the whole draft list.
			const row = [
				...this.ctx.storage.sql.exec(
					`SELECT COUNT(DISTINCT COALESCE(in_reply_to, id)) as total
					 FROM emails
					 WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
					 ${categoryClause}`,
					...countArgs,
				),
			][0] as { total: number } | undefined;
			return row?.total ?? 0;
		}

		const streamFilter = streamFilterSql(stream, "\t\t\t\t");
		const row = [
			...this.ctx.storage.sql.exec(
				`${threadedConversationCtes(categoryClause)},
				conversation_rows AS (
					SELECT
						lif.read, lif.starred,
						${NEEDS_REPLY_SQL} as needs_reply
					FROM latest_in_folder lif
					JOIN conversation_stats cs ON lif.conversation_id = cs.conversation_id
					LEFT JOIN latest_message_per_conversation lmc
						ON lmc.conversation_id = lif.conversation_id AND lmc.rn = 1
					WHERE lif.rn = 1
				)
				SELECT COUNT(*) as total FROM conversation_rows${streamFilter}`,
				...countArgs,
			),
		][0] as { total: number } | undefined;
		return row?.total ?? 0;
	}

	/**
	 * Priority/other conversation counts for a folder in one query. The two
	 * sum to countThreadedEmails(folder, category): both derive the same
	 * conversations and read the same priority predicate.
	 */
	countThreadedStreams(folder: string, category?: string): { priority: number; other: number } {
		const isDraftFolder = folder === Folders.DRAFT;
		const categoryClause = category ? "AND category = ?2" : "";
		const countArgs: (string | number)[] = category
			? [folder, category]
			: [folder];

		if (isDraftFolder) {
			// Streams do not apply to draft groups (see countThreadedEmails).
			return {
				priority: 0,
				other: this.countThreadedEmails(folder, category),
			};
		}

		const row = [
			...this.ctx.storage.sql.exec(
				`${threadedConversationCtes(categoryClause)},
				conversation_rows AS (
					SELECT
						lif.read, lif.starred,
						${NEEDS_REPLY_SQL} as needs_reply
					FROM latest_in_folder lif
					JOIN conversation_stats cs ON lif.conversation_id = cs.conversation_id
					LEFT JOIN latest_message_per_conversation lmc
						ON lmc.conversation_id = lif.conversation_id AND lmc.rn = 1
					WHERE lif.rn = 1
				)
				SELECT
					SUM(CASE WHEN ${PRIORITY_STREAM_SQL} THEN 1 ELSE 0 END) as priority,
					SUM(CASE WHEN NOT ${PRIORITY_STREAM_SQL} THEN 1 ELSE 0 END) as other
				FROM conversation_rows`,
				...countArgs,
			),
		][0] as { priority: number | null; other: number | null } | undefined;
		return { priority: row?.priority ?? 0, other: row?.other ?? 0 };
	}

	// ── Single email operations (Drizzle) ──────────────────────────

	getEmail(id: string) {
		const email = this.db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select()
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		return {
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: emailAttachments,
		};
	}

	/**
	 * Fetch all emails in a thread with full bodies and attachments in
	 * two queries (one for emails, one for attachments) instead of
	 * N+1 individual getEmail calls.
	 */
	getThreadEmails(threadId: string) {
		const emailRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM emails WHERE thread_id = ?1 ORDER BY date ASC`,
				threadId,
			),
		] as unknown as EmailRow[];

		if (emailRows.length === 0) return [];

		const emailIds = emailRows.map((e) => e.id);

		// Batch-fetch all attachments for the thread in a single query
		const placeholders = emailIds.map((_, i) => `?${i + 1}`).join(",");
		const attachmentRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM attachments WHERE email_id IN (${placeholders})`,
				...emailIds,
			),
		] as unknown as AttachmentRow[];

		// Group attachments by email_id
		const attachmentsByEmail = new Map<string, AttachmentRow[]>();
		for (const att of attachmentRows) {
			const list = attachmentsByEmail.get(att.email_id) || [];
			list.push(att);
			attachmentsByEmail.set(att.email_id, list);
		}

		return emailRows.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: attachmentsByEmail.get(email.id) || [],
		}));
	}

	updateEmail(
		id: string,
		{ read, starred }: { read?: boolean | undefined; starred?: boolean | undefined },
	) {
		const data: { read?: number; starred?: number } = {};
		if (read !== undefined) {
			data.read = read ? 1 : 0;
		}
		if (starred !== undefined) {
			data.starred = starred ? 1 : 0;
		}

		if (Object.keys(data).length === 0) {
			return this.getEmail(id);
		}

		this.db
			.update(schema.emails)
			.set(data)
			.where(eq(schema.emails.id, id))
			.run();

		return this.getEmail(id);
	}

	markThreadRead(threadId: string) {
		this.ctx.storage.sql.exec(
			`UPDATE emails SET read = 1 WHERE thread_id = ? AND read = 0`,
			threadId,
		);
		return { threadId, markedRead: true };
	}

	deleteEmail(id: string) {
		const email = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select({
				id: schema.attachments.id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		// The message's label assignments go with it — deleted explicitly
		// here and in every other delete path, so no join row can outlive the
		// message regardless of foreign-key enforcement.
		this.db
			.delete(schema.emailLabels)
			.where(eq(schema.emailLabels.email_id, id))
			.run();

		// The extracted attachment text (migration 36) goes with the message
		// for the same reason: no text may outlive its attachment. The FTS
		// triggers drop the index postings with the rows.
		this.db
			.delete(schema.attachmentText)
			.where(eq(schema.attachmentText.email_id, id))
			.run();

		this.db
			.delete(schema.emails)
			.where(eq(schema.emails.id, id))
			.run();

		return emailAttachments;
	}

	/**
	 * Bounce/DSN bookkeeping (workers/index.ts receiveEmail): record the
	 * delivery outcome a delivery-status notification reports for one of
	 * this mailbox's Sent messages. Matches the report's original id against
	 * the stored `message_id` first, then the binding-returned
	 * `send_message_id` (migration 32), and finally — only when exactly one
	 * Sent copy in a bounded window matches on normalized subject and
	 * recipient — that copy (workers/lib/delivery-match.ts). Ambiguity is a
	 * no-op, never a guess. The folders table stores display names, so the
	 * lookup uses the name-or-id fallback; the newest matching row wins. A
	 * report with no original id, or one that matches nothing, is a silent
	 * no-op (false): the DSN itself is stored as ordinary mail either way.
	 */
	applyDeliveryReport(report: {
		originalMessageId: string | null;
		status: "failed" | "delayed" | "delivered";
		detail: string | null;
		/** The report's Final-Recipient, used by the bounded fallback. */
		finalRecipient?: string | null;
		/** The original message's Subject from the report, used by the fallback. */
		originalSubject?: string | null;
	}): boolean {
		const originalMessageId = report.originalMessageId?.trim();
		if (!originalMessageId) return false;

		const match =
			this.#sentCopyByStoredId("message_id", originalMessageId) ??
			this.#sentCopyByStoredId("send_message_id", originalMessageId) ??
			this.#deliveryFallbackMatch(report);
		if (!match) return false;

		this.ctx.storage.sql.exec(
			`UPDATE emails SET delivery_status = ?, delivery_detail = ?, delivery_updated_at = ? WHERE id = ?`,
			report.status,
			report.detail,
			new Date().toISOString(),
			match.id,
		);
		return true;
	}

	/**
	 * The newest Sent copy whose stored id column equals the report's
	 * original id. The column name is one of two literals chosen here, never
	 * caller input.
	 */
	#sentCopyByStoredId(
		column: "message_id" | "send_message_id",
		value: string,
	): { id: string } | null {
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT id FROM emails
				 WHERE ${column} = ?
				   AND folder_id = (SELECT id FROM folders WHERE name = 'sent' OR id = 'sent' LIMIT 1)
				 ORDER BY date DESC, id DESC
				 LIMIT 1`,
				value,
			),
		][0] as { id: string } | undefined;
		return row ?? null;
	}

	/**
	 * The bounded fallback: the one Sent copy in the delivery-match window
	 * whose normalized subject and recipient both match the report
	 * (workers/lib/delivery-match.ts). No candidates, or several, mean no
	 * match — a guess would record the outcome on the wrong message.
	 */
	#deliveryFallbackMatch(report: {
		finalRecipient?: string | null;
		originalSubject?: string | null;
	}): { id: string } | null {
		const window = deliveryMatchWindow(new Date());
		const candidates = [
			...this.ctx.storage.sql.exec(
				`SELECT id, subject, recipient FROM emails
				 WHERE folder_id = (SELECT id FROM folders WHERE name = 'sent' OR id = 'sent' LIMIT 1)
				   AND date >= ?1 AND date <= ?2`,
				window.from,
				window.to,
			),
		] as unknown as DeliveryMatchCandidate[];
		const match = pickDeliveryFallbackCandidate(candidates, {
			subject: report.originalSubject ?? null,
			recipient: report.finalRecipient ?? null,
		});
		return match ? { id: match.id } : null;
	}

	/**
	 * Store the id the email binding returned for a Sent copy (migration
	 * 32). Called best-effort right after every send (workers/lib/delivery-match.ts
	 * captureSendMessageId); false when the row is gone. A delivery report
	 * that names this id is matched even though the platform — not this
	 * mailbox — set the wire Message-ID.
	 */
	setSendMessageId(id: string, sendMessageId: string): boolean {
		if (!sendMessageId) return false;
		const cursor = this.ctx.storage.sql.exec(
			`UPDATE emails SET send_message_id = ?1 WHERE id = ?2`,
			sendMessageId,
			id,
		);
		return cursor.rowsWritten > 0;
	}

	/**
	 * Calendar invite bookkeeping (workers/index.ts receiveEmail): store the
	 * iMIP metadata one inbound message carried, one row per email — the
	 * email_id index is unique, so a second ingest for the same email
	 * rewrites the metadata in place and keeps the row's id, its created_at
	 * and the operator's recorded response. Every field is already bounded
	 * by the parser (workers/lib/calendar.ts), and the message itself is
	 * stored as ordinary mail either way.
	 */
	recordCalendarInvite(
		invite: CalendarInviteFields & { email_id: string },
	): CalendarInviteRow | null {
		this.ctx.storage.sql.exec(
			`INSERT INTO calendar_invites
				(id, email_id, uid, method, summary, organizer, location, start_at, end_at, attendee, response, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11)
			 ON CONFLICT(email_id) DO UPDATE SET
				uid = excluded.uid,
				method = excluded.method,
				summary = excluded.summary,
				organizer = excluded.organizer,
				location = excluded.location,
				start_at = excluded.start_at,
				end_at = excluded.end_at,
				attendee = excluded.attendee`,
			crypto.randomUUID(),
			invite.email_id,
			invite.uid,
			invite.method,
			invite.summary,
			invite.organizer,
			invite.location,
			invite.start_at,
			invite.end_at,
			invite.attendee,
			new Date().toISOString(),
		);
		return this.getCalendarInvite(invite.email_id);
	}


	/**
	 * The invite stored for one message, or null when that message carried
	 * no calendar part. Metadata only, at most one row per email.
	 */
	getCalendarInvite(emailId: string): CalendarInviteRow | null {
		return (
			this.db
				.select()
				.from(schema.calendarInvites)
				.where(eq(schema.calendarInvites.email_id, emailId))
				.get() ?? null
		);
	}


	/**
	 * Record the operator's answer to an invite (the respond route in
	 * workers/index.ts) and return the updated row — null when the message
	 * has no invite at all. The route only reaches this for a REQUEST invite
	 * whose iMIP reply was built, so the row's `response` is what the panel
	 * shows next to the invitation.
	 */
	setCalendarInviteResponse(
		emailId: string,
		response: CalendarResponse,
	): CalendarInviteRow | null {
		this.ctx.storage.sql.exec(
			`UPDATE calendar_invites SET response = ? WHERE email_id = ?`,
			response,
			emailId,
		);
		return this.getCalendarInvite(emailId);
	}

	getAttachment(id: string) {
		return (
			this.db
				.select()
				.from(schema.attachments)
				.where(eq(schema.attachments.id, id))
				.get() ?? null
		);
	}

	/**
	 * Expire public attachment links (migration 28_add_attachment_links) whose
	 * expiry has passed: hand back the rows whose R2 blobs the caller must
	 * delete, and clear the two link columns so a second sweep run finds
	 * nothing. A Durable Object cannot touch R2, so the worker deletes the
	 * objects — exactly like the empty-trash route and the Trash retention
	 * sweep. `limit` bounds one round trip; the daily sweep loops until the
	 * mailbox has no expired links left (or hits its own cap).
	 */
	expireAttachmentLinks(
		now: string,
		limit: number,
	): { id: string; email_id: string; filename: string }[] {
		const expired = this.db
			.select({
				id: schema.attachments.id,
				email_id: schema.attachments.email_id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.where(
				and(
					isNotNull(schema.attachments.link_token),
					isNotNull(schema.attachments.link_expires_at),
					lte(schema.attachments.link_expires_at, now),
				),
			)
			.limit(limit)
			.all();

		if (expired.length === 0) return [];

		this.db
			.update(schema.attachments)
			.set({ link_token: null, link_expires_at: null })
			.where(inArray(schema.attachments.id, expired.map((att) => att.id)))
			.run();

		return expired;
	}

	// ── Folders (Drizzle) ──────────────────────────────────────────

	getFolders() {
		const result = this.db
			.select({
				id: schema.folders.id,
				name: schema.folders.name,
				unreadCount: sql<number>`COALESCE(SUM(CASE WHEN ${schema.emails.read} = 0 THEN 1 ELSE 0 END), 0)`.mapWith(Number),
			})
			.from(schema.folders)
			.leftJoin(schema.emails, eq(schema.emails.folder_id, schema.folders.id))
			.groupBy(schema.folders.id, schema.folders.name)
			.all();
		return result;
	}

	createFolder(id: string, name: string, is_deletable: number = 1) {
		try {
			const result = this.db
				.insert(schema.folders)
				.values({ id, name, is_deletable })
				.returning({ id: schema.folders.id, name: schema.folders.name })
				.get();
			return { ...result, unreadCount: 0 };
		} catch (e: unknown) {
			if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
				return null;
			}
			throw e;
		}
	}

	updateFolder(id: string, name: string) {
		const result = this.db
			.update(schema.folders)
			.set({ name })
			.where(eq(schema.folders.id, id))
			.returning({ id: schema.folders.id, name: schema.folders.name })
			.get();
		return result;
	}

	deleteFolder(id: string) {
		const folder = this.db
			.select({ is_deletable: schema.folders.is_deletable })
			.from(schema.folders)
			.where(eq(schema.folders.id, id))
			.get();

		if (!folder || folder.is_deletable === 0) {
			return false;
		}

		this.db
			.delete(schema.folders)
			.where(eq(schema.folders.id, id))
			.run();

		return true;
	}

	moveEmail(id: string, folderId: string) {
		const folder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(eq(schema.folders.id, folderId))
			.get();

		if (!folder) return false;

		this.db
			.update(schema.emails)
			.set(folderMoveFields(folderId))
			.where(eq(schema.emails.id, id))
			.run();

		return true;
	}

	// ── Bulk actions (list-view multi-select) ──────────────────────

	/**
	 * Apply read/starred flags to multiple emails in one statement.
	 *
	 * When `threadIds` is supplied, a read/unread change also extends to every
	 * message in those conversations — threaded list rows represent a whole
	 * conversation, so toggling only the latest message would leave the row's
	 * unread badge out of sync.
	 */
	bulkUpdateEmails(
		ids: string[],
		{ read, starred }: { read?: boolean; starred?: boolean },
		threadIds: string[] = [],
	) {
		const data: { read?: number; starred?: number } = {};
		if (read !== undefined) data.read = read ? 1 : 0;
		if (starred !== undefined) data.starred = starred ? 1 : 0;

		if (ids.length > 0 && Object.keys(data).length > 0) {
			this.db
				.update(schema.emails)
				.set(data)
				.where(inArray(schema.emails.id, ids))
				.run();
		}

		if (read !== undefined && threadIds.length > 0) {
			this.db
				.update(schema.emails)
				.set({ read: read ? 1 : 0 })
				.where(inArray(schema.emails.thread_id, threadIds))
				.run();
		}

		return { updated: ids.length };
	}

	/** Move multiple emails into an existing folder. Returns false when the folder is unknown. */
	bulkMoveEmails(ids: string[], folderId: string) {
		if (ids.length === 0) return false;

		const folder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(eq(schema.folders.id, folderId))
			.get();

		if (!folder) return false;

		this.db
			.update(schema.emails)
			.set(folderMoveFields(folderId))
			.where(inArray(schema.emails.id, ids))
			.run();

		return true;
	}

	/**
	 * Delete multiple emails. Returns any attachments that belonged to them so
	 * the Worker can remove the corresponding R2 objects (attachments rows
	 * cascade away with the email).
	 */
	bulkDeleteEmails(ids: string[]) {
		if (ids.length === 0) return [];

		const emailAttachments = this.db
			.select({
				id: schema.attachments.id,
				email_id: schema.attachments.email_id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.where(inArray(schema.attachments.email_id, ids))
			.all();

		this.db
			.delete(schema.emailLabels)
			.where(inArray(schema.emailLabels.email_id, ids))
			.run();

		// The extracted attachment text goes with the messages (see
		// deleteEmail); the FTS triggers drop the postings with the rows.
		this.db
			.delete(schema.attachmentText)
			.where(inArray(schema.attachmentText.email_id, ids))
			.run();

		this.db
			.delete(schema.emails)
			.where(inArray(schema.emails.id, ids))
			.run();

		return emailAttachments;
	}

	// ── Trash semantics ────────────────────────────────────────────


	/**
	 * Move emails into the Trash folder.
	 *
	 * Messages already in Trash are left untouched, so deleting an email that
	 * is already trashed never silently purges it. Returns the ids that moved
	 * and the ids that were already in Trash — the partition the API needs to
	 * apply the per-message "delete from Trash = delete forever" rule.
	 */
	trashEmails(ids: string[]) {
		if (ids.length === 0) return { trashed: [], alreadyInTrash: [] };


		// Snapshot the partition before moving anything: once the UPDATE runs,
		// freshly-moved messages would look like they were already in Trash.
		const alreadyInTrash = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(
				and(
					inArray(schema.emails.id, ids),
					eq(schema.emails.folder_id, Folders.TRASH),
				),
			)
			.all()
			.map((row) => row.id);


		const trashed = this.db
			.update(schema.emails)
			.set(folderMoveFields(Folders.TRASH))
			.where(
				and(
					inArray(schema.emails.id, ids),
					ne(schema.emails.folder_id, Folders.TRASH),
				),
			)
			.returning({ id: schema.emails.id })
			.all()
			.map((row) => row.id);


		return { trashed, alreadyInTrash };
	}


	/** Move messages from Trash back to the Inbox. Returns the ids that moved. */
	restoreEmails(ids: string[]) {
		if (ids.length === 0) return [];


		return this.db
			.update(schema.emails)
			.set(folderMoveFields(Folders.INBOX))
			.where(
				and(
					inArray(schema.emails.id, ids),
					eq(schema.emails.folder_id, Folders.TRASH),
				),
			)
			.returning({ id: schema.emails.id })
			.all()
			.map((row) => row.id);
	}


	/**
	 * Permanently delete every message in the Trash folder.
	 *
	 * Returns the number of purged messages plus the attachment rows that
	 * belonged to them, so the Worker can remove the corresponding R2 objects
	 * (attachment rows cascade away with their email).
	 */
	emptyTrash() {
		const trashRows = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.folder_id, Folders.TRASH))
			.all();


		if (trashRows.length === 0) return { purged: 0, attachments: [] };


		const ids = trashRows.map((row) => row.id);


		const emailAttachments = this.db
			.select({
				id: schema.attachments.id,
				email_id: schema.attachments.email_id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.where(inArray(schema.attachments.email_id, ids))
			.all();


		this.db
			.delete(schema.emailLabels)
			.where(inArray(schema.emailLabels.email_id, ids))
			.run();


		// The extracted attachment text goes with the messages (see
		// deleteEmail); the FTS triggers drop the postings with the rows.
		this.db
			.delete(schema.attachmentText)
			.where(inArray(schema.attachmentText.email_id, ids))
			.run();


		this.db
			.delete(schema.emails)
			.where(inArray(schema.emails.id, ids))
			.run();


		return { purged: ids.length, attachments: emailAttachments };
	}


	/**
	 * Delete everything this mailbox owns and hand back its attachment rows so
	 * the caller can remove the matching R2 blobs (a DO cannot touch R2).
	 *
	 * Storage is emptied outright and the migration list re-applied, so the
	 * mailbox comes back pristine. The re-apply matters: the constructor runs
	 * once per DO instance, so without it the still-live instance would keep
	 * serving tables that no longer exist.
	 */
	async purgeAll(): Promise<{
		emails: number;
		attachments: { id: string; email_id: string; filename: string }[];
	}> {
		const emailCount = this.db
			.select({ count: sql<number>`COUNT(*)` })
			.from(schema.emails)
			.get();

		const emailAttachments = this.db
			.select({
				id: schema.attachments.id,
				email_id: schema.attachments.email_id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.all();

		await this.ctx.storage.deleteAll();
		applyMigrations(this.ctx.storage.sql, mailboxMigrations, this.ctx.storage);

		return { emails: emailCount?.count ?? 0, attachments: emailAttachments };
	}


	/**
	 * Permanently delete Trash messages that entered Trash before `cutoffIso`.
	 *
	 * Only rows with an explicit `trashed_at` older than the cutoff are
	 * eligible: rows trashed before retention existed (NULL) are left for the
	 * manual "Empty trash" action, and anything restored or re-trashed carries
	 * a fresh stamp. Mirrors emptyTrash: returns the number of purged messages
	 * plus their attachment rows so the Worker can delete the R2 objects.
	 */
	purgeTrashedBefore(cutoffIso: string) {
		const expiredRows = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(
				and(
					eq(schema.emails.folder_id, Folders.TRASH),
					isNotNull(schema.emails.trashed_at),
					lt(schema.emails.trashed_at, cutoffIso),
				),
			)
			.all();


		if (expiredRows.length === 0) return { purged: 0, attachments: [] };


		const ids = expiredRows.map((row) => row.id);


		const emailAttachments = this.db
			.select({
				id: schema.attachments.id,
				email_id: schema.attachments.email_id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.where(inArray(schema.attachments.email_id, ids))
			.all();


		this.db
			.delete(schema.emailLabels)
			.where(inArray(schema.emailLabels.email_id, ids))
			.run();


		// The extracted attachment text goes with the messages (see
		// deleteEmail); the FTS triggers drop the postings with the rows.
		this.db
			.delete(schema.attachmentText)
			.where(inArray(schema.attachmentText.email_id, ids))
			.run();


		this.db
			.delete(schema.emails)
			.where(inArray(schema.emails.id, ids))
			.run();


		return { purged: ids.length, attachments: emailAttachments };
	}


	// ── Snooze & reminders (alarm-driven) ──────────────────────────

	/**
	 * Messages currently snoozed, earliest wake time first. Rows carry the
	 * same fields as a folder listing so the UI can render them like any
	 * other message.
	 */
	getSnoozed() {
		const rows = this.db
			.select(this.#listRowSelection())
			.from(schema.emails)
			.where(isNotNull(schema.emails.snooze_until))
			.orderBy(asc(schema.emails.snooze_until), asc(schema.emails.id))
			.all();

		return rows.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
		}));
	}

	/**
	 * Follow-ups that already fired, newest message first. A pending reminder
	 * is not listed here: until it fires it is just `remind_at` on its own
	 * row, so a cancelled reminder can never leave a stale entry behind.
	 */
	getReminders() {
		const rows = this.db
			.select(this.#listRowSelection())
			.from(schema.emails)
			.where(isNotNull(schema.emails.reminded_at))
			.orderBy(desc(schema.emails.date), desc(schema.emails.id))
			.all();

		return rows.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
		}));
	}

	/**
	 * Park a message in the Snoozed folder until `until` (ISO 8601 UTC) and
	 * arm the alarm for that instant. The folder it came from is remembered
	 * so waking restores it; re-snoozing a message that is already snoozed
	 * keeps the original origin instead of recording Snoozed as the place to
	 * return to. Returns the updated row, or null when the id is unknown.
	 */
	async setSnooze(id: string, until: string) {
		const current = this.db
			.select({
				folder_id: schema.emails.folder_id,
				snoozed_from_folder: schema.emails.snoozed_from_folder,
			})
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!current) return null;

		const origin =
			current.folder_id === Folders.SNOOZED
				? current.snoozed_from_folder ?? Folders.INBOX
				: current.folder_id;

		this.db
			.update(schema.emails)
			.set({
				snooze_until: until,
				snoozed_from_folder: origin,
				...folderMoveFields(Folders.SNOOZED),
			})
			.where(eq(schema.emails.id, id))
			.run();

		await this.#armAlarm();
		return this.getEmail(id);
	}

	/**
	 * Cancel a snooze: clear both snooze columns and put the message back
	 * where it came from (the Inbox when that is unknown or gone). Returns
	 * the updated row, or null when the id is unknown.
	 */
	clearSnooze(id: string) {
		const current = this.db
			.select({
				folder_id: schema.emails.folder_id,
				snooze_until: schema.emails.snooze_until,
				snoozed_from_folder: schema.emails.snoozed_from_folder,
			})
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!current) return null;

		// A message that was never snoozed has nothing to restore: leave its
		// folder alone so an unsnooze call cannot yank it out of Archive,
		// Spam or Trash.
		if (current.folder_id === Folders.SNOOZED || current.snooze_until !== null) {
			this.#restoreSnoozed(id, current.snoozed_from_folder);
		}

		return this.getEmail(id);
	}

	/**
	 * Set (or re-set) a follow-up reminder at `at` (ISO 8601 UTC) and arm the
	 * alarm. The message stays where it is until the reminder fires. Returns
	 * the updated row, or null when the id is unknown.
	 */
	async setReminder(id: string, at: string) {
		const email = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		this.db
			.update(schema.emails)
			.set({ remind_at: at, reminded_at: null })
			.where(eq(schema.emails.id, id))
			.run();

		await this.#armAlarm();
		return this.getEmail(id);
	}

	/**
	 * Cancel a follow-up reminder, pending or already fired. Returns the
	 * updated row, or null when the id is unknown.
	 */
	clearReminder(id: string) {
		const email = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		this.db
			.update(schema.emails)
			.set({ remind_at: null, reminded_at: null })
			.where(eq(schema.emails.id, id))
			.run();

		return this.getEmail(id);
	}

	/**
	 * Wake every snooze whose time has come: put the message back in the
	 * folder it was snoozed from, clear the snooze columns and leave the read
	 * state untouched. Returns how many messages woke. Idempotent — the
	 * columns are cleared as part of the wake, so a second pass finds nothing.
	 */
	wakeDueSnoozes(now: string) {
		const due = this.db
			.select({
				id: schema.emails.id,
				snoozed_from_folder: schema.emails.snoozed_from_folder,
			})
			.from(schema.emails)
			.where(
				and(
					isNotNull(schema.emails.snooze_until),
					lte(schema.emails.snooze_until, now),
				),
			)
			.all();

		if (due.length === 0) return 0;

		this.ctx.storage.transactionSync(() => {
			for (const email of due) {
				this.#restoreSnoozed(email.id, email.snoozed_from_folder, now);
			}
		});

		return due.length;
	}

	/**
	 * Fire every due follow-up. A reminder only fires when its thread still
	 * expects a reply — the newest message in it is not in Sent — in which
	 * case the message is pulled back to the Inbox and stamped with
	 * `reminded_at`. A thread that already has a reply loses the reminder
	 * silently, so answering before the follow-up lands never produces a
	 * stale nudge. Returns how many reminders fired. Idempotent: `remind_at`
	 * is cleared either way, so a second pass finds nothing due.
	 */
	fireDueReminders(now: string) {
		const due = this.db
			.select({
				id: schema.emails.id,
				thread_id: schema.emails.thread_id,
				folder_id: schema.emails.folder_id,
			})
			.from(schema.emails)
			.where(
				and(
					isNotNull(schema.emails.remind_at),
					lte(schema.emails.remind_at, now),
					isNull(schema.emails.reminded_at),
				),
			)
			.all();

		if (due.length === 0) return 0;

		let fired = 0;
		this.ctx.storage.transactionSync(() => {
			for (const email of due) {
				if (!this.#threadNeedsReply(email)) {
					this.ctx.storage.sql.exec(
						`UPDATE emails SET remind_at = NULL WHERE id = ?1`,
						email.id,
					);
					continue;
				}
				this.ctx.storage.sql.exec(
					`UPDATE emails SET remind_at = NULL, reminded_at = ?1, folder_id = ?2, trashed_at = NULL WHERE id = ?3`,
					now,
					Folders.INBOX,
					email.id,
				);
				fired += 1;
			}
		});

		return fired;
	}

	// ── Scheduled sends (queue outbound mail for later) ────────────

	/**
	 * Queue one outbound message for a future instant: insert a pending row,
	 * stamp `created_at` and arm the alarm for `send_at`. `payload` is the
	 * bounded JSON of the send parameters (workers/lib/scheduled-sends.ts) —
	 * never attachment bytes. Nothing is sent here: the alarm (or the cron
	 * sweep) fires it when it comes due. Returns the stored row.
	 */
	async scheduleSend(input: ScheduleSendInput): Promise<ScheduledSendRow> {
		const id = crypto.randomUUID();
		this.db
			.insert(schema.scheduledSends)
			.values({
				id,
				draft_id: input.draft_id ?? null,
				send_at: input.sendAt,
				status: "pending",
				payload: input.payload,
				attempts: 0,
				last_error: null,
				created_at: new Date().toISOString(),
				sent_at: null,
			})
			.run();

		// Keep only the newest terminal rows; pending rows are never pruned
		// (a queued send must survive any number of later ones). Ties on
		// created_at fall back to rowid (insertion order) so the prune is
		// deterministic.
		this.ctx.storage.sql.exec(
			`DELETE FROM scheduled_sends
			 WHERE status != 'pending'
			   AND id NOT IN (
				SELECT id FROM scheduled_sends
				WHERE status != 'pending'
				ORDER BY created_at DESC, rowid DESC
				LIMIT ?1
			   )`,
			MAX_SCHEDULED_SENDS,
		);

		await this.#armAlarm();

		const stored = this.#scheduledSendById(id);
		if (!stored) {
			throw new Error("scheduleSend: the inserted row could not be read back.");
		}
		return stored;
	}

	/**
	 * The mailbox's scheduled sends, newest first. Terminal rows (sent,
	 * failed, cancelled) are listed too, so the operator can see what
	 * happened to a queued send. `limit` defaults to 50 and is capped at
	 * MAX_SCHEDULED_SENDS.
	 */
	listScheduledSends(limit = DEFAULT_SCHEDULED_SEND_LIMIT): ScheduledSendRow[] {
		const capped = Math.min(Math.max(Math.trunc(limit), 1), MAX_SCHEDULED_SENDS);
		return this.db
			.select()
			.from(schema.scheduledSends)
			.orderBy(desc(schema.scheduledSends.created_at), sql`rowid DESC`)
			.limit(capped)
			.all()
			.map((row) => scheduledSendRow(row));
	}

	/** How many scheduled sends this mailbox currently stores. */
	countScheduledSends(): number {
		const row = this.db
			.select({ total: sql<number>`COUNT(*)`.mapWith(Number) })
			.from(schema.scheduledSends)
			.get();
		return row?.total ?? 0;
	}

	/**
	 * Cancel a pending scheduled send: the row becomes `cancelled` and will
	 * never fire. Nothing is sent and nothing is deleted — the row stays for
	 * the operator to see. Returns `{ ok: true, send }` with the updated row,
	 * or `{ ok: false, error }` when the id is unknown or the row is no
	 * longer pending.
	 */
	cancelScheduledSend(id: string): ScheduledSendActionResult {
		const row = this.#scheduledSendDbRow(id);
		if (!row) return { ok: false as const, error: SCHEDULED_SEND_NOT_FOUND };
		if (row.status !== "pending") {
			return {
				ok: false as const,
				error: `Only a pending send can be cancelled; this one is ${row.status}.`,
			};
		}

		this.ctx.storage.sql.exec(
			`UPDATE scheduled_sends SET status = 'cancelled' WHERE id = ?1`,
			id,
		);

		const cancelled = this.#scheduledSendById(id);
		if (!cancelled) return { ok: false as const, error: SCHEDULED_SEND_NOT_FOUND };
		return { ok: true as const, send: cancelled };
	}

	/**
	 * Re-arm a failed scheduled send: the row goes back to `pending` with
	 * `send_at = now` (due immediately) and the alarm is armed, so the next
	 * alarm fires it again. The payload is untouched — a retry resends what
	 * was queued — and `attempts` keeps counting. Returns `{ ok: true, send }`
	 * with the updated row, or `{ ok: false, error }` when the id is unknown
	 * or the row is not failed.
	 */
	async retryScheduledSend(id: string): Promise<ScheduledSendActionResult> {
		const row = this.#scheduledSendDbRow(id);
		if (!row) return { ok: false as const, error: SCHEDULED_SEND_NOT_FOUND };
		if (row.status !== "failed") {
			return {
				ok: false as const,
				error: `Only a failed send can be retried; this one is ${row.status}.`,
			};
		}

		this.ctx.storage.sql.exec(
			`UPDATE scheduled_sends
			 SET status = 'pending', send_at = ?1, last_error = NULL
			 WHERE id = ?2`,
			new Date().toISOString(),
			id,
		);
		await this.#armAlarm();

		const pending = this.#scheduledSendById(id);
		if (!pending) return { ok: false as const, error: SCHEDULED_SEND_NOT_FOUND };
		return { ok: true as const, send: pending };
	}

	/**
	 * Fire every pending scheduled send whose time has come: rebuild the
	 * stored parameters, re-run the guards the immediate send path runs
	 * (sender validation, the mailbox rate limit, the spam-marked reply
	 * target check, `verifyDraft`), deliver through the EMAIL binding and
	 * store the Sent copy exactly like the immediate path does. A row that
	 * fails a guard or the send itself is recorded `failed` with its reason
	 * in `last_error` and an incremented `attempts` — its payload is never
	 * touched, and nothing is silently dropped. Returns how many due rows
	 * were fired (delivered or recorded failed). Idempotent: every processed
	 * row leaves `pending`, so a second run finds nothing due.
	 */
	async fireDueSends(now: string): Promise<number> {
		const due = this.db
			.select()
			.from(schema.scheduledSends)
			.where(
				and(
					eq(schema.scheduledSends.status, "pending"),
					lte(schema.scheduledSends.send_at, now),
				),
			)
			.orderBy(
				asc(schema.scheduledSends.send_at),
				asc(schema.scheduledSends.created_at),
				sql`rowid ASC`,
			)
			.all();

		let fired = 0;
		for (const row of due) {
			await this.#fireScheduledSend(row, now);
			fired += 1;
		}
		return fired;
	}

	/**
	 * Fire one due row. Never throws: every failure — an unreadable payload,
	 * a failed guard, a missing EMAIL binding, a rejected send — is recorded
	 * on the row as `failed` with its reason, so the operator can see it and
	 * retry it. A row that goes out is marked `sent` with `sent_at`.
	 */
	async #fireScheduledSend(row: ScheduledSendDbRow, now: string): Promise<void> {
		const markFailed = (reason: string): void => {
			// The row carries this reason too; the log is what a tail sees live.
			console.error(`Scheduled send ${row.id} failed: ${reason}`);
			this.ctx.storage.sql.exec(
				`UPDATE scheduled_sends
				 SET status = 'failed', attempts = attempts + 1, last_error = ?1
				 WHERE id = ?2`,
				reason,
				row.id,
			);
		};

		const payload = parseScheduledSendPayload(row.payload);
		if (!payload) {
			markFailed("The stored send payload could not be read; nothing was sent.");
			return;
		}

		// The mailbox's own address is the DO's name (see requireMailbox).
		const mailboxId = this.ctx.id.name;
		if (!mailboxId) {
			markFailed("This mailbox has no address, so the sender cannot be validated.");
			return;
		}

		// Guard 1: the sender must be the mailbox itself, exactly like the
		// immediate send route.
		let toStr: string;
		let fromEmail: string;
		let fromDomain: string;
		try {
			({ toStr, fromEmail, fromDomain } = validateSender(
				payload.to,
				payload.from,
				mailboxId,
			));
		} catch (e) {
			markFailed((e as Error).message);
			return;
		}

		// Guard 2: the mailbox send rate limit.
		const rateLimitError = this.checkSendRateLimit();
		if (rateLimitError) {
			markFailed(rateLimitError);
			return;
		}

		// Guard 3: a reply to a spam-marked message — or into a spam-marked
		// thread — is refused, mirroring the draft route's spam guard.
		const replyTarget = payload.in_reply_to ?? null;
		const threadTarget = payload.thread_id ?? null;
		if (replyTarget) {
			const original = this.getEmail(replyTarget);
			if (!original) {
				markFailed("Original email not found");
				return;
			}
			if (isSpamMarkedEmail(original)) {
				markFailed(
					"Cannot send a reply to an email marked as spam. Move the original out of Spam or remove the spam category first.",
				);
				return;
			}
		} else if (threadTarget) {
			const threadEmails = this.getThreadEmails(threadTarget);
			if (threadEmails.some((email) => isSpamMarkedEmail(email))) {
				markFailed(
					"Cannot send a reply into a spam-marked thread. Move the original out of Spam or remove the spam category first.",
				);
				return;
			}
		}

		// Guard 4: verifyDraft, exactly like the agent/MCP send paths — the
		// body that goes out is the verified one. The mailbox's resolved
		// draft-verifier model is used here too, so a Settings override is
		// honoured on the queued path the same as on every other send path.
		let verifyModel: string = DEFAULT_MODELS.draftVerify;
		try {
			verifyModel = (await resolveMailboxModels(this.env, mailboxId)).draftVerify;
		} catch {
			/* settings unreadable: keep the built-in default */
		}
		let html = payload.html;
		let text = payload.text;
		const hadContent = (html ?? text ?? "").trim().length > 0;
		// Only the part that is actually sent is verified, and only that part
		// has to survive: the composer sends html plus a derived plain-text
		// alternative, and an empty alternative (an image-only or blank body
		// has no plain text) is not a verification failure. An empty part that
		// is not the body must never refuse the send.
		let verifiedBody: string | undefined;
		if (html !== undefined) {
			html = await verifyDraft(this.env.AI, html, verifyModel);
			verifiedBody = html;
		} else if (text !== undefined) {
			text = await verifyDraft(this.env.AI, text, verifyModel);
			verifiedBody = text;
		}
		if (verifiedBody === undefined) {
			markFailed("The stored send has no body; nothing was sent.");
			return;
		}
		if (verifiedBody === "") {
			// An empty result for a body that had content means the verifier
			// could not run — verifyDraft returns "" when the AI call throws —
			// so say that instead of the generic refusal.
			markFailed(
				hadContent
					? "Draft verification failed — the verifier could not run (the AI call failed), so nothing was sent. Retry, or set a different draft-verifier model in Settings."
					: "Draft verification failed — refusing to send unverified content. Please try again.",
			);
			return;
		}

		// Deliver through the EMAIL binding (or the injected test seam).
		const sender = resolveScheduledSendSender(this.env);
		if (!sender) {
			markFailed("no EMAIL binding configured");
			return;
		}

		const verified: ScheduledSendPayload = { ...payload };
		if (html !== undefined) verified.html = html;
		if (text !== undefined) verified.text = text;
		const params = buildScheduledSendParams(verified);
		// The queued files, resolved to bytes now — immediately before the
		// send call — so a message never goes out without them. The bytes
		// live in R2 and the row records what they are; one id that is
		// missing, expired or already consumed fails the row here instead.
		const uploadIds = payload.upload_ids ?? [];
		let uploads: ResolvedScheduledUpload[] = [];
		if (uploadIds.length > 0) {
			const resolved = await resolveScheduledSendUploads(
				this.env.BUCKET,
				(id) => this.#pendingUploadById(id),
				uploadIds,
			);
			if (!resolved.ok) {
				markFailed(resolved.error);
				return;
			}
			uploads = resolved.uploads;
			// Files at or above the link threshold follow the send route's
			// linked rule unchanged: they never travel in the message. Their
			// bytes stay in R2 behind a fresh download link and the body
			// gains the link section, exactly as the immediate path builds
			// it (buildLinkedAttachmentSection / buildLinkedAttachmentText).
			if (uploads.some((upload) => upload.link)) {
				const section = scheduledUploadLinkedSection(uploads, mailboxId);
				if (params.html !== undefined) params.html = `${params.html}${section.html}`;
				if (params.text !== undefined) params.text = `${params.text}${section.text}`;
			}
			const inline = scheduledUploadInlineAttachments(uploads);
			if (inline.length > 0) params.attachments = inline;
		}

		let sent: { messageId: string };
		try {
			// Logged before the call, so a send that never returns shows up
			// as a "sending" line with no outcome after it.
			console.log(`Scheduled send ${row.id}: sending to ${toStr}`);
			sent = await sender.send(params);
		} catch (e) {
			markFailed(`Send failed: ${(e as Error).message}`);
			return;
		}
		console.log(`Scheduled send ${row.id}: delivered (binding id ${sent.messageId})`);
		// The message is out, so every queued file is consumed. Stamped
		// before the Sent copy below, so the daily sweep cannot delete a row
		// whose bytes are still being copied into that copy.
		for (const upload of uploads) {
			this.markPendingUploadConsumed(upload.row.id);
		}

		// Store the Sent copy exactly as the immediate path does. Best-effort
		// on purpose: the message has already gone out, so a storage failure
		// must not flip the row to `failed` and let a retry send it twice.
		const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
		try {
			// The queued files land in the Sent copy exactly like an
			// immediate send's: each one's bytes are copied to the attachment
			// key the download routes read, before the row that names them.
			for (const copy of scheduledUploadSentCopies(uploads, messageId)) {
				await this.env.BUCKET.put(copy.key, copy.bytes);
			}
			this.createEmail(
				Folders.SENT,
				{
					id: messageId,
					subject: payload.subject,
					sender: fromEmail,
					recipient: toStr,
					cc: payload.cc
						? (Array.isArray(payload.cc) ? payload.cc.join(", ") : payload.cc).toLowerCase()
						: null,
					bcc: payload.bcc
						? (Array.isArray(payload.bcc) ? payload.bcc.join(", ") : payload.bcc).toLowerCase()
						: null,
					date: new Date().toISOString(),
					body: params.html || params.text || "",
					in_reply_to: payload.in_reply_to ?? null,
					email_references: payload.references
						? JSON.stringify(payload.references)
						: null,
					thread_id: payload.thread_id || payload.in_reply_to || messageId,
					message_id: outgoingMessageId,
					raw_headers: JSON.stringify([
						{
							key: "from",
							value:
								typeof payload.from === "string"
									? payload.from
									: `${payload.from.name} <${payload.from.email}>`,
						},
						{
							key: "to",
							value: Array.isArray(payload.to) ? payload.to.join(", ") : payload.to,
						},
						...(payload.cc
							? [
									{
										key: "cc",
										value: Array.isArray(payload.cc)
											? payload.cc.join(", ")
											: payload.cc,
									},
								]
							: []),
						...(payload.bcc
							? [
									{
										key: "bcc",
										value: Array.isArray(payload.bcc)
											? payload.bcc.join(", ")
											: payload.bcc,
									},
								]
							: []),
						{ key: "subject", value: payload.subject },
						{ key: "date", value: new Date().toISOString() },
						{ key: "message-id", value: `<${outgoingMessageId}>` },
					]),
				},
				scheduledUploadSentAttachments(uploads, messageId),
			);
		} catch (e) {
			console.error(
				`Storing the Sent copy of scheduled send ${row.id} failed:`,
				(e as Error).message,
			);
		}

		// Best-effort: the id the binding returned, on the copy that just went
		// in, so a bounce can be matched to it (workers/lib/delivery-match.ts).
		await captureSendMessageId(this, messageId, sent);

		this.ctx.storage.sql.exec(
			`UPDATE scheduled_sends SET status = 'sent', sent_at = ?1, last_error = NULL WHERE id = ?2`,
			now,
			row.id,
		);

		// Drop each consumed upload's row and its object: the files have
		// gone out with the message and nothing references them any more.
		// Best-effort — the send has already succeeded, so a cleanup failure
		// must not flip the row to `failed`, and the daily sweep is the
		// backstop for anything left behind.
		for (const upload of uploads) {
			try {
				await this.env.BUCKET.delete(upload.row.r2_key);
			} catch (e) {
				console.error(
					`Deleting the bytes of upload ${upload.row.id} failed:`,
					(e as Error).message,
				);
			}
			this.deletePendingUpload(upload.row.id);
		}
	}

	/** One stored row of the queue, or null when the id is unknown. */
	#scheduledSendDbRow(id: string): ScheduledSendDbRow | null {
		return (
			this.db
				.select()
				.from(schema.scheduledSends)
				.where(eq(schema.scheduledSends.id, id))
				.get() ?? null
		);
	}

	/** One stored row in the API shape, or null when the id is unknown. */
	#scheduledSendById(id: string): ScheduledSendRow | null {
		const row = this.#scheduledSendDbRow(id);
		return row ? scheduledSendRow(row) : null;
	}

	/**
	 * Durable Object alarm: drain everything that is due — snoozes first,
	 * then reminders, scheduled sends and staged imports — and re-arm for
	 * whatever is still pending. Idempotent: a duplicate or early run finds
	 * nothing due and leaves the alarm unset when there is nothing left to
	 * wait for.
	 */
	override async alarm(): Promise<void> {
		const now = new Date().toISOString();
		const woken = this.wakeDueSnoozes(now);
		const reminded = this.fireDueReminders(now);
		const fired = await this.fireDueSends(now);
		// A staged import drains in bounded batches here, beside the other
		// due work; a job with bytes left re-arms for immediately.
		const imported = await this.#drainImportJobs();
		// One line per wake: what this alarm did, and what it re-armed for.
		// Without it the fire path is silent and a tail shows nothing at all.
		console.log(
			`MailboxDO alarm ${this.ctx.id.name ?? "?"} at ${now}: ` +
				`${woken} snooze(s), ${reminded} reminder(s), ${fired} send(s), ${imported} import message(s) fired; ` +
				`next due ${this.#nextDueAtMs() ?? "none"}`,
		);
		await this.#armAlarm();
	}

	/**
	 * Arm the Durable Object alarm for the earliest pending snooze, reminder
	 * or scheduled send.
	 *
	 * Only ever moves the alarm EARLIER: an alarm already set for a sooner
	 * instant is left alone (it re-arms for whatever is still pending when it
	 * fires) and a later one is pulled forward. Together with the idempotent
	 * alarm handler this makes every wake path self-healing — a stale alarm
	 * that fires early finds nothing due and simply re-arms.
	 */
	async #armAlarm(): Promise<void> {
		const next = this.#nextDueAtMs();
		if (next === null) return;
		const current = await this.ctx.storage.getAlarm();
		if (current !== null && current <= next) return;
		await this.ctx.storage.setAlarm(next);
	}

	/**
	 * Epoch-ms of the earliest pending due time — the soonest of a snooze, a
	 * reminder and a scheduled send — or null when nothing is scheduled. A
	 * pending or running import job is due right now: its drain runs in
	 * bounded batches and re-arms immediately for the next one. A MIN() per
	 * column is enough: every stored value is an ISO 8601 UTC string, which
	 * sorts chronologically.
	 */
	#nextDueAtMs(): number | null {
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT
					(SELECT MIN(snooze_until) FROM emails WHERE snooze_until IS NOT NULL) AS next_snooze,
					(SELECT MIN(remind_at) FROM emails WHERE remind_at IS NOT NULL AND reminded_at IS NULL) AS next_reminder,
					(SELECT MIN(send_at) FROM scheduled_sends WHERE status = 'pending') AS next_send,
					(SELECT COUNT(*) FROM import_jobs WHERE status IN ('pending', 'running')) AS active_imports`,
			),
		][0] as
			| {
					next_snooze: string | null;
					next_reminder: string | null;
					next_send: string | null;
					active_imports: number;
			  }
			| undefined;

		const due = [row?.next_snooze, row?.next_reminder, row?.next_send]
			.map((iso) => (typeof iso === "string" ? Date.parse(iso) : Number.NaN))
			.filter((ms) => !Number.isNaN(ms));
		// A staged import is due immediately; the drain is bounded and
		// re-arms for as long as the job has bytes left.
		if ((row?.active_imports ?? 0) > 0) due.push(Date.now());

		return due.length > 0 ? Math.min(...due) : null;
	}

	/**
	 * Put a snoozed message back where it came from and clear its snooze
	 * columns. `now` only stamps `trashed_at` when the origin is Trash, so
	 * every folder move keeps the retention invariant intact.
	 */
	#restoreSnoozed(
		id: string,
		fromFolder: string | null,
		now: string = new Date().toISOString(),
	): void {
		const target = this.#restoreTargetFolder(fromFolder);
		this.ctx.storage.sql.exec(
			`UPDATE emails
			 SET folder_id = ?1, trashed_at = ?2, snooze_until = NULL, snoozed_from_folder = NULL
			 WHERE id = ?3`,
			target,
			target === Folders.TRASH ? now : null,
			id,
		);
	}

	/**
	 * Folder a message snoozed from `fromFolder` lands in. Falls back to the
	 * Inbox when nothing was recorded, when the recording is Snoozed itself
	 * (a message must never wake back into Snoozed), or when the remembered
	 * folder has since been deleted — the foreign key would otherwise reject
	 * the move and the alarm would retry forever.
	 */
	#restoreTargetFolder(fromFolder: string | null): string {
		if (fromFolder && fromFolder !== Folders.SNOOZED && this.#folderExists(fromFolder)) {
			return fromFolder;
		}
		return Folders.INBOX;
	}

	/** Whether a folder row exists (see #restoreTargetFolder). */
	#folderExists(folderId: string): boolean {
		const row = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(eq(schema.folders.id, folderId))
			.get();
		return row !== undefined;
	}

	/**
	 * Whether a thread still expects a reply: the newest message in it is not
	 * in Sent. A message without a thread_id is its own thread, and equal
	 * dates break by id so the answer is deterministic.
	 */
	#threadNeedsReply(email: {
		id: string;
		thread_id: string | null;
		folder_id: string;
	}): boolean {
		if (!email.thread_id) return email.folder_id !== Folders.SENT;

		const newest = this.db
			.select({ folder_id: schema.emails.folder_id })
			.from(schema.emails)
			.where(eq(schema.emails.thread_id, email.thread_id))
			.orderBy(desc(schema.emails.date), desc(schema.emails.id))
			.limit(1)
			.get();

		return (newest?.folder_id ?? email.folder_id) !== Folders.SENT;
	}

	/** Wake every snoozed message in a thread because new mail arrived in it. */
	#wakeSnoozedThread(threadId: string): void {
		const snoozed = this.db
			.select({
				id: schema.emails.id,
				snoozed_from_folder: schema.emails.snoozed_from_folder,
			})
			.from(schema.emails)
			.where(
				and(
					eq(schema.emails.thread_id, threadId),
					isNotNull(schema.emails.snooze_until),
				),
			)
			.all();

		if (snoozed.length === 0) return;

		this.ctx.storage.transactionSync(() => {
			for (const email of snoozed) {
				this.#restoreSnoozed(email.id, email.snoozed_from_folder);
			}
		});
	}

	/** Drop every reminder on a thread: a reply answered the follow-up. */
	#clearThreadReminder(threadId: string): void {
		this.ctx.storage.sql.exec(
			`UPDATE emails
			 SET remind_at = NULL, reminded_at = NULL
			 WHERE thread_id = ?1 AND (remind_at IS NOT NULL OR reminded_at IS NOT NULL)`,
			threadId,
		);
	}

	// ── Unsubscribe (RFC 8058) ─────────────────────────────────────

	/**
	 * Stamp `unsubscribed_at` on a message whose one-click unsubscribe
	 * endpoint answered 2xx. The request itself is made by the API route in
	 * workers/index.ts — the only caller of the SSRF guard, reached only by
	 * an explicit operator action — so this mutator just records the
	 * outcome, and the route never calls it when the request failed.
	 * Returns the updated row, or null when the id is unknown.
	 */
	setUnsubscribed(id: string, at: string) {
		const email = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		this.db
			.update(schema.emails)
			.set({ unsubscribed_at: at })
			.where(eq(schema.emails.id, id))
			.run();

		return this.getEmail(id);
	}

	// ── Agent action audit (agent + MCP tools) ─────────────────────

	/** Read a raw audit row as the API shape (`undoable` as a boolean). */
	#agentActionRow(row: typeof schema.agentActions.$inferSelect): AgentActionRow {
		return { ...row, undoable: !!row.undoable };
	}

	/**
	 * Record one mutating agent/MCP tool call, then prune the mailbox back
	 * to its newest MAX_AGENT_ACTIONS rows so the log is bounded on every
	 * write. Metadata only: `args`/`beforeState`/`afterState` arrive as JSON
	 * strings the caller has already bounded. Returns the stored row.
	 */
	recordAgentAction(action: AgentActionInput) {
		const row = this.db
			.insert(schema.agentActions)
			.values({
				id: action.id,
				source: action.source,
				tool: action.tool,
				email_id: action.emailId ?? null,
				email_subject: action.emailSubject ?? null,
				thread_id: action.threadId ?? null,
				args: action.args ?? null,
				before_state: action.beforeState ?? null,
				after_state: action.afterState ?? null,
				undoable: action.undoable ? 1 : 0,
				created_at: action.createdAt ?? new Date().toISOString(),
			})
			.returning()
			.get();

		// Keep only the newest rows. Ties on created_at fall back to rowid
		// (insertion order) so the prune is deterministic.
		this.ctx.storage.sql.exec(
			`DELETE FROM agent_actions
			 WHERE id NOT IN (
				SELECT id FROM agent_actions
				ORDER BY created_at DESC, rowid DESC
				LIMIT ?1
			 )`,
			MAX_AGENT_ACTIONS,
		);

		return this.#agentActionRow(row);
	}

	/** The newest `limit` audit rows for this mailbox, newest first. */
	listAgentActions(limit = 50) {
		const capped = Math.min(Math.max(Math.trunc(limit), 1), MAX_AGENT_ACTIONS);
		return this.db
			.select()
			.from(schema.agentActions)
			.orderBy(desc(schema.agentActions.created_at), sql`rowid DESC`)
			.limit(capped)
			.all()
			.map((row) => this.#agentActionRow(row));
	}

	/** How many audit rows this mailbox currently stores. */
	countAgentActions() {
		const row = this.db
			.select({ total: sql<number>`COUNT(*)`.mapWith(Number) })
			.from(schema.agentActions)
			.get();
		return row?.total ?? 0;
	}

	/**
	 * Undo one recorded action: restore the message's read state, star state
	 * and folder from `before_state`, then stamp `undone_at`. The folder
	 * restore goes through folderMoveFields so the Trash retention invariant
	 * holds when the restore moves a message into or out of Trash. Never
	 * sends and never deletes mail — the three reversible fields are the
	 * whole effect.
	 *
	 * Returns `{ ok: true, action, email }` on success, `{ ok: false, error }`
	 * when the action is not undoable, was already undone, or its message is
	 * gone, and null for an unknown id. A failed undo changes nothing: the
	 * stamp and the restore share one transaction.
	 */
	undoAgentAction(id: string) {
		const action = this.db
			.select()
			.from(schema.agentActions)
			.where(eq(schema.agentActions.id, id))
			.get();

		if (!action) return null;
		if (!action.undoable) {
			return { ok: false as const, error: "This action is not undoable." };
		}
		if (action.undone_at) {
			return {
				ok: false as const,
				error: "This action has already been undone.",
			};
		}

		const emailId = action.email_id;
		if (!emailId) {
			return { ok: false as const, error: "This action has no message to restore." };
		}

		const before = safeJsonParse(action.before_state) as AgentActionState | null;
		if (!before) {
			return {
				ok: false as const,
				error: "This action has no recorded state to restore.",
			};
		}

		// The message must still exist: restoring a row that is gone would
		// stamp the action undone while changing nothing.
		const current = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.id, emailId))
			.get();
		if (!current) {
			return { ok: false as const, error: "The message no longer exists." };
		}

		const fields: {
			read?: number;
			starred?: number;
			folder_id?: string;
			trashed_at?: string | null;
		} = {};
		if (typeof before.read === "boolean") fields.read = before.read ? 1 : 0;
		if (typeof before.starred === "boolean") fields.starred = before.starred ? 1 : 0;
		if (typeof before.folder_id === "string") {
			Object.assign(fields, folderMoveFields(before.folder_id));
		}

		const undoneAt = new Date().toISOString();
		this.ctx.storage.transactionSync(() => {
			if (Object.keys(fields).length > 0) {
				this.db
					.update(schema.emails)
					.set(fields)
					.where(eq(schema.emails.id, emailId))
					.run();
			}
			this.db
				.update(schema.agentActions)
				.set({ undone_at: undoneAt })
				.where(eq(schema.agentActions.id, id))
				.run();
		});

		const email = this.getEmail(emailId);
		if (!email) {
			return { ok: false as const, error: "The message no longer exists." };
		}
		return {
			ok: true as const,
			action: { ...this.#agentActionRow(action), undone_at: undoneAt },
			email,
		};
	}


	// ── Search (raw SQL — dynamic condition builder) ───────────────

	/**
	 * Build WHERE conditions and params for search queries.
	 * Shared between searchEmails and countSearchResults.
	 */
	#buildSearchConditions(
		options: SearchFilterOptions,
		tableAlias = "",
	): { conditions: string[]; params: (string | number)[] } {
		const { query, folder, category, label, from, to, subject, date_start, date_end, is_read, is_starred, has_attachment } = options;
		const prefix = tableAlias ? `${tableAlias}.` : "";
		const conditions: string[] = [];
		const params: (string | number)[] = [];
		let paramIdx = 0;

		const addParam = (value: string | number) => {
			paramIdx++;
			params.push(value);
			return `?${paramIdx}`;
		};

		// LIKE patterns are escaped and chunked (see lib/like-terms.ts) so a term
		// containing % or _ matches those characters literally, and a term longer
		// than the SQLite LIKE pattern limit is split into several patterns that
		// are ANDed together instead of failing the request. All columns for one
		// chunk share a single bound parameter.
		const addLikeConditions = (columns: string[], term: string | undefined) => {
			if (!term) return;
			for (const pattern of likePatternsFor(term)) {
				const p = addParam(pattern);
				const matches = columns.map((column) => `${prefix}${column} LIKE ${p} ESCAPE '\\'`);
				conditions.push(`(${matches.join(" OR ")})`);
			}
		};

		// The columns a free-text query searches — exactly the columns indexed
		// by `emails_fts` (migration 23); keep the two lists in step.
		const searchColumns = ["subject", "body", "sender", "recipient", "envelope_recipient", "cc", "bcc"];

		// Free-text terms go through the `emails_fts` index (migration 23):
		// one condition per term, ANDed, so a multi-word query still means
		// "every word appears somewhere in the message". The trigram tokenizer
		// makes each phrase a substring match, so 'arter' finds 'quarterly'.
		// Every phrase is quoted (lib/fts-terms.ts) because raw operator text
		// would otherwise be parsed as FTS5 syntax. The index is
		// external-content, so its `rowid` is the `emails` rowid, and the
		// subquery is prefixed like any other column so the builder works with
		// and without a table alias (countSearchResults passes none).
		// A term also matches the text extracted from the message's
		// attachments (attachment_text_fts, migration 36): the second
		// subquery joins that index back to the message by email_id,
		// prefixed like the label filter below so the builder works with and
		// without a table alias, and it shares the one bound phrase with the
		// message index. Only the FTS path sees attachment text — the
		// one- and two-character LIKE path stays message-columns-only.
		const { ftsPhrases, shortTerms } = splitFtsTerms(query);
		for (const phrase of ftsPhrases) {
			const p = addParam(phrase);
			conditions.push(
				`(${prefix}rowid IN (SELECT rowid FROM emails_fts WHERE emails_fts MATCH ${p})` +
					` OR ${prefix}id IN (SELECT at.email_id FROM attachment_text at` +
					` JOIN attachment_text_fts ON attachment_text_fts.rowid = at.rowid` +
					` WHERE attachment_text_fts MATCH ${p}))`,
			);
		}
		// One- and two-character terms have no trigram to match, so they keep
		// the LIKE path over the same columns.
		for (const term of shortTerms) {
			addLikeConditions(searchColumns, term);
		}
		if (folder) {
			const p = addParam(folder);
			conditions.push(`${prefix}folder_id = (SELECT id FROM folders WHERE name = ${p} OR id = ${p} LIMIT 1)`);
		}
		if (category) { const p = addParam(category); conditions.push(`${prefix}category = ${p}`); }
		// A label filter matches the label NAME exactly (case-insensitively),
		// never as a prefix, and only through the message's assignment rows:
		// the subquery is prefixed like every other column so the builder
		// works with and without a table alias (countSearchResults passes none).
		if (label) {
			const p = addParam(label);
			conditions.push(
				`${prefix}id IN (SELECT el.email_id FROM email_labels el JOIN labels l ON l.id = el.label_id WHERE l.name = ${p} COLLATE NOCASE)`,
			);
		}
		addLikeConditions(["sender"], from);
		addLikeConditions(["recipient", "envelope_recipient", "cc", "bcc"], to);
		addLikeConditions(["subject"], subject);
		if (date_start) { const p = addParam(date_start); conditions.push(`${prefix}date >= ${p}`); }
		if (date_end) { const p = addParam(date_end); conditions.push(`${prefix}date <= ${p}`); }
		if (is_read !== undefined) { const p = addParam(is_read ? 1 : 0); conditions.push(`${prefix}read = ${p}`); }
		if (is_starred !== undefined) { const p = addParam(is_starred ? 1 : 0); conditions.push(`${prefix}starred = ${p}`); }
		if (has_attachment) { conditions.push(`${prefix}id IN (SELECT DISTINCT email_id FROM attachments)`); }

		return { conditions, params };
	}

	searchEmails(options: SearchFilterOptions & { page?: number; limit?: number }) {
		const { page = 1, limit: rawLimit = 25 } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);
		const { conditions, params } = this.#buildSearchConditions(options, "e");

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const offset = (page - 1) * limit;

		const query = `
			SELECT e.id, e.subject, e.sender, e.recipient, e.envelope_recipient, e.cc, e.bcc, e.date,
				e.read, e.starred, e.in_reply_to, e.email_references,
				e.thread_id, e.folder_id, e.category, e.category_confidence,
				SUBSTR(e.body, 1, 300) as snippet,
				f.name as folder_name
			FROM emails e
			LEFT JOIN folders f ON e.folder_id = f.id
			${where}
			ORDER BY e.date DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`;
		params.push(limit, offset);

		const result = this.ctx.storage.sql.exec(query, ...params);
		return ([...result] as unknown as SearchEmailRow[]).map((row) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
		}));
	}

	// ── Semantic search bookkeeping (raw SQL) ──────────────────────

	/**
	 * Record that one message's embedding is stored in the vector index.
	 *
	 * Upserts the one bookkeeping row per message (migration
	 * 31_add_message_embeddings) and answers false when the message no longer
	 * exists, so an ingest that lost a race with a delete never leaves a row
	 * behind. `model` is the embedding model id the vector was made with and
	 * `contentHash` the hash of the text that was embedded (empty for a
	 * message with nothing embeddable). Metadata only — never message
	 * content.
	 */
	markMessageEmbedded(emailId: string, model: string, contentHash: string): boolean {
		const exists = [
			...this.ctx.storage.sql.exec(`SELECT 1 FROM emails WHERE id = ?1`, emailId),
		].length > 0;
		if (!exists) return false;

		this.ctx.storage.sql.exec(
			`INSERT OR REPLACE INTO message_embeddings (email_id, model, content_hash, created_at)
			 VALUES (?1, ?2, ?3, ?4)`,
			emailId,
			model,
			contentHash,
			new Date().toISOString(),
		);
		return true;
	}

	/**
	 * The newest messages that have no embedding row yet, newest first and
	 * bounded to `limit` — the reindex route passes one batch
	 * (SEMANTIC_REINDEX_BATCH_MAX, workers/lib/semantic.ts; clamped again here
	 * for direct Durable Object callers). Bodies are clipped to 12000
	 * characters: more than enough for the embedding text (6000 plain-text
	 * characters) without shipping whole bodies over the RPC.
	 */
	listUnembeddedMessages(limit: number = 20): Array<{
		id: string;
		subject: string | null;
		sender: string | null;
		date: string | null;
		body_text: string | null;
		body: string | null;
	}> {
		const boundedLimit = Number.isFinite(limit)
			? Math.min(Math.max(Math.trunc(limit), 1), 100)
			: 20;

		return [
			...this.ctx.storage.sql.exec(
				`SELECT e.id, e.subject, e.sender, e.date,
				        SUBSTR(e.body_text, 1, 12000) AS body_text,
				        SUBSTR(e.body, 1, 12000) AS body
				 FROM emails e
				 LEFT JOIN message_embeddings me ON me.email_id = e.id
				 WHERE me.email_id IS NULL
				 ORDER BY e.date DESC
				 LIMIT ?1`,
				boundedLimit,
			),
		] as unknown as Array<{
			id: string;
			subject: string | null;
			sender: string | null;
			date: string | null;
			body_text: string | null;
			body: string | null;
		}>;
	}

	/**
	 * How much of this mailbox's mail is embedded: `embedded` counts the
	 * bookkeeping rows (one per message, cascading away with its message) and
	 * `total` every stored message. The reindex route answers with both so a
	 * caller can loop until nothing remains.
	 */
	countEmbeddings(): { embedded: number; total: number } {
		const embedded = [
			...this.ctx.storage.sql.exec(`SELECT COUNT(*) AS total FROM message_embeddings`),
		][0] as { total: number } | undefined;
		const total = [
			...this.ctx.storage.sql.exec(`SELECT COUNT(*) AS total FROM emails`),
		][0] as { total: number } | undefined;
		return { embedded: embedded?.total ?? 0, total: total?.total ?? 0 };
	}

	/**
	 * Count total search results matching the given filters (for pagination).
	 */
	countSearchResults(options: SearchFilterOptions) {
		const { conditions, params } = this.#buildSearchConditions(options);

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const query = `SELECT COUNT(*) as total FROM emails ${where}`;

		const row = [...this.ctx.storage.sql.exec(query, ...params)][0] as
			| { total: number }
			| undefined;
		return row?.total ?? 0;
	}

	// ── Threading helpers (raw SQL) ────────────────────────────────

	findThreadBySubject(subject: string, senderAddress?: string): string | null {
		const normalized = subject
			.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
			.trim()
			.toLowerCase();

		if (!normalized) return null;

		const rows = [
			...this.ctx.storage.sql.exec(
				`SELECT thread_id, subject,
			        GROUP_CONCAT(DISTINCT LOWER(sender)) as senders,
			        GROUP_CONCAT(DISTINCT LOWER(recipient)) as recipients
			 FROM emails
			 WHERE thread_id IS NOT NULL
			   AND thread_id != id
			   AND date >= datetime('now', '-7 days')
			 GROUP BY thread_id
			 ORDER BY MAX(date) DESC
				 LIMIT 50`,
			),
		] as unknown as ThreadCandidateRow[];

		const normalizedSender = senderAddress?.toLowerCase().trim();

		for (const row of rows) {
			const rowSubject = (row.subject || "")
				.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
				.trim()
				.toLowerCase();
			if (rowSubject !== normalized) continue;

			if (normalizedSender) {
				const threadSenders = row.senders || "";
				const threadRecipients = row.recipients || "";
				const allParticipants = `${threadSenders},${threadRecipients}`;
				if (!allParticipants.includes(normalizedSender)) {
					continue;
				}
			}

			return row.thread_id;
		}
		return null;
	}

	// ── Rate limiting (raw SQL) ────────────────────────────────────

	/**
	 * Check if the mailbox has exceeded the send rate limit.
	 * Limits: 20 emails per hour, 100 per day per mailbox.
	 * Returns null if under limit, or an error message string if exceeded.
	 */
	checkSendRateLimit(): string | null {
		const hourRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 hour')`,
			Folders.SENT,
		)][0] as { cnt: number } | undefined;

		if ((hourRow?.cnt ?? 0) >= 20) {
			return "Rate limit exceeded: max 20 emails per hour per mailbox";
		}

		const dayRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 day')`,
			Folders.SENT,
		)][0] as { cnt: number } | undefined;

		if ((dayRow?.cnt ?? 0) >= 100) {
			return "Rate limit exceeded: max 100 emails per day per mailbox";
		}

		return null;
	}

	// ── Email creation (Drizzle) ───────────────────────────────────

	createEmail(
		folder: string,
		email: EmailData,
		attachments: AttachmentData[],
	): CreateEmailResult {
		// Resolve folder name or ID to the actual folder ID.
		const folderRow = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(or(eq(schema.folders.id, folder), eq(schema.folders.name, folder)))
			.limit(1)
			.get();

		if (!folderRow) {
			throw new Error(
				`createEmail: folder "${folder}" not found. ` +
					"Ensure the folder exists before inserting an email.",
			);
		}

		const folderId = folderRow.id;

		// Duplicate deliveries — same RFC 5322 Message-ID already stored in this
		// mailbox — are not inserted again. The existing row's id comes back with
		// `duplicate: true` so the ingest path can skip downstream side effects.
		// The lookup ignores folder on purpose: a message the user moved to
		// another folder is still a duplicate and must not be resurrected here.
		const duplicateId = findDuplicateEmailId(this.db, email.message_id);
		if (duplicateId) {
			return { id: duplicateId, duplicate: true };
		}

		const isSent = folderId === Folders.SENT;

		// Sent emails are always read — the sender obviously knows what they wrote.
		// This prevents sent replies from inflating thread_unread_count.
		this.db
			.insert(schema.emails)
			.values({
				id: email.id,
				// A message can be created straight in Trash (an inbound rule
				// routing to it), so creation goes through the same stamping
				// helper as every folder move.
				...folderMoveFields(folderId),
				subject: email.subject,
				sender: email.sender,
				recipient: email.recipient,
				envelope_recipient: email.envelope_recipient ?? null,
				cc: email.cc ?? null,
				bcc: email.bcc ?? null,
				reply_to: email.reply_to ?? null,
				date: email.date,
				read: isSent ? 1 : (email.read ? 1 : 0),
				starred: email.starred ? 1 : 0,
				body: email.body,
				body_text: email.body_text ?? null,
				in_reply_to: email.in_reply_to ?? null,
				email_references: email.email_references ?? null,
				thread_id: email.thread_id ?? null,
				message_id: email.message_id ?? null,
				raw_headers: email.raw_headers ?? null,
				category: email.category ?? null,
				category_confidence: email.category_confidence ?? null,
				classification: email.classification ?? null,
				matched_rule_id: email.matched_rule_id ?? null,
				matched_rule_name: email.matched_rule_name ?? null,
				// Stored verbatim from the inbound headers; the unsubscribe
				// route re-parses them on demand (never at ingest).
				list_unsubscribe: email.list_unsubscribe ?? null,
				list_unsubscribe_post: email.list_unsubscribe_post ?? null,
			})
			.run();

		if (attachments.length > 0) {
			this.db.insert(schema.attachments).values(attachments).run();
		}

		// Contacts feed: a Sent copy counts every addressee as a sent contact,
		// any other folder counts the sender as received. Metadata only and
		// bounded (workers/lib/contacts.ts), and best-effort on purpose — a
		// contact bookkeeping failure must never fail message storage.
		try {
			this.recordContacts(contactDeltasForEmail(folderId, email));
		} catch (e) {
			console.error(
				`Contact recording failed for ${email.id}:`,
				(e as Error).message,
			);
		}

		// A message landing anywhere but Sent means the thread is active
		// again: wake its snoozed messages right away so new mail is not
		// hidden behind a snooze that was set before it arrived.
		if (!isSent && email.thread_id) {
			this.#wakeSnoozedThread(email.thread_id);
		}
		// A reply (stored in Sent) answers the thread: drop its follow-up so
		// nobody is nudged about mail that has already been handled.
		if (isSent && email.thread_id) {
			this.#clearThreadReminder(email.thread_id);
		}

		return { id: email.id, duplicate: false };
	}

	// ── Attachment text (search index) ─────────────────────────────

	/**
	 * Store the searchable text extracted from a message's attachments
	 * (workers/lib/attachment-text.ts, migration 36). Rows are upserted by
	 * attachment_id, so a second write for the same attachment replaces its
	 * text, and both the batch size and the text length are clamped again
	 * here — a direct RPC caller cannot write an unbounded batch. The
	 * attachment_text_fts triggers keep the search index in step with every
	 * insert and update, so this method never touches FTS directly.
	 *
	 * Callers store text only for attachments they have just stored, and
	 * only once the message itself is stored: every email-delete path
	 * deletes the message's attachment_text rows alongside it, so a row can
	 * never outlive its attachment.
	 */
	storeAttachmentText(rows: AttachmentTextInput[]): number {
		const now = new Date().toISOString();
		let written = 0;
		for (const row of (rows ?? []).slice(0, MAX_ATTACHMENT_TEXT_ROWS)) {
			if (!row?.attachment_id || !row.email_id) continue;
			const text = (row.text ?? "").replaceAll("\u0000", "").slice(0, MAX_ATTACHMENT_TEXT_CHARS);
			if (text.length === 0) continue;
			// One upsert per row, like recordContacts: a multi-row INSERT would
			// spend one bound parameter per column per row, and Durable Object
			// SQLite caps a statement at 100 parameters.
			this.db
				.insert(schema.attachmentText)
				.values({
					attachment_id: row.attachment_id,
					email_id: row.email_id,
					filename: row.filename || "untitled",
					mimetype: row.mimetype || "application/octet-stream",
					text,
					created_at: now,
				})
				.onConflictDoUpdate({
					target: schema.attachmentText.attachment_id,
					set: {
						email_id: sql`excluded.email_id`,
						filename: sql`excluded.filename`,
						mimetype: sql`excluded.mimetype`,
						text: sql`excluded.text`,
						created_at: sql`excluded.created_at`,
					},
				})
				.run();
			written += 1;
		}
		return written;
	}

	// ── Contacts (mail-flow address book) ──────────────────────────

	/**
	 * Apply one batch of contact deltas: upsert each address by its
	 * lowercased form, add the sent/received increments to the stored
	 * counters, refresh the display name from a non-empty arrival, stamp
	 * `last_seen_at`, then prune the mailbox back to its newest MAX_CONTACTS
	 * rows so the store is bounded on every write. Returns how many contacts
	 * were written.
	 *
	 * Deltas that do not normalize to a usable address, and deltas that carry
	 * no increment, are skipped. The upsert targets the UNIQUE email column,
	 * so a repeat sighting increments the existing row instead of inserting a
	 * duplicate. `first_seen_at` is set on insert only; the update path never
	 * touches it.
	 */
	recordContacts(deltas: ContactDelta[]) {
		const now = new Date().toISOString();
		let written = 0;

		for (const delta of deltas) {
			const email = normalizeContactAddress(delta.email);
			if (!email) continue;
			const sent = Math.max(Math.trunc(delta.sent ?? 0), 0);
			const received = Math.max(Math.trunc(delta.received ?? 0), 0);
			if (sent === 0 && received === 0) continue;

			this.ctx.storage.sql.exec(
				`INSERT INTO contacts
					(id, email, name, sent_count, received_count, first_seen_at, last_seen_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
				 ON CONFLICT(email) DO UPDATE SET
					sent_count = sent_count + excluded.sent_count,
					received_count = received_count + excluded.received_count,
					name = COALESCE(excluded.name, contacts.name),
					last_seen_at = excluded.last_seen_at`,
				crypto.randomUUID(),
				email,
				normalizeContactName(delta.name),
				sent,
				received,
				now,
			);
			written += 1;
		}

		if (written > 0) {
			// Keep only the newest rows. Ties on last_seen_at fall back to
			// rowid (insertion order) so the prune is deterministic.
			this.ctx.storage.sql.exec(
				`DELETE FROM contacts
				 WHERE id NOT IN (
					SELECT id FROM contacts
					ORDER BY last_seen_at DESC, rowid DESC
					LIMIT ?1
				 )`,
				MAX_CONTACTS,
			);
		}

		return written;
	}

	/**
	 * One stored contact by address, matched case-insensitively (addresses
	 * are stored lowercased), or null when this mailbox has never seen it.
	 */
	getContact(email: string) {
		const address = normalizeContactAddress(email);
		if (!address) return null;
		return (
			this.db
				.select()
				.from(schema.contacts)
				.where(eq(schema.contacts.email, address))
				.get() ?? null
		);
	}

	/**
	 * The prefix conditions one contact query matches: a case-insensitive
	 * prefix on the address or on the display name. Empty (no condition at
	 * all) for a blank query, which then reads the whole table.
	 */
	#contactConditions(query: string): SQL[] {
		const term = (query ?? "").trim().toLowerCase();
		return term
			? [
					contactPrefixCondition(schema.contacts.email, term),
					contactPrefixCondition(schema.contacts.name, term),
				]
			: [];
	}

	/**
	 * The mailbox's contacts, ranked by how much it sent to them
	 * (`sent_count DESC`), then how much they sent (`received_count DESC`),
	 * then recency (`last_seen_at DESC`). A non-empty query prefix-matches
	 * the address or the display name case-insensitively; an empty query
	 * returns the top-ranked contacts. The page is capped at
	 * MAX_CONTACT_SEARCH_LIMIT rows.
	 */
	searchContacts(query: string, limit = DEFAULT_CONTACT_SEARCH_LIMIT) {
		const capped = Math.min(
			Math.max(Math.trunc(limit), 1),
			MAX_CONTACT_SEARCH_LIMIT,
		);
		const conditions = this.#contactConditions(query);

		return this.db
			.select()
			.from(schema.contacts)
			.where(conditions.length > 0 ? or(...conditions) : undefined)
			.orderBy(
				desc(schema.contacts.sent_count),
				desc(schema.contacts.received_count),
				desc(schema.contacts.last_seen_at),
			)
			.limit(capped)
			.all();
	}

	// ── Web push subscriptions (workers/lib/webpush.ts) ────────────


	/**
	 * Store (or refresh) one browser push subscription, keyed by its
	 * endpoint: subscribing again from the same browser rewrites the two keys
	 * in place and keeps the row's `created_at` and `last_ok_at`. After every
	 * insert the mailbox is pruned back to its newest MAX_PUSH_SUBSCRIPTIONS
	 * endpoints, so the table — and the fan-out over it — can never grow
	 * unbounded.
	 */
	upsertPushSubscription(subscription: PushSubscriptionInput): void {
		this.ctx.storage.sql.exec(
			`INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, last_ok_at)
			 VALUES (?1, ?2, ?3, ?4, NULL)
			 ON CONFLICT(endpoint) DO UPDATE SET
				p256dh = excluded.p256dh,
				auth = excluded.auth`,
			subscription.endpoint,
			subscription.p256dh,
			subscription.auth,
			new Date().toISOString(),
		);
		this.prunePushSubscriptions();
	}


	/**
	 * Remove one subscription by endpoint. Answers whether a row was actually
	 * deleted, so the unsubscribe route can report an idempotent
	 * `removed: false` for an endpoint that was already gone.
	 */
	deletePushSubscription(endpoint: string): boolean {
		const cursor = this.ctx.storage.sql.exec(
			`DELETE FROM push_subscriptions WHERE endpoint = ?1`,
			endpoint,
		);
		return cursor.rowsWritten > 0;
	}


	/**
	 * The mailbox's subscriptions, newest first and capped at
	 * MAX_PUSH_SUBSCRIPTIONS — the same order `prunePushSubscriptions` keeps,
	 * so the fan-out and the table always agree. This is the whole list the
	 * push notifier can ever iterate.
	 */
	listPushSubscriptions(): PushSubscriptionRecord[] {
		return this.db
			.select()
			.from(schema.pushSubscriptions)
			.orderBy(
				desc(schema.pushSubscriptions.created_at),
				desc(sql`rowid`),
			)
			.limit(MAX_PUSH_SUBSCRIPTIONS)
			.all();
	}


	/**
	 * Delete every subscription past the newest MAX_PUSH_SUBSCRIPTIONS,
	 * newest-first by `created_at` with the insertion order (rowid) as the
	 * tie-break. Returns how many rows were deleted; called by the upsert, and
	 * safe to call on its own.
	 */
	prunePushSubscriptions(): number {
		const cursor = this.ctx.storage.sql.exec(
			`DELETE FROM push_subscriptions
			 WHERE rowid NOT IN (
				SELECT rowid FROM push_subscriptions
				ORDER BY created_at DESC, rowid DESC
				LIMIT ?1
			 )`,
			MAX_PUSH_SUBSCRIPTIONS,
		);
		return cursor.rowsWritten;
	}


	/**
	 * Record that a push to this endpoint succeeded (`last_ok_at`). Unknown or
	 * already-pruned endpoints update nothing — best-effort bookkeeping, never
	 * an error for the caller.
	 */
	markPushSubscriptionOk(endpoint: string): void {
		this.ctx.storage.sql.exec(
			`UPDATE push_subscriptions SET last_ok_at = ?1 WHERE endpoint = ?2`,
			new Date().toISOString(),
			endpoint,
		);
	}

	/** How many contacts match the same query searchContacts reads. */
	countContacts(query = "") {
		const conditions = this.#contactConditions(query);

		const row = this.db
			.select({ total: sql<number>`COUNT(*)`.mapWith(Number) })
			.from(schema.contacts)
			.where(conditions.length > 0 ? or(...conditions) : undefined)
			.get();
		return row?.total ?? 0;
	}


	// ── Rules CRUD (raw SQL — JSON match/actions columns) ──────────


	/**
	 * Every rule for this mailbox in evaluation order — ascending priority,
	 * then creation order, then id. This is exactly the order `runRules`
	 * applies them in, so the API/UI list matches inbound behaviour.
	 */
	listRules(): MailRule[] {
		const rows = [
			...this.ctx.storage.sql.exec(
				`SELECT r.id, r.name, r.enabled, r.priority, r.match, r.actions, r.created_at,
				        COALESCE(s.fired_count, 0) AS fired_count,
				        s.last_fired_at AS last_fired_at
				 FROM rules r
				 LEFT JOIN rule_stats s ON s.rule_id = r.id
				 ORDER BY r.priority ASC, r.created_at ASC, r.id ASC`,
			),
		] as unknown as RuleRow[];
		return rows.map(parseRuleRow);
	}


	/**
	 * Store a new rule. An omitted priority appends it to the end of the list.
	 * Throws RuleValidationError for unusable rules (missing name, unknown
	 * folder, no conditions, no actions) so callers can answer with a 400.
	 */
	createRule(draft: RuleDraft): MailRule {
		const id = crypto.randomUUID();
		const createdAt = new Date().toISOString();
		const name = this.#normalizeRuleName(draft.name);
		const priority =
			draft.priority === undefined
				? this.#nextRulePriority()
				: this.#normalizeRulePriority(draft.priority);
		const match = this.#normalizeStoredMatch(draft.match);
		const actions = this.#normalizeStoredActions(draft.actions);
		const enabled = draft.enabled !== false;

		this.ctx.storage.sql.exec(
			`INSERT INTO rules (id, name, enabled, priority, match, actions, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
			id,
			name,
			enabled ? 1 : 0,
			priority,
			JSON.stringify(match),
			JSON.stringify(actions),
			createdAt,
		);

		return {
			id,
			name,
			enabled,
			priority,
			match,
			actions,
			created_at: createdAt,
			fired_count: 0,
			last_fired_at: null,
		};
	}


	/**
	 * Patch a rule. Fields left out keep their stored value; returns the
	 * updated rule, or null when the id is unknown.
	 */
	updateRule(id: string, patch: RulePatch): MailRule | null {
		const existing = this.#getRule(id);
		if (!existing) return null;

		const name =
			patch.name === undefined
				? existing.name
				: this.#normalizeRuleName(patch.name);
		const priority =
			patch.priority === undefined
				? existing.priority
				: this.#normalizeRulePriority(patch.priority);
		const match =
			patch.match === undefined
				? existing.match
				: this.#normalizeStoredMatch(patch.match);
		const actions =
			patch.actions === undefined
				? existing.actions
				: this.#normalizeStoredActions(patch.actions);
		const enabled =
			patch.enabled === undefined ? existing.enabled : patch.enabled !== false;

		this.ctx.storage.sql.exec(
			`UPDATE rules
			 SET name = ?1, enabled = ?2, priority = ?3, match = ?4, actions = ?5
			 WHERE id = ?6`,
			name,
			enabled ? 1 : 0,
			priority,
			JSON.stringify(match),
			JSON.stringify(actions),
			id,
		);

		return { ...existing, name, enabled, priority, match, actions };
	}


	/** Delete a rule. Returns false when the id is unknown. */
	deleteRule(id: string): boolean {
		if (!this.#getRule(id)) return false;
		this.ctx.storage.sql.exec(`DELETE FROM rules WHERE id = ?1`, id);
		return true;
	}


	/**
	 * Rewrite priorities so they follow the given id order (index 0 evaluates
	 * first). Unknown or duplicate ids are ignored, and rules missing from the
	 * list keep their relative order after the listed ones. Returns the
	 * re-ordered list.
	 */
	reorderRules(orderedIds: string[]): MailRule[] {
		const current = this.listRules();
		const byId = new Map(current.map((rule) => [rule.id, rule]));
		const seen = new Set<string>();
		const ordered: MailRule[] = [];

		for (const id of orderedIds) {
			const rule = byId.get(id);
			if (!rule || seen.has(id)) continue;
			seen.add(id);
			ordered.push(rule);
		}
		for (const rule of current) {
			if (!seen.has(rule.id)) ordered.push(rule);
		}

		this.ctx.storage.transactionSync(() => {
			ordered.forEach((rule, index) => {
				if (rule.priority === index) return;
				this.ctx.storage.sql.exec(
					`UPDATE rules SET priority = ?1 WHERE id = ?2`,
					index,
					rule.id,
				);
			});
		});

		return this.listRules();
	}


	/**
	 * Dry-run a rule draft against this mailbox: the SAME matcher the live
	 * engine uses (`matchRule`) runs over the most recent
	 * `RULE_PREVIEW_SCAN_LIMIT` messages and nothing is written — no stats,
	 * no email changes, no sends. Returns up to `limit` summaries plus the
	 * total number of matches within the scanned window.
	 *
	 * The scanned window comes from the same `#scanRuleRows` helper the
	 * retroactive apply uses, so a dry run and an apply always judge the
	 * same messages.
	 *
	 * `enabled` is ignored on purpose: a preview of a paused rule still shows
	 * what it would do once enabled.
	 */
	previewRule(
		draft: RulePreviewDraft,
		limit = RULE_PREVIEW_MAX_MATCHES,
	): RulePreviewResult {
		const match = normalizeRuleMatch(draft?.match);
		if (!hasActiveConditions(match.conditions)) {
			throw new RuleValidationError("A rule needs at least one match condition");
		}
		const boundedLimit =
			Number.isFinite(limit) && limit > 0
				? Math.min(Math.trunc(limit), RULE_PREVIEW_MAX_MATCHES)
				: RULE_PREVIEW_MAX_MATCHES;
		const previewRule: MailRule = {
			id: "preview",
			name:
				typeof draft?.name === "string" && draft.name.trim()
					? draft.name.trim()
					: "Preview",
			enabled: true,
			priority: 0,
			match,
			actions: {},
			created_at: "",
		};
		const rows = this.#scanRuleRows();

		const matches: RulePreviewMatch[] = [];
		let total = 0;
		for (const row of rows) {
			if (!matchRule(previewRule, previewRowToRuleEmail(row))) continue;
			total += 1;
			if (matches.length < boundedLimit) {
				matches.push({
					id: String(row.id),
					subject: String(row.subject ?? ""),
					sender: String(row.sender ?? ""),
					date: String(row.date ?? ""),
					folder_id: String(row.folder_id ?? ""),
				});
			}
		}

		return {
			total,
			scanned: rows.length,
			scan_limit: RULE_PREVIEW_SCAN_LIMIT,
			limit: boundedLimit,
			matches,
		};
	}




	/**
	 * Retroactively run a stored rule's local actions over the mailbox's
	 * existing mail — the operator-only counterpart of the arrival-time
	 * pipeline.
	 *
	 * Bounded per call: the newest `RULE_PREVIEW_SCAN_LIMIT` messages are
	 * scanned with the SAME `matchRule` matcher as the dry-run preview and
	 * the live engine, matches already in the target state are counted as
	 * `skipped` instead of rewritten, and at most `limit` (1..90) of the
	 * rest are changed. A caller loops until `remaining` is 0 or a batch
	 * applies nothing — which always terminates, because every changed
	 * message lands in its target state and is skipped on the next pass.
	 *
	 * Deliberately does NOT perform the outbound actions or honour
	 * `discard` (see `localRuleActions` in ../lib/rules.ts), does NOT bump
	 * `rule_stats` or stamp `matched_rule_*` (those describe arriving mail,
	 * and a repeatable operator action must not inflate them), and never
	 * touches the agent/MCP audit log.
	 *
	 * Returns null when the rule does not exist (route -> 404). Throws
	 * RuleValidationError when the rule has no stored-mail actions, or when
	 * its folder target has since been deleted (route -> 400).
	 */
	applyRuleToExisting(
		ruleId: string,
		limit: number = RULE_APPLY_LIMIT_DEFAULT,
	): RuleApplyResult | null {
		const stored = this.#getRule(ruleId);
		if (!stored) return null;

		const actions = stored.actions ?? {};
		if (!hasLocalRuleActions(actions)) {
			throw new RuleValidationError(
				"This rule has no folder, category, read or star action to apply to existing mail",
			);
		}
		const local = localRuleActions(actions);
		if (local.folder !== undefined && !this.#folderExists(local.folder)) {
			// The route pre-checks this too; checking again here means a
			// folder deleted between the route's check and this call cannot
			// leave dangling folder ids behind.
			throw new RuleValidationError(`Unknown folder: ${local.folder}`);
		}

		// A retroactive apply follows the dry run's rule: `enabled` is
		// ignored on purpose, so a paused rule can still be applied to mail
		// that predates it (the operator picked it explicitly).
		const rule: MailRule = { ...stored, enabled: true };

		// The route's schema keeps `limit` inside 1..90; clamping here is
		// defence in depth for direct Durable Object callers, the same way
		// `previewRule` clamps its summary limit.
		const boundedLimit = Number.isFinite(limit)
			? Math.min(Math.max(Math.trunc(limit), 1), RULE_APPLY_LIMIT_MAX)
			: RULE_APPLY_LIMIT_DEFAULT;

		const rows = this.#scanRuleRows();
		let applied = 0;
		let skipped = 0;
		let remaining = 0;
		let matched = 0;

		for (const row of rows) {
			if (!matchRule(rule, previewRowToRuleEmail(row))) continue;
			matched += 1;
			const needsChange = ruleNeedsChange(
				{
					folder_id: row.folder_id,
					category: row.category,
					read: row.read === 1 || row.read === true,
					starred: row.starred === 1 || row.starred === true,
				},
				local,
			);
			if (!needsChange) {
				skipped += 1;
				continue;
			}
			if (applied >= boundedLimit) {
				remaining += 1;
				continue;
			}
			this.#applyLocalRuleActions(String(row.id), local);
			applied += 1;
		}

		return {
			rule_id: ruleId,
			applied,
			skipped,
			matched,
			remaining,
			scanned: rows.length,
			scan_limit: RULE_PREVIEW_SCAN_LIMIT,
		};
	}
	// ── Pending uploads (files a queued send carries) ──────────────

	/**
	 * Record one file the composer uploaded ahead of a queued send. The
	 * bytes are already in R2 (pendingUploadR2Key owns the key shape); this
	 * row is what the fire path resolves an `upload_ids` entry back to.
	 * Nothing is sent here and no bytes travel: the row is deleted with its
	 * object once a send has used it, or by the daily sweep once it has
	 * gone stale. The caller deletes the object again when this throws, so
	 * stored bytes are never left without a row.
	 */
	createPendingUpload(input: CreatePendingUploadInput): PendingUploadRow {
		this.db
			.insert(schema.pendingUploads)
			.values({
				id: input.id,
				filename: input.filename,
				mimetype: input.mimetype,
				size: input.size,
				r2_key: input.r2Key,
				created_at: input.createdAt ?? new Date().toISOString(),
				consumed: 0,
			})
			.run();
		const stored = this.#pendingUploadById(input.id);
		if (!stored) {
			throw new Error(
				"createPendingUpload: the inserted row could not be read back.",
			);
		}
		return stored;
	}

	/** One pending upload by id, or null when it is unknown (or already gone). */
	getPendingUpload(id: string): PendingUploadRow | null {
		return this.#pendingUploadById(id);
	}

	/**
	 * Unconsumed uploads older than `cutoff`, oldest first — the rows the
	 * daily sweep deletes with their R2 objects. Bounded to one batch so a
	 * backlog cannot stall the sweep; a consumed row is never listed, so a
	 * file a send is using (or has just used) is never swept.
	 */
	listPendingUploadsBefore(
		cutoff: string,
		limit: number = PENDING_UPLOAD_SWEEP_BATCH,
	): PendingUploadRow[] {
		const capped = Math.min(
			Math.max(Math.trunc(limit), 1),
			PENDING_UPLOAD_SWEEP_BATCH,
		);
		return this.db
			.select()
			.from(schema.pendingUploads)
			.where(
				and(
					eq(schema.pendingUploads.consumed, 0),
					lt(schema.pendingUploads.created_at, cutoff),
				),
			)
			.orderBy(asc(schema.pendingUploads.created_at))
			.limit(capped)
			.all();
	}

	/**
	 * Delete one pending upload's row. Returns false when the id was already
	 * gone. The R2 object is the caller's to delete: the sweep and the
	 * DELETE route drop it around this call, and the fire path drops it
	 * after a successful send.
	 */
	deletePendingUpload(id: string): boolean {
		const existing = this.#pendingUploadById(id);
		if (!existing) return false;
		this.db
			.delete(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, id))
			.run();
		return true;
	}

	/**
	 * Stamp an upload as consumed: a send has used its bytes, so the sweep
	 * must not touch it. The fire path stamps this right after the message
	 * goes out and deletes the row moments later; the stamp is what covers
	 * the window in between.
	 */
	markPendingUploadConsumed(id: string): boolean {
		const existing = this.#pendingUploadById(id);
		if (!existing) return false;
		this.db
			.update(schema.pendingUploads)
			.set({ consumed: 1 })
			.where(eq(schema.pendingUploads.id, id))
			.run();
		return true;
	}

	/** One stored pending upload, or null when the id is unknown. */
	#pendingUploadById(id: string): PendingUploadRow | null {
		return (
			this.db
				.select()
				.from(schema.pendingUploads)
				.where(eq(schema.pendingUploads.id, id))
				.get() ?? null
		);
	}


	/**
	 * Rows one rule evaluation scans: the newest `RULE_PREVIEW_SCAN_LIMIT`
	 * stored messages, with every field the matcher and the retroactive
	 * apply need. Shared by `previewRule` and `applyRuleToExisting` so both
	 * always judge the same window with the same data — the apply's extra
	 * columns (`read`, `starred`) are simply ignored by the dry run.
	 */
	#scanRuleRows(): PreviewEmailRow[] {
		return [
			...this.ctx.storage.sql.exec(
				`SELECT id, subject, sender, recipient, envelope_recipient, cc, bcc,
				        body, category, folder_id, read, starred, date,
				        EXISTS (SELECT 1 FROM attachments WHERE attachments.email_id = emails.id) AS has_attachment
				 FROM emails
				 ORDER BY date DESC
				 LIMIT ?1`,
				RULE_PREVIEW_SCAN_LIMIT,
			),
		] as unknown as PreviewEmailRow[];
	}


	/**
	 * Apply a reduced action set to one stored message, through the existing
	 * primitives every other mutation path uses: `folderMoveFields` for
	 * moves (so the Trash retention stamp is written exactly as elsewhere),
	 * `updateEmail` for read/starred flags, and the same
	 * `UPDATE emails SET category = ?N` shape the stored-mail mutators use
	 * for a category stamp. No second mutation path is invented.
	 */
	#applyLocalRuleActions(id: string, actions: RuleLocalActions): void {
		if (actions.folder !== undefined) {
			this.db
				.update(schema.emails)
				.set(folderMoveFields(actions.folder))
				.where(eq(schema.emails.id, id))
				.run();
		}
		if (actions.category !== undefined) {
			this.ctx.storage.sql.exec(
				`UPDATE emails SET category = ?1 WHERE id = ?2`,
				actions.category,
				id,
			);
		}
		if (actions.read !== undefined || actions.starred !== undefined) {
			this.updateEmail(id, { read: actions.read, starred: actions.starred });
		}
	}



	/**
	 * Bump `fired_count` and `last_fired_at` for every rule that acted on one
	 * inbound message. Ids that no longer exist are ignored, so a rule deleted
	 * while mail is in flight can never break delivery.
	 */
	recordRuleFirings(ruleIds: readonly string[]): void {
		const ids = [
			...new Set(
				(ruleIds ?? []).filter(
					(id): id is string => typeof id === "string" && id.length > 0,
				),
			),
		];
		if (ids.length === 0) return;
		const known = new Set(
			[...this.ctx.storage.sql.exec(`SELECT id FROM rules`)].map((row) =>
				String((row as { id: unknown }).id),
			),
		);
		const valid = ids.filter((id) => known.has(id));
		if (valid.length === 0) return;
		const firedAt = new Date().toISOString();
		this.ctx.storage.transactionSync(() => {
			for (const id of valid) {
				this.ctx.storage.sql.exec(
					`INSERT INTO rule_stats (rule_id, fired_count, last_fired_at)
					 VALUES (?1, 1, ?2)
					 ON CONFLICT(rule_id) DO UPDATE SET
						fired_count = fired_count + 1,
						last_fired_at = ?2`,
					id,
					firedAt,
				);
			}
		});
	}




	/**
	 * Timestamp of the last auto-reply this mailbox sent to a sender, or null.
	 * Backed by Durable Object storage (no table needed) and keyed by address.
	 */
	async getLastAutoReplyAt(senderAddress: string): Promise<string | null> {
		const key = this.#autoReplyKey(senderAddress);
		if (!key) return null;
		const value = await this.ctx.storage.get<string>(key);
		return typeof value === "string" ? value : null;
	}




	/** Remember when this mailbox last auto-replied to a sender. */
	async recordAutoReply(senderAddress: string, at: string): Promise<void> {
		const key = this.#autoReplyKey(senderAddress);
		if (!key || typeof at !== "string" || !at) return;
		await this.ctx.storage.put(key, at);
	}




	/** Storage key for the per-sender auto-reply cap; null for junk input. */
	#autoReplyKey(senderAddress: string): string | null {
		const normalized = (senderAddress ?? "").trim().toLowerCase();
		if (!normalized) return null;
		return `ruleAutoReply:${normalized}`;
	}




	/** Load one rule by id, or null when it does not exist. */
	#getRule(id: string): MailRule | null {
		const rows = [
			...this.ctx.storage.sql.exec(
				`SELECT r.id, r.name, r.enabled, r.priority, r.match, r.actions, r.created_at,
				        COALESCE(s.fired_count, 0) AS fired_count,
				        s.last_fired_at AS last_fired_at
				 FROM rules r
				 LEFT JOIN rule_stats s ON s.rule_id = r.id
				 WHERE r.id = ?1`,
				id,
			),
		] as unknown as RuleRow[];
		const row = rows[0];
		return row ? parseRuleRow(row) : null;
	}


	/** Priority for a rule appended without an explicit one. */
	#nextRulePriority(): number {
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT COALESCE(MAX(priority), -1) + 1 AS next FROM rules`,
			),
		][0] as { next: number } | undefined;
		return row?.next ?? 0;
	}




	// ── Templates (mailbox snippets) ───────────────────────────────

	/**
	 * Every template for this mailbox, ordered by name (case-insensitive),
	 * then creation order, then id (the tie-break that keeps the list stable
	 * when two templates share a name and a timestamp). Name and subject are
	 * metadata; the body is the operator-authored content the composer
	 * inserts into a draft.
	 */
	listTemplates(): Template[] {
		return this.db
			.select()
			.from(schema.templates)
			.orderBy(
				sql`${schema.templates.name} COLLATE NOCASE ASC`,
				asc(schema.templates.created_at),
				asc(schema.templates.id),
			)
			.all();
	}

	// ── Labels (mailbox-wide tags) ─────────────────────────────────

	/**
	 * Every label for this mailbox, ordered by name (case-insensitive), then
	 * creation order, then id (the tie-break that keeps the list stable when
	 * two labels share a timestamp). A label is a user/agent-applied tag —
	 * unlike the AI-assigned `category`, nothing here is a model verdict.
	 */
	listLabels(): Label[] {
		return this.db
			.select()
			.from(schema.labels)
			.orderBy(
				sql`${schema.labels.name} COLLATE NOCASE ASC`,
				asc(schema.labels.created_at),
				asc(schema.labels.id),
			)
			.all();
	}

	/** How many labels this mailbox holds (the create-time cap check). */
	#countLabels(): number {
		const row = this.db
			.select({ total: sql<number>`COUNT(*)`.mapWith(Number) })
			.from(schema.labels)
			.get();
		return row?.total ?? 0;
	}

	/** One label by name, case-insensitively — the uniqueness check. */
	#getLabelByName(name: string): Label | null {
		return (
			this.db
				.select()
				.from(schema.labels)
				.where(sql`${schema.labels.name} = ${name} COLLATE NOCASE`)
				.get() ?? null
		);
	}

	/**
	 * Store a new label. The name is validated (1..MAX_LABEL_NAME_LENGTH
	 * characters, trimmed, unique per mailbox case-insensitively) and a
	 * mailbox already holding MAX_LABELS refuses the write, so a runaway
	 * caller cannot grow the table without limit — labels are kept, never
	 * pruned. Throws LabelValidationError so routes can answer with a 400.
	 */
	createLabel(input: LabelInput | null): Label {
		const name = normalizeLabelName(input?.name);
		const color = normalizeLabelColor(input?.color);
		if (this.#getLabelByName(name)) {
			throw new LabelValidationError(
				`A label named "${name}" already exists`,
			);
		}
		if (this.#countLabels() >= MAX_LABELS) {
			throw new LabelValidationError(
				`A mailbox can hold at most ${MAX_LABELS} labels`,
			);
		}
		const row: Label = {
			id: crypto.randomUUID(),
			name,
			color,
			created_at: new Date().toISOString(),
		};
		this.db.insert(schema.labels).values(row).run();
		return row;
	}

	/**
	 * Apply a partial change to one label: omitted fields keep their stored
	 * value, an explicit null (or blank) color clears it, and a rename that
	 * collides with another label's name (case-insensitively) is refused.
	 * Returns the updated row, or null when the id is unknown (the route
	 * answers 404).
	 */
	updateLabel(id: string, patch: LabelPatch | null): Label | null {
		const existing = this.db
			.select()
			.from(schema.labels)
			.where(eq(schema.labels.id, id))
			.get();
		if (!existing) return null;
		const name =
			patch?.name === undefined ? existing.name : normalizeLabelName(patch.name);
		const color =
			patch?.color === undefined
				? existing.color
				: normalizeLabelColor(patch.color);
		if (name !== existing.name) {
			const clash = this.#getLabelByName(name);
			if (clash && clash.id !== id) {
				throw new LabelValidationError(
					`A label named "${name}" already exists`,
				);
			}
		}
		this.db
			.update(schema.labels)
			.set({ name, color })
			.where(eq(schema.labels.id, id))
			.run();
		return { ...existing, name, color };
	}

	/**
	 * Remove one label and every assignment of it. The messages themselves
	 * are never touched. Returns false when the id is unknown.
	 */
	deleteLabel(id: string): boolean {
		const existing = this.db
			.select({ id: schema.labels.id })
			.from(schema.labels)
			.where(eq(schema.labels.id, id))
			.get();
		if (!existing) return false;
		this.db
			.delete(schema.emailLabels)
			.where(eq(schema.emailLabels.label_id, id))
			.run();
		this.db.delete(schema.labels).where(eq(schema.labels.id, id)).run();
		return true;
	}

	/**
	 * Attach one label to one email. Both sides must exist — the result says
	 * which one was missing so the route can answer a 404 by name — and
	 * attaching a label the email already carries is a no-op, not an error.
	 * Answers the email's labels after the change.
	 */
	addLabelToEmail(emailId: string, labelId: string): LabelEmailResult {
		const email = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.id, emailId))
			.get();
		if (!email) return { ok: false, error: "Email not found" };
		const label = this.db
			.select({ id: schema.labels.id })
			.from(schema.labels)
			.where(eq(schema.labels.id, labelId))
			.get();
		if (!label) return { ok: false, error: "Label not found" };
		this.db
			.insert(schema.emailLabels)
			.values({
				email_id: emailId,
				label_id: labelId,
				created_at: new Date().toISOString(),
			})
			.onConflictDoNothing()
			.run();
		return { ok: true, labels: this.listLabelsForEmail(emailId) };
	}

	/**
	 * Detach one label from one email. Both sides must exist; detaching a
	 * label the email does not carry is a no-op, not an error. Answers the
	 * email's labels after the change.
	 */
	removeLabelFromEmail(emailId: string, labelId: string): LabelEmailResult {
		const email = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.id, emailId))
			.get();
		if (!email) return { ok: false, error: "Email not found" };
		const label = this.db
			.select({ id: schema.labels.id })
			.from(schema.labels)
			.where(eq(schema.labels.id, labelId))
			.get();
		if (!label) return { ok: false, error: "Label not found" };
		this.db
			.delete(schema.emailLabels)
			.where(
				and(
					eq(schema.emailLabels.email_id, emailId),
					eq(schema.emailLabels.label_id, labelId),
				),
			)
			.run();
		return { ok: true, labels: this.listLabelsForEmail(emailId) };
	}

	/**
	 * The labels one email carries, ordered by name (case-insensitive). The
	 * join to `emails` means a deleted message never shows a label, even if
	 * an assignment row somehow outlived it.
	 */
	listLabelsForEmail(emailId: string): Label[] {
		return this.db
			.select({
				id: schema.labels.id,
				name: schema.labels.name,
				color: schema.labels.color,
				created_at: schema.labels.created_at,
			})
			.from(schema.emailLabels)
			.innerJoin(
				schema.labels,
				eq(schema.labels.id, schema.emailLabels.label_id),
			)
			.innerJoin(
				schema.emails,
				eq(schema.emails.id, schema.emailLabels.email_id),
			)
			.where(eq(schema.emailLabels.email_id, emailId))
			.orderBy(
				sql`${schema.labels.name} COLLATE NOCASE ASC`,
				asc(schema.labels.created_at),
				asc(schema.labels.id),
			)
			.all();
	}

	/** How many templates this mailbox holds (the create-time cap check). */
	#countTemplates(): number {
		const row = this.db
			.select({ total: sql<number>`COUNT(*)`.mapWith(Number) })
			.from(schema.templates)
			.get();
		return row?.total ?? 0;
	}

	/**
	 * Store a new template. Every field is validated and bounded
	 * (workers/lib/templates.ts) and a mailbox already holding MAX_TEMPLATES
	 * refuses the write, so a runaway caller cannot grow the table without
	 * limit — templates are kept, never pruned. Throws
	 * TemplateValidationError so routes can answer with a 400.
	 */
	createTemplate(input: TemplateInput): Template {
		const name = normalizeTemplateName(input?.name);
		const subject = normalizeTemplateSubject(input?.subject);
		const body = normalizeTemplateBody(input?.body);
		if (this.#countTemplates() >= MAX_TEMPLATES) {
			throw new TemplateValidationError(
				`A mailbox can hold at most ${MAX_TEMPLATES} templates`,
			);
		}
		const now = new Date().toISOString();
		const row: Template = {
			id: crypto.randomUUID(),
			name,
			subject,
			body,
			created_at: now,
			updated_at: now,
		};
		this.db.insert(schema.templates).values(row).run();
		return row;
	}

	/**
	 * Apply a partial change to one template: omitted fields keep their
	 * stored value, an explicit null (or blank) subject clears it, and every
	 * supplied field is validated and bounded before it is stored. Returns
	 * the updated row, or null when the id is unknown (the route answers
	 * 404). updated_at is stamped on every successful write.
	 */
	updateTemplate(id: string, patch: TemplatePatch): Template | null {
		const existing = this.db
			.select()
			.from(schema.templates)
			.where(eq(schema.templates.id, id))
			.get();
		if (!existing) return null;

		const name =
			patch?.name === undefined
				? existing.name
				: normalizeTemplateName(patch.name);
		const subject =
			patch?.subject === undefined
				? existing.subject
				: normalizeTemplateSubject(patch.subject);
		const body =
			patch?.body === undefined
				? existing.body
				: normalizeTemplateBody(patch.body);
		const updatedAt = new Date().toISOString();

		this.db
			.update(schema.templates)
			.set({ name, subject, body, updated_at: updatedAt })
			.where(eq(schema.templates.id, id))
			.run();
		return { ...existing, name, subject, body, updated_at: updatedAt };
	}

	/** Remove one template. Returns false when the id is unknown. */
	deleteTemplate(id: string): boolean {
		const existing = this.db
			.select({ id: schema.templates.id })
			.from(schema.templates)
			.where(eq(schema.templates.id, id))
			.get();
		if (!existing) return false;
		this.db.delete(schema.templates).where(eq(schema.templates.id, id)).run();
		return true;
	}


	// ── Morning digest (built for the cron sweep and the digest route) ──

	/**
	 * The mailbox's morning brief over `window`: what arrived, what still
	 * needs a reply, how the arrivals break down by category and which
	 * follow-up reminders fired. Read-only — it writes nothing, never
	 * touches the alarm and never sends mail; the caller decides whether to
	 * deliver it (see workers/lib/digest-sweep.ts).
	 *
	 * An "arrival" is a stored message whose receive `date` falls in the
	 * window and whose folder is neither Sent nor Draft (a sent copy and a
	 * draft are not mail that arrived). Spam-marked arrivals are counted in
	 * `counts.spam` but excluded from `recent` and `needs_reply`, matching
	 * the new-mail notifier, which never notifies for spam.
	 *
	 * `needs_reply` mirrors the list query's predicate exactly
	 * (getThreadedEmails): the newest window arrival of a conversation whose
	 * overall newest message is not in Sent or Draft and whose conversation
	 * contains at least one read message. Its count is not capped; the ref
	 * list is.
	 */
	buildDigest(window: { from: string; to: string }): Digest {
		// The mailbox's own address is the DO's name (see requireMailbox).
		const mailboxId = this.ctx.id.name ?? "";
		// ?1 spam folder name, ?2 spam category id — the order every query
		// below binds them in, because spamMarkedSql() references them.
		const spamArgs: (string | number)[] = [Folders.SPAM, SPAM_CATEGORY_ID];

		const countsRow = [
			...this.ctx.storage.sql.exec(
				`SELECT
					COUNT(*) as received,
					SUM(CASE WHEN e.read = 0 THEN 1 ELSE 0 END) as unread,
					SUM(CASE WHEN e.starred = 1 THEN 1 ELSE 0 END) as starred,
					SUM(CASE WHEN ${spamMarkedSql("e")} THEN 1 ELSE 0 END) as spam
				 FROM emails e
				 WHERE e.date >= ?3 AND e.date <= ?4
				   AND ${notSentSql("e.folder_id")}
				   AND ${notDraftSql("e.folder_id")}`,
				...spamArgs,
				window.from,
				window.to,
			),
		][0] as
			| {
					received: number | null;
					unread: number | null;
					starred: number | null;
					spam: number | null;
			  }
			| undefined;

		const needsReplyCountRow = [
			...this.ctx.storage.sql.exec(
				`${DIGEST_NEEDS_REPLY_CTE}
				 SELECT COUNT(*) as total
				 FROM digest_candidates
				 ${DIGEST_NEEDS_REPLY_WHERE}`,
				...spamArgs,
				window.from,
				window.to,
			),
		][0] as { total: number | null } | undefined;

		const needsReplyRows = [
			...this.ctx.storage.sql.exec(
				`${DIGEST_NEEDS_REPLY_CTE}
				 SELECT c.id, c.subject, c.sender, c.date, c.category, c.folder_id,
					COALESCE(f.name, c.folder_id) as folder_name
				 FROM digest_candidates c
				 LEFT JOIN folders f ON f.id = c.folder_id
				 ${DIGEST_NEEDS_REPLY_WHERE}
				 ORDER BY c.date DESC, c.id DESC
				 LIMIT ?5`,
				...spamArgs,
				window.from,
				window.to,
				DIGEST_NEEDS_REPLY_LIMIT,
			),
		] as unknown as DigestRefRow[];

		const recentRows = [
			...this.ctx.storage.sql.exec(
				`SELECT e.id, e.subject, e.sender, e.date, e.category, e.folder_id,
					COALESCE(f.name, e.folder_id) as folder_name
				 FROM emails e
				 LEFT JOIN folders f ON f.id = e.folder_id
				 WHERE e.date >= ?3 AND e.date <= ?4
				   AND ${notSentSql("e.folder_id")}
				   AND ${notDraftSql("e.folder_id")}
				   AND ${notSpamSql("e")}
				 ORDER BY e.date DESC, e.id DESC
				 LIMIT ?5`,
				...spamArgs,
				window.from,
				window.to,
				DIGEST_RECENT_LIMIT,
			),
		] as unknown as DigestRefRow[];

		const categoryRows = [
			...this.ctx.storage.sql.exec(
				`SELECT e.category as category, COUNT(*) as count
				 FROM emails e
				 WHERE e.date >= ?3 AND e.date <= ?4
				   AND ${notSentSql("e.folder_id")}
				   AND ${notDraftSql("e.folder_id")}
				   AND e.category IS NOT NULL
				 GROUP BY e.category
				 ORDER BY count DESC, category ASC
				 LIMIT ?5`,
				...spamArgs,
				window.from,
				window.to,
				DIGEST_CATEGORY_LIMIT,
			),
		] as unknown as { category: string; count: number }[];

		// Fired reminders are not windowed: `reminded_at` stays set until the
		// thread is answered or the reminder dismissed, so the newest ones
		// are exactly the nudges that are still outstanding.
		const reminderRows = [
			...this.ctx.storage.sql.exec(
				`SELECT e.id, e.subject, e.sender, e.reminded_at as fired_at
				 FROM emails e
				 WHERE e.reminded_at IS NOT NULL
				 ORDER BY e.reminded_at DESC, e.id DESC
				 LIMIT ?1`,
				DIGEST_REMINDER_LIMIT,
			),
		] as unknown as {
			id: string;
			subject: string | null;
			sender: string | null;
			fired_at: string | null;
		}[];

		// Open tasks/deadlines the items extractor stored for this mailbox:
		// how many are open, how many are overdue or due today (UTC), and the
		// soonest few by due date. Read-only like the rest of the digest, and
		// metadata only — items carry a bounded title and due instant, never
		// message bodies.
		const itemDayStart = `${window.to.slice(0, 10)}T00:00:00.000Z`;
		const itemDayEnd = new Date(
			Date.parse(itemDayStart) + 24 * 60 * 60 * 1000,
		).toISOString();
		const itemCountsRow = [
			...this.ctx.storage.sql.exec(
				`SELECT
					SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_count,
					SUM(CASE WHEN status = 'open' AND due_at IS NOT NULL AND due_at < ?1 THEN 1 ELSE 0 END) as overdue,
					SUM(CASE WHEN status = 'open' AND due_at >= ?1 AND due_at < ?2 THEN 1 ELSE 0 END) as due_today
				 FROM extracted_items`,
				itemDayStart,
				itemDayEnd,
			),
		][0] as
			| { open_count: number | null; overdue: number | null; due_today: number | null }
			| undefined;
		const dueItemRows = [
			...this.ctx.storage.sql.exec(
				`SELECT id, title, due_at, email_id FROM extracted_items
				 WHERE status = 'open' AND due_at IS NOT NULL
				 ORDER BY due_at ASC, created_at ASC
				 LIMIT ?1`,
				DIGEST_ITEM_LIMIT,
			),
		] as unknown as {
			id: string;
			title: string | null;
			due_at: string | null;
			email_id: string | null;
		}[];

		const toRef = (row: DigestRefRow): DigestEmailRef => ({
			id: row.id,
			subject: row.subject ?? "",
			sender: row.sender ?? "",
			date: row.date ?? "",
			folder: row.folder_name ?? row.folder_id,
			category: row.category ?? null,
		});

		return {
			mailbox: mailboxId,
			generated_at: new Date().toISOString(),
			window: { from: window.from, to: window.to },
			counts: {
				received: countsRow?.received ?? 0,
				unread: countsRow?.unread ?? 0,
				starred: countsRow?.starred ?? 0,
				spam: countsRow?.spam ?? 0,
				needs_reply: needsReplyCountRow?.total ?? 0,
			},
			by_category: categoryRows.map((row) => ({
				category: String(row.category),
				count: Number(row.count) || 0,
			})),
			needs_reply: needsReplyRows.map(toRef),
			recent: recentRows.map(toRef),
			reminders: reminderRows.map((row) => ({
				id: String(row.id),
				subject: row.subject ?? "",
				sender: row.sender ?? "",
				fired_at: row.fired_at ?? "",
			})),
			items: {
				open: itemCountsRow?.open_count ?? 0,
				overdue: itemCountsRow?.overdue ?? 0,
				due_today: itemCountsRow?.due_today ?? 0,
				due: dueItemRows.map((row) => ({
					id: String(row.id),
					title: row.title ?? "",
					due_at: row.due_at ?? "",
					email_id: row.email_id ?? "",
				})),
			},
		};
	}

	/**
	 * Claim the mailbox's digest for one UTC day (`YYYY-MM-DD`).
	 *
	 * Insert-or-ignore on the `day` primary key: only the call that actually
	 * inserted the row answers `true`, so a retried or duplicated cron run —
	 * or a manual invocation after the cron already ran — can never deliver
	 * the same day's digest twice. The row starts pending (`ok = 0`) and is
	 * settled by recordDigestDelivery. Prunes the mailbox back to its newest
	 * MAX_DIGEST_DELIVERIES days whenever a claim lands.
	 */
	claimDigestDay(day: string): boolean {
		const cursor = this.ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO digest_deliveries (day, delivered_at, ok)
			 VALUES (?1, ?2, 0)`,
			day,
			new Date().toISOString(),
		);
		if (cursor.rowsWritten === 0) return false;

		this.ctx.storage.sql.exec(
			`DELETE FROM digest_deliveries
			 WHERE day NOT IN (
				SELECT day FROM digest_deliveries
				ORDER BY day DESC
				LIMIT ?1
			 )`,
			MAX_DIGEST_DELIVERIES,
		);
		return true;
	}

	/**
	 * Settle one claimed digest day with the delivery outcome. Best-effort:
	 * an unknown or already-pruned day updates nothing. `status` is the
	 * upstream HTTP status (null when the request never got a response) and
	 * `error` the failure reason (null on success).
	 */
	recordDigestDelivery(day: string, result: DigestDeliveryResult): void {
		this.ctx.storage.sql.exec(
			`UPDATE digest_deliveries
			 SET delivered_at = ?1, ok = ?2, status = ?3, error = ?4
			 WHERE day = ?5`,
			new Date().toISOString(),
			result.ok ? 1 : 0,
			result.status,
			result.error,
			day,
		);
	}

	// ── Extracted items (tasks & deadlines) ────────────────────────

	/**
	 * Store the items extracted from one inbound email. Ids and timestamps
	 * are minted here (crypto.randomUUID, ISO now) so a direct RPC caller
	 * cannot invent an id or a created_at; every item is bounded again before
	 * it is written. Returns the stored rows.
	 *
	 * After the insert the mailbox is pruned back to MAX_EXTRACTED_ITEMS rows
	 * by deleting the oldest CLOSED items (done or dismissed). Open items are
	 * never deleted: a mailbox holding more open items than the cap keeps
	 * them all rather than losing work.
	 */
	insertItems(
		emailId: string,
		threadId: string | null,
		items: ExtractedItemInput[],
	): ExtractedItem[] {
		const now = new Date().toISOString();
		const rows: ExtractedItem[] = [];
		for (const item of items ?? []) {
			const normalized = this.#normalizeItemInput(item);
			if (!normalized) continue;
			rows.push({
				id: crypto.randomUUID(),
				email_id: emailId,
				thread_id: threadId ?? null,
				kind: normalized.kind,
				title: normalized.title,
				details: normalized.details,
				due_at: normalized.due_at,
				status: "open",
				created_at: now,
				updated_at: now,
			});
		}
		if (rows.length === 0) return [];
		this.db.insert(schema.extractedItems).values(rows).run();
		this.#pruneExtractedItems();
		return rows;
	}


	/**
	 * One page of stored items, newest first, plus the total matching the
	 * filters. `status` narrows to one lifecycle state (omit for all),
	 * `due` to one due bucket, `limit` defaults to 50 and is capped at
	 * ITEM_LIST_LIMIT_MAX, and `page` is 1-based. Due buckets are computed
	 * against UTC day boundaries (overdue = before today, today = today,
	 * upcoming = after today, none = no due date); due_at is stored as ISO
	 * 8601 UTC, so string comparison orders it correctly.
	 */
	listItems(filters: ItemListFilters = {}): ItemListPage {
		const rawLimit = Math.trunc(filters.limit ?? ITEM_LIST_LIMIT_DEFAULT);
		const limit = Number.isFinite(rawLimit)
			? Math.min(Math.max(rawLimit, 1), ITEM_LIST_LIMIT_MAX)
			: ITEM_LIST_LIMIT_DEFAULT;
		const rawPage = Math.trunc(filters.page ?? 1);
		const page = Number.isFinite(rawPage) ? Math.max(rawPage, 1) : 1;

		const conditions = this.#itemConditions(filters);
		const where = conditions.length > 0 ? and(...conditions) : undefined;

		const totalCount =
			this.db
				.select({ total: sql<number>`COUNT(*)`.mapWith(Number) })
				.from(schema.extractedItems)
				.where(where)
				.get()?.total ?? 0;

		// The rows carry their source message's sender and subject: the tasks
		// view renders both on every row, and joining them here is what keeps
		// that view to one request per group instead of one per item.
		const items = this.db
			.select({
				...getTableColumns(schema.extractedItems),
				sender: schema.emails.sender,
				subject: schema.emails.subject,
			})
			.from(schema.extractedItems)
			.leftJoin(
				schema.emails,
				eq(schema.emails.id, schema.extractedItems.email_id),
			)
			.where(where)
			.orderBy(
				desc(schema.extractedItems.created_at),
				sql`extracted_items.rowid DESC`,
			)
			.limit(limit)
			.offset((page - 1) * limit)
			.all()
			.map((row) =>
				parseExtractedItemRow(row, {
					sender: row.sender,
					subject: row.subject,
				}),
			)
			.filter((item): item is ExtractedItem => item !== null);

		return { items, totalCount };
	}


	/**
	 * Every item one message contributed, newest first — the message panel's
	 * card. The extractor stores at most MAX_EXTRACTED_ITEMS_PER_EMAIL rows
	 * per message; the limit is a safety net for a directly seeded database.
	 */
	listItemsForEmail(emailId: string): ExtractedItem[] {
		return this.db
			.select()
			.from(schema.extractedItems)
			.where(eq(schema.extractedItems.email_id, emailId))
			.orderBy(desc(schema.extractedItems.created_at), sql`rowid DESC`)
			.limit(ITEM_LIST_LIMIT_MAX)
			.all()
			.map((row) => parseExtractedItemRow(row))
			.filter((item): item is ExtractedItem => item !== null);
	}


	/**
	 * Move one item to a new lifecycle state (open | done | dismissed),
	 * stamping updated_at, and return the stored row. An unknown id — and a
	 * status outside the vocabulary, so a direct RPC caller cannot write
	 * junk — answers null; the route validates the status first and answers
	 * 404 for the id.
	 */
	updateItemStatus(id: string, status: ItemStatus): ExtractedItem | null {
		if (!isItemStatus(status)) return null;
		const existing = this.db
			.select()
			.from(schema.extractedItems)
			.where(eq(schema.extractedItems.id, id))
			.get();
		if (!existing) return null;

		this.db
			.update(schema.extractedItems)
			.set({ status, updated_at: new Date().toISOString() })
			.where(eq(schema.extractedItems.id, id))
			.run();

		const stored = this.db
			.select()
			.from(schema.extractedItems)
			.where(eq(schema.extractedItems.id, id))
			.get();
		return stored ? parseExtractedItemRow(stored) : null;
	}


	/** How many items this mailbox stores. */
	#countExtractedItems(): number {
		const row = this.db
			.select({ total: sql<number>`COUNT(*)`.mapWith(Number) })
			.from(schema.extractedItems)
			.get();
		return row?.total ?? 0;
	}


	/** How many stored items are closed (done or dismissed). */
	#countClosedExtractedItems(): number {
		const row = this.db
			.select({ total: sql<number>`COUNT(*)`.mapWith(Number) })
			.from(schema.extractedItems)
			.where(ne(schema.extractedItems.status, "open"))
			.get();
		return row?.total ?? 0;
	}


	/**
	 * Keep the mailbox at MAX_EXTRACTED_ITEMS rows by deleting the oldest
	 * CLOSED items (done or dismissed), oldest first. Open items are never
	 * deleted, so a mailbox whose rows above the cap are all open is left as
	 * it is — the cap is housekeeping for finished work, not a reason to
	 * lose a task. One statement, run after every insert.
	 */
	#pruneExtractedItems(): void {
		const total = this.#countExtractedItems();
		if (total <= MAX_EXTRACTED_ITEMS) return;
		const closed = this.#countClosedExtractedItems();
		const doomed = Math.min(total - MAX_EXTRACTED_ITEMS, closed);
		if (doomed <= 0) return;
		this.ctx.storage.sql.exec(
			`DELETE FROM extracted_items
			 WHERE id IN (
				SELECT id FROM extracted_items
				WHERE status != 'open'
				ORDER BY created_at ASC, rowid ASC
				LIMIT ?1
			 )`,
			doomed,
		);
	}


	/**
	 * SQL conditions for one items page: status and due bucket, nothing else.
	 * Values outside the vocabulary are ignored rather than rejected, so a
	 * direct RPC caller passing junk gets the unfiltered list back.
	 */
	#itemConditions(filters: ItemListFilters): SQL[] {
		const conditions: SQL[] = [];
		if (isItemStatus(filters.status)) {
			conditions.push(eq(schema.extractedItems.status, filters.status));
		}
		const due = filters.due;
		if (!isItemDueFilter(due)) return conditions;
		if (due === "none") {
			conditions.push(isNull(schema.extractedItems.due_at));
			return conditions;
		}
		const startOfToday = new Date();
		startOfToday.setUTCHours(0, 0, 0, 0);
		const startIso = startOfToday.toISOString();
		const endIso = new Date(
			startOfToday.getTime() + 24 * 60 * 60 * 1000,
		).toISOString();
		if (due === "overdue") {
			conditions.push(
				and(
					isNotNull(schema.extractedItems.due_at),
					lt(schema.extractedItems.due_at, startIso),
				)!,
			);
		} else if (due === "today") {
			conditions.push(
				and(
					gte(schema.extractedItems.due_at, startIso),
					lt(schema.extractedItems.due_at, endIso),
				)!,
			);
		} else {
			conditions.push(gte(schema.extractedItems.due_at, endIso));
		}
		return conditions;
	}


	/**
	 * The mailbox's storage footprint as the storage route reports it:
	 * SQLite database bytes, the attachments table's byte total and row
	 * count, and the email row count. Byte accounting only — the R2
	 * settings JSON is measured by the route itself (this object cannot
	 * see R2) and no limit is enforced anywhere.
	 */
	getStorageUsage(): Omit<StorageUsage, "mailbox_json_bytes"> {
		const attachmentRow = [
			...this.ctx.storage.sql.exec(
				"SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS count FROM attachments",
			),
		][0] as { bytes: number; count: number };
		const emailRow = [
			...this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM emails"),
		][0] as { count: number };
		return {
			database_bytes: this.ctx.storage.sql.databaseSize,
			attachment_bytes: attachmentRow.bytes,
			attachment_count: attachmentRow.count,
			email_count: emailRow.count,
		};
	}


	/**
	 * One bounded page of stored messages for the mbox and EML export routes
	 * (GET /api/v1/mailboxes/:mailboxId/export and .../emails/:emailId/eml):
	 * the raw stored fields an export reconstructs from — sender, recipient,
	 * cc, date, subject, the stored message_id and body — plus each
	 * message's attachment metadata (filename, mimetype, size). The mailbox
	 * never stores the wire source, so the routes rebuild a message from
	 * this page rather than copying bytes.
	 *
	 * Rows come back oldest-first (date, then rowid), so a paged export
	 * reads the mailbox in one stable order and `has_more` says whether
	 * another page follows. Both inputs are clamped and the limit is capped
	 * at 500, so a single call can never pull an unbounded number of rows.
	 */
	listEmailsForExport(
		options: { page?: number | undefined; limit?: number | undefined } = {},
	): {
		emails: {
			id: string;
			sender: string | null;
			recipient: string | null;
			cc: string | null;
			date: string | null;
			subject: string | null;
			message_id: string | null;
			body: string | null;
			attachments: { filename: string; mimetype: string; size: number }[];
		}[];
		total: number;
		has_more: boolean;
	} {
		const requestedLimit = Number(options.limit);
		const limit = Number.isFinite(requestedLimit)
			? Math.min(Math.max(Math.trunc(requestedLimit), 1), 500)
			: 200;
		const requestedPage = Number(options.page);
		const page = Number.isFinite(requestedPage)
			? Math.max(Math.trunc(requestedPage), 1)
			: 1;
		const offset = (page - 1) * limit;

		const rows = [
			...this.ctx.storage.sql.exec(
				`SELECT id, sender, recipient, cc, date, subject, message_id, body
				 FROM emails
				 ORDER BY date ASC, rowid ASC
				 LIMIT ?1 OFFSET ?2`,
				limit,
				offset,
			),
		] as unknown as {
			id: string;
			sender: string | null;
			recipient: string | null;
			cc: string | null;
			date: string | null;
			subject: string | null;
			message_id: string | null;
			body: string | null;
		}[];

		// Attachment metadata for the whole page, grouped here rather than
		// fetched per message. Durable Object SQLite caps one statement at
		// 100 bound parameters, so the page's ids go through in chunks
		// instead of a single IN list.
		const attachmentsByEmail = new Map<
			string,
			{ filename: string; mimetype: string; size: number }[]
		>();
		const attachmentLookupChunk = 100;
		for (let start = 0; start < rows.length; start += attachmentLookupChunk) {
			const chunk = rows.slice(start, start + attachmentLookupChunk);
			const placeholders = chunk.map((_, index) => `?${index + 1}`).join(",");
			const attachmentRows = [
				...this.ctx.storage.sql.exec(
					`SELECT email_id, filename, mimetype, size FROM attachments
					 WHERE email_id IN (${placeholders})
					 ORDER BY rowid ASC`,
					...chunk.map((row) => row.id),
				),
			] as unknown as {
				email_id: string;
				filename: string;
				mimetype: string;
				size: number;
			}[];
			for (const attachment of attachmentRows) {
				const list = attachmentsByEmail.get(attachment.email_id) ?? [];
				list.push({
					filename: attachment.filename,
					mimetype: attachment.mimetype,
					size: attachment.size,
				});
				attachmentsByEmail.set(attachment.email_id, list);
			}
		}

		const totalRow = [
			...this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM emails"),
		][0] as { count: number };

		return {
			emails: rows.map((row) => ({
				...row,
				attachments: attachmentsByEmail.get(row.id) ?? [],
			})),
			total: totalRow.count,
			has_more: offset + rows.length < totalRow.count,
		};
	}


	// ── Mailbox import (staged mbox/EML files) ─────────────────────

	/**
	 * Record one staged import job: the file's bytes are already in R2
	 * (`imports/{mailboxId}/{jobId}.mbox`), the row starts `pending` with a
	 * zero cursor, and the alarm is armed so the drain begins on the next
	 * wake. Nothing is parsed here.
	 */
	async createImportJob(input: CreateImportJobInput): Promise<ImportJobRow> {
		const now = input.createdAt ?? new Date().toISOString();
		this.ctx.storage.sql.exec(
			`INSERT INTO import_jobs
				(id, filename, r2_key, size, cursor, status, imported, skipped, failed, last_error, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, 0, 'pending', 0, 0, 0, NULL, ?5, ?5)`,
			input.id,
			input.filename,
			input.r2Key,
			input.size,
			now,
		);
		await this.#armAlarm();

		const stored = this.#importJobById(input.id);
		if (!stored) {
			throw new Error("createImportJob: the inserted row could not be read back.");
		}
		return stored;
	}

	/**
	 * The mailbox's import jobs, newest first (ties broken by insertion
	 * order). `limit` defaults to DEFAULT_IMPORT_JOB_LIMIT and is capped at
	 * MAX_IMPORT_JOB_LIST.
	 */
	listImportJobs(options: { limit?: number } = {}): ImportJobRow[] {
		const requested = Number(options.limit);
		const limit = Number.isFinite(requested)
			? Math.min(Math.max(Math.trunc(requested), 1), MAX_IMPORT_JOB_LIST)
			: DEFAULT_IMPORT_JOB_LIMIT;
		const rows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM import_jobs ORDER BY created_at DESC, rowid DESC LIMIT ?1`,
				limit,
			),
		] as unknown as ImportJobDbRow[];
		return rows.map((row) => importJobRow(row));
	}

	/**
	 * Advance one job by a drained batch: the cursor and the three counts
	 * move in one statement, and the job reads `running` from then on.
	 * Returns the updated row, or null when the id is gone.
	 */
	claimImportBatch(id: string, batch: ImportJobBatch): ImportJobRow | null {
		this.ctx.storage.sql.exec(
			`UPDATE import_jobs
			 SET cursor = ?1,
			     imported = imported + ?2,
			     skipped = skipped + ?3,
			     failed = failed + ?4,
			     status = 'running',
			     updated_at = ?5
			 WHERE id = ?6`,
			Math.max(Math.trunc(batch.cursor), 0),
			Math.max(Math.trunc(batch.imported), 0),
			Math.max(Math.trunc(batch.skipped), 0),
			Math.max(Math.trunc(batch.failed), 0),
			new Date().toISOString(),
			id,
		);
		return this.#importJobById(id);
	}

	/**
	 * Mark a fully drained job `done` and clear any stale error; returns the
	 * updated row or null when the id is gone.
	 */
	finishImportJob(id: string): ImportJobRow | null {
		this.ctx.storage.sql.exec(
			`UPDATE import_jobs SET status = 'done', last_error = NULL, updated_at = ?1 WHERE id = ?2`,
			new Date().toISOString(),
			id,
		);
		return this.#importJobById(id);
	}

	/**
	 * Record why a job could not be imported; the row stays for the
	 * operator to see, with the reason in `last_error`.
	 */
	failImportJob(id: string, reason: string): ImportJobRow | null {
		this.ctx.storage.sql.exec(
			`UPDATE import_jobs SET status = 'failed', last_error = ?1, updated_at = ?2 WHERE id = ?3`,
			reason,
			new Date().toISOString(),
			id,
		);
		return this.#importJobById(id);
	}

	/**
	 * Cancel a pending or running job: the row becomes `cancelled` and the
	 * drain never picks it up again. Nothing is deleted here — the route
	 * removes the staged object, and the row keeps its r2_key so the
	 * operator can see where the bytes lived. Returns `{ ok: true, job }`
	 * with the updated row, or `{ ok: false, error }` when the id is unknown
	 * or the job has already finished.
	 */
	cancelImportJob(id: string): ImportJobCancelResult {
		const row = this.#importJobDbRow(id);
		if (!row) return { ok: false as const, error: IMPORT_JOB_NOT_FOUND };
		if (!isImportJobActive(row.status)) {
			return {
				ok: false as const,
				error: `Only a pending or running import can be cancelled; this one is ${row.status}.`,
			};
		}

		this.ctx.storage.sql.exec(
			`UPDATE import_jobs SET status = 'cancelled', updated_at = ?1 WHERE id = ?2`,
			new Date().toISOString(),
			id,
		);

		const cancelled = this.#importJobById(id);
		if (!cancelled) return { ok: false as const, error: IMPORT_JOB_NOT_FOUND };
		return { ok: true as const, job: cancelled };
	}

	/** One raw import_jobs row by id, or null. */
	#importJobDbRow(id: string): ImportJobDbRow | null {
		const rows = [
			...this.ctx.storage.sql.exec(`SELECT * FROM import_jobs WHERE id = ?1`, id),
		] as unknown as ImportJobDbRow[];
		return rows[0] ?? null;
	}

	/** One import job in the API shape, or null when the id is unknown. */
	#importJobById(id: string): ImportJobRow | null {
		const row = this.#importJobDbRow(id);
		return row ? importJobRow(row) : null;
	}

	/** The oldest job the drain should work on: pending or running. */
	#nextImportJob(): ImportJobDbRow | null {
		const rows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM import_jobs WHERE status IN ('pending', 'running') ORDER BY created_at ASC, rowid ASC LIMIT 1`,
			),
		] as unknown as ImportJobDbRow[];
		return rows[0] ?? null;
	}

	/** One range read of a staged object as bytes, or null when it is gone. */
	async #readImportRange(r2Key: string, offset: number, length: number): Promise<Uint8Array | null> {
		const object = await this.env.BUCKET.get(r2Key, { range: { offset, length } });
		if (!object) return null;
		return new Uint8Array(await object.arrayBuffer());
	}

	/** Best-effort removal of a staged object; a failure only logs. */
	async #deleteImportObject(r2Key: string): Promise<void> {
		try {
			await this.env.BUCKET.delete(r2Key);
		} catch (e) {
			console.error(
				`Import: the staged object ${r2Key} could not be deleted:`,
				(e as Error).message,
			);
		}
	}

	/**
	 * Parse one message block and store it in the Inbox: the same decode
	 * pipeline inbound mail uses (workers/lib/mbox-import.ts), then the same
	 * createEmail the receive path calls. A duplicate Message-ID is skipped
	 * before anything is uploaded, so re-importing a stored file costs no
	 * storage; a parse or storage failure is counted failed and the batch
	 * moves on. No rule, no classifier and no notification runs here.
	 */
	async #storeImportedMessage(
		block: Uint8Array,
		options: { mbox: boolean; mailboxId: string },
	): Promise<"imported" | "skipped" | "failed"> {
		// A record with nothing but framing newlines is nothing to store.
		if (block.length === 0 || !block.some((byte) => byte !== 0x0a && byte !== 0x0d)) {
			return "skipped";
		}

		let parsed: ImportedMessage;
		try {
			parsed = await parseImportMessage(block, options);
		} catch (e) {
			console.error(`Import: a message failed to parse:`, (e as Error).message);
			return "failed";
		}
		if (parsed.email.message_id && findDuplicateEmailId(this.db, parsed.email.message_id)) {
			return "skipped";
		}

		const messageId = crypto.randomUUID();
		const attachments: AttachmentData[] = [];
		// Searchable text for this message's attachments, extracted locally
		// once the message is stored (workers/lib/attachment-text.ts). The
		// import path is storage-only: it never calls the AI conversion.
		const attachmentTextSources: {
			attachment_id: string;
			email_id: string;
			filename: string;
			mimetype: string;
			bytes: Uint8Array;
		}[] = [];
		try {
			for (const attachment of parsed.attachments) {
				const attachmentId = crypto.randomUUID();
				await this.env.BUCKET.put(
					attachmentR2Key({
						email_id: messageId,
						id: attachmentId,
						filename: attachment.filename,
					}),
					attachment.content,
				);
				attachments.push({
					id: attachmentId,
					email_id: messageId,
					filename: attachment.filename,
					mimetype: attachment.mimetype,
					size: attachment.content.byteLength,
					content_id: attachment.content_id,
					disposition: attachment.disposition,
				});
				attachmentTextSources.push({
					attachment_id: attachmentId,
					email_id: messageId,
					filename: attachment.filename,
					mimetype: attachment.mimetype,
					bytes: attachment.content,
				});
			}
			// createEmail still owns the final duplicate check, so a second
			// message with the same Message-ID inside one batch is caught too.
			const result = this.createEmail(
				Folders.INBOX,
				{ id: messageId, ...parsed.email, read: false },
				attachments,
			);
			if (result.duplicate) return "skipped";

			// Attachment text for mailbox search is extracted locally (never
			// through AI — this path is storage-only) and stored only once the
			// message itself is stored, so a skipped duplicate never leaves
			// text behind. Best-effort: a text failure must not flip an
			// imported message to failed.
			try {
				const textRows: AttachmentTextInput[] = [];
				for (const source of attachmentTextSources) {
					const text = extractAttachmentText(source.mimetype, source.filename, source.bytes);
					if (text) {
						textRows.push({
							attachment_id: source.attachment_id,
							email_id: source.email_id,
							filename: source.filename,
							mimetype: source.mimetype,
							text,
						});
					}
				}
				if (textRows.length > 0) this.storeAttachmentText(textRows);
			} catch (e) {
				console.error(`Import: attachment text could not be stored:`, (e as Error).message);
			}
			return "imported";
		} catch (e) {
			console.error(`Import: a message could not be stored:`, (e as Error).message);
			return "failed";
		}
	}

	/**
	 * Drain one bounded batch of the oldest pending or running import job.
	 *
	 * The staged bytes stay in R2 and are read in bounded slices: at most
	 * IMPORT_SLICE_BYTES per tick, grown only while a single message does
	 * not fit, and at most IMPORT_MAX_MESSAGES_PER_TICK messages stored.
	 * Each slice is split on mbox framing and every message goes through
	 * the same decode pipeline inbound mail uses before it is stored in the
	 * Inbox. Duplicates are counted skipped, never failed. The cursor and
	 * counts are written in one statement after the batch, and a job with
	 * bytes left re-arms the alarm immediately. A job whose object is gone,
	 * or whose single message exceeds the read cap, is recorded failed with
	 * the reason. Returns how many messages this batch stored (imported +
	 * skipped + failed), for the alarm log.
	 */
	async #drainImportJobs(): Promise<number> {
		const job = this.#nextImportJob();
		if (!job) return 0;

		const processed = job.imported + job.skipped + job.failed;
		// The per-job message cap is checked before any work: a job already
		// at it fails outright rather than importing an unbounded file.
		if (processed >= MAX_IMPORT_MESSAGES) {
			this.failImportJob(
				job.id,
				`This import reached the ${MAX_IMPORT_MESSAGES} message cap; the rest of the file was not imported.`,
			);
			return 0;
		}
		const budget = Math.min(
			IMPORT_MAX_MESSAGES_PER_TICK,
			MAX_IMPORT_MESSAGES - processed,
		);
		const mailboxId = this.ctx.id.name ?? "";

		// A job that already consumed its object (an empty file, or a
		// resumed one that ended exactly on a boundary) is done.
		if (job.cursor >= job.size) {
			this.finishImportJob(job.id);
			await this.#deleteImportObject(job.r2_key);
			return 0;
		}

		// The framing decision is made once, from the object's first bytes:
		// "From " means mbox records, anything else is one .eml message.
		const probeLength = Math.min(5, job.size);
		const probe = await this.#readImportRange(job.r2_key, 0, probeLength);
		if (!probe) {
			this.failImportJob(
				job.id,
				"The staged upload is missing from storage; nothing was imported.",
			);
			return 0;
		}

		let cursor = job.cursor;
		let imported = 0;
		let skipped = 0;
		let failed = 0;

		if (!isMboxFramed(probe)) {
			// A single .eml message: the whole object is one message.
			const bytes = await this.#readImportRange(job.r2_key, 0, job.size);
			if (!bytes) {
				this.failImportJob(
					job.id,
					"The staged upload is missing from storage; nothing was imported.",
				);
				return 0;
			}
			const outcome = await this.#storeImportedMessage(bytes, {
				mbox: false,
				mailboxId,
			});
			cursor = job.size;
			if (outcome === "imported") imported += 1;
			else if (outcome === "skipped") skipped += 1;
			else failed += 1;
		} else {
			let length = Math.min(IMPORT_SLICE_BYTES, job.size - cursor);
			let slice = await this.#readImportRange(job.r2_key, cursor, length);
			if (!slice) {
				this.failImportJob(
					job.id,
					"The staged upload is missing from storage; nothing was imported.",
				);
				return 0;
			}
			let split = splitMboxSlice(slice, cursor, job.size, budget);
			// Grow the read while a single message spans the whole slice, up
			// to the cap: a message larger than that fails the job below.
			while (
				split.partial &&
				length < job.size - cursor &&
				length < IMPORT_MAX_SLICE_BYTES
			) {
				length = Math.min(length * 2, IMPORT_MAX_SLICE_BYTES, job.size - cursor);
				const grown = await this.#readImportRange(job.r2_key, cursor, length);
				if (!grown) {
					this.failImportJob(
						job.id,
						"The staged upload is missing from storage; nothing was imported.",
					);
					return 0;
				}
				slice = grown;
				split = splitMboxSlice(slice, cursor, job.size, budget);
			}
			if (split.partial) {
				this.failImportJob(
					job.id,
					`A single message in this file is larger than the ${IMPORT_MAX_SLICE_BYTES / (1024 * 1024)} MiB read cap; it was not imported.`,
				);
				return 0;
			}
			for (const block of split.messages) {
				const outcome = await this.#storeImportedMessage(block, {
					mbox: true,
					mailboxId,
				});
				if (outcome === "imported") imported += 1;
				else if (outcome === "skipped") skipped += 1;
				else failed += 1;
			}
			cursor = split.nextCursor;
		}

		const updated = this.claimImportBatch(job.id, { cursor, imported, skipped, failed });
		if (updated && updated.cursor >= updated.size) {
			// Fully drained: the staged object has no further use.
			this.finishImportJob(job.id);
			await this.#deleteImportObject(updated.r2_key);
		} else if (
			updated &&
			updated.imported + updated.skipped + updated.failed >= MAX_IMPORT_MESSAGES
		) {
			this.failImportJob(
				job.id,
				`This import reached the ${MAX_IMPORT_MESSAGES} message cap; the rest of the file was not imported.`,
			);
		}
		return imported + skipped + failed;
	}


	/**
	 * Bound one caller-supplied item before it is stored: a missing title
	 * makes the row unusable (null, dropped), kind falls back to task, text
	 * is trimmed and clamped, and an unparseable due date becomes null.
	 */
	#normalizeItemInput(item: ExtractedItemInput): ExtractedItemInput | null {
		const title =
			typeof item?.title === "string"
				? item.title.trim().slice(0, MAX_ITEM_TITLE_LENGTH)
				: "";
		if (!title) return null;
		const details =
			typeof item.details === "string" && item.details.trim()
				? item.details.trim().slice(0, MAX_ITEM_DETAILS_LENGTH)
				: null;
		const dueAt =
			typeof item.due_at === "string" &&
			Number.isFinite(Date.parse(item.due_at))
				? new Date(item.due_at).toISOString()
				: null;
		return {
			kind: isItemKind(item?.kind) ? item.kind : "task",
			title,
			details,
			due_at: dueAt,
		};
	}


	// ── Sender policy CRUD (per-mailbox allow/block list) ──────────


	/**
	 * Every sender-policy entry, oldest first (ties broken by address) so the
	 * settings card lists entries in the order they were added. Rows whose
	 * stored policy is not a known value are ignored rather than trusted.
	 */
	listSenderPolicy(): SenderPolicyEntry[] {
		const rows = [
			...this.ctx.storage.sql.exec(
				`SELECT address, policy, created_at
				 FROM sender_policy
				 ORDER BY created_at ASC, address ASC`,
			),
		] as unknown as SenderPolicyRow[];
		return rows
			.map(parseSenderPolicyRow)
			.filter((entry): entry is SenderPolicyEntry => entry !== null);
	}


	/** One entry by address (trimmed + lowercased), or null when absent. */
	getSenderPolicy(address: string): SenderPolicyEntry | null {
		const normalized = normalizeSenderAddress(address);
		if (!normalized) return null;
		const rows = [
			...this.ctx.storage.sql.exec(
				`SELECT address, policy, created_at
				 FROM sender_policy WHERE address = ?1`,
				normalized,
			),
		] as unknown as SenderPolicyRow[];
		const row = rows[0];
		return row ? parseSenderPolicyRow(row) : null;
	}


	/**
	 * Insert or replace the policy for one sender address. The address is
	 * stored trimmed + lowercased; an update keeps the original created_at so
	 * the list order stays stable. Throws SenderPolicyValidationError for an
	 * empty address or an unknown policy so routes can answer with a 400.
	 */
	// eslint-disable-next-line @typescript-eslint/require-await -- callers of this method await it for a rejected promise on invalid input.
	async setSenderPolicy(
		address: string,
		policy: SenderPolicy,
	): Promise<SenderPolicyEntry> {
		const normalized = normalizeSenderAddress(address);
		if (!normalized) {
			throw new SenderPolicyValidationError("A sender address is required");
		}
		if (!isSenderPolicy(policy)) {
			throw new SenderPolicyValidationError(
				`Unknown sender policy: ${String(policy)}`,
			);
		}
		const existing = this.getSenderPolicy(normalized);
		const createdAt = existing?.created_at ?? new Date().toISOString();
		this.ctx.storage.sql.exec(
			`INSERT INTO sender_policy (address, policy, created_at)
			 VALUES (?1, ?2, ?3)
			 ON CONFLICT(address) DO UPDATE SET policy = excluded.policy`,
			normalized,
			policy,
			createdAt,
		);
		return { address: normalized, policy, created_at: createdAt };
	}


	/** Remove an entry. Returns false when the address has no entry. */
	removeSenderPolicy(address: string): boolean {
		const normalized = normalizeSenderAddress(address);
		if (!normalized) return false;
		if (!this.getSenderPolicy(normalized)) return false;
		this.ctx.storage.sql.exec(
			`DELETE FROM sender_policy WHERE address = ?1`,
			normalized,
		);
		return true;
	}


	/**
	 * One-click feedback from the message panel.
	 *
	 * Records the sender's policy and re-files the message in one pass:
	 *   - `allow` ("Not spam"): the sender is allowed, the message moves back
	 *     to the Inbox, and its spam category/classification is cleared.
	 *   - `block` ("Block sender"): the sender is blocked, the message moves
	 *     to Spam and is stamped with the spam category (still undraftable,
	 *     never deleted).
	 *
	 * Returns the stored entry, or null when the email id is unknown.
	 */
	async applySenderPolicyFeedback(
		id: string,
		policy: SenderPolicy,
	): Promise<SenderPolicyEntry | null> {
		const email = this.getEmail(id);
		if (!email) return null;
		const entry = await this.setSenderPolicy(email.sender ?? "", policy);
		if (policy === "allow") {
			this.ctx.storage.sql.exec(
				`UPDATE emails
				 SET folder_id = ?1, category = NULL, category_confidence = NULL, classification = NULL
				 WHERE id = ?2`,
				Folders.INBOX,
				id,
			);
		} else {
			this.ctx.storage.sql.exec(
				`UPDATE emails SET folder_id = ?1, category = ?2 WHERE id = ?3`,
				Folders.SPAM,
				SPAM_CATEGORY_ID,
				id,
			);
		}
		return entry;
	}


	#normalizeRuleName(name: string): string {
		const trimmed =
			typeof name === "string" ? name.trim().slice(0, MAX_RULE_NAME_LENGTH) : "";
		if (!trimmed) throw new RuleValidationError("Rule name is required");
		return trimmed;
	}


	#normalizeRulePriority(priority: number): number {
		if (typeof priority !== "number" || !Number.isFinite(priority)) {
			throw new RuleValidationError("Rule priority must be a finite number");
		}
		return Math.min(Math.max(Math.trunc(priority), 0), MAX_RULE_PRIORITY);
	}


	#normalizeStoredMatch(raw: unknown): RuleMatchSpec {
		const match = normalizeRuleMatch(raw);
		if (!hasActiveConditions(match.conditions)) {
			throw new RuleValidationError("A rule needs at least one match condition");
		}
		return match;
	}


	#normalizeStoredActions(raw: unknown): RuleActions {
		const actions = normalizeRuleActions(raw);
		if (!hasActiveActions(actions)) {
			throw new RuleValidationError("A rule needs at least one action");
		}
		if (actions.mark_read === true && actions.mark_unread === true) {
			throw new RuleValidationError(
				"mark_read and mark_unread cannot both be set",
			);
		}
		if (actions.star === true && actions.unstar === true) {
			throw new RuleValidationError("star and unstar cannot both be set");
		}
		// Folder ids are validated here so a rule can never point at a folder
		// that does not exist (deleting a folder later still falls back to the
		// Inbox in the inbound pipeline).
		if (actions.move_to_folder) {
			actions.move_to_folder = this.#resolveRuleFolder(actions.move_to_folder);
		}
		return actions;
	}


	/** Resolve a folder name or id to the real folder id, rejecting unknowns. */
	#resolveRuleFolder(folder: string): string {
		const folders = [
			...this.ctx.storage.sql.exec(`SELECT id, name FROM folders`),
		] as { id: string; name: string }[];
		const resolved = resolveRuleFolderId(folder, folders);
		if (!resolved) throw new RuleValidationError(`Unknown folder: ${folder}`);
		return resolved;
	}
}


/** A raw `emails` row, exactly as `SELECT *` returns it. */
type EmailRow = typeof schema.emails.$inferSelect;


/** A raw `attachments` row, exactly as `SELECT *` returns it. */
type AttachmentRow = typeof schema.attachments.$inferSelect;


/** A raw `extracted_items` row, exactly as `SELECT *` returns it. */
type ExtractedItemRow = typeof schema.extractedItems.$inferSelect;


/**
 * Parse a stored item row into the shared shape, or null for a row that is
 * unusable (no title, or a kind/status value the vocabulary does not know).
 * Unknown rows are ignored rather than trusted, so a hand-edited database
 * cannot put a bogus status or kind in front of the UI or the agent.
 */
function parseExtractedItemRow(
	row: ExtractedItemRow,
	source?: { sender: string | null; subject: string | null },
): ExtractedItem | null {
	const title = typeof row.title === "string" ? row.title.trim() : "";
	if (!title) return null;
	if (!isItemKind(row.kind) || !isItemStatus(row.status)) return null;
	return {
		id: String(row.id),
		email_id: String(row.email_id),
		thread_id: row.thread_id ?? null,
		kind: row.kind,
		title,
		details: row.details ?? null,
		due_at: row.due_at ?? null,
		status: row.status,
		created_at: String(row.created_at ?? ""),
		updated_at: String(row.updated_at ?? ""),
		...(source ? { sender: source.sender, subject: source.subject } : {}),
	};
}


/**
 * Raw row shape for the threaded list queries: the latest message of each
 * conversation plus the counts aggregated over it. SQLite returns the 0/1
 * flags as numbers. The draft query selects neither `needs_reply` nor
 * `has_draft`.
 */
interface ThreadedEmailRow {
	id: string;
	subject: string | null;
	sender: string | null;
	recipient: string | null;
	envelope_recipient: string | null;
	date: string | null;
	read: number | null;
	starred: number | null;
	thread_id: string | null;
	folder_id: string;
	in_reply_to: string | null;
	email_references: string | null;
	category: string | null;
	category_confidence: number | null;
	snippet: string | null;
	thread_count: number | null;
	thread_unread_count: number | null;
	participants: string | null;
	needs_reply?: number | null;
	has_draft?: number | null;
}


/** Raw row shape for a search result: the listed email columns plus folder name. */
interface SearchEmailRow {
	id: string;
	subject: string | null;
	sender: string | null;
	recipient: string | null;
	envelope_recipient: string | null;
	cc: string | null;
	bcc: string | null;
	date: string | null;
	read: number | null;
	starred: number | null;
	in_reply_to: string | null;
	email_references: string | null;
	thread_id: string | null;
	folder_id: string;
	category: string | null;
	category_confidence: number | null;
	snippet: string | null;
	folder_name: string | null;
}


/** Raw row shape for a digest message reference (folder name resolved). */
interface DigestRefRow {
	id: string;
	subject: string | null;
	sender: string | null;
	date: string | null;
	category: string | null;
	folder_id: string;
	folder_name: string | null;
}


/** Raw row shape for a thread candidate (grouped by thread_id). */
interface ThreadCandidateRow {
	thread_id: string;
	subject: string | null;
	senders: string | null;
	recipients: string | null;
}


/** Raw `rules` row shape (JSON columns arrive as strings). */
interface RuleRow {
	id: string;
	name: string;
	enabled: number;
	priority: number;
	match: string;
	actions: string;
	created_at: string;
	/** From the rule_stats LEFT JOIN; 0 when the rule never fired. */
	fired_count?: number | null;
	last_fired_at?: string | null;
}




/**
 * Raw row shape for a rule scan (shared by the dry-run preview and the
 * retroactive apply). `has_attachment` comes back from the EXISTS subquery
 * as 0/1 (SQLite booleans); `read`/`starred` are the stored 0/1 flags the
 * retroactive apply compares against.
 */
interface PreviewEmailRow {
	id: string;
	subject: string | null;
	sender: string | null;
	recipient: string | null;
	envelope_recipient: string | null;
	cc: string | null;
	bcc: string | null;
	body: string | null;
	category: string | null;
	folder_id: string | null;
	/** Stored read/star flags (the SQLite column returns 0/1). */
	read: number | boolean | null;
	starred: number | boolean | null;
	date: string | null;
	has_attachment: number | boolean;
}




/** Map a stored email row onto the engine's `RuleEmail` view. */
function previewRowToRuleEmail(row: PreviewEmailRow): RuleEmail {
	return {
		sender: row.sender,
		recipient: row.recipient,
		envelope_recipient: row.envelope_recipient,
		cc: row.cc,
		bcc: row.bcc,
		subject: row.subject,
		body: row.body,
		category: row.category,
		has_attachment: row.has_attachment === 1 || row.has_attachment === true,
	};
}


/**
 * Parse a `rules` row into the engine shape. JSON columns are normalized on
 * read so a hand-edited or legacy row can never crash rule evaluation.
 */
function parseRuleRow(row: RuleRow): MailRule {
	return {
		id: String(row.id),
		name: String(row.name),
		enabled: row.enabled !== 0,
		priority: Number.isFinite(Number(row.priority)) ? Number(row.priority) : 0,
		match: normalizeRuleMatch(safeJsonParse(row.match)),
		actions: normalizeRuleActions(safeJsonParse(row.actions)),
		created_at: String(row.created_at ?? ""),
		fired_count: Number.isFinite(Number(row.fired_count))
			? Number(row.fired_count)
			: 0,
		last_fired_at:
			typeof row.last_fired_at === "string" && row.last_fired_at
				? row.last_fired_at
				: null,
	};
}


function safeJsonParse(value: unknown): unknown {
	if (typeof value !== "string") return null;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}


/** Raw `sender_policy` row shape. */
interface SenderPolicyRow {
	address: string;
	policy: string;
	created_at: string;
}


/**
 * Parse a `sender_policy` row into the shared shape, or null for a row that
 * is unusable (no address, or a policy value the enum does not know). Unknown
 * rows are ignored — treated as "none" at ingest — rather than trusted, so
 * hand-edited data can never drop mail or bypass classification unexpectedly.
 */
function parseSenderPolicyRow(row: SenderPolicyRow): SenderPolicyEntry | null {
	const address = normalizeSenderAddress(row.address);
	if (!address) return null;
	if (!isSenderPolicy(row.policy)) return null;
	return {
		address,
		policy: row.policy,
		created_at: String(row.created_at ?? ""),
	};
}
