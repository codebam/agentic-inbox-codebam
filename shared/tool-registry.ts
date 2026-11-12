// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The single tool registry: every agent/MCP/scoped tool, on which surfaces
 * it is exposed, the token scope each surface requires, and a one-line
 * description for the MCP panel.
 *
 * This is metadata only — a pure data table with no server imports — so the
 * app UI can read it without bundling the worker (`app/components/
 * MCPPanel.tsx`), the parity test can derive its expectations from it
 * (`tests/tool-parity.test.ts`) instead of hardcoding a second list, and the
 * scoped surface can derive its scope maps from it
 * (`workers/lib/scoped-surface.ts`, which re-exports nothing here but reads
 * the same table). `workers/lib/tools.ts` re-exports TOOL_REGISTRY and the
 * derived name lists for server-side callers.
 *
 * Adding a tool means adding one entry here AND the registration in
 * `workers/mcp/index.ts` (MCP tools), `createEmailTools` in
 * `workers/agent/index.ts` (agent tools) and the scoped dispatch in
 * `workers/lib/scoped-surface.ts` (scoped tools). The parity test compares
 * the registry against the live MCP `/mcp` surface and the agent tool map,
 * so a registry entry without a registration — or the reverse — fails in CI.
 *
 * Fields:
 *   handler         the `tool*` implementation in `workers/lib/tools.ts`.
 *                   `create_draft` (MCP) and `draft_email` (agent) share
 *                   `toolDraftEmail`; `get_image` and `unsubscribe_email`
 *                   are scoped-surface-only and never reach the MCP or
 *                   agent surfaces.
 *   mcp             exposed on the MCP server (`workers/mcp/index.ts`).
 *   agent           present in per-mailbox agent chats
 *                   (`createEmailTools` with a fixed mailbox). All-mailbox
 *                   chats also expose these, plus the tools flagged
 *                   agentGlobalOnly.
 *   agentGlobalOnly only in all-mailbox agent chats
 *                   (`list_mailboxes`, `search_all_mailboxes`,
 *                   `list_all_emails`).
 *   scope           the entry in `SCOPED_TOOL_SCOPES` (the scoped surface
 *                   and the /mcp mailbox-bound gate), or null when no
 *                   accessor token may call it.
 *   appOnlyScope    the entry in `APP_ONLY_SCOPED_TOOL_SCOPES`: all-mailbox
 *                   reads an app-level token may call, or null.
 *   scopedOnlyScope the entry in `SCOPED_SURFACE_ONLY_TOOL_SCOPES`: tools
 *                   only an explicit operator action through an
 *                   operator-minted token may reach (`get_image`,
 *                   `unsubscribe_email`), or null.
 *   description     the one-line summary the MCP panel renders.
 *   requiresConfirm destructive tools: the handlers refuse to run unless the
 *                   caller passes `confirm: true` — `empty_trash` (always),
 *                   `delete_spam_emails` (always), `delete_email` (only on
 *                   the `permanent: true` path; moving to Trash is not
 *                   destructive).
 */

import type { AccessTokenScope } from "./access-tokens";

/** One tool's surfaces, scopes, handler and panel summary. */
export interface ToolRegistryEntry {
	/** The `tool*` implementation in `workers/lib/tools.ts`. */
	handler: string;
	/** Exposed on the MCP server. */
	mcp: boolean;
	/** Present in per-mailbox agent chats (and all-mailbox chats). */
	agent: boolean;
	/** Only in all-mailbox agent chats. */
	agentGlobalOnly: boolean;
	/** `SCOPED_TOOL_SCOPES` membership, or null. */
	scope: AccessTokenScope | null;
	/** `APP_ONLY_SCOPED_TOOL_SCOPES` membership, or null. */
	appOnlyScope: AccessTokenScope | null;
	/** `SCOPED_SURFACE_ONLY_TOOL_SCOPES` membership, or null. */
	scopedOnlyScope: AccessTokenScope | null;
	/** One-line summary the MCP panel renders. */
	description: string;
	/** Destructive: the handler requires `confirm: true`. */
	requiresConfirm: boolean;
}

