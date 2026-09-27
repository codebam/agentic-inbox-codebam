// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, primaryKey } from "drizzle-orm/sqlite-core";
import type { CalendarResponse } from "../lib/calendar";

export const folders = sqliteTable("folders", {
	id: text("id").primaryKey(),
	name: text("name").notNull().unique(),
	is_deletable: integer("is_deletable").notNull().default(1),
});

export const emails = sqliteTable("emails", {
	id: text("id").primaryKey(),
	folder_id: text("folder_id")
		.notNull()
		.references(() => folders.id, { onDelete: "cascade" }),
	subject: text("subject"),
	sender: text("sender"),
	recipient: text("recipient"),
	envelope_recipient: text("envelope_recipient"),
	cc: text("cc"),
	bcc: text("bcc"),
	reply_to: text("reply_to"),
	date: text("date"),
	read: integer("read").default(0),
	starred: integer("starred").default(0),
	body: text("body"),
	body_text: text("body_text"),
	in_reply_to: text("in_reply_to"),
	email_references: text("email_references"),
	thread_id: text("thread_id"),
	message_id: text("message_id"),
	raw_headers: text("raw_headers"),
	category: text("category"),
	category_confidence: real("category_confidence"),
	classification: text("classification"),
	/** When the message entered Trash; NULL means "not retention-eligible". */
	trashed_at: text("trashed_at"),
	/** Rule that routed or acted on this message (first one, evaluation order). */
	matched_rule_id: text("matched_rule_id"),
	matched_rule_name: text("matched_rule_name"),
	/** Wake time while the message sits in the Snoozed folder; NULL otherwise. */
	snooze_until: text("snooze_until"),
	/** Folder the message was snoozed from, restored when the snooze wakes. */
	snoozed_from_folder: text("snoozed_from_folder"),
	/** Pending follow-up time; NULL when no reminder is set. */
	remind_at: text("remind_at"),
	/** When the follow-up fired; NULL when it has not (or the reminder was cancelled). */
	reminded_at: text("reminded_at"),
	/** Raw List-Unsubscribe header as received; NULL when the sender set none. */
	list_unsubscribe: text("list_unsubscribe"),
	/** Raw List-Unsubscribe-Post header (RFC 8058 one-click marker); NULL when absent. */
	list_unsubscribe_post: text("list_unsubscribe_post"),
	/** When this mailbox completed a one-click unsubscribe for this message; NULL until then. */
	unsubscribed_at: text("unsubscribed_at"),
	/** Delivery outcome a bounce/DSN reported for this Sent copy (migration 27); NULL until one arrives. */
	delivery_status: text("delivery_status"),
	/** Bounded, whitespace-normalized detail of that report (status code plus diagnostic text). */
	delivery_detail: text("delivery_detail"),
	/** ISO 8601 time the delivery outcome was recorded. */
	delivery_updated_at: text("delivery_updated_at"),
	/**
	 * The id the email binding returned for this Sent copy (migration 32).
	 * The platform sets the wire Message-ID itself, so this is the only id a
	 * bounce can name; delivery-report matching tries it right after the
	 * stored `message_id` (workers/lib/delivery-match.ts). NULL when the
	 * send returned no id or the capture failed.
	 */
	send_message_id: text("send_message_id"),
});


/**
 * Deterministic per-mailbox rules (migration 11_add_rules). The CRUD path
 * uses raw SQL because `match`/`actions` are JSON strings, but the table is
 * mirrored here so drizzle joins and the stats table can reference it.
 */
export const rules = sqliteTable("rules", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	enabled: integer("enabled").notNull().default(1),
	priority: integer("priority").notNull().default(0),
	match: text("match").notNull(),
	actions: text("actions").notNull(),
	created_at: text("created_at").notNull().default("(datetime('now'))"),
});


/**
 * Firing statistics (migration 15_add_rule_stats): one row per rule that has
 * fired at least once. Cascades away with its rule.
 */
