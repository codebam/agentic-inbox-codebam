// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The scoped automation surface: `POST /api/v1/scoped/<tool>`.
 *
 * An automation outside the Cloudflare Access boundary authenticates with an
 * access token instead of an Access session. Two kinds are accepted:
 *
 *     ain1_<hex mailbox id>_<43-char secret>   one mailbox (Settings tokens)
 *     ain2_<43-char secret>                    every mailbox (app tokens)
 *
 * A mailbox token carries the mailbox id it was minted for
 * (shared/access-tokens.ts), so it is bound to exactly one mailbox: every
 * call it makes runs in that mailbox, and the request body can never name
 * another. An app token names no mailbox at all: each mailbox-scoped call it
 * makes must carry `mailboxId` in the body and runs against exactly the
 * mailbox named. Each exposed tool maps to one of the token's scopes:
 *
 *     read   list_emails, get_email, get_thread, search_emails, get_attachment
 *     draft  draft_reply, create_draft, update_draft, discard_draft
 *     send   send_email, send_reply, unsubscribe_email
 *     manage mark_email_read, star_email, move_email, delete_email,
 *            snooze_email, unsnooze_email, set_sender_policy
 *
 * An app token may additionally call the two all-mailbox read tools —
 * list_mailboxes and search_all_mailboxes, each requiring the read scope.
 * They are deliberately absent from SCOPED_TOOL_SCOPES: that map is the /mcp
 * gate's authority for a mailbox-bound session (workers/mcp/index.ts), so a
 * name in it describes a tool a one-mailbox token may call. A mailbox token
 * naming either all-mailbox name is refused like any other unknown tool.
 *
 * A scoped call only ever runs the tool the token-holding client asked for:
 * nothing on this surface schedules, drafts or sends mail on its own, and the
 * two send tools keep every guard the agent and MCP surfaces carry — the
 * draft verifier runs first, and a refusal comes back as an error answer, not
 * as a send.
 *
 * Two tools never join SCOPED_TOOL_SCOPES: unsubscribe_email fires the
 * RFC 8058 one-click POST to a URL taken from message content, and
 * get_image relays one message image through the shared SSRF guard. The
 * guardrail keeps both reachable only through an operator-minted token on
 * an explicit operator action, never by an agent or MCP session
 * (SCOPED_SURFACE_ONLY_TOOL_SCOPES, below).
 *
 * Mutating calls are recorded in the target mailbox's `agent_actions` log
 * with source "scoped" (workers/lib/agent-actions.ts), the same metadata-only
 * record the MCP surface writes for its own mutating tools, so the operator
 * can see what each token did.
 */

import { Folders } from "../../shared/folders";
import {
	parseAccessToken,
	parseAppAccessToken,
	type AccessTokenScope,
} from "../../shared/access-tokens";
import { hashAccessToken } from "./access-tokens";
import { runAudited } from "./agent-actions";
import { verifyAppAccessToken } from "./app-tokens";
import { getMailboxStub } from "./email-helpers";
import {
	toolDeleteEmail,
	toolDiscardDraft,
	toolDraftEmail,
	toolDraftReply,
	toolGetAttachment,
	toolGetEmail,
	toolGetImage,
	toolGetThread,
	toolListEmails,
	toolListMailboxes,
	toolMarkEmailRead,
	toolMoveEmail,
	toolSearchAllMailboxes,
	toolSearchEmails,
	toolSendEmail,
	toolSendReply,
	toolSetSenderPolicy,
	toolSnoozeEmail,
	toolStarEmail,
	toolUnsnoozeEmail,
	toolUnsubscribeEmail,
	toolUpdateDraft,
	type SearchEmailParams,
	type ToolSendEmailAttachment,
} from "./tools";
import type { Env } from "../types";

/**
 * The scope each mailbox-scoped tool requires. Every tool listed here is
 * callable with either token kind, and a mailbox token can call nothing else:
 * a name that is not in the map is refused before anything else about the
 * request is looked at.
 */
export const SCOPED_TOOL_SCOPES: Record<string, AccessTokenScope> = {
	list_emails: "read",
	get_email: "read",
	get_thread: "read",
	search_emails: "read",
	get_attachment: "read",
	draft_reply: "draft",
	create_draft: "draft",
	update_draft: "draft",
	discard_draft: "draft",
	mark_email_read: "manage",
	star_email: "manage",
	move_email: "manage",
	delete_email: "manage",
	snooze_email: "manage",
	unsnooze_email: "manage",
	set_sender_policy: "manage",
	send_email: "send",
	send_reply: "send",
};

