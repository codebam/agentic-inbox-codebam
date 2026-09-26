// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { CategorizationSettings } from "shared/categories";
import type { ModelConfig } from "shared/models";
import type { EmailViewMode } from "shared/email-view";
import type { ItemKind, ItemStatus, ItemsSettings } from "shared/items";

export interface SignatureSettings {
	enabled: boolean;
	text: string;
	html?: string;
}

export interface MailboxSettings {
	fromName?: string;
	signature?: SignatureSettings;
	agentSystemPrompt?: string;
	/** Whether new mail triggers an automatic draft reply. Defaults to on. */
	autoDraft?: boolean;
	/** Whether the daily morning digest is POSTed to the notification webhook. */
	digestEnabled?: boolean;
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
	/** Whether inbound mail is scanned for tasks and deadlines. Defaults to on. */
	items?: ItemsSettings;
}

export interface Mailbox {
	id: string;
	email: string;
	name: string;
	settings?: MailboxSettings;
}

/**
 * One address in a mailbox's contact index, as returned by
 * `GET /api/v1/mailboxes/:mailboxId/contacts`. The server ranks matches by
 * how often, and how recently, the mailbox has exchanged mail with them.
 */
export interface Contact {
	id: string;
	email: string;
	/** Display name learned from the mail headers; null for unnamed addresses. */
	name: string | null;
	/** Messages this mailbox has sent to the address. */
	sent_count: number;
	/** Messages this mailbox has received from the address. */
	received_count: number;
	/** ISO 8601 time the address was first seen. */
	first_seen_at: string;
	/** ISO 8601 time the address was last seen. */
	last_seen_at: string;
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
	/** Delivery outcome a bounce/DSN reported for this Sent copy; NULL until one arrives. */
	delivery_status?: string | null;
	/** Bounded, whitespace-normalized detail of that report, e.g. "550 5.1.1 Mailbox unavailable". */
	delivery_detail?: string | null;
	/** ISO 8601 time the delivery outcome was recorded. */
	delivery_updated_at?: string | null;
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
	/**
	 * Capability token of this attachment's public download link, when the
	 * file was too large for the send binding (migration 28). Absent/null on
	 * an ordinary attachment; the link's URL is
	 * `/api/v1/downloads/{mailboxId}/{id}?token={link_token}`.
	 */
	link_token?: string | null;
	/** ISO 8601 instant the public link stops working; absent/null when there is no link. */
	link_expires_at?: string | null;
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

/**
 * One row of a mailbox's scheduled-send queue, as returned by
 * `GET /api/v1/mailboxes/:mailboxId/scheduled-sends`.
 *
 * The composer's Send and Send later actions queue a message here instead
 * of sending it immediately; the queue fires it at `send_at`. `draft_id`
 * names the stored draft that holds the message — the queue owns that
 * draft's lifecycle, the composer only creates it.
 */
export interface ScheduledSend {
	id: string;
	draft_id: string;
	/** ISO 8601 instant the queue will send the message. */
	send_at: string;
	status: "pending" | "sent" | "failed" | "cancelled";
	/** Delivery attempts made so far. */
	attempts: number;
	/** Last delivery error, when the send failed. */
	last_error: string | null;
	created_at: string;
	/** ISO 8601 time the queue actually sent the message; null until it has. */
	sent_at: string | null;
}


/** One message referenced by a morning digest. */
export interface DigestEmailRef {
	id: string;
	subject: string;
	sender: string;
	/** ISO 8601 receive time. */
	date: string;
	/** Folder display name. */
	folder: string;
	category: string | null;
}


/** One follow-up reminder that already fired, as the digest lists it. */
export interface DigestReminderRef {
	id: string;
	subject: string;
	sender: string;
	/** ISO 8601 instant the reminder fired. */
	fired_at: string;
}


/** Arrival counts over the digest window. */
export interface DigestCounts {
	received: number;
	unread: number;
	starred: number;
	spam: number;
	needs_reply: number;
}


/** One `by_category` row: a category id and how many arrivals carry it. */
export interface DigestCategoryCount {
	category: string;
	count: number;
}


/** One open task or deadline the digest's items section lists. */
export interface DigestItemRef {
	id: string;
	title: string;
	/** ISO 8601 UTC instant the item is due. */
	due_at: string;
	email_id: string;
}


/** The open work the items extractor has stored for this mailbox. */
export interface DigestItems {
	/** Every open item, dated or not. */
	open: number;
	/** Open items already past due (due date before today, UTC). */
	overdue: number;
	/** Open items due on the digest's UTC day. */
	due_today: number;
	/** Soonest due first, at most ten; undated items excluded. */
	due: DigestItemRef[];
}


/**
 * One mailbox's morning brief, as returned by
 * `GET /api/v1/mailboxes/:mailboxId/digest`. Mirrors the frozen wire shape in
 * workers/lib/digest.ts field for field — the same shape (plus a
 * `type: "digest"` discriminator) is what the daily cron POSTs to the
 * mailbox's notification webhook.
 */
export interface Digest {
	mailbox: string;
	/** ISO 8601 instant the digest was built. */
	generated_at: string;
	/** Trailing 24 hours, ISO 8601. */
	window: { from: string; to: string };
	counts: DigestCounts;
	/** At most 20 rows, largest count first. */
	by_category: DigestCategoryCount[];
	/** At most 10 conversations, newest first. */
	needs_reply: DigestEmailRef[];
	/** At most 10 newest non-spam arrivals. */
	recent: DigestEmailRef[];
	/** At most 10 most recently fired follow-ups. */
	reminders: DigestReminderRef[];
	/** Open tasks and deadlines from the items extractor. */
	items: DigestItems;
}


/**
 * One extracted task or deadline, as `GET /api/v1/mailboxes/:mailboxId/items`
 * and `GET .../emails/:emailId/items` return it.
 *
 * Rows are metadata only: the extractor stores a short title and optional
 * details, never the message body. `email_id` names the message the item came
 * from (the Tasks page links to it, the message panel filters by it), `due_at`
 * is the ISO 8601 UTC instant the message stated or null, and `status` is
 * open | done | dismissed.
 */
export interface ExtractedItem {
	id: string;
	email_id: string;
	thread_id: string | null;
	kind: ItemKind;
	title: string;
	details: string | null;
	due_at: string | null;
	status: ItemStatus;
	created_at: string;
	updated_at: string;
}
