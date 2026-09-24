// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { CategorizationSettings } from "shared/categories";
import type { ModelConfig } from "shared/models";
import type { EmailViewMode } from "shared/email-view";

export interface SignatureSettings {
	enabled: boolean;
	text: string;
	html?: string;
}

export interface MailboxSettings {
	fromName?: string;
	forwarding?: { enabled: boolean; email: string };
	signature?: SignatureSettings;
	autoReply?: { enabled: boolean; subject: string; message: string };
	agentSystemPrompt?: string;
	/** Whether new mail triggers an automatic draft reply. Defaults to on. */
	autoDraft?: boolean;
	categorization?: CategorizationSettings;
	/** Mailbox-level AI model overrides; blank fields inherit. */
	models?: ModelConfig;
	/** Mailbox-level default message view; blank/null inherits the app-wide default. */
	defaultEmailView?: EmailViewMode | null;
	/** Days a message may sit in Trash before the retention sweep deletes it; 0 disables. */
	trashRetentionDays?: number;
	/** https endpoint notified for every new non-spam message; empty disables. */
	notifyWebhookUrl?: string;
	/** Optional signing secret for the X-Agentic-Inbox-Signature header. */
	notifyWebhookSecret?: string;
	/**
	 * Senders whose remote images always load: exact addresses
	 * (`alerts@example.com`) or domain entries (`@example.com`). Normalised
	 * to lowercase by the mailbox settings route; see shared/remote-images.ts.
	 */
	imageAllowlist?: string[];
}

export interface Mailbox {
	id: string;
	email: string;
	name: string;
	settings?: MailboxSettings;
}

export interface Email {
	id: string;
	thread_id?: string | null;
	folder_id?: string | null;
	subject: string;
	sender: string;
	recipient: string;
	envelope_recipient?: string | null;
	cc?: string | undefined;
	bcc?: string | undefined;
	/** Reply-To target(s) the sender set, when any. */
	reply_to?: string | null;
	date: string;
	read: boolean;
	starred: boolean;
	body?: string | null;
	/** The message's text/plain alternative, when the sender included one. */
	body_text?: string | null;
	in_reply_to?: string | null;
	email_references?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	category?: string | null;
	category_confidence?: number | null;
	classification?: string | null;
	attachments?: Attachment[] | undefined;
	snippet?: string | null;
	// Thread aggregate fields (only present in threaded list view)
	thread_count?: number;
	thread_unread_count?: number;
	participants?: string;
	needs_reply?: boolean;
	has_draft?: boolean;
	/** ISO 8601 wake time while the message waits in the "snoozed" folder. */
	snooze_until?: string | null;
	/** ISO 8601 time of a scheduled follow-up reminder. */
	remind_at?: string | null;
	/** Set once the reminder has fired; the nudge stays until dismissed. */
	reminded_at?: string | null;
	/** Raw List-Unsubscribe header value, when the sender set one. */
	list_unsubscribe?: string | null;
	/** Raw List-Unsubscribe-Post header value (RFC 8058 one-click marker). */
	list_unsubscribe_post?: string | null;
	/** ISO 8601 time the user unsubscribed through the message panel. */
	unsubscribed_at?: string | null;
	// Present in the aggregated All Accounts list so each row knows which
	// mailbox it belongs to.
	mailboxId?: string;
}

export interface Attachment {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string;
	disposition?: string;
}

export interface Folder {
	id: string;
	name: string;
	unreadCount: number;
}

/** Batch actions offered by the list-view multi-select toolbar. */
export type BulkEmailAction =
	| "mark_read"
	| "mark_unread"
	| "star"
	| "unstar"
	| "move"
	| "trash"
	| "restore"
	| "delete";

/**
 * One selected list row, tagged with the mailbox that owns it so the All
 * Accounts view can group a batch into one request per mailbox.
 */
export interface BulkEmailTarget {
	mailboxId: string;
	id: string;
	/** Thread fields from the list row, used to expand read/unread to conversations. */
	threadId?: string | null | undefined;
	threadCount?: number | undefined;
}

/** Surface that recorded an action: the built-in agent or an MCP client. */
export type AgentActionSource = "agent" | "mcp";

/**
 * One row of a mailbox's agent/MCP action audit log.
 *
 * `args`, `before_state` and `after_state` are metadata-only payloads (never
 * message bodies). They are stored as TEXT, so the API may hand them back as
 * raw JSON or as parsed values — read them through `parseActionState` in
 * ~/lib/agent-actions.ts rather than indexing them directly.
 */
export interface AgentAction {
	id: string;
	source: AgentActionSource;
	tool: string;
	email_id: string | null;
	email_subject: string | null;
	thread_id: string | null;
	args: unknown;
	before_state: unknown;
	after_state: unknown;
	/** 1 when the recorded tool has an inverse; 0 when the action cannot be undone. */
	undoable: number;
	/** ISO 8601 time the action was undone through this view, if it has been. */
	undone_at: string | null;
	created_at: string;
}