/**
 * The two all-mailbox read tools an app-level token may additionally call,
 * and the scope each requires. Deliberately separate from SCOPED_TOOL_SCOPES:
 * that map is shared with the /mcp gate, where it describes what a
 * mailbox-bound session may invoke, so an all-mailbox name must never join
 * it.
 */
export const APP_ONLY_SCOPED_TOOL_SCOPES: Record<string, AccessTokenScope> = {
	list_mailboxes: "read",
	search_all_mailboxes: "read",
};

/**
 * The tools this surface carries that the /mcp gate must never share, and
 * the scope each requires. Both fetch a URL taken from message content:
 * unsubscribe_email fires the RFC 8058 one-click POST, get_image relays
 * one message image through the SSRF guard and R2 cache. The guardrail is
 * that only an explicit operator action through an operator-minted token
 * may reach either: the names stay out of SCOPED_TOOL_SCOPES, the map the
 * /mcp gate reads, so no agent or MCP session can ever call them.
 */
export const SCOPED_SURFACE_ONLY_TOOL_SCOPES: Record<string, AccessTokenScope> = {
	get_image: "read",
	unsubscribe_email: "send",
};
// (get_image reuses the image-proxy guard and cache; it is read-scoped
// because what it returns is message content, not a state change.)

/**
 * The one message every authentication failure answers with. A bearer
 * credential must not be an oracle: a missing header, another scheme, a
 * malformed token and a wrong or revoked secret all read the same.
 */
const INVALID_ACCESS_TOKEN_ERROR = "Invalid or revoked access token";

/**
 * The refusal an app-token call that names no mailbox answers with. An app
 * token reaches every mailbox, so it can never have one picked for it: every
 * mailbox-scoped call names its target, and the message says how.
 */
const APP_MAILBOX_ID_REQUIRED_ERROR =
	"This token reaches every mailbox; pass mailboxId to name the one this call acts on.";

/** A verified mailbox-scoped caller, bound to the mailbox its token was minted for. */
export interface ScopedMailboxAuthSuccess {
	ok: true;
	kind: "mailbox";
	mailboxId: string;
	scopes: AccessTokenScope[];
	tokenId: string;
}

/**
 * A verified app-level caller: one credential for every mailbox. It carries
 * no mailbox of its own — each mailbox-scoped call names its target, and the
 * two all-mailbox read tools need none.
 */
export interface ScopedAppAuthSuccess {
	ok: true;
	kind: "app";
	scopes: AccessTokenScope[];
	tokenId: string;
}

/** A verified scoped caller, of either kind. */
export type ScopedAuthSuccess = ScopedMailboxAuthSuccess | ScopedAppAuthSuccess;

/** The single 401 shape an unverifiable request answers with. */
export interface ScopedAuthFailure {
	ok: false;
	status: 401;
	error: string;
}

/** The outcome of authenticating one scoped request. */
export type ScopedAuthResult = ScopedAuthSuccess | ScopedAuthFailure;

/** The statuses `runScopedTool` answers with. */
export type ScopedToolStatus = 200 | 400 | 403 | 404 | 500;

/** One scoped call's answer, ready for the route's `c.json(body, status)`. */
export interface ScopedToolResult {
	status: ScopedToolStatus;
	body: Record<string, unknown>;
}

/**
 * Extract the token from an `Authorization` header. The scheme is matched
 * case-insensitively (`Bearer`), as mcp-auth.ts does for /mcp; a header with
 * no value, another scheme, or whitespace inside the value yields null.
 */
function bearerToken(authorization: string | undefined): string | null {
	if (!authorization) return null;
	const match = /^\s*Bearer[ \t]+(\S+)\s*$/i.exec(authorization);
	return match?.[1] ?? null;
}

/**
 * Authenticate one scoped request from its raw `Authorization` header.
 *
 * Either token kind is accepted, and the two parsers are disjoint, so a
 * presented credential can never be read as the wrong kind. A mailbox token
 * (`ain1`) selects the mailbox's Durable Object by its id segment and its
 * SHA-256 is the lookup key there, so it only ever resolves in the mailbox it
 * was minted for; an app token (`ain2`) carries no mailbox and resolves
 * against the deployment's R2 store (workers/lib/app-tokens.ts). Every
 * failure — missing header, another scheme, a token that is not either wire
 * shape, a secret that does not resolve, a revoked token — answers the
 * identical 401, so a near miss cannot be told from garbage.
 */