export const ruleStats = sqliteTable("rule_stats", {
	rule_id: text("rule_id")
		.primaryKey()
		.references(() => rules.id, { onDelete: "cascade" }),
	fired_count: integer("fired_count").notNull().default(0),
	last_fired_at: text("last_fired_at"),
});

export const attachments = sqliteTable("attachments", {
	id: text("id").primaryKey(),
	email_id: text("email_id")
		.notNull()
		.references(() => emails.id, { onDelete: "cascade" }),
	filename: text("filename").notNull(),
	mimetype: text("mimetype").notNull(),
	size: integer("size").notNull(),
	content_id: text("content_id"),
	disposition: text("disposition"),
	/**
	 * Capability token of the public download link, NULL on ordinary
	 * attachments (migration 28_add_attachment_links). The token is the only
	 * credential the public route needs; the sweep clears it with the expiry.
	 */
	link_token: text("link_token"),
	/** ISO 8601 instant the public link stops working; NULL when there is no link. */
	link_expires_at: text("link_expires_at"),
});


/**
 * Per-mailbox sender allow/block policy. `policy` is `allow` or `block`;
 * addresses are stored trimmed + lowercased (see workers/lib/sender-policy.ts).
 * The inbound pipeline reads this table before the Jev classifier runs.
 */
export const senderPolicy = sqliteTable("sender_policy", {
	address: text("address").primaryKey(),
	policy: text("policy").notNull(),
	created_at: text("created_at")
		.notNull()
		.default(sql`(datetime('now'))`),
});


/**
 * Metadata-only audit log of mutating agent/MCP tool calls (migration
 * 20_add_agent_actions). `args`/`before_state`/`after_state` are JSON
 * strings bounded to ~1000 characters by workers/lib/agent-actions.ts --
 * never message bodies, attachment bytes or credentials. `undoable` marks
 * the reversible tools (move_email, star_email, mark_email_read);
 * `undone_at` is stamped when undo_action restores the before-state.
 * MailboxDO prunes each mailbox back to its newest 500 rows.
 */
export const agentActions = sqliteTable("agent_actions", {
	id: text("id").primaryKey(),
	source: text("source").notNull(),
	tool: text("tool").notNull(),
	email_id: text("email_id"),
	email_subject: text("email_subject"),
	thread_id: text("thread_id"),
	args: text("args"),
	before_state: text("before_state"),
	after_state: text("after_state"),
	undoable: integer("undoable").notNull().default(0),
	undone_at: text("undone_at"),
	created_at: text("created_at").notNull(),
});


/**
 * Mail-flow contacts (migration 21_add_contacts): one row per address this
 * mailbox has exchanged mail with, fed by MailboxDO.createEmail. Metadata
 * only — address, display name, sent/received counts, timestamps — never
 * message bodies. `email` is stored lowercased and is the upsert target;
 * MailboxDO prunes each mailbox back to its newest 5000 rows on every write
 * (workers/lib/contacts.ts).
 */
export const contacts = sqliteTable("contacts", {
	id: text("id").primaryKey(),
	email: text("email").notNull().unique(),
	name: text("name"),
	sent_count: integer("sent_count").notNull().default(0),
	received_count: integer("received_count").notNull().default(0),
	first_seen_at: text("first_seen_at").notNull(),
	last_seen_at: text("last_seen_at").notNull(),
});


/**
 * Outbound mail queued for later (migration 22_add_scheduled_sends).
 * `payload` is bounded JSON of the send parameters — never attachment
 * bytes — and `send_at` is the instant the send becomes due. `status` is
 * one of pending | sent | failed | cancelled; a failed row keeps its
 * payload and records the reason in `last_error`. MailboxDO prunes the
 * terminal rows back to its newest 200 on every insert; pending rows are
 * never pruned (workers/lib/scheduled-sends.ts).
 */
