// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-mailbox task/deadline extraction switch.
 *
 * Extraction is on by default, mirroring auto-draft: only an explicit
 * `false` turns it off, so mailboxes whose stored settings predate the
 * switch keep extracting.
 */

export interface ItemsSettings {
	enabled: boolean;
}

/** Whether a mailbox extracts tasks and deadlines from incoming mail. */
export function normalizeItemsSettings(value: unknown): ItemsSettings {
	const raw =
		typeof value === "object" && value !== null
			? (value as Record<string, unknown>)
			: {};
	return { enabled: raw["enabled"] !== false };
}


/**
 * Frozen item vocabulary, shared by the extractor (workers/lib/items.ts), the
 * Durable Object that stores the rows, the routes and tools that read them
 * and the UI that renders them.
 *
 * The strings are wire values: `kind` and `status` appear in every stored row
 * and API/tool answer, and the due filters are exactly the four buckets the
 * items list — and the Tasks page — group by.
 */

/** What one extracted row is: a concrete task or an explicit deadline. */
export type ItemKind = "task" | "deadline";

/** Lifecycle of an extracted row: open until the operator closes it. */
export type ItemStatus = "open" | "done" | "dismissed";

/** Every stored status. */
export const ITEM_STATUSES = ["open", "done", "dismissed"] as const;

/** Whether a value is one of the stored statuses. */
export function isItemStatus(value: unknown): value is ItemStatus {
	return (
		typeof value === "string" &&
		(ITEM_STATUSES as readonly string[]).includes(value)
	);
}

/** Whether a value is a kind the extractor may produce. */
export function isItemKind(value: unknown): value is ItemKind {
	return value === "task" || value === "deadline";
}

/** The four due buckets the list endpoint understands. */
export const ITEM_DUE_FILTERS = ["overdue", "today", "upcoming", "none"] as const;

/** One due bucket: overdue, due today, upcoming, or no due date at all. */
export type ItemDueFilter = (typeof ITEM_DUE_FILTERS)[number];

/** Whether a value is one of the four due buckets. */
export function isItemDueFilter(value: unknown): value is ItemDueFilter {
	return (
		typeof value === "string" &&
		(ITEM_DUE_FILTERS as readonly string[]).includes(value)
	);
}

