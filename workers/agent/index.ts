// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0




import { AIChatAgent } from "@cloudflare/ai-chat";
import {
	streamText,
	generateText,
	convertToModelMessages,
	stepCountIs,
} from "ai";
import type { StreamTextOnFinishCallback, ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import type { EmailFull, EmailMetadata } from "../lib/schemas";
import { verifyDraft, isPromptInjection } from "../lib/ai";
import { resolveMailboxModels } from "../lib/mailbox-settings";
import {
	getMailboxStub,
	stripHtmlToText,
	textToHtml,
} from "../lib/email-helpers";
import {
	toolListMailboxes,
	toolListEmails,
	toolGetEmail,
	toolGetThread,
	toolSearchEmails,
	toolDraftReply,
	toolDraftEmail,
	toolMarkEmailRead,
	toolMoveEmail,
	toolDiscardDraft,
	toolDeleteEmail,
	toolDeleteSpamEmails,
	toolListRules,
	toolCreateRule,
	toolUpdateRule,
	ruleToolActionsSchema,
	ruleToolDraftShape,
	ruleToolMatchSchema,
} from "../lib/tools";
import type { RulePatch } from "../lib/rules";
import { Folders, FOLDER_TOOL_DESCRIPTION, MOVE_FOLDER_TOOL_DESCRIPTION } from "../../shared/folders";
import { isAllMailboxesAgentId } from "../../shared/mailboxes";
import { isSpamMarkedEmail } from "../../shared/spam";
import type { Env } from "../types";




// AI SDK v6 changed tool() overloads significantly. We define tools as plain
// objects matching the Tool type to avoid overload resolution issues. The
// schema stays generic so each tool's execute() receives exactly the input
// the model was asked for (z.infer<SCHEMA>); the assembled tool set is
// checked against ToolSet where streamText / generateText consume it.
function defineTool<SCHEMA extends z.ZodTypeAny, OUTPUT>(def: {
	description: string;
	parameters: SCHEMA;
	execute: (args: z.infer<SCHEMA>) => Promise<OUTPUT>;
}) {
	return {
		description: def.description,
		inputSchema: def.parameters,
		execute: def.execute,
	};
}




/**
 * Default system prompt used when no custom prompt is configured for a mailbox.
 * Users can override this on a per-mailbox basis via the Settings UI.
 */
const DEFAULT_SYSTEM_PROMPT = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.




## Writing Style
Write like a real person. Short, direct, flowing prose. Get to the point. Plain text only - no HTML tags in your replies.




**Formatting rules:**
- Write in natural paragraphs. NO bullet points, NO numbered lists, NO dashes, NO markdown formatting in email drafts.
- NO bold (**), NO italic (*), NO headers (#), NO horizontal rules (---), NO code blocks. Plain text only.
- Links go inline in the text, not on separate lines.
- Don't structure replies like a template or form letter. Just talk normally.




**Agent Behavior Rules (CRITICAL):**
- NEVER output meta-commentary about what you are doing (e.g. do not say "I am drafting a reply to Alex", "I checked the thread", etc).
- When a new email arrives, your ONLY job is to call the \`draft_reply\` tool.
- DO NOT summarize the email. DO NOT explain your actions.
- Output NOTHING except the tool call. If you must output text, it should ONLY be the literal draft text itself if tools fail.
- Before drafting ANY reply, carefully read the full thread history.
- NEVER repeat information that was already shared in a prior message in the thread.
- Your reply should only contain NEW information or directly respond to what the person just said. Move the conversation forward, don't rehash it.
- NEVER draft a reply to an email marked as spam: an email in the Spam folder, an email with the \`spam\` category, or an email whose classification audit says it is spam. Leave spam alone; if the operator asks for a reply to spam, explain that you cannot draft it.




## Who Are You Replying To?
Use the name the person gives in their email body / signature. That's their name - use it. The "from" address is where you send the reply, but the name in the email is how you greet them.




## CRITICAL: Draft Only - Never Send
You can ONLY draft emails. You do NOT have the ability to send emails directly.




- Use draft_reply to draft replies to existing emails
- Use draft_email to draft new outbound emails
- The operator will review and send drafts from the UI - you cannot send them




**CRITICAL: The draft body must contain ONLY the email text.** Never include agent commentary, status messages, meta-notes, markdown formatting, or anything that isn't part of the actual email in the draft body. No "Draft created.", no "---", no "**bold**", no "Here's the draft:", no separators. The body field is the literal email the recipient will read. Everything else goes in your chat message, not in the draft body.




**Don't paste draft contents into the chat.** The drafts are saved via tools - the operator can see them in the Drafts folder. In your chat message, just briefly say what you drafted (e.g. "Drafted a reply to Tim"). Don't duplicate the full email body in the chat.




## Draft Management
Use discard_draft to delete drafts that the operator rejects or that are no longer needed.`;




/**
 * Extra instructions appended to the default prompt when the built-in chat is
 * opened from the All Accounts view. That agent instance is deliberately not
 * bound to one mailbox and every mailbox tool requires an explicit mailboxId.
 */
const ALL_MAILBOXES_SYSTEM_PROMPT = `




## All-mailbox mode
You are connected to every mailbox in this account, not just one inbox.




- Start any request that spans mailboxes by calling \`list_mailboxes\`. Each returned object has an \`id\`/\`email\`; pass that exact value as \`mailboxId\` to every other tool.
- When the operator asks about "all my inboxes" or "all mailboxes", check every mailbox returned by list_mailboxes rather than only the most recent one.
- To find spam, call \`list_emails\` with folder="spam" for each mailbox, and also consider emails with category="spam" (a mailbox with moveToSpam disabled still marks spam in the category field).
- When the operator explicitly asks to delete spam across mailboxes, call \`delete_spam_emails\` (omit mailboxId to cover every mailbox). That tool only deletes messages marked as spam (Spam folder, \`spam\` category, or classifier audit). Report the per-mailbox counts back to the operator.
- Never delete non-spam mail through delete_spam_emails, and never try to draft a reply to spam: both are enforced by the tools, but do not attempt to work around a refusal.
`;




/**
 * Fetch the custom system prompt for a mailbox from its R2 settings.
 * Falls back to DEFAULT_SYSTEM_PROMPT if none is configured.
 */
async function getSystemPrompt(env: Env, mailboxId: string): Promise<string> {
	try {
		const key = `mailboxes/${mailboxId}.json`;
		const obj = await env.BUCKET.get(key);
		if (obj) {
			const settings = await obj.json<Record<string, unknown>>();
			if (typeof settings["agentSystemPrompt"] === "string" && settings["agentSystemPrompt"].trim()) {
				return settings["agentSystemPrompt"];
			}
		}
	} catch {
		// Fall through to default
	}
	return DEFAULT_SYSTEM_PROMPT;
}




function createEmailTools(env: Env, fixedMailboxId: string | null) {
	const allMailboxes = fixedMailboxId === null;




	// Both shapes are spread into every tool's z.object parameters. They carry
	// an explicit mailboxId type instead of z.ZodRawShape so the key survives in
	// the params type each execute() sees. The entry itself still reads back as
	// `unknown` (zod cannot infer the output of a shape entry declared as an
	// optional property), so resolveMailboxId narrows it back to a string.
	const mailboxIdField: { mailboxId?: z.ZodString } = allMailboxes
		? {
				mailboxId: z
					.string()
					.min(1)
					.describe(
						"The mailbox address from list_mailboxes (e.g. user@example.com)",
					),
			}
		: {};
	const optionalMailboxIdField: { mailboxId?: z.ZodOptional<z.ZodString> } = allMailboxes
		? {
				mailboxId: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Mailbox address from list_mailboxes. Omit to operate on every mailbox.",
					),
			}
		: {};




	const missingMailbox = {
		error:
			"mailboxId is required. Call list_mailboxes first and pass the exact mailbox address.",
	};




	/**
	 * Resolve the mailbox for one tool call. Global mode requires an explicit
	 * mailboxId and verifies it exists, so a hallucinated or mistyped address
	 * cannot silently operate on an empty Durable Object.
	 *
	 * The argument arrives as `unknown`: the mailboxId entry of the spread
	 * params shape reads back as unknown (see above), and the tool's JSON
	 * schema still requires a string, so any non-string counts as absent.
	 */
	const resolveMailboxId = async (
		explicit?: unknown,
	): Promise<string | { error: string }> => {
		const requested = typeof explicit === "string" ? explicit : undefined;
		const candidate = (allMailboxes ? requested : fixedMailboxId)?.trim();
		if (!candidate) return missingMailbox;
		if (!allMailboxes) return candidate;
		const normalized = candidate.toLowerCase();
		const exists = await env.BUCKET.head(`mailboxes/${normalized}.json`);
		if (!exists) {
			return {
				error: `Mailbox "${candidate}" not found. Call list_mailboxes and use one of the returned IDs.`,
			};
		}
		return normalized;
	};




	return {
		// Only expose the mailbox list when the chat is not already scoped to
		// a single mailbox; per-mailbox chats should stay focused.
		...(allMailboxes
			? {
					list_mailboxes: defineTool({
						description:
							"List every mailbox in this account. Call this first for any request that spans mailboxes, then pass the returned mailboxId to the other tools.",
						parameters: z.object({}),
						execute: async (): Promise<unknown> => {
							return toolListMailboxes(env);
						},
					}),
				}
			: {}),




		list_emails: defineTool({
			description:
				"List emails in a folder. Returns email metadata (id, subject, sender, recipient, date, read/starred status, thread_id, folder_id, category). Use folder='spam' to review the Spam folder.",
			parameters: z.object({
				...mailboxIdField,
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
			}),
			execute: async (args) => {
				const mailboxId = await resolveMailboxId(args.mailboxId);
				if (typeof mailboxId !== "string") return mailboxId;
				return toolListEmails(env, mailboxId, {
					folder: args.folder ?? Folders.INBOX,
					limit: args.limit ?? 20,
					page: args.page ?? 1,
					category: args.category,
				});
			},
		}),




		get_email: defineTool({
			description:
				"Get a single email with its full body content and attachments. Use this to read the actual content of an email.",
			parameters: z.object({
				...mailboxIdField,
				emailId: z.string().describe("The email ID to retrieve"),
			}),
			execute: async (args) => {
				const mailboxId = await resolveMailboxId(args.mailboxId);
				if (typeof mailboxId !== "string") return mailboxId;
				return toolGetEmail(env, mailboxId, args.emailId);
			},
		}),




		get_thread: defineTool({
			description:
				"Get all emails in a conversation thread. This is essential for understanding the full context of a conversation before drafting a response. Returns all messages sorted chronologically.",
			parameters: z.object({
				...mailboxIdField,
				threadId: z
					.string()
					.describe(
						"The thread_id to retrieve all messages for. Get this from an email's thread_id field.",
					),
			}),
			execute: async (args) => {
				const mailboxId = await resolveMailboxId(args.mailboxId);
				if (typeof mailboxId !== "string") return mailboxId;
				return toolGetThread(env, mailboxId, args.threadId);
			},
		}),




		search_emails: defineTool({
			description:
				"Search for emails in one mailbox. Free text matches subject, body, sender and recipient; Gmail-style operators (from:bob is:unread has:attachment before:2025-01-01) are accepted in the query or as separate filters.",
			parameters: z.object({
				...mailboxIdField,
				query: z
					.string()
					.optional()
					.describe(
						"Search text matched against subject, body, sender and recipient. May also contain Gmail-style operators (from:bob, is:unread, has:attachment, before:2025-01-01).",
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
			}),
			execute: async (args) => {
				const mailboxId = await resolveMailboxId(args.mailboxId);
				if (typeof mailboxId !== "string") return mailboxId;
				return toolSearchEmails(env, mailboxId, {
					query: args.query,
					folder: args.folder,
					category: args.category,
					from: args.from,
					to: args.to,
					subject: args.subject,
					isRead: args.isRead,
					isStarred: args.isStarred,
					hasAttachment: args.hasAttachment,
					before: args.before,
					after: args.after,
					page: args.page,
					limit: args.limit,
				});
			},
		}),




		draft_email: defineTool({
			description:
				"Draft a new email (not a reply) and save it to the Drafts folder. This does NOT send — it saves a draft for the operator to review. Use this for composing new outbound emails. Write the body as plain text — no HTML tags.",
			parameters: z.object({
				...mailboxIdField,
				to: z.string().email().describe("Recipient email address"),
				subject: z.string().describe("Subject line"),
				body: z
					.string()
					.describe(
						"The plain text body of the email. No HTML — just write normally.",
					),
			}),
			execute: async (args) => {
				const mailboxId = await resolveMailboxId(args.mailboxId);
				if (typeof mailboxId !== "string") return mailboxId;
				return toolDraftEmail(env, mailboxId, {
					to: args.to,
					subject: args.subject,
					body: args.body,
					isPlainText: true,
					applySignature: true,
				});
			},
		}),




		draft_reply: defineTool({
			description:
				"Draft a reply to an existing email and save it to the Drafts folder. This does NOT send — it saves a draft for the operator to review and send from the UI. Drafts are refused for emails marked as spam. Write the body as plain text — no HTML tags.",
			parameters: z.object({
				...mailboxIdField,
				originalEmailId: z
					.string()
					.describe("The ID of the email being replied to"),
				to: z.string().email().describe("Recipient email address"),
				subject: z
					.string()
					.describe("Subject line (usually 'Re: ...')"),
				body: z
					.string()
					.describe(
						"The plain text body of the reply. No HTML — just write normally.",
					),
			}),
			execute: async (args) => {
				const mailboxId = await resolveMailboxId(args.mailboxId);
				if (typeof mailboxId !== "string") return mailboxId;
				return toolDraftReply(env, mailboxId, {
					originalEmailId: args.originalEmailId,
					to: args.to,
					subject: args.subject,
					body: args.body,
					isPlainText: true,
					runVerifyDraft: true,
					applySignature: true,
				});
			},
		}),




		mark_email_read: defineTool({
			description: "Mark an email as read or unread.",
			parameters: z.object({
				...mailboxIdField,
				emailId: z.string().describe("The email ID"),
				read: z
					.boolean()
					.describe("true to mark as read, false for unread"),
			}),
			execute: async (args) => {
				const mailboxId = await resolveMailboxId(args.mailboxId);
				if (typeof mailboxId !== "string") return mailboxId;
				return toolMarkEmailRead(env, mailboxId, args.emailId, args.read);
			},
		}),




		move_email: defineTool({
			description:
				"Move an email to a different folder (inbox, sent, draft, archive, spam, trash).",
			parameters: z.object({
				...mailboxIdField,
				emailId: z.string().describe("The email ID"),
				folderId: z
					.string()
					.describe(MOVE_FOLDER_TOOL_DESCRIPTION),
			}),
			execute: async (args) => {
				const mailboxId = await resolveMailboxId(args.mailboxId);
				if (typeof mailboxId !== "string") return mailboxId;
				return toolMoveEmail(env, mailboxId, args.emailId, args.folderId);
			},
		}),




		delete_email: defineTool({
			description:
				"Delete one email by ID. By default the email is moved to Trash and can be restored; set permanent=true to remove it for good. Permanent deletion is irreversible — only use it when the operator explicitly asks to delete the email forever.",
			parameters: z.object({
				...mailboxIdField,
				emailId: z.string().describe("The email ID to delete"),
				permanent: z
					.boolean()
					.optional()
					.describe(
						"true to permanently delete (irreversible); omit or false to move the email to Trash",
					),
			}),
			execute: async (args) => {
				const mailboxId = await resolveMailboxId(args.mailboxId);
				if (typeof mailboxId !== "string") return mailboxId;
				return toolDeleteEmail(env, mailboxId, args.emailId, args.permanent === true);
			},
		}),




		delete_spam_emails: defineTool({
			description:
				"Permanently delete every email marked as spam (Spam folder, category 'spam', or classifier audit is_spam: true). Permanent deletion is irreversible — spam mail is not moved to Trash. In all-mailbox mode, omit mailboxId to clear spam from every mailbox. Only call this when the operator explicitly asks to delete spam; never delete non-spam mail with it.",
			parameters: z.object({
				...optionalMailboxIdField,
			}).strict(),
			execute: async (args) => {
				if (!allMailboxes) {
					return toolDeleteSpamEmails(env, fixedMailboxId ?? undefined);
				}
				// Omitted mailboxId intentionally means "every mailbox". A supplied
				// but blank ID must not quietly become the same broad operation.
				if (args.mailboxId === undefined) {
					return toolDeleteSpamEmails(env);
				}
				const mailboxId = await resolveMailboxId(args.mailboxId);
				if (typeof mailboxId !== "string") return mailboxId;
				return toolDeleteSpamEmails(env, mailboxId);
			},
		}),




		discard_draft: defineTool({
			description:
				"Permanently delete a draft email — drafts are not moved to Trash and cannot be restored. Use this to discard drafts that are no longer needed or were rejected by the operator.",
			parameters: z.object({
				...mailboxIdField,
				draftId: z.string().describe("The ID of the draft to delete"),
			}),
			execute: async (args) => {
				const mailboxId = await resolveMailboxId(args.mailboxId);
				if (typeof mailboxId !== "string") return mailboxId;
				return toolDiscardDraft(env, mailboxId, args.draftId);
			},
		}),








		// Rules: deterministic per-mailbox filters. These tools can shape mail
		// (file, label, star, discard) but can never author automation that
		// SENDS mail — forward_to and auto_reply_text are stripped by
		// toolCreateRule / toolUpdateRule, and a rule carrying them cannot be
		// enabled from here.
		list_rules: defineTool({
			description:
				"List the mailbox's deterministic rules (file, label, star, mark read, discard) with firing statistics. Rules that forward or auto-reply are operator-only: they are listed, but cannot be created, edited, or enabled through tools.",
			parameters: z.object({ ...mailboxIdField }),
			execute: async (args) => {
				const mailboxId = await resolveMailboxId(args.mailboxId);
				if (typeof mailboxId !== "string") return mailboxId;
				return toolListRules(env, mailboxId);
			},
		}),








		create_rule: defineTool({
			description:
				"Create a deterministic rule for incoming mail: move it to a folder, set a category, star/unstar, mark read/unread, or discard it. A rule needs at least one match condition and at least one action. Rules created here cannot send mail: forward_to and auto_reply_text are operator-only and are stripped.",
			parameters: z.object({ ...mailboxIdField, ...ruleToolDraftShape }),
			execute: async (args) => {
				const mailboxId = await resolveMailboxId(args.mailboxId);
				if (typeof mailboxId !== "string") return mailboxId;
				return toolCreateRule(env, mailboxId, {
					name: args.name,
					enabled: args.enabled,
					priority: args.priority,
					match: args.match,
					actions: args.actions,
				});
			},
		}),








		update_rule: defineTool({
			description:
				"Update one deterministic rule by id: rename, reorder, change its conditions or actions, enable or pause it. Rules that send mail automatically (forward or auto-reply) cannot be edited or enabled through tools — only the operator can change those.",
			parameters: z.object({
				...mailboxIdField,
				ruleId: z.string().describe("The rule id to update"),
				name: z.string().optional().describe("New rule name"),
				enabled: z.boolean().optional().describe("true enables, false pauses"),
				priority: z.number().int().optional().describe("Lower runs first"),
				match: ruleToolMatchSchema.optional(),
				actions: ruleToolActionsSchema.optional(),
			}),
			execute: async (args) => {
				const mailboxId = await resolveMailboxId(args.mailboxId);
				if (typeof mailboxId !== "string") return mailboxId;
				const patch = Object.fromEntries(
					Object.entries({
						name: args.name,
						enabled: args.enabled,
						priority: args.priority,
						match: args.match,
						actions: args.actions,
					}).filter(([, value]) => value !== undefined),
				) as RulePatch;
				return toolUpdateRule(env, mailboxId, args.ruleId, patch);
			},
		}),
	};
}




/**
 * JSON body of the POST /onNewEmail request the inbound Worker sends to
 * the agent Durable Object.
 */
interface NewEmailRequest {
	mailboxId: string;
	emailId: string;
	sender: string;
	subject: string;
	threadId: string;
}

// `Env` extends the generated `Cloudflare.Env` — the binding shape the
// AIChatAgent generic is constrained to — so the agent is instantiated with
// the real env type and `this.env` needs no cast.
export class EmailAgent extends AIChatAgent<Env> {
	override async onChatMessage(onFinish: StreamTextOnFinishCallback<ToolSet>) {
		const env = this.env;
		const agentName = this.name;
		const allMailboxes = isAllMailboxesAgentId(agentName);
		const workersai = createWorkersAI({ binding: env.AI });
		const tools: ToolSet = createEmailTools(env, allMailboxes ? null : agentName);
		const systemPrompt = allMailboxes
			? `${DEFAULT_SYSTEM_PROMPT}${ALL_MAILBOXES_SYSTEM_PROMPT}`
			: await getSystemPrompt(env, agentName);




		// Model ids come from the mailbox settings. The all-mailboxes agent
		// has no mailbox of its own, so it uses the app-wide/default model.
		const models = allMailboxes
			? await resolveMailboxModels(env, agentName, {})
			: await resolveMailboxModels(env, agentName);




		const result = streamText({
			model: workersai(models.agent),
			system: systemPrompt,
			messages: await convertToModelMessages(this.messages),
			tools,
			// All-mailbox requests naturally take more rounds (list every mailbox,
			// inspect and delete per mailbox). Per-mailbox chats keep a tighter
			// bound so a normal request stays cheap.
			stopWhen: stepCountIs(allMailboxes ? 40 : 5),
			onFinish,
		});




		return result.toUIMessageStreamResponse();
	}




	/**
	 * Handle HTTP requests to the agent DO. Intercepts /onNewEmail
	 * before passing to the default AIChatAgent handler.
	 */
	override async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/onNewEmail" && request.method === "POST") {
			try {
				const emailData: NewEmailRequest = await request.json();
				const result = await this.handleNewEmail(emailData);
				return new Response(JSON.stringify(result), {
					headers: { "Content-Type": "application/json" },
				});
			} catch (e) {
				console.error("onNewEmail handler failed:", (e as Error).message);
				return new Response(
					JSON.stringify({ error: (e as Error).message }),
					{ status: 500, headers: { "Content-Type": "application/json" } },
				);
			}
		}
		return super.onRequest(request);
	}




	/**
	 * Called when a new email arrives. Reads it, loads the thread,
	 * drafts a response, and saves it to the Drafts folder.
	 */
	async handleNewEmail(emailData: NewEmailRequest) {
		const env = this.env;
		const workersai = createWorkersAI({ binding: env.AI });
		const tools: ToolSet = createEmailTools(env, emailData.mailboxId);
		const systemPrompt = await getSystemPrompt(env, emailData.mailboxId);
		// Model ids come from the mailbox settings, falling back to app-wide
		// settings and the built-in defaults.
		const models = await resolveMailboxModels(env, emailData.mailboxId);




		// Pre-read the email and thread so the agent has full context
		// without needing to waste tool calls discovering it
		const stub = getMailboxStub(env, emailData.mailboxId);




		let emailBody = "";
		let threadContext = "";
		try {
			const email = (await stub.getEmail(emailData.emailId)) as EmailFull | null;




			// Defense in depth: the inbound Worker already skips auto-draft for
			// mail classified as spam, but re-check the stored row so a direct
			// /onNewEmail invocation (or manually moved spam) can never create
			// a reply draft.
			if (isSpamMarkedEmail(email)) {
				console.warn(
					"Skipping auto-draft for spam-marked email:",
					emailData.emailId,
				);
				return { status: "skipped_spam" as const };
			}
			if (email?.body) {
				const isInjection = await isPromptInjection(env.AI, email.body, models.promptInjection);
				if (isInjection) {
					console.warn("Skipping auto-draft due to detected prompt injection:", emailData.emailId);
					
					// Log to agent chat so the user knows why it skipped
					const newMessages = [
						{
							id: crypto.randomUUID(),
							role: "user" as const,
							content: `[Auto-triggered] New email from ${emailData.sender}: "${emailData.subject}"`,
							createdAt: new Date(),
							parts: [{ type: "text" as const, text: `[Auto-triggered] New email from ${emailData.sender}: "${emailData.subject}"` }],
						},
						{
							id: crypto.randomUUID(),
							role: "assistant" as const,
							content: "⚠️ Blocked auto-draft creation: the email appears to contain prompt injection or malicious instructions.",
							createdAt: new Date(),
							parts: [{ type: "text" as const, text: "⚠️ Blocked auto-draft creation: the email appears to contain prompt injection or malicious instructions." }],
						},
					];
					await this.persistMessages([...this.messages, ...newMessages]);
					
					return;
				}
				
				emailBody = stripHtmlToText(email.body);
			}




		// Load thread for conversation context
		const threadEmails = (await stub.getEmails({ thread_id: emailData.threadId })) as EmailMetadata[];
		if (threadEmails.length > 1) {
			const fullThread = await Promise.all(
				threadEmails.map(async (e) => {
					const full = (await stub.getEmail(e.id)) as EmailFull | null;
					const text = full?.body ? stripHtmlToText(full.body) : "";
					return { id: e.id, sender: e.sender, recipient: e.recipient, subject: e.subject, date: e.date, folder_id: e.folder_id, body_text: text };
				}),
			);
			fullThread.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
			threadContext = fullThread
				.map((e) => `[${e.date}] ${e.sender} → ${e.recipient} (${e.folder_id}): ${e.body_text.substring(0, 500)}`)
				.join("\n\n");




			// Scan thread context for prompt injection too -- an attacker
			// could plant an injection in an earlier email in the thread
			// that gets included in the agent's prompt.
			if (threadContext) {
				const threadInjection = await isPromptInjection(env.AI, threadContext, models.promptInjection);
				if (threadInjection) {
					console.warn("Skipping auto-draft due to prompt injection in thread context:", emailData.threadId);
					const newMessages = [
						{
							id: crypto.randomUUID(),
							role: "user" as const,
							content: `[Auto-triggered] New email from ${emailData.sender}: "${emailData.subject}"`,
							createdAt: new Date(),
							parts: [{ type: "text" as const, text: `[Auto-triggered] New email from ${emailData.sender}: "${emailData.subject}"` }],
						},
						{
							id: crypto.randomUUID(),
							role: "assistant" as const,
							content: "Blocked auto-draft creation: the thread context appears to contain prompt injection or malicious instructions.",
							createdAt: new Date(),
							parts: [{ type: "text" as const, text: "Blocked auto-draft creation: the thread context appears to contain prompt injection or malicious instructions." }],
						},
					];
					await this.persistMessages([...this.messages, ...newMessages]);
					return;
				}
			}
		}
		} catch (e) {
			console.warn("Pre-read failed, agent will use tools:", (e as Error).message);
		}




		let autoPrompt = `A new email just arrived. Draft an appropriate response using draft_reply.




Email details:
- Mailbox: ${emailData.mailboxId}
- Email ID: ${emailData.emailId}
- From: ${emailData.sender}
- Subject: ${emailData.subject}
- Thread ID: ${emailData.threadId}




Email body:
${emailBody || "(could not pre-read — use get_email to read it)"}`;




		if (threadContext) {
			autoPrompt += `




Full thread history (${emailData.threadId}):
${threadContext}`;
		} else {
			autoPrompt += `




This is the first message in the thread (no prior conversation).`;
		}




		autoPrompt += `




Based on the email content and thread context above, draft a reply using draft_reply. If you need more context, use get_thread with thread ID "${emailData.threadId}".`;




		// Fresh context for auto-draft -- don't include prior chat history
		// to avoid confusing the model with old messages and tool calls
		const messages = [
			{
				role: "user" as const,
				content: autoPrompt,
				parts: [{ type: "text" as const, text: autoPrompt }],
				createdAt: new Date(),
			},
		];




		try {
			const result = await generateText({
				model: workersai(models.agent),
				system: systemPrompt,
				messages: await convertToModelMessages(messages),
				tools,
				stopWhen: stepCountIs(5),
			});




			// Check whether a draft was actually saved. A draft_reply call that
			// was refused (for example because the email is spam) must not be
			// reported as success.
			const draftToolCalled = result.steps.some((step) =>
				step.toolCalls?.some(
					(tc) => tc?.toolName === "draft_reply" || tc?.toolName === "draft_email",
				),
			);
			const draftToolSucceeded = result.steps.some((step) =>
				(step.toolResults ?? []).some((toolResult) => {
					// `result` is the pre-v6 spelling of `output`; keep reading it so
					// steps produced before the rename still count as saved drafts.
					const output: unknown =
						toolResult.output ?? ("result" in toolResult ? toolResult.result : undefined);
					return Boolean(
						output &&
							typeof output === "object" &&
							"draftId" in output,
					);
				}),
			);




			let inlineDraftSaved = false;
			if (!draftToolCalled && result.text.trim()) {
				const draftStub = getMailboxStub(env, emailData.mailboxId);
				// Fail closed: re-read the row before writing. If the email vanished
				// or was marked as spam while the model was running, keep the draft
				// out of the mailbox.
				const freshEmail = (await draftStub.getEmail(emailData.emailId)) as EmailFull | null;
				if (!freshEmail || isSpamMarkedEmail(freshEmail)) {
					console.warn(
						"Skipping inline auto-draft: email missing or marked as spam:",
						emailData.emailId,
					);
				} else {
					// Model generated a draft inline as text -- verify with AI
					const sanitizedText = await verifyDraft(env.AI, result.text.trim());
					if (sanitizedText) {
						const draftId = crypto.randomUUID();
						const reSubject = emailData.subject.startsWith("Re:")
							? emailData.subject
							: `Re: ${emailData.subject}`;
						await draftStub.createEmail(
							Folders.DRAFT,
							{
								id: draftId,
								subject: reSubject,
								sender: emailData.mailboxId.toLowerCase(),
								recipient: emailData.sender.toLowerCase(),
								date: new Date().toISOString(),
								// verifyDraft may return plain text or HTML depending on
								// its code path; only wrap plain text.
								body: /<[a-z][\s\S]*>/i.test(sanitizedText)
									? sanitizedText
									: textToHtml(sanitizedText),
								in_reply_to: emailData.emailId,
								email_references: null,
								thread_id: emailData.threadId,
							},
							[],
						);
						inlineDraftSaved = true;
					}
				}
			}




			// Persist the conversation into the agent's chat history.
			const assistantText = draftToolSucceeded || inlineDraftSaved
				? `Created draft reply to ${emailData.sender}.`
				: result.text.trim() ||
					"No draft was created. The email may be marked as spam; check the Spam folder.";




			const newMessages = [
				{
					id: crypto.randomUUID(),
					role: "user" as const,
					content: `[Auto-triggered] New email from ${emailData.sender}: "${emailData.subject}"`,
					createdAt: new Date(),
					parts: [
						{
							type: "text" as const,
							text: `[Auto-triggered] New email from ${emailData.sender}: "${emailData.subject}"`,
						},
					],
				},
				{
					id: crypto.randomUUID(),
					role: "assistant" as const,
					content: assistantText,
					createdAt: new Date(),
					parts: [
						{
							type: "text" as const,
							text: assistantText,
						},
					],
				},
			];




			await this.persistMessages([...this.messages, ...newMessages]);




			return { status: "draft_generated", text: result.text };
		} catch (e) {
			console.error("Auto-draft failed:", (e as Error).message);
			return { status: "error", error: (e as Error).message };
		}
	}
}