export const scheduledSends = sqliteTable("scheduled_sends", {
	id: text("id").primaryKey(),
	/** The draft this send was queued from, when the caller recorded one. */
	draft_id: text("draft_id"),
	send_at: text("send_at").notNull(),
	status: text("status").notNull(),
	payload: text("payload").notNull(),
	attempts: integer("attempts").notNull().default(0),
	last_error: text("last_error"),
	created_at: text("created_at").notNull(),
	sent_at: text("sent_at"),
});


/**
 * Per-mailbox message templates (migration 24_add_templates): reusable
 * snippets the composer inserts into a draft. Operator-authored content
 * only — `subject` is optional, the body is required, and every field is
 * bounded on every write (workers/lib/templates.ts); MailboxDO holds each
 * mailbox to at most 200 rows by refusing a create past the cap. The
 * agent/MCP surfaces read this table through one read-only tool
 * (list_templates) and have no write path.
 */
export const templates = sqliteTable("templates", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	subject: text("subject"),
	body: text("body").notNull(),
	created_at: text("created_at").notNull(),
	updated_at: text("updated_at").notNull(),
});


/**
 * Daily morning-digest deliveries (migration 25_add_digest_deliveries): one
 * row per UTC day a mailbox's digest was claimed, keyed by `day`
 * (YYYY-MM-DD), so a retried or duplicated cron run can never POST the same
 * day's digest twice. `ok` stays 0 while the delivery is pending; the
 * outcome lands with `status` (upstream HTTP status, null when the request
 * never got a response) and `error`. Bookkeeping only — never message
 * content. MailboxDO.claimDigestDay prunes each mailbox back to its newest
 * MAX_DIGEST_DELIVERIES days on every claim (workers/lib/digest.ts).
 */
export const digestDeliveries = sqliteTable("digest_deliveries", {
	day: text("day").primaryKey(),
	delivered_at: text("delivered_at").notNull(),
	ok: integer("ok").notNull(),
	status: integer("status"),
	error: text("error"),
});


/**
 * Tasks and deadlines extracted from inbound mail (migration
 * 26_add_extracted_items): one row per concrete task or deadline a message
 * states, written by the extractor off the receive path
 * (workers/lib/items.ts). Metadata only — `title` and `details` are clamped
 * (200 / 1000 characters) and `due_at` is an ISO 8601 UTC instant within two
 * years of extraction, or null. `kind` is task | deadline, `status` is
 * open | done | dismissed; MailboxDO prunes closed rows back to
 * MAX_EXTRACTED_ITEMS on every insert and never deletes open ones. The
 * agent/MCP surfaces read this table through one read-only tool
 * (list_items).
 */
export const extractedItems = sqliteTable("extracted_items", {
	id: text("id").primaryKey(),
	email_id: text("email_id").notNull(),
	thread_id: text("thread_id"),
	kind: text("kind").notNull(),
	title: text("title").notNull(),
	details: text("details"),
	due_at: text("due_at"),
	status: text("status").notNull().default("open"),
	created_at: text("created_at").notNull(),
	updated_at: text("updated_at").notNull(),
});

/**
 * Calendar invites (migration 29_add_calendar_invites): the metadata of the
 * iMIP text/calendar part one inbound message carried, parsed at ingest by
 * workers/lib/calendar.ts and read by the message panel's invite card. One
 * row per email — the email_id index is unique, so a second ingest for the
 * same email rewrites the metadata in place. Metadata only: every text
 * column is bounded by the parser, no ICS body is stored, and `response`
 * (accepted | declined | tentative) stays null until the operator answers
 * through the respond route — the only path that sends an iMIP REPLY, since
 * the agent and MCP surfaces expose no way to fire one.
 */
export const calendarInvites = sqliteTable("calendar_invites", {
	id: text("id").primaryKey(),
	email_id: text("email_id").notNull(),
	uid: text("uid"),
	method: text("method"),
	summary: text("summary"),
	organizer: text("organizer"),
	location: text("location"),
	start_at: text("start_at"),
	end_at: text("end_at"),
	attendee: text("attendee"),
	response: text("response").$type<CalendarResponse>(),
	created_at: text("created_at").notNull(),
});

