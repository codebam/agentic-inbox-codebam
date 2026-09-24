// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	toolListMailboxes,
	toolListEmails,
	toolGetEmail,
	toolGetThread,
	toolSearchEmails,
	toolSearchAllMailboxes,
	toolDraftReply,
	toolDraftEmail,
	toolUpdateDraft,
	toolDeleteEmail,
	toolSendReply,
	toolSendEmail,
	toolMarkEmailRead,
	toolMoveEmail,
	toolStarEmail,
	toolSetSenderPolicy,
	toolDiscardDraft,
	toolDeleteSpamEmails,
	toolSnoozeEmail,
	toolUnsnoozeEmail,
	toolSetReminder,
	toolClearReminder,
	toolListSnoozed,
	toolListScheduledSends,
	toolCancelScheduledSend,
	toolListAgentActions,
	toolListRules,
	toolCreateRule,
	toolUpdateRule,
	toolUndoAgentAction,
	toolSearchContacts,
	toolListTemplates,
	ruleToolActionsSchema,
	ruleToolDraftShape,
	ruleToolMatchSchema,
} from "../lib/tools";
import { runAudited } from "../lib/agent-actions";
import {
	DEFAULT_CONTACT_SEARCH_LIMIT,
	MAX_CONTACT_SEARCH_LIMIT,
} from "../lib/contacts";
import { Folders, FOLDER_TOOL_DESCRIPTION, MOVE_FOLDER_TOOL_DESCRIPTION } from "../../shared/folders";
import type { Env } from "../types";

/** Wrap a plain result object into MCP content format. */
function mcpText(result: unknown) {
	return {
		content: [
			{ type: "text" as const, text: JSON.stringify(result, null, 2) },
		],
	};
}

/** Wrap an error string into MCP error format. */
function mcpError(message: string) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
		isError: true as const,
	};
}

/**
 * Wrap a result that may contain an `error` field into MCP format,
 * automatically setting isError when appropriate.
 */
function mcpResult(result: Record<string, unknown>) {
	if ("error" in result) {
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
			isError: true as const,
		};
	}
	return mcpText(result);
}


/**
 * Search filters shared by the search_emails and search_all_mailboxes tools.
 * Every filter is optional; Gmail-style operators inside `query` are parsed
 * server-side by shared/search-query.ts, so callers can pass either form.
 */
const searchFilterShape = {
	query: z
		.string()
		.optional()
		.describe(
			"Search text matched against subject, body, sender and recipient. May also contain Gmail-style operators (from:bob, to:ann, subject:invoice, is:unread, is:starred, has:attachment, before:2025-01-01, after:2024-01-01); they are parsed server-side.",
		),
	folder: z
		.string()
		.optional()
		.describe("Optional folder to restrict search to"),
	category: z
		.string()
		.optional()
		.describe("Optional category ID to restrict search to"),
	from: z
		.string()
		.optional()
		.describe("Only emails whose sender matches this text"),
	to: z
		.string()
		.optional()
		.describe("Only emails whose recipient (to/cc/bcc) matches this text"),
	subject: z
		.string()
		.optional()
		.describe("Only emails whose subject matches this text"),
	isRead: z
		.boolean()
		.optional()
		.describe("true = only read emails, false = only unread emails"),
	isStarred: z
		.boolean()
		.optional()
		.describe("true = only starred emails, false = only unstarred emails"),
	hasAttachment: z
		.boolean()
		.optional()
		.describe("true = only emails with attachments"),
	before: z
		.string()
		.optional()
		.describe("Only emails dated before this date (YYYY-MM-DD or ISO 8601)"),
	after: z
		.string()
		.optional()
		.describe("Only emails dated after this date (YYYY-MM-DD or ISO 8601)"),
	page: z.number().int().min(1).optional().describe("Page number (default 1)"),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("Results per page (default 25, max 100)"),
};


/**
 * EmailMCP — exposes email tools over the Model Context Protocol.
 *
 * Clients (ProtoAgent, Claude Code, Cursor, etc.) connect to the
 * `/mcp` endpoint and can list mailboxes, read/search emails,
 * draft replies, send messages, and manage folders.
 */
