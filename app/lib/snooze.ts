// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Snooze and follow-up reminder helpers shared by the message toolbar, the
 * snoozed list and the list rows.
 *
 * Every value here is computed in the user's local timezone; the API only
 * ever receives ISO 8601 instants (`Date.toISOString()`). The server
 * rejects past timestamps, so no helper here produces one.
 */

import { Folders } from "shared/folders";

/**
 * Folder the workers side parks snoozed messages in. Re-exported from the
 * shared folder constants so the UI and the Durable Object cannot drift.
 */
export const SNOOZE_FOLDER_ID: string = Folders.SNOOZED;

export interface SnoozePreset {
	id: string;
	label: string;
	/** Wake/reminder instant, in the user's local time. */
	until: Date;
}

/** Local wall-clock time on a day offset from today. */
function atLocalTime(dayOffset: number, hour: number): Date {
	const date = new Date();
	date.setDate(date.getDate() + dayOffset);
	date.setHours(hour, 0, 0, 0);
	return date;
}

/**
 * Local wall-clock occurrence of a weekday (0 = Sunday). With
 * `allowToday` the occurrence may be later today; without it a weekday
 * that matches today rolls a week forward, so "Next week" never collapses
 * into "this morning".
 */
function nextWeekday(weekday: number, hour: number, allowToday: boolean): Date {
	const date = new Date();
	const delta = (weekday - date.getDay() + 7) % 7;
	date.setDate(date.getDate() + delta);
	date.setHours(hour, 0, 0, 0);
	if (date.getTime() <= Date.now() || (delta === 0 && !allowToday)) {
		date.setDate(date.getDate() + 7);
	}
	return date;
}

/**
 * The canned wake times offered by the snooze and reminder menus — every
 * entry is in the future:
 * - Later today: 18:00 local, or +3h when 18:00 has already passed.
 * - Tomorrow: 09:00 local.
 * - This weekend: the next Saturday 09:00 local.
 * - Next week: the next Monday 09:00 local.
 */
export function snoozePresets(): SnoozePreset[] {
	const laterToday = atLocalTime(0, 18);
	if (laterToday.getTime() <= Date.now()) {
		laterToday.setTime(Date.now() + 3 * 60 * 60 * 1000);
	}
	return [
		{ id: "later_today", label: "Later today", until: laterToday },
		{ id: "tomorrow", label: "Tomorrow", until: atLocalTime(1, 9) },
		{
			id: "this_weekend",
			label: "This weekend",
			until: nextWeekday(6, 9, true),
		},
		{ id: "next_week", label: "Next week", until: nextWeekday(1, 9, false) },
	];
}

/** True when `iso` is missing, unparseable, or not in the future. */
export function isPastOrInvalid(iso: string): boolean {
	if (!iso) return true;
	const time = new Date(iso).getTime();
	return Number.isNaN(time) || time <= Date.now();
}

/**
 * Human-readable local time for a wake/reminder instant: "6:00 PM" for
 * today (or an already-due time), "tomorrow 9:00 AM", "Thu 2:00 PM" within
 * the week, and "Mar 3, 9:00 AM" beyond it.
 */
export function formatSnoozeTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const time = date.toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});
	const startOfToday = new Date();
	startOfToday.setHours(0, 0, 0, 0);
	const daysAway = Math.floor(
		(date.getTime() - startOfToday.getTime()) / 86_400_000,
	);
	if (daysAway <= 0) return time;
	if (daysAway === 1) return `tomorrow ${time}`;
	if (daysAway <= 6) {
		return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
	}
	return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** `input[type=datetime-local]` value for a local Date: "YYYY-MM-DDTHH:mm". */
export function toDateTimeLocalValue(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
