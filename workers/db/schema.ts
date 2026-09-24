// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

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
	date: text("date"),
	read: integer("read").default(0),
	starred: integer("starred").default(0),
	body: text("body"),
	in_reply_to: text("in_reply_to"),
	email_references: text("email_references"),
	thread_id: text("thread_id"),
	message_id: text("message_id"),
	raw_headers: text("raw_headers"),
	category: text("category"),
	category_confidence: real("category_confidence"),
	classification: text("classification"),
	/** Rule that routed or acted on this message (first one, evaluation order). */
	matched_rule_id: text("matched_rule_id"),
	matched_rule_name: text("matched_rule_name"),
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