export class EmailMCP extends McpAgent<Env> {
	server = new McpServer(
		{
			name: "agentic-inbox-codebam",
			version: "1.1.0",
		},
		{
			instructions: `Agentic Inbox Codebam is a self-hosted email client. You can read, search, draft, and send email for any mailbox returned by list_mailboxes.

Workflow:
1. Call list_mailboxes to discover available mailbox addresses.
2. Pass mailboxId to every other tool.
3. Read before writing: use get_email and get_thread to understand the full context.
4. draft_reply, create_draft, and update_draft only write to the Drafts folder; they never send.
5. Never draft a reply to an email marked as spam (Spam folder, \`spam\` category, or a stored spam classification). The draft tools enforce this and return an error; do not try to work around it.
6. send_reply and send_email deliver real email immediately and cannot be undone. Call them only after the human operator has explicitly confirmed the exact recipient, subject, and body.

Never invent recipients, and never send without confirmation. Prefer reply tools over new email when continuing an existing thread. Body fields accept HTML.`,
		},
	);

	// eslint-disable-next-line @typescript-eslint/require-await -- McpAgent declares init(): Promise<void>, and this body only registers tools.
	async init() {
		const env = this.env;

		/**
		 * Verify a mailbox exists in R2 before operating on it.
		 * Returns an MCP error response if the mailbox is not found, or null if valid.
		 */
		const verifyMailbox = async (mailboxId: string) => {
			const obj = await env.BUCKET.head(`mailboxes/${mailboxId}.json`);
			if (!obj) {
				return mcpError(`Mailbox "${mailboxId}" not found. Use list_mailboxes to see available mailboxes.`);
			}
			return null;
		};

		// ── list_mailboxes ─────────────────────────────────────────
		this.server.tool(
			"list_mailboxes",
			"List all available mailboxes",
			{},
			async () => {
				const result = await toolListMailboxes(env);
				return mcpText(result);
			},
		);

		// ── list_emails ────────────────────────────────────────────
		this.server.tool(
			"list_emails",
			"List emails in a mailbox folder. Returns email metadata (id, subject, sender, recipient, date, read/starred status, thread_id, category).",
			{
				mailboxId: z
					.string()
					.describe("The mailbox email address (e.g. user@example.com)"),
				folder: z
					.string()
					.default(Folders.INBOX)
					.describe(FOLDER_TOOL_DESCRIPTION),
				limit: z
					.number()
					.default(20)
					.describe("Maximum number of emails to return"),
				page: z
					.number()
					.default(1)
					.describe("Page number for pagination"),
				category: z
					.string()
					.optional()
					.describe(
						"Optional category ID to filter by (spam or a configured category from an email's category field)",
					),
			},
			async ({ mailboxId, folder, limit, page, category }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolListEmails(env, mailboxId, { folder, limit, page, category });
				return mcpText(result);
			},
		);

		// ── get_email ──────────────────────────────────────────────
		this.server.tool(
			"get_email",
			"Get a single email with its full body content. Use this to read the actual content of an email.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID to retrieve"),
			},
			async ({ mailboxId, emailId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolGetEmail(env, mailboxId, emailId);
				if ("error" in result) {
					return {
						content: [{ type: "text" as const, text: "Email not found" }],
						isError: true,
					};
				}
				return mcpText(result);
			},
		);

		// ── get_thread ─────────────────────────────────────────────
		this.server.tool(
			"get_thread",
			"Get all emails in a conversation thread. Returns all messages sorted chronologically.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				threadId: z
					.string()
					.describe("The thread_id to retrieve all messages for"),
			},
			async ({ mailboxId, threadId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolGetThread(env, mailboxId, threadId);
				return mcpText(result);
			},
		);

