// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

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