export async function authenticateScopedRequest(
	authorization: string | undefined,
	env: Env,
): Promise<ScopedAuthResult> {
	const failure: ScopedAuthFailure = {
		ok: false,
		status: 401,
		error: INVALID_ACCESS_TOKEN_ERROR,
	};

	const token = bearerToken(authorization);
	if (!token) return failure;

	const parsed = parseAccessToken(token);
	if (parsed) {
		const record = await getMailboxStub(env, parsed.mailboxId).verifyAccessToken(
			await hashAccessToken(token),
		);
		if (!record) return failure;
		return {
			ok: true,
			kind: "mailbox",
			mailboxId: parsed.mailboxId,
			scopes: record.scopes,
			tokenId: record.id,
		};
	}

	if (!parseAppAccessToken(token)) return failure;
	const appRecord = await verifyAppAccessToken(env.BUCKET, token);
	if (!appRecord) return failure;
	return {
		ok: true,
		kind: "app",
		scopes: appRecord.scopes,
		tokenId: appRecord.id,
	};
}

/** The request body as a plain argument object; anything else is no args. */
function argumentObject(args: unknown): Record<string, unknown> {
	return args !== null && typeof args === "object" && !Array.isArray(args)
		? (args as Record<string, unknown>)
		: {};
}

/**
 * One string argument, read only when the field actually carries a string —
 * a JSON number or object is read as an empty string rather than passed on
 * to a tool function that declared a string.
 */
function stringArgument(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	return typeof value === "string" ? value : "";
}

/** One optional string argument; undefined when absent or not a string. */
function optionalStringArgument(
	args: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = args[key];
	return typeof value === "string" ? value : undefined;
}

/** One optional boolean argument; undefined when absent or not a boolean. */
function optionalBooleanArgument(
	args: Record<string, unknown>,
	key: string,
): boolean | undefined {
	const value = args[key];
	return typeof value === "boolean" ? value : undefined;
}