// Short-name helper: every scoped-surface entry shares the handler name
// pattern `tool<Name>`; the entries below write it out in full so a missing
// or renamed handler is a visible diff, not a silent mismatch.
export const TOOL_REGISTRY: Record<string, ToolRegistryEntry> = {
	list_mailboxes: {
		handler: "toolListMailboxes",
		mcp: true,
		agent: false,
		agentGlobalOnly: true,
		scope: null,
		appOnlyScope: "read",
		scopedOnlyScope: null,
		description: "List mailboxes",
		requiresConfirm: false,
	},
	list_emails: {
		handler: "toolListEmails",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "read",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "List folder messages",
		requiresConfirm: false,
	},
	get_email: {
		handler: "toolGetEmail",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "read",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Read one email",
		requiresConfirm: false,
	},
	get_attachment: {
		handler: "toolGetAttachment",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "read",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Read one attachment",
		requiresConfirm: false,
	},
	get_thread: {
		handler: "toolGetThread",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "read",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Read a conversation",
		requiresConfirm: false,
	},
	search_emails: {
		handler: "toolSearchEmails",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "read",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Search one mailbox",
		requiresConfirm: false,
	},
	search_all_mailboxes: {
		handler: "toolSearchAllMailboxes",
		mcp: true,
		agent: false,
		agentGlobalOnly: true,
		scope: null,
		appOnlyScope: "read",
		scopedOnlyScope: null,
		description: "Search every mailbox",
		requiresConfirm: false,
	},
	list_all_emails: {
		handler: "toolListAllEmails",
		mcp: true,
		agent: false,
		agentGlobalOnly: true,
		scope: null,
		appOnlyScope: "read",
		scopedOnlyScope: null,
		description: "List every mailbox's mail",
		requiresConfirm: false,
	},
	semantic_search: {
		handler: "toolSemanticSearch",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Semantic search by meaning",
		requiresConfirm: false,
	},
	list_folders: {
		handler: "toolListFolders",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "List folders",
		requiresConfirm: false,
	},
	create_folder: {
		handler: "toolCreateFolder",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Create a folder",
		requiresConfirm: false,
	},
	update_folder: {
		handler: "toolUpdateFolder",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Rename a folder",
		requiresConfirm: false,
	},
	delete_folder: {
		handler: "toolDeleteFolder",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Delete a folder",
		requiresConfirm: false,
	},
	draft_reply: {
		handler: "toolDraftReply",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "draft",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Draft a reply",
		requiresConfirm: false,
	},
	create_draft: {
		handler: "toolDraftEmail",
		mcp: true,
		agent: false,
		agentGlobalOnly: false,
		scope: "draft",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Create a new draft",
		requiresConfirm: false,
	},
	draft_email: {
		handler: "toolDraftEmail",
		mcp: false,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Draft a new email",
		requiresConfirm: false,
	},
	update_draft: {
		handler: "toolUpdateDraft",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "draft",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Update a draft",
		requiresConfirm: false,
	},
	delete_email: {
		handler: "toolDeleteEmail",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Delete an email (Trash, or permanent with confirm:true)",
		requiresConfirm: true,
	},
	update_item: {
		handler: "toolUpdateItem",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Move an extracted task or deadline",
		requiresConfirm: false,
	},
	empty_trash: {
		handler: "toolEmptyTrash",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Permanently empty Trash (needs confirm:true)",
		requiresConfirm: true,
	},
	restore_email: {
		handler: "toolRestoreEmail",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Restore a trashed email",
		requiresConfirm: false,
	},
	discard_draft: {
		handler: "toolDiscardDraft",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "draft",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Permanently delete a draft",
		requiresConfirm: false,
	},
	delete_spam_emails: {
		handler: "toolDeleteSpamEmails",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Permanently delete spam in one mailbox (needs confirm:true)",
		requiresConfirm: true,
	},
	send_reply: {
		handler: "toolSendReply",
		mcp: true,
		agent: false,
		agentGlobalOnly: false,
		scope: "send",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Send a reply",
		requiresConfirm: false,
	},
	send_email: {
		handler: "toolSendEmail",
		mcp: true,
		agent: false,
		agentGlobalOnly: false,
		scope: "send",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Send a new email",
		requiresConfirm: false,
	},
	mark_email_read: {
		handler: "toolMarkEmailRead",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Toggle read state",
		requiresConfirm: false,
	},
	star_email: {
		handler: "toolStarEmail",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Star or unstar an email",
		requiresConfirm: false,
	},
	move_email: {
		handler: "toolMoveEmail",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Move to a folder",
		requiresConfirm: false,
	},
	set_sender_policy: {
		handler: "toolSetSenderPolicy",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Allow or block a sender",
		requiresConfirm: false,
	},
	get_sender_policy: {
		handler: "toolGetSenderPolicy",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "read",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "List sender allow/block entries",
		requiresConfirm: false,
	},
	remove_sender_policy: {
		handler: "toolRemoveSenderPolicy",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Remove a sender allow/block entry",
		requiresConfirm: false,
	},
	snooze_email: {
		handler: "toolSnoozeEmail",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Snooze an email",
		requiresConfirm: false,
	},
	unsnooze_email: {
		handler: "toolUnsnoozeEmail",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Wake a snoozed email now",
		requiresConfirm: false,
	},
	set_reminder: {
		handler: "toolSetReminder",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Set a follow-up reminder",
		requiresConfirm: false,
	},
	clear_reminder: {
		handler: "toolClearReminder",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Cancel a follow-up reminder",
		requiresConfirm: false,
	},
	list_snoozed: {
		handler: "toolListSnoozed",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "List snoozed emails",
		requiresConfirm: false,
	},
	mute_thread: {
		handler: "toolMuteThread",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Mute a thread",
		requiresConfirm: false,
	},
	unmute_thread: {
		handler: "toolUnmuteThread",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Unmute a thread",
		requiresConfirm: false,
	},
	mark_thread_read: {
		handler: "toolMarkThreadRead",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Mark a whole thread read",
		requiresConfirm: false,
	},
	summarize_thread: {
		handler: "toolSummarizeThread",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "read",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Summarize a thread",
		requiresConfirm: false,
	},
	list_scheduled_sends: {
		handler: "toolListScheduledSends",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "read",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "List scheduled sends",
		requiresConfirm: false,
	},
	cancel_scheduled_send: {
		handler: "toolCancelScheduledSend",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "send",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Cancel a pending scheduled send",
		requiresConfirm: false,
	},
	schedule_send: {
		handler: "toolScheduleSend",
		mcp: true,
		agent: false,
		agentGlobalOnly: false,
		scope: "send",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Queue a message for later",
		requiresConfirm: false,
	},
	retry_scheduled_send: {
		handler: "toolRetryScheduledSend",
		mcp: true,
		agent: false,
		agentGlobalOnly: false,
		scope: "send",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Re-arm a failed scheduled send",
		requiresConfirm: false,
	},
	list_agent_actions: {
		handler: "toolListAgentActions",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "List recorded mutating tool calls",
		requiresConfirm: false,
	},
	undo_action: {
		handler: "toolUndoAgentAction",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Undo one recorded tool call",
		requiresConfirm: false,
	},
	list_rules: {
		handler: "toolListRules",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "List automation rules",
		requiresConfirm: false,
	},
	create_rule: {
		handler: "toolCreateRule",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Create an automation rule",
		requiresConfirm: false,
	},
	update_rule: {
		handler: "toolUpdateRule",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Update a rule",
		requiresConfirm: false,
	},
	delete_rule: {
		handler: "toolDeleteRule",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Delete a rule",
		requiresConfirm: false,
	},
	preview_rule: {
		handler: "toolPreviewRule",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Preview a rule against stored mail",
		requiresConfirm: false,
	},
	reorder_rules: {
		handler: "toolReorderRules",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Reorder rule priority",
		requiresConfirm: false,
	},
	apply_rule: {
		handler: "toolApplyRule",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Apply a rule to stored mail",
		requiresConfirm: false,
	},
	list_saved_searches: {
		handler: "toolListSavedSearches",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "read",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "List saved searches",
		requiresConfirm: false,
	},
	create_saved_search: {
		handler: "toolCreateSavedSearch",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Save a search",
		requiresConfirm: false,
	},
	update_saved_search: {
		handler: "toolUpdateSavedSearch",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Update a saved search",
		requiresConfirm: false,
	},
	delete_saved_search: {
		handler: "toolDeleteSavedSearch",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Delete a saved search",
		requiresConfirm: false,
	},
	list_templates: {
		handler: "toolListTemplates",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "read",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "List message templates",
		requiresConfirm: false,
	},
	create_template: {
		handler: "toolCreateTemplate",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Create a message template",
		requiresConfirm: false,
	},
	update_template: {
		handler: "toolUpdateTemplate",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Update a message template",
		requiresConfirm: false,
	},
	delete_template: {
		handler: "toolDeleteTemplate",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Delete a message template",
		requiresConfirm: false,
	},
	list_labels: {
		handler: "toolListLabels",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "read",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "List labels",
		requiresConfirm: false,
	},
	add_label: {
		handler: "toolAddLabel",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Attach a label to an email",
		requiresConfirm: false,
	},
	remove_label: {
		handler: "toolRemoveLabel",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Detach a label from an email",
		requiresConfirm: false,
	},
	create_label: {
		handler: "toolCreateLabel",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Create a label",
		requiresConfirm: false,
	},
	update_label: {
		handler: "toolUpdateLabel",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Update a label",
		requiresConfirm: false,
	},
	delete_label: {
		handler: "toolDeleteLabel",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: "manage",
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Delete a label",
		requiresConfirm: false,
	},
	list_items: {
		handler: "toolListItems",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "List extracted tasks and deadlines",
		requiresConfirm: false,
	},
	get_digest: {
		handler: "toolGetDigest",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Read the morning brief",
		requiresConfirm: false,
	},
	get_storage: {
		handler: "toolGetStorage",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Read the storage footprint",
		requiresConfirm: false,
	},
	export_email: {
		handler: "toolExportEmail",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Export one email as EML",
		requiresConfirm: false,
	},
	get_calendar_invite: {
		handler: "toolGetCalendarInvite",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Read a message's calendar invite",
		requiresConfirm: false,
	},
	respond_to_invite: {
		handler: "toolRespondToInvite",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Accept, decline or tentatively answer an invite",
		requiresConfirm: false,
	},
	search_contacts: {
		handler: "toolSearchContacts",
		mcp: true,
		agent: true,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: null,
		description: "Find a contact address",
		requiresConfirm: false,
	},
	get_image: {
		handler: "toolGetImage",
		mcp: false,
		agent: false,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: "read",
		description: "Fetch one message image (scoped tokens only)",
		requiresConfirm: false,
	},
	unsubscribe_email: {
		handler: "toolUnsubscribeEmail",
		mcp: false,
		agent: false,
		agentGlobalOnly: false,
		scope: null,
		appOnlyScope: null,
		scopedOnlyScope: "send",
		description: "One-click unsubscribe (scoped tokens only)",
		requiresConfirm: false,
	},
};