		// ── search_emails ──────────────────────────────────────────
		this.server.tool(
			"search_emails",
			"Search for emails in one mailbox. Free text matches subject, body, sender and recipient; Gmail-style operators (from:bob is:unread has:attachment before:2025-01-01) are accepted in the query or as separate filters.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				...searchFilterShape,
			},
			async ({ mailboxId, ...filters }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolSearchEmails(env, mailboxId, filters);
				return mcpText(result);
			},
		);

		// ── search_all_mailboxes ───────────────────────────────────
		this.server.tool(
			"search_all_mailboxes",
			"Search every mailbox in the deployment at once and merge the matches by date (newest first). Same filters as search_emails; each result row includes the mailboxId it came from.",
			{ ...searchFilterShape },
			async (filters) => {
				const result = await toolSearchAllMailboxes(env, filters);
				return mcpText(result);
			},
		);

		// ── draft_reply ────────────────────────────────────────────
		this.server.tool(
			"draft_reply",
			"Draft a reply to an email and save it to the Drafts folder. Does NOT send — saves a draft for review.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				originalEmailId: z
					.string()
					.describe("The ID of the email being replied to"),
				to: z
					.string()
					.email()
					.optional()
					.describe(
						"Recipient email address. Omit it to reply to the original's Reply-To address (or its sender).",
					),
				subject: z.string().describe("Subject line (usually 'Re: ...')"),
				bodyHtml: z
					.string()
					.describe("The HTML body of the reply"),
			},
			async ({ mailboxId, originalEmailId, to, subject, bodyHtml }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolDraftReply(env, mailboxId, {
					originalEmailId,
					to,
					subject,
					body: bodyHtml,
					isPlainText: false,
					runVerifyDraft: true,
					applySignature: true,
				});
				return mcpResult(result);
			},
		);

		// ── create_draft ───────────────────────────────────────────
		this.server.tool(
			"create_draft",
			"Create a new draft email. Can be a new email or a reply draft.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				to: z
					.string()
					.optional()
					.describe("Recipient email address (optional for early drafts)"),
				subject: z.string().describe("Subject line"),
				bodyHtml: z.string().describe("The HTML body of the draft"),
				in_reply_to: z
					.string()
					.optional()
					.describe("The ID of the email this draft is replying to (optional)"),
				thread_id: z
					.string()
					.optional()
					.describe("Thread ID to attach this draft to (optional)"),
			},
			async ({ mailboxId, to, subject, bodyHtml, in_reply_to, thread_id }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolDraftEmail(env, mailboxId, {
					to: to || "",
					subject,
					body: bodyHtml,
					isPlainText: false,
					runVerifyDraft: true,
					applySignature: true,
					in_reply_to,
					thread_id,
				});
				if ("error" in result) {
					return mcpResult(result);
				}
				// Map the response to match the original create_draft output shape
				return mcpText({
					status: "draft_created",
					draftId: result.draftId,
					threadId: result.threadId,
					message: result.signatureApplied
						? "Draft created in Drafts folder with the mailbox signature."
						: "Draft created in Drafts folder.",
					signatureApplied: result.signatureApplied,
				});
			},
		);

		// ── update_draft ───────────────────────────────────────────
		this.server.tool(
			"update_draft",
			"Update an existing draft email's content.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				draftId: z.string().describe("The ID of the draft to update"),
				to: z
					.string()
					.optional()
					.describe("Updated recipient email address"),
				subject: z.string().optional().describe("Updated subject line"),
				bodyHtml: z.string().optional().describe("Updated HTML body"),
			},
			async ({ mailboxId, draftId, to, subject, bodyHtml }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolUpdateDraft(env, mailboxId, {
					draftId,
					to,
					subject,
					bodyHtml,
				});
				if ("error" in result) {
					if (result.error === "Draft not found") {
						return {
							content: [{ type: "text" as const, text: "Draft not found" }],
							isError: true,
						};
					}
					return mcpResult(result);
				}
				return mcpText(result);
			},
		);

		// ── delete_email ───────────────────────────────────────────
		this.server.tool(
			"delete_email",
			"Delete an email by ID. By default the email is moved to Trash and can be restored; set permanent=true to remove it for good. Permanent deletion is irreversible.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID to delete"),
				permanent: z
					.boolean()
					.optional()
					.describe(
						"true to permanently delete (irreversible); omit or false to move the email to Trash",
					),
			},
			async ({ mailboxId, emailId, permanent }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await runAudited(
					env,
					{
						source: "mcp",
						tool: "delete_email",
						mailboxId,
						emailId,
						args: { emailId, permanent: permanent === true },
					},
					() => toolDeleteEmail(env, mailboxId, emailId, permanent === true),
				);
				return mcpResult(result);
			},
		);

		// ── discard_draft ──────────────────────────────────────────
		this.server.tool(
			"discard_draft",
			"Permanently delete a draft email — drafts are not moved to Trash and cannot be restored.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				draftId: z.string().describe("The ID of the draft to delete"),
			},
			async ({ mailboxId, draftId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolDiscardDraft(env, mailboxId, draftId);
				return mcpResult(result);
			},
		);

		// ── delete_spam_emails ─────────────────────────────────────
		this.server.tool(
			"delete_spam_emails",
			"Permanently delete every email marked as spam (Spam folder, spam category, or classifier is_spam). Irreversible — spam is never moved to Trash. Omit mailboxId to clear spam from every mailbox.",
			{
				mailboxId: z
					.string()
					.optional()
					.describe("Mailbox address; omit to clear spam from every mailbox"),
			},
			async ({ mailboxId }) => {
				if (mailboxId !== undefined) {
					const denied = await verifyMailbox(mailboxId);
					if (denied) return denied;
				}
				const result = await toolDeleteSpamEmails(env, mailboxId);
				return mcpResult(result);
			},
		);

		// ── send_reply ─────────────────────────────────────────────
		this.server.tool(
			"send_reply",
			"Send a reply to an email. Only call after drafting and getting confirmation.",
			{
				mailboxId: z.string().describe("The mailbox email address to send from"),
				originalEmailId: z
					.string()
					.describe("The ID of the email being replied to"),
				to: z.string().email().describe("Recipient email address"),
				subject: z.string().describe("Subject line"),
				bodyHtml: z.string().describe("The HTML body of the reply"),
			},
			async ({ mailboxId, originalEmailId, to, subject, bodyHtml }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolSendReply(env, mailboxId, {
					originalEmailId,
					to,
					subject,
					bodyHtml,
				});
				if ("error" in result) {
					// Preserve the original MCP error format for send failures
					if (typeof result.error === "string" && result.error.startsWith("Failed to send")) {
						return {
							content: [{ type: "text" as const, text: result.error }],
							isError: true,
						};
					}
					if (result.error === "Original email not found") {
						return {
							content: [{ type: "text" as const, text: "Original email not found" }],
							isError: true,
						};
					}
					return mcpResult(result);
				}
				return mcpText(result);
			},
		);

		// ── send_email ─────────────────────────────────────────────
		this.server.tool(
			"send_email",
			"Send a new email (not a reply). Only call after getting confirmation.",
			{
				mailboxId: z.string().describe("The mailbox email address to send from"),
				to: z.string().email().describe("Recipient email address"),
				subject: z.string().describe("Subject line"),
				bodyHtml: z.string().describe("The HTML body of the email"),
			},
			async ({ mailboxId, to, subject, bodyHtml }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolSendEmail(env, mailboxId, {
					to,
					subject,
					bodyHtml,
				});
				if ("error" in result) {
					if (typeof result.error === "string" && result.error.startsWith("Failed to send")) {
						return {
							content: [{ type: "text" as const, text: result.error }],
							isError: true,
						};
					}
					return mcpResult(result);
				}
				return mcpText(result);
			},
		);

		// ── mark_email_read ────────────────────────────────────────
		this.server.tool(
			"mark_email_read",
			"Mark an email as read or unread.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID"),
				read: z.boolean().describe("true to mark as read, false for unread"),
			},
			async ({ mailboxId, emailId, read }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await runAudited(
					env,
					{
						source: "mcp",
						tool: "mark_email_read",
						mailboxId,
						emailId,
						args: { emailId, read },
					},
					() => toolMarkEmailRead(env, mailboxId, emailId, read),
				);
				return mcpText(result);
			},
		);

		// ── star_email ─────────────────────────────────────────────
		this.server.tool(
			"star_email",
			"Star or unstar an email.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID"),
				starred: z.boolean().describe("true to star, false to unstar"),
			},
			async ({ mailboxId, emailId, starred }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await runAudited(
					env,
					{
						source: "mcp",
						tool: "star_email",
						mailboxId,
						emailId,
						args: { emailId, starred },
					},
					() => toolStarEmail(env, mailboxId, emailId, starred),
				);
				return mcpResult(result);
			},
		);

		// ── move_email ─────────────────────────────────────────────
		this.server.tool(
			"move_email",
			"Move an email to a different folder (inbox, sent, draft, archive, spam, trash).",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID"),
				folderId: z
					.string()
					.describe(MOVE_FOLDER_TOOL_DESCRIPTION),
			},
			async ({ mailboxId, emailId, folderId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await runAudited(
					env,
					{
						source: "mcp",
						tool: "move_email",
						mailboxId,
						emailId,
						args: { emailId, folderId },
					},
					() => toolMoveEmail(env, mailboxId, emailId, folderId),
				);
				if ("error" in result) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({ error: "Failed to move email" }),
							},
						],
						isError: true,
					};
				}
				return mcpText(result);
			},
		);


		// ── set_sender_policy ──────────────────────────────────────
		this.server.tool(
			"set_sender_policy",
			"Record an allow or block decision for the sender of an email: allow moves the message back to the Inbox and clears its spam markings, block moves it to Spam. Nothing is deleted.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email whose sender the decision applies to"),
				action: z
					.enum(["allow", "block"])
					.describe("allow = trust this sender (not spam); block = send them to Spam"),
			},
			async ({ mailboxId, emailId, action }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolSetSenderPolicy(env, mailboxId, emailId, action);
				return mcpResult(result);
			},
		);

		// ── snooze_email ───────────────────────────────────────────
		this.server.tool(
			"snooze_email",
			"Snooze an email until a future time. The message moves to the Snoozed folder and returns to the folder it came from by itself when the time arrives — nothing is deleted. Accepts an ISO 8601 timestamp or a relative shorthand like 30m, 4h, 3d or 1w.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID to snooze"),
				until: z
					.string()
					.describe(
						"When to wake the message: an ISO 8601 timestamp or a relative shorthand like 30m, 4h, 3d or 1w.",
					),
			},
			async ({ mailboxId, emailId, until }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolSnoozeEmail(env, mailboxId, emailId, until);
				return mcpResult(result);
			},
		);

		// ── unsnooze_email ─────────────────────────────────────────
		this.server.tool(
			"unsnooze_email",
			"Wake a snoozed email now: it returns to the folder it came from immediately. Nothing is deleted.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The snoozed email ID"),
			},
			async ({ mailboxId, emailId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolUnsnoozeEmail(env, mailboxId, emailId);
				return mcpResult(result);
			},
		);

		// ── set_reminder ───────────────────────────────────────────
		this.server.tool(
			"set_reminder",
			"Set a follow-up reminder for an email. The message stays where it is; when the reminder fires it is flagged and pulled back to the Inbox if the thread still expects a reply. Nothing is deleted. Accepts an ISO 8601 timestamp or a relative shorthand like 30m, 4h, 3d or 1w.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email to remind about"),
				at: z
					.string()
					.describe(
						"When to fire the reminder: an ISO 8601 timestamp or a relative shorthand like 30m, 4h, 3d or 1w.",
					),
			},
			async ({ mailboxId, emailId, at }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolSetReminder(env, mailboxId, emailId, at);
				return mcpResult(result);
			},
		);

		// ── clear_reminder ─────────────────────────────────────────
		this.server.tool(
			"clear_reminder",
			"Cancel an email's follow-up reminder, pending or already fired. Nothing is deleted.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email whose reminder to cancel"),
			},
			async ({ mailboxId, emailId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolClearReminder(env, mailboxId, emailId);
				return mcpResult(result);
			},
		);

		// ── list_snoozed ───────────────────────────────────────────
		this.server.tool(
			"list_snoozed",
			"List the messages currently snoozed in a mailbox, earliest wake time first. Read-only: it changes nothing.",
			{ mailboxId: z.string().describe("The mailbox email address") },
			async ({ mailboxId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				return mcpText(await toolListSnoozed(env, mailboxId));
			},
		);

		// ── list_scheduled_sends ───────────────────────────────────
		// Sending is operator-only: these tools can read the queue and
		// cancel a pending send, never schedule or send one.
		this.server.tool(
			"list_scheduled_sends",
			"List the outbound messages queued for later in a mailbox, newest first, with their send time and status. Read-only: it sends and changes nothing.",
			{ mailboxId: z.string().describe("The mailbox email address") },
			async ({ mailboxId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				return mcpText(await toolListScheduledSends(env, mailboxId));
			},
		);

		// ── cancel_scheduled_send ──────────────────────────────────
		this.server.tool(
			"cancel_scheduled_send",
			"Cancel a pending scheduled send so it never fires. Only a pending send can be cancelled; nothing is sent and nothing is deleted.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				scheduledSendId: z.string().describe("The scheduled send ID to cancel"),
			},
			async ({ mailboxId, scheduledSendId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				return mcpResult(
					await toolCancelScheduledSend(env, mailboxId, scheduledSendId),
				);
			},
		);

		// ── list_rules ─────────────────────────────────────────────
		// Rules are deterministic per-mailbox filters. The agent/MCP rule
		// tools can shape mail (file, label, star, discard) but can never
		// author automation that SENDS mail: forward_to and auto_reply_text
		// are stripped by toolCreateRule / toolUpdateRule, and a rule carrying
		// them cannot be enabled from here.
		this.server.tool(
			"list_rules",
			"List the mailbox's deterministic rules (file, label, star, mark read, discard) with firing statistics. Rules that forward or auto-reply are operator-only: they are listed, but cannot be created, edited, or enabled through tools.",
			{ mailboxId: z.string().describe("The mailbox email address") },
			async ({ mailboxId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				return mcpText(await toolListRules(env, mailboxId));
			},
		);


		// ── create_rule ────────────────────────────────────────────
		this.server.tool(
			"create_rule",
			"Create a deterministic rule for incoming mail: move it to a folder, set a category, star/unstar, mark read/unread, or discard it. A rule needs at least one match condition and at least one action. Rules created here cannot send mail: forward_to and auto_reply_text are operator-only and are stripped.",
			{ mailboxId: z.string().describe("The mailbox email address"), ...ruleToolDraftShape },
			async ({ mailboxId, ...draft }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolCreateRule(env, mailboxId, draft);
				return mcpResult(result);
			},
		);


		// ── update_rule ────────────────────────────────────────────
		this.server.tool(
			"update_rule",
			"Update one deterministic rule by id: rename, reorder, change its conditions or actions, enable or pause it. Rules that send mail automatically (forward or auto-reply) cannot be edited or enabled through tools — only the operator can change those.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				ruleId: z.string().describe("The rule id to update"),
				name: z.string().optional().describe("New rule name"),
				enabled: z.boolean().optional().describe("true enables, false pauses"),
				priority: z.number().int().optional().describe("Lower runs first"),
				match: ruleToolMatchSchema.optional(),
				actions: ruleToolActionsSchema.optional(),
			},
			async ({ mailboxId, ruleId, ...patch }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolUpdateRule(
					env,
					mailboxId,
					ruleId,
					patch,
				);
				return mcpResult(result);
			},
		);


		// ── list_agent_actions ─────────────────────────────────────
		this.server.tool(
			"list_agent_actions",
			"List the most recent mutating tool calls made through the agent or the MCP server for this mailbox, newest first, with the total number recorded. Read-only: it changes nothing. The log holds metadata only (tool, message id, subject, thread id, folder/read/star state) — never message bodies.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				limit: z
					.number()
					.int()
					.min(1)
					.max(200)
					.optional()
					.describe("How many recent actions to return (default 50, max 200)"),
			},
			async ({ mailboxId, limit }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				return mcpText(await toolListAgentActions(env, mailboxId, limit ?? 50));
			},
		);


		// ── undo_action ────────────────────────────────────────────
		this.server.tool(
			"undo_action",
			"Undo one recorded mutating tool call by its action id: restores the message's read state, star state and folder from the state recorded before the call. It never sends and never deletes mail; only actions flagged undoable (move, star, mark read) can be undone, and each action can be undone once. Get the action id from list_agent_actions.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				actionId: z
					.string()
					.describe("The action id from list_agent_actions"),
			},
			async ({ mailboxId, actionId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				return mcpResult(await toolUndoAgentAction(env, mailboxId, actionId));
			},
		);


		// ── search_contacts ────────────────────────────────────────
		this.server.tool(
			"search_contacts",
			"Search this mailbox's contacts — the addresses it has exchanged mail with — ranked by how often it sent to them and how recently they were seen. Use it to resolve a recipient address before send_email or send_reply. Read-only: it returns address metadata only (address, display name, sent/received counts, last seen), never message bodies.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				query: z
					.string()
					.optional()
					.describe(
						"Prefix matched against the contact's address or display name (case-insensitive). Omit for the most-contacted addresses.",
					),
				limit: z
					.number()
					.int()
					.min(1)
					.max(MAX_CONTACT_SEARCH_LIMIT)
					.optional()
					.describe("How many contacts to return (default 10, max 50)"),
			},
			async ({ mailboxId, query, limit }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				return mcpText(
					await toolSearchContacts(
						env,
						mailboxId,
						query ?? "",
						limit ?? DEFAULT_CONTACT_SEARCH_LIMIT,
					),
				);
			},
		);


		// ── list_templates ─────────────────────────────────────────
		this.server.tool(
			"list_templates",
			"List the mailbox's message templates — operator-authored reusable snippets (name, optional subject, body). Read-only: use a template as a starting point for a draft, but templates can only be created, edited or deleted by the operator in the app.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
			},
			async ({ mailboxId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				return mcpText(await toolListTemplates(env, mailboxId));
			},
		);
	}
}