/** One optional number argument; undefined when absent or not a finite number. */
function optionalNumberArgument(
	args: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = args[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The filters of one search_emails call: the same fields the MCP tool schema
 * declares, each read only when it carries the expected JSON type.
 */
function searchArguments(args: Record<string, unknown>): SearchEmailParams {
	return {
		query: optionalStringArgument(args, "query"),
		folder: optionalStringArgument(args, "folder"),
		category: optionalStringArgument(args, "category"),
		from: optionalStringArgument(args, "from"),
		to: optionalStringArgument(args, "to"),
		subject: optionalStringArgument(args, "subject"),
		isRead: optionalBooleanArgument(args, "isRead"),
		isStarred: optionalBooleanArgument(args, "isStarred"),
		hasAttachment: optionalBooleanArgument(args, "hasAttachment"),
		before: optionalStringArgument(args, "before"),
		after: optionalStringArgument(args, "after"),
		page: optionalNumberArgument(args, "page"),
		limit: optionalNumberArgument(args, "limit"),
	};
}

/**
 * The inline files one send call carries, passed on exactly as the caller
 * sent them: toolSendEmail's own cap and base64 checks refuse anything the
 * attachment list cannot carry, so nothing is dropped silently here.
 */
function attachmentArguments(
	value: unknown,
): ToolSendEmailAttachment[] | undefined {
	return Array.isArray(value) ? (value as ToolSendEmailAttachment[]) : undefined;
}

/**
 * Run one mapped tool in the token's mailbox.
 *
 * Each call mirrors the MCP registration for that tool — the same argument
 * names, the same defaults and the same options (drafts are HTML, run the
 * draft verifier and take the mailbox signature; no-argument calls pass what
 * the MCP call passes) — and every mutating tool is wrapped in runAudited
 * where the MCP surface wraps its own mutating tools, with source "scoped",
 * the scoped tool name, and metadata-only args (ids, a subject, a thread id —
 * never a message body).
 */
/** One boolean argument; an absent or unusable value takes the fallback. */
function booleanArgument(
	args: Record<string, unknown>,
	key: string,
	fallback: boolean,
): boolean {
	const value = args[key];
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return fallback;
}

async function invokeScopedTool(
	env: Env,
	mailboxId: string,
	toolName: string,
	params: Record<string, unknown>,
): Promise<unknown> {
	switch (toolName) {
		case "list_emails":
			return toolListEmails(env, mailboxId, {
				folder: stringArgument(params, "folder") || Folders.INBOX,
				limit: optionalNumberArgument(params, "limit") ?? 20,
				page: optionalNumberArgument(params, "page") ?? 1,
				category: optionalStringArgument(params, "category"),
			});
		case "get_email":
			return toolGetEmail(env, mailboxId, stringArgument(params, "emailId"));
		case "get_thread":
			return toolGetThread(env, mailboxId, stringArgument(params, "threadId"));
		case "search_emails":
			return toolSearchEmails(env, mailboxId, searchArguments(params));
		case "get_attachment":
			return toolGetAttachment(env, mailboxId, {
				attachmentId: stringArgument(params, "attachmentId"),
			});
		case "get_image":
			return toolGetImage(env, { url: stringArgument(params, "url") });
		case "draft_reply":
			return runAudited(
				env,
				{
					source: "scoped",
					tool: "draft_reply",
					mailboxId,
					emailId: optionalStringArgument(params, "originalEmailId") ?? null,
					args: {
						originalEmailId: stringArgument(params, "originalEmailId"),
						subject: stringArgument(params, "subject"),
					},
				},
				() =>
					toolDraftReply(env, mailboxId, {
						originalEmailId: stringArgument(params, "originalEmailId"),
						to: optionalStringArgument(params, "to"),
						subject: stringArgument(params, "subject"),
						body: stringArgument(params, "bodyHtml"),
						isPlainText: false,
						runVerifyDraft: true,
						applySignature: true,
					}),
			);
		case "create_draft":
			return runAudited(
				env,
				{
					source: "scoped",
					tool: "create_draft",
					mailboxId,
					emailId: null,
					args: {
						subject: stringArgument(params, "subject"),
						in_reply_to: optionalStringArgument(params, "in_reply_to") ?? null,
						thread_id: optionalStringArgument(params, "thread_id") ?? null,
					},
				},
				() =>
					toolDraftEmail(env, mailboxId, {
						to: stringArgument(params, "to"),
						subject: stringArgument(params, "subject"),
						body: stringArgument(params, "bodyHtml"),
						isPlainText: false,
						runVerifyDraft: true,
						applySignature: true,
						in_reply_to: optionalStringArgument(params, "in_reply_to"),
						thread_id: optionalStringArgument(params, "thread_id"),
					}),
			);
		case "update_draft":
			return runAudited(
				env,
				{
					source: "scoped",
					tool: "update_draft",
					mailboxId,
					emailId: optionalStringArgument(params, "draftId") ?? null,
					args: {
						draftId: stringArgument(params, "draftId"),
						subject: optionalStringArgument(params, "subject") ?? null,
					},
				},
				() =>
					toolUpdateDraft(env, mailboxId, {
						draftId: stringArgument(params, "draftId"),
						to: optionalStringArgument(params, "to"),
						subject: optionalStringArgument(params, "subject"),
						bodyHtml: optionalStringArgument(params, "bodyHtml"),
					}),
			);
		case "discard_draft":
			return runAudited(
				env,
				{
					source: "scoped",
					tool: "discard_draft",
					mailboxId,
					emailId: optionalStringArgument(params, "draftId") ?? null,
					args: { draftId: stringArgument(params, "draftId") },
				},
				() => toolDiscardDraft(env, mailboxId, stringArgument(params, "draftId")),
			);
		case "send_email":
			return runAudited(
				env,
				{
					source: "scoped",
					tool: "send_email",
					mailboxId,
					emailId: null,
					args: { subject: stringArgument(params, "subject") },
				},
				() =>
					toolSendEmail(env, mailboxId, {
						to: stringArgument(params, "to"),
						cc: stringOrStringList(params, "cc"),
						bcc: stringOrStringList(params, "bcc"),
						subject: stringArgument(params, "subject"),
						bodyHtml: stringArgument(params, "bodyHtml"),
						attachments: attachmentArguments(params["attachments"]),
					}),
			);
		case "send_reply":
			return runAudited(
				env,
				{
					source: "scoped",
					tool: "send_reply",
					mailboxId,
					emailId: optionalStringArgument(params, "originalEmailId") ?? null,
					args: {
						originalEmailId: stringArgument(params, "originalEmailId"),
						subject: stringArgument(params, "subject"),
					},
				},
				() =>
					toolSendReply(env, mailboxId, {
						originalEmailId: stringArgument(params, "originalEmailId"),
						to: stringArgument(params, "to"),
						subject: stringArgument(params, "subject"),
						bodyHtml: stringArgument(params, "bodyHtml"),
					}),
			);
		case "mark_email_read":
			return runAudited(
				env,
				{
					source: "scoped",
					tool: "mark_email_read",
					mailboxId,
					emailId: stringArgument(params, "emailId"),
					args: {
						emailId: stringArgument(params, "emailId"),
						read: booleanArgument(params, "read", true),
					},
				},
				() =>
					toolMarkEmailRead(
						env,
						mailboxId,
						stringArgument(params, "emailId"),
						booleanArgument(params, "read", true),
					),
			);
		case "star_email":
			return runAudited(
				env,
				{
					source: "scoped",
					tool: "star_email",
					mailboxId,
					emailId: stringArgument(params, "emailId"),
					args: {
						emailId: stringArgument(params, "emailId"),
						starred: booleanArgument(params, "starred", true),
					},
				},
				() =>
					toolStarEmail(
						env,
						mailboxId,
						stringArgument(params, "emailId"),
						booleanArgument(params, "starred", true),
					),
			);
		case "move_email":
			return runAudited(
				env,
				{
					source: "scoped",
					tool: "move_email",
					mailboxId,
					emailId: stringArgument(params, "emailId"),
					args: {
						emailId: stringArgument(params, "emailId"),
						folderId: stringArgument(params, "folderId"),
					},
				},
				() =>
					toolMoveEmail(
						env,
						mailboxId,
						stringArgument(params, "emailId"),
						stringArgument(params, "folderId"),
					),
			);
		case "delete_email":
			return runAudited(
				env,
				{
					source: "scoped",
					tool: "delete_email",
					mailboxId,
					emailId: stringArgument(params, "emailId"),
					args: {
						emailId: stringArgument(params, "emailId"),
						permanent: booleanArgument(params, "permanent", false),
					},
				},
				() =>
					toolDeleteEmail(
						env,
						mailboxId,
						stringArgument(params, "emailId"),
						booleanArgument(params, "permanent", false),
					),
			);
		case "snooze_email":
			return runAudited(
				env,
				{
					source: "scoped",
					tool: "snooze_email",
					mailboxId,
					emailId: stringArgument(params, "emailId"),
					args: {
						emailId: stringArgument(params, "emailId"),
						until: stringArgument(params, "until"),
					},
				},
				() =>
					toolSnoozeEmail(
						env,
						mailboxId,
						stringArgument(params, "emailId"),
						stringArgument(params, "until"),
					),
			);
		case "unsnooze_email":
			return runAudited(
				env,
				{
					source: "scoped",
					tool: "unsnooze_email",
					mailboxId,
					emailId: stringArgument(params, "emailId"),
					args: { emailId: stringArgument(params, "emailId") },
				},
				() =>
					toolUnsnoozeEmail(env, mailboxId, stringArgument(params, "emailId")),
			);
		case "set_sender_policy": {
			const policy = stringArgument(params, "policy");
			if (policy !== "allow" && policy !== "block") {
				return { error: 'policy must be "allow" or "block"' };
			}
			return runAudited(
				env,
				{
					source: "scoped",
					tool: "set_sender_policy",
					mailboxId,
					emailId: stringArgument(params, "emailId"),
					args: {
						emailId: stringArgument(params, "emailId"),
						policy,
					},
				},
				() =>
					toolSetSenderPolicy(
						env,
						mailboxId,
						stringArgument(params, "emailId"),
						policy,
					),
			);
		}
		case "unsubscribe_email":
			return runAudited(
				env,
				{
					source: "scoped",
					tool: "unsubscribe_email",
					mailboxId,
					emailId: stringArgument(params, "emailId"),
					args: { emailId: stringArgument(params, "emailId") },
				},
				() =>
					toolUnsubscribeEmail(env, mailboxId, stringArgument(params, "emailId")),
			);
		default:
			// Unreachable through runScopedTool, which only dispatches names
			// the scope map carries. A direct caller that bypasses it still
			// fails loudly instead of running nothing.
			throw new Error(`Unknown tool: ${toolName}`);
	}
}

/**
 * Run one app-only tool: the two all-mailbox reads an app token may call,
 * which no mailbox token and no mailbox-bound call can reach. list_mailboxes
 * answers every mailbox in the deployment verbatim; search_all_mailboxes is
 * the very function the MCP registration calls, with the request's search
 * filters (searchArguments, whose mailboxId field is not a filter).
 */
function invokeAppOnlyScopedTool(
	env: Env,
	toolName: string,
	params: Record<string, unknown>,
): Promise<unknown> {
	switch (toolName) {
		case "list_mailboxes":
			return toolListMailboxes(env);
		case "search_all_mailboxes":
			return toolSearchAllMailboxes(env, searchArguments(params));
		default:
			// Unreachable through runScopedTool, which only dispatches names
			// the two scope maps carry.
			throw new Error(`Unknown tool: ${toolName}`);
	}
}

/** One address argument, as a lone address or a list of addresses. */
function stringOrStringList(
	args: Record<string, unknown>,
	key: string,
): string | string[] | undefined {
	const value = args[key];
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		const values: unknown[] = value;
		return values.every((entry): entry is string => typeof entry === "string")
			? values
			: undefined;
	}
	return undefined;
}

/** The `error` message of a tool answer that carries one, else null. */
function errorMessage(value: unknown): string | null {
	if (value === null || typeof value !== "object" || !("error" in value)) {
		return null;
	}
	const message = (value as { error?: unknown }).error;
	return typeof message === "string" ? message : "Tool call failed";
}

/**
 * Dispatch one authenticated scoped call.
 *
 * The order is fixed: an unknown tool answers 404 (echoing only the tool
 * name), a body the surface cannot act on answers 400, a token without the
 * tool's scope answers 403, and only then does the tool run. What that 400
 * body refuses depends on the token kind: a mailbox token naming a
 * `mailboxId` (its token fixes the mailbox), or an app token not naming one
 * with a string (the token reaches every mailbox, so the call must say
 * which). A mailbox token runs every call in its own mailbox; an app token's
 * mailbox-scoped calls run against the mailbox the body names, and its two
 * all-mailbox tools run against all of them. A tool answer that carries an
 * `error` field — the refusal shape every tool in workers/lib/tools.ts uses —
 * is a 400, a tool answer without one is a 200 carrying the tool's own
 * return, and a thrown error is logged and answered 500.
 */
export async function runScopedTool(
	env: Env,
	auth: ScopedAuthSuccess,
	toolName: string,
	args: unknown,
): Promise<ScopedToolResult> {
	const sharedScope = SCOPED_TOOL_SCOPES[toolName];
	const surfaceOnlyScope = SCOPED_SURFACE_ONLY_TOOL_SCOPES[toolName];
	const appOnlyScope =
		auth.kind === "app" ? APP_ONLY_SCOPED_TOOL_SCOPES[toolName] : undefined;
	const scope = sharedScope ?? surfaceOnlyScope ?? appOnlyScope;
	if (!scope) {
		return { status: 404, body: { error: `Unknown tool: ${toolName}` } };
	}

	// Only an app token ever gets this far with a name neither the shared
	// map nor the surface-only map carries (a mailbox token would have
	// answered 404 above): it is one of the two app-only tools.
	const appOnly = appOnlyScope !== undefined;

	const params = argumentObject(args);
	// The mailbox the call runs against: the token's own for a mailbox token,
	// the body's for an app token's mailbox-scoped call, and none at all for
	// an app-only tool (which reaches every mailbox by design).
	let mailboxId: string | null = null;
	if (auth.kind === "mailbox") {
		if ("mailboxId" in params) {
			return {
				status: 400,
				body: {
					error:
						"The scoped surface is bound to one mailbox; mailboxId is not accepted.",
				},
			};
		}
		mailboxId = auth.mailboxId;
	} else if (!appOnly) {
		const requested = params["mailboxId"];
		if (typeof requested !== "string") {
			return { status: 400, body: { error: APP_MAILBOX_ID_REQUIRED_ERROR } };
		}
		mailboxId = requested;
	}

	if (!auth.scopes.includes(scope)) {
		return {
			status: 403,
			body: { error: `This token lacks the ${scope} scope` },
		};
	}

	try {
		const result =
			mailboxId === null
				? await invokeAppOnlyScopedTool(env, toolName, params)
				: await invokeScopedTool(env, mailboxId, toolName, params);
		const failure = errorMessage(result);
		if (failure !== null) {
			return { status: 400, body: { error: failure } };
		}
		return { status: 200, body: { ok: true, result } };
	} catch (e) {
		console.error(
			`Scoped tool ${toolName} failed for ${mailboxId ?? "every mailbox"}:`,
			(e as Error).message,
		);
		return { status: 500, body: { error: (e as Error).message } };
	}
}
