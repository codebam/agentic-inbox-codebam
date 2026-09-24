// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { CategorizationSettings } from "shared/categories";

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
	categorization?: CategorizationSettings;
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
	cc?: string;
	bcc?: string;
	date: string;
	read: boolean;
	starred: boolean;
	body?: string | null;
	in_reply_to?: string | null;
	email_references?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	category?: string | null;
	category_confidence?: number | null;
	classification?: string | null;
	attachments?: Attachment[];
	snippet?: string | null;
	// Thread aggregate fields (only present in threaded list view)
	thread_count?: number;
	thread_unread_count?: number;
	participants?: string;
	needs_reply?: boolean;
	has_draft?: boolean;
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
	threadId?: string | null;
	threadCount?: number;
}