/** Every tool name in the registry, sorted. */
export const TOOL_NAMES: string[] = Object.keys(TOOL_REGISTRY).sort();

/** Tools exposed on the MCP server, sorted — what `/mcp` tools/list serves. */
export const MCP_TOOL_NAMES: string[] = Object.entries(TOOL_REGISTRY)
	.filter(([, entry]) => entry.mcp)
	.map(([name]) => name)
	.sort();

/** Tools in per-mailbox agent chats, sorted — see `createEmailTools`. */
export const AGENT_SCOPED_TOOL_NAMES: string[] = Object.entries(TOOL_REGISTRY)
	.filter(([, entry]) => entry.agent)
	.map(([name]) => name)
	.sort();

/** Tools only in all-mailbox agent chats, sorted. */
export const AGENT_GLOBAL_TOOL_NAMES: string[] = Object.entries(TOOL_REGISTRY)
	.filter(([, entry]) => entry.agentGlobalOnly)
	.map(([name]) => name)
	.sort();

/** The scope map the scoped surface exposes, derived from the registry. */
export function scopedToolScopes(): Record<string, AccessTokenScope> {
	return Object.fromEntries(
		Object.entries(TOOL_REGISTRY)
			.filter(([, entry]) => entry.scope !== null)
			.map(([name, entry]) => [name, entry.scope as AccessTokenScope]),
	);
}

/** The all-mailbox scope map an app-level token may call, from the registry. */
export function appOnlyToolScopes(): Record<string, AccessTokenScope> {
	return Object.fromEntries(
		Object.entries(TOOL_REGISTRY)
			.filter(([, entry]) => entry.appOnlyScope !== null)
			.map(([name, entry]) => [name, entry.appOnlyScope as AccessTokenScope]),
	);
}

/** The scoped-surface-only scope map, from the registry. */
export function scopedOnlyToolScopes(): Record<string, AccessTokenScope> {
	return Object.fromEntries(
		Object.entries(TOOL_REGISTRY)
			.filter(([, entry]) => entry.scopedOnlyScope !== null)
			.map(([name, entry]) => [name, entry.scopedOnlyScope as AccessTokenScope]),
	);
}
