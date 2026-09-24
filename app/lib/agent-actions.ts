// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Presentation helpers for the agent/MCP action audit log.
 *
 * Rows store metadata only — the tool name plus small JSON snapshots — so
 * every summary here is derived from those fields, never from a rendered
 * payload. A tool this file does not recognise falls back to its own name;
 * a raw JSON dump is never shown.
 */

import { formatDetailDate, formatListDate } from "shared/dates";
import { getFolderDisplayName } from "shared/folders";
import type { AgentAction } from "~/types";

/** A parsed metadata blob (args / before_state / after_state). */
type ActionState = Record<string, unknown>;

function isRecord(value: unknown): value is ActionState {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read one stored metadata blob. SQLite keeps these as TEXT, so the API may
 * hand back a JSON string or an already-parsed object; anything else — or
 * malformed JSON — yields null rather than a partial guess.
 */
export function parseActionState(value: unknown): ActionState | null {
	if (typeof value === "string") {
		try {
			const parsed: unknown = JSON.parse(value);
			return isRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}
	return isRecord(value) ? value : null;
}

/** First argument that is a non-empty string. */
function pickString(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return null;
}

/** First argument that is a boolean (or a JSON boolean spelled as text). */
function pickBoolean(...values: unknown[]): boolean | null {
	for (const value of values) {
		if (typeof value === "boolean") return value;
		if (value === "true") return true;
		if (value === "false") return false;
	}
	return null;
}

/** First argument that is a finite number. */
function pickNumber(...values: unknown[]): number | null {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return null;
}

/** Display name for a folder id, preferring the mailbox's own folder list. */
function folderName(folderId: string, folderNames?: Map<string, string>): string {
	return folderNames?.get(folderId) ?? getFolderDisplayName(folderId);
}

/**
 * One-line human summary of what a recorded action did, built from the tool
 * name plus the stored metadata (args first, then the after/before
 * snapshots, so a row recorded before a tool's args shape changed still
 * reads sensibly).
 */
export function describeAgentAction(
	action: AgentAction,
	folderNames?: Map<string, string>,
): string {
	const args = parseActionState(action.args);
	const before = parseActionState(action.before_state);
	const after = parseActionState(action.after_state);

	switch (action.tool) {
		case "mark_email_read": {
			const read = pickBoolean(args?.["read"], after?.["read"], before?.["read"]);
			return read === false ? "marked as unread" : "marked as read";
		}
		case "star_email": {
			const starred = pickBoolean(args?.["starred"], after?.["starred"], before?.["starred"]);
			return starred === false ? "unstarred" : "starred";
		}
		case "move_email": {
			const folderId = pickString(
				args?.["folderId"],
				args?.["folder_id"],
				after?.["folder_id"],
				after?.["folderId"],
				after?.["folder"],
			);
			return folderId ? `moved to ${folderName(folderId, folderNames)}` : "moved the message";
		}
		case "delete_email": {
			const status = pickString(after?.["status"]);
			const permanent = pickBoolean(args?.["permanent"]);
			if (permanent === true || status === "deleted_permanently") {
				return "deleted permanently";
			}
			return status === "already_in_trash" ? "left in Trash" : "moved to Trash";
		}
		case "delete_spam_emails": {
			const count = pickNumber(after?.["deletedCount"]);
			if (count === null) return "deleted spam messages";
			return `deleted ${count} spam message${count === 1 ? "" : "s"}`;
		}
		case "discard_draft":
			return "discarded the draft";
		case "snooze_email": {
			const until = pickString(args?.["until"], after?.["snooze_until"]);
			return until ? `snoozed until ${formatDetailDate(until)}` : "snoozed the message";
		}
		case "unsnooze_email":
			return "unsnoozed the message";
		case "set_reminder": {
			const at = pickString(args?.["at"], after?.["remind_at"]);
			return at ? `set a reminder for ${formatDetailDate(at)}` : "set a follow-up reminder";
		}
		case "clear_reminder":
			return "cleared the follow-up reminder";
		case "set_sender_policy": {
			const policy = pickString(args?.["policy"], args?.["action"], after?.["action"]);
			if (policy === "allow") return "allowed the sender";
			if (policy === "block") return "blocked the sender";
			return "changed the sender policy";
		}
		case "send_reply":
			return "sent a reply";
		case "send_email":
			return "sent an email";
		case "draft_reply":
			return "drafted a reply";
		case "draft_email":
			return "drafted a new email";
		case "update_draft":
			return "updated a draft";
		case "create_rule": {
			const name = pickString(args?.["name"]);
			return name ? `created the rule "${name}"` : "created a rule";
		}
		case "update_rule": {
			const name = pickString(args?.["name"]);
			return name ? `updated the rule "${name}"` : "updated a rule";
		}
		case "delete_rule": {
			const name = pickString(args?.["name"]);
			return name ? `deleted the rule "${name}"` : "deleted a rule";
		}
		default: {
			const words = action.tool.replace(/[_-]+/g, " ").trim();
			return words ? `ran ${words}` : "ran a tool";
		}
	}
}

/** Short relative time ("3m ago") for log rows; the exact time goes in a tooltip. */
export function formatActionTime(iso: string): string {
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return iso;
	const minutes = Math.floor((Date.now() - then) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return formatListDate(iso);
}