/**
 * Web push subscriptions (migration 30_add_push_subscriptions): the browser
 * endpoints this mailbox can raise a notification on, written by the
 * subscribe route and read by the new-mail push fan-out
 * (workers/lib/webpush.ts). Keyed by endpoint, so re-subscribing from the
 * same browser refreshes the keys in place; `last_ok_at` stays null until a
 * push to that endpoint succeeds. The table never holds message content —
 * only the endpoint and the two keys the payload is encrypted to — and
 * MailboxDO prunes each mailbox back to its newest MAX_PUSH_SUBSCRIPTIONS
 * rows on every insert.
 */
export const pushSubscriptions = sqliteTable("push_subscriptions", {
	endpoint: text("endpoint").primaryKey(),
	p256dh: text("p256dh").notNull(),
	auth: text("auth").notNull(),
	created_at: text("created_at").notNull(),
	last_ok_at: text("last_ok_at"),
});

/**
 * Semantic search bookkeeping (migration 31_add_message_embeddings): one row
 * per message whose embedding is stored in the Vectorize index, written by
 * workers/lib/semantic.ts at ingest and by the reindex route. `model` is the
 * embedding model id the vector was made with and `content_hash` the SHA-256
 * of the embedded text (empty when the message had nothing embeddable), so a
 * future re-embed can tell which rows predate a model change. The email_id
 * primary key plus its unique index make a second write for the same message
 * rewrite the row, and the foreign key cascades the row away with its
 * message. Metadata only — never message content, and the index itself lives
 * in Vectorize, not here.
 */
export const messageEmbeddings = sqliteTable("message_embeddings", {
	email_id: text("email_id")
		.primaryKey()
		.references(() => emails.id, { onDelete: "cascade" }),
	model: text("model").notNull(),
	content_hash: text("content_hash").notNull(),
	created_at: text("created_at").notNull(),
});

/**
 * Files uploaded ahead of a queued send (migration 33_add_pending_uploads,
 * workers/lib/pending-uploads.ts). A scheduled send's stored payload holds
 * ids, never bytes: the composer uploads each file first, the bytes live in
 * R2 at `uploads/{mailbox_id}/{id}/{filename}`, and `r2_key` is the exact
 * object the fire path reads. `consumed` is stamped once a send has used the
 * bytes; the daily sweep deletes unconsumed rows (with their objects) older
 * than PENDING_UPLOAD_TTL_DAYS, and the fire path deletes a row and its
 * object after a successful send. Metadata only — the bytes never enter the
 * Durable Object's SQLite.
 */
export const pendingUploads = sqliteTable("pending_uploads", {
	id: text("id").primaryKey(),
	filename: text("filename").notNull(),
	mimetype: text("mimetype").notNull(),
	size: integer("size").notNull(),
	/** R2 key of the bytes (`uploads/{mailbox_id}/{id}/{filename}`). */
	r2_key: text("r2_key").notNull(),
	created_at: text("created_at").notNull(),
	/** 1 once a send has used the bytes; such a row is never swept. */
	consumed: integer("consumed").notNull().default(0),
});

/**
 * Per-mailbox labels (migration 34_add_labels, workers/lib/labels.ts):
 * user/agent-applied tags on messages, distinct from the AI-assigned
 * `category` column. A name is unique per mailbox case-insensitively (the
 * migration's unique NOCASE index enforces it on top of the Durable
 * Object's check), and one mailbox holds at most MAX_LABELS rows (refused
 * by MailboxDO.createLabel; labels are kept, never pruned).
 */
export const labels = sqliteTable("labels", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	/** Color token the UI renders (e.g. "#f59e0b"); null when the label sets none. */
	color: text("color"),
	created_at: text("created_at").notNull(),
});

