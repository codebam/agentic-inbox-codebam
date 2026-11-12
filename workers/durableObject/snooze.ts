// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Snooze & reminder domain for MailboxDO (workers/durableObject/index.ts).
 *
 * This module is the first extracted domain of the MailboxDO split: the
 * Snoozed/Reminders listings, the snooze wake/restore mechanics and the
 * reminder firing decision, factored out of the ~6,600-line
 * workers/durableObject/index.ts into pure helpers that take the
 * `(db, sql)` dependencies explicitly, leaving MailboxDO as a thin
 * delegating shell for these methods (alarm arming, set/clear mutators and
 * `getEmail` stay in the DO because they also need the alarm and the DO's
 * own read path).
 *
 * Modularisation status (deliberately minimal, see task-6): the rest of
 * MailboxDO is NOT yet split. Do not attempt a full 6k-line split in one
 * step; continue by extracting one domain at a time (e.g. scheduled sends,
 * search/FTS, labels, templates) following this file's pattern: move the
 * SQL + logic here-style with `(db, sql)` deps, keep the DO method as a
 * one-line delegating shell, and keep every RPC signature byte-compatible
 * (see `SnoozedListPage` for the pagination-compatibility note below).
 */

import { and, asc, desc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { Folders } from "../../shared/folders";
import type { MailboxDb } from "./dedupe";

/** The raw Durable Object SQL handle, as MailboxDO receives it on its state. */
export type MailboxSql = DurableObjectState["storage"]["sql"];

/** `ctx.storage.transactionSync`, handed in so helpers stay DO-free. */
export type MailboxTransactionSync = (callback: () => void) => void;

/**
 * The column set every list row carries: the list-card fields plus the
 * snooze/reminder state, so a row can render its badge from any listing
 * (folder, Snoozed, Reminders). `getEmail` returns the whole row instead.
 *
 * Owned here because the Snoozed/Reminders listings are its heaviest
 * consumer; MailboxDO's `#listRowSelection` (and therefore `getEmails`)
 * delegates to this single definition so the listings cannot drift.
 */
export function listRowSelection() {
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

/** Default page size for the Snoozed/Reminders listings. */
export const SNOOZED_LIST_DEFAULT_LIMIT = 500;

/** Hard page ceiling: a single call can never pull more than this many rows. */
export const SNOOZED_LIST_MAX_LIMIT = 500;

/** Pagination options for the Snoozed/Reminders listings (both optional). */
export interface SnoozedListOptions {
	limit?: number;
	offset?: number;
}

/**
 * One page of a Snoozed/Reminders listing: the row array, with `hasMore`
 * attached *only when the result was actually truncated*.
 *
 * The conditional flag is the backward-compatibility contract: callers that
 * pass no options (the routes, the MCP tools, the snooze suites) receive
 * exactly the array they always received whenever the listing fits in one
 * page — so `list.length`, `.map`, iteration and even `toEqual([])` behave
 * byte-identically to the pre-pagination shape — while a paged caller
 * (`{ limit, offset }`) can read `page.hasMore === true` to know another
 * page follows. Retrieving with `offset = rows.length` continues the walk.
 */
export type SnoozedListPage<T> = T[] & { hasMore?: boolean };

function paginate<T>(rows: T[], limit: number): SnoozedListPage<T> {
	// Rows were fetched with one row of over-fetch (limit + 1); the extra
	// row only says whether another page follows — it is not returned.
	const hasMore = rows.length > limit;
	const page = (hasMore ? rows.slice(0, limit) : rows) as SnoozedListPage<T>;
	if (hasMore) {
		page.hasMore = true;
	}
	return page;
}

function clampPage(options: SnoozedListOptions): { limit: number; offset: number } {
	const requestedLimit = Number(options.limit);
	const limit = Number.isFinite(requestedLimit)
		? Math.min(Math.max(Math.trunc(requestedLimit), 1), SNOOZED_LIST_MAX_LIMIT)
		: SNOOZED_LIST_DEFAULT_LIMIT;
	const requestedOffset = Number(options.offset);
	const offset = Number.isFinite(requestedOffset)
		? Math.max(Math.trunc(requestedOffset), 0)
		: 0;
	return { limit, offset };
}

/**
 * Messages currently snoozed, earliest wake time first. Rows carry the
 * same fields as a folder listing so the UI can render them like any
 * other message. Paginated (see `SnoozedListPage`): `LIMIT` + one row of
 * over-fetch, so a mailbox with thousands asleep never materialises an
 * unbounded array in one call.
 */
export function getSnoozedRows(db: MailboxDb, options: SnoozedListOptions = {}) {
	const { limit, offset } = clampPage(options);
	const rows = db
		.select(listRowSelection())
		.from(schema.emails)
		.where(isNotNull(schema.emails.snooze_until))
		.orderBy(asc(schema.emails.snooze_until), asc(schema.emails.id))
		.limit(limit + 1)
		.offset(offset)
		.all();

	// The boolean coercion runs BEFORE paginate: Array.prototype.map would
	// otherwise drop the `hasMore` flag paginate attaches to a truncated page.
	const mapped = rows.map((email) => ({
		...email,
		read: !!email.read,
		starred: !!email.starred,
	}));
	return paginate(mapped, limit);
}

/**
 * Follow-ups that already fired, newest message first. A pending reminder
 * is not listed here: until it fires it is just `remind_at` on its own
 * row, so a cancelled reminder can never leave a stale entry behind.
 * Paginated exactly like `getSnoozedRows`.
 */
export function getReminderRows(db: MailboxDb, options: SnoozedListOptions = {}) {
	const { limit, offset } = clampPage(options);
	const rows = db
		.select(listRowSelection())
		.from(schema.emails)
		.where(isNotNull(schema.emails.reminded_at))
		.orderBy(desc(schema.emails.date), desc(schema.emails.id))
		.limit(limit + 1)
		.offset(offset)
		.all();

	// The boolean coercion runs BEFORE paginate: Array.prototype.map would
	// otherwise drop the `hasMore` flag paginate attaches to a truncated page.
	const mapped = rows.map((email) => ({
		...email,
		read: !!email.read,
		starred: !!email.starred,
	}));
	return paginate(mapped, limit);
}

/** Whether a folder row exists (see `restoreTargetFolder`). */
export function folderExists(db: MailboxDb, folderId: string): boolean {
	const row = db
		.select({ id: schema.folders.id })
		.from(schema.folders)
		.where(eq(schema.folders.id, folderId))
		.get();
	return row !== undefined;
}

/**
 * Folder a message snoozed from `fromFolder` lands in. Falls back to the
 * Inbox when nothing was recorded, when the recording is Snoozed itself
 * (a message must never wake back into Snoozed), or when the remembered
 * folder has since been deleted — the foreign key would otherwise reject
 * the move and the alarm would retry forever.
 */
export function restoreTargetFolder(db: MailboxDb, fromFolder: string | null): string {
	if (fromFolder && fromFolder !== Folders.SNOOZED && folderExists(db, fromFolder)) {
		return fromFolder;
	}
	return Folders.INBOX;
}

/**
 * Put a snoozed message back where it came from and clear its snooze
 * columns. `now` only stamps `trashed_at` when the origin is Trash, so
 * every folder move keeps the retention invariant intact.
 */
export function restoreSnoozed(
	db: MailboxDb,
	sql: MailboxSql,
	id: string,
	fromFolder: string | null,
	now: string = new Date().toISOString(),
): void {
	const target = restoreTargetFolder(db, fromFolder);
	sql.exec(
		`UPDATE emails
				 SET folder_id = ?1, trashed_at = ?2, snooze_until = NULL, snoozed_from_folder = NULL
				 WHERE id = ?3`,
		target,
		target === Folders.TRASH ? now : null,
		id,
	);
}

/**
 * Whether a thread still expects a reply: the newest message in it is not
 * in Sent. A message without a thread_id is its own thread, and equal
 * dates break by id so the answer is deterministic.
 */
export function threadNeedsReply(
	db: MailboxDb,
	email: {
		id: string;
		thread_id: string | null;
		folder_id: string;
	},
): boolean {
	if (!email.thread_id) return email.folder_id !== Folders.SENT;

	const newest = db
		.select({ folder_id: schema.emails.folder_id })
		.from(schema.emails)
		.where(eq(schema.emails.thread_id, email.thread_id))
		.orderBy(desc(schema.emails.date), desc(schema.emails.id))
		.limit(1)
		.get();

	return (newest?.folder_id ?? email.folder_id) !== Folders.SENT;
}

/** Snoozes whose wake time has come, ready for `restoreSnoozed`. */
export function dueSnoozes(db: MailboxDb, now: string): {
	id: string;
	snoozed_from_folder: string | null;
}[] {
	return db
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
}

/**
 * One due reminder: either fires it (pulled back to the Inbox and stamped
 * with `reminded_at`) when its thread still expects a reply, or drops it
 * silently when the thread was already answered. Returns true when it
 * fired. The caller runs this inside its transaction, exactly as the
 * MailboxDO method did inline.
 */
export function fireDueReminder(
	db: MailboxDb,
	sql: MailboxSql,
	email: {
		id: string;
		thread_id: string | null;
		folder_id: string;
	},
	now: string,
): boolean {
	if (!threadNeedsReply(db, email)) {
		sql.exec(
			`UPDATE emails SET remind_at = NULL WHERE id = ?1`,
			email.id,
		);
		return false;
	}
	sql.exec(
		`UPDATE emails SET remind_at = NULL, reminded_at = ?1, folder_id = ?2, trashed_at = NULL WHERE id = ?3`,
		now,
		Folders.INBOX,
		email.id,
	);
	return true;
}

/** Reminders whose due time has come and that have not fired yet. */
export function dueReminders(db: MailboxDb, now: string): {
	id: string;
	thread_id: string | null;
	folder_id: string;
}[] {
	return db
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
}

/** Wake every snoozed message in a thread because new mail arrived in it. */
export function wakeSnoozedThread(
	db: MailboxDb,
	sql: MailboxSql,
	transactionSync: MailboxTransactionSync,
	threadId: string,
): void {
	const snoozed = db
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

	transactionSync(() => {
		for (const email of snoozed) {
			restoreSnoozed(db, sql, email.id, email.snoozed_from_folder);
		}
	});
}

/** Drop every reminder on a thread: a reply answered the follow-up. */
export function clearThreadReminder(sql: MailboxSql, threadId: string): void {
	sql.exec(
		`UPDATE emails
				 SET remind_at = NULL, reminded_at = NULL
				 WHERE thread_id = ?1 AND (remind_at IS NOT NULL OR reminded_at IS NOT NULL)`,
		threadId,
	);
}
