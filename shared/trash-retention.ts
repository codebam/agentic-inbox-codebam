// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Trash retention settings shared by the mailbox settings API (validation),
 * the scheduled sweep (`workers/lib/trash-retention.ts`) and the settings UI.
 *
 * `trashRetentionDays` is how long a message may sit in the Trash folder
 * before the daily sweep deletes it for good:
 *
 *   - unset / blank / unusable -> DEFAULT_TRASH_RETENTION_DAYS (30)
 *   - 0 (or negative)          -> retention disabled; only the manual
 *                                 "Empty trash" action removes mail
 *   - N > 0                    -> purge messages trashed more than N days ago
 *
 * The clock starts when a message enters Trash (`emails.trashed_at`), not on
 * its Date header, so an old message trashed today still gets its full
 * retention window.
 */


/** Retention applied when a mailbox has no usable `trashRetentionDays`. */
export const DEFAULT_TRASH_RETENTION_DAYS = 30;


/** Upper bound accepted from settings; ten years is effectively "forever". */
export const MAX_TRASH_RETENTION_DAYS = 3650;


const MS_PER_DAY = 24 * 60 * 60 * 1000;


/** Clamp a numeric day count: <= 0 disables retention, positive is capped. */
function clampTrashRetentionDays(days: number): number {
	if (days <= 0) return 0;
	return Math.min(days, MAX_TRASH_RETENTION_DAYS);
}


/**
 * Coerce a stored or configured value into a usable retention day count.
 * Never throws: malformed input falls back to the default so a hand-edited
 * settings file can never disable cleanup by accident.
 */
export function normalizeTrashRetentionDays(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return clampTrashRetentionDays(Math.trunc(value));
	}
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return clampTrashRetentionDays(Math.trunc(parsed));
		}
	}
	return DEFAULT_TRASH_RETENTION_DAYS;
}


/**
 * The ISO instant a sweep compares `trashed_at` against: messages trashed
 * strictly before this instant are eligible for deletion.
 */
export function trashRetentionCutoffIso(
	days: number,
	now: Date = new Date(),
): string {
	return new Date(now.getTime() - days * MS_PER_DAY).toISOString();
}