/**
 * Which labels a message carries (migration 34_add_labels): one row per
 * (email, label) pair, so a message can carry many labels and a label many
 * messages. The composite primary key makes a repeated attach idempotent
 * and covers the by-email lookup; MailboxDO deletes the rows with their
 * label (deleteLabel) and with their message (every email-delete path).
 */
export const emailLabels = sqliteTable(
	"email_labels",
	{
		email_id: text("email_id")
			.notNull()
			.references(() => emails.id, { onDelete: "cascade" }),
		label_id: text("label_id")
			.notNull()
			.references(() => labels.id, { onDelete: "cascade" }),
		created_at: text("created_at").notNull(),
	},
	(table) => [primaryKey({ columns: [table.email_id, table.label_id] })],
);

/**
 * Uploaded mbox/EML files staged for import (migration 35_add_import_jobs,
 * workers/lib/mbox-import.ts). The bytes live in R2 at
 * `imports/{mailbox_id}/{id}.mbox` and never enter the Durable Object's
 * SQLite; this row is the job the mailbox's alarm drains — `cursor` is a
 * byte offset into the object, the three counters are per-message
 * outcomes, and `status` is pending | running | done | failed | cancelled.
 * A job with bytes left re-arms the alarm immediately, so a large file
 * imports in bounded batches; the staged object is deleted once the job
 * finishes.
 */
export const importJobs = sqliteTable("import_jobs", {
	id: text("id").primaryKey(),
	filename: text("filename").notNull(),
	/** R2 key of the staged bytes (`imports/{mailbox_id}/{id}.mbox`). */
	r2_key: text("r2_key").notNull(),
	size: integer("size").notNull(),
	/** Byte offset into the object the drain has reached. */
	cursor: integer("cursor").notNull().default(0),
	status: text("status").notNull(),
	imported: integer("imported").notNull().default(0),
	skipped: integer("skipped").notNull().default(0),
	failed: integer("failed").notNull().default(0),
	last_error: text("last_error"),
	created_at: text("created_at").notNull(),
	updated_at: text("updated_at").notNull(),
});

/**
 * Searchable text extracted from an attachment's contents (migration
 * 36_add_attachment_text, workers/lib/attachment-text.ts): one row per
 * attachment whose bytes decoded (or converted) to text, so mailbox search
 * can match a message by what its files contain. `attachment_id` is the
 * primary key and the upsert target, and `text` is bounded to
 * MAX_ATTACHMENT_TEXT_CHARS on every write. There is deliberately no foreign
 * key back to `attachments` — the delete hooks in MailboxDO are what keep a
 * row from outliving its attachment. The FTS index over the `text` column
 * (attachment_text_fts, with its sync triggers) is created by the migration
 * and has no Drizzle mirror, exactly like emails_fts.
 */
export const attachmentText = sqliteTable("attachment_text", {
	attachment_id: text("attachment_id").primaryKey(),
	email_id: text("email_id").notNull(),
	filename: text("filename").notNull(),
	mimetype: text("mimetype").notNull(),
	text: text("text").notNull(),
	created_at: text("created_at").notNull(),
});


/**
 * Muted threads (migration 38_add_muted_threads): the thread ids whose new
 * mail the push and webhook notification fan-outs skip — MailboxDO owns the
 * rows (muteThread/unmuteThread/isThreadMuted) and workers/index.ts reads
 * them off the receive path through those methods. `thread_id` is the primary
 * key and the upsert target, so re-muting refreshes `created_at` instead of
 * adding a row. Notification bookkeeping only — never message content — and
 * deliberately no foreign key: a thread id is an id over `emails`, and
 * muting an id with no messages is allowed, so a thread can be muted before
 * its first message arrives.
 */
export const mutedThreads = sqliteTable("muted_threads", {
	thread_id: text("thread_id").primaryKey(),
	created_at: text("created_at").notNull(),
});
