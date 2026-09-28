// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The scoped automation surface: `POST /api/v1/scoped/<tool>`.
 *
 * An automation outside the Cloudflare Access boundary authenticates with a
 * per-mailbox access token instead of an Access session. The token string
 * carries the mailbox id it was minted for (shared/access-tokens.ts), so a
 * token is bound to exactly one mailbox: every call it makes runs in that
 * mailbox, and the request body can never name another. Each exposed tool
 * maps to one of the token's scopes:
 *
 *     read   list_emails, get_email, get_thread, search_emails, get_attachment
 *     draft  draft_reply, create_draft, update_draft, discard_draft
 *     send   send_email, send_reply
 *
 * A scoped call only ever runs the tool the token-holding client asked for:
 * nothing on this surface schedules, drafts or sends mail on its own, and the
 * two send tools keep every guard the agent and MCP surfaces carry — the
 * draft verifier runs first, and a refusal comes back as an error answer, not
 * as a send.
 *
 * Mutating calls are recorded in the mailbox's `agent_actions` log with
 * source "scoped" (workers/lib/agent-actions.ts), the same metadata-only
 * record the MCP surface writes for its own mutating tools, so the operator
 * can see what each token did.
 */

import { Folders } from "../../shared/folders";
import {
	parseAccessToken,
	type AccessTokenScope,
} from "../../shared/access-tokens";
import { hashAccessToken } from "./access-tokens";
import { runAudited } from "./agent-actions";
import { getMailboxStub } from "./email-helpers";
import {
	toolDiscardDraft,
	toolDraftEmail,
	toolDraftReply,
	toolGetAttachment,
	toolGetEmail,
	toolGetThread,
	toolListEmails,
	toolSearchEmails,
	toolSendEmail,
	toolSendReply,
	toolUpdateDraft,
	type SearchEmailParams,
	type ToolSendEmailAttachment,
} from "./tools";
import type { Env } from "../types";

/**
 * The scope each scoped tool requires. Every tool this surface exposes is
 * listed here exactly once; a name that is not in the map is refused before
 * anything else about the request is looked at.
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
	send_email: "send",
	send_reply: "send",
};

/**
 * The one message every authentication failure answers with. A bearer
 * credential must not be an oracle: a missing header, another scheme, a
 * malformed token and a wrong or revoked secret all read the same.
 */
const INVALID_ACCESS_TOKEN_ERROR = "Invalid or revoked access token";

/** A verified scoped caller, bound to the mailbox its token was minted for. */
export interface ScopedAuthSuccess {
	ok: true;
	mailboxId: string;
	scopes: AccessTokenScope[];
	tokenId: string;
}

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
 * The token string is the whole credential: its mailbox-id segment selects
 * the mailbox's Durable Object and the SHA-256 of the full string is the
 * lookup key, so a token only ever resolves in the mailbox it was minted
 * for. Every failure — missing header, another scheme, a token that is not
 * the wire shape, a secret that does not resolve, a revoked token — answers
 * the identical 401, so a near miss cannot be told from garbage.
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
	if (!parsed) return failure;

	const record = await getMailboxStub(env, parsed.mailboxId).verifyAccessToken(
		await hashAccessToken(token),
	);
	if (!record) return failure;

	return {
		ok: true,
		mailboxId: parsed.mailboxId,
		scopes: record.scopes,
		tokenId: record.id,
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
function invokeScopedTool(
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
		default:
			// Unreachable through runScopedTool, which only dispatches names
			// the scope map carries. A direct caller that bypasses it still
			// fails loudly instead of running nothing.
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
 * name), a body that carries a `mailboxId` answers 400 (the surface is bound
 * to one mailbox by its token), a token without the tool's scope answers 403,
 * and only then does the tool run. A tool answer that carries an `error`
 * field — the refusal shape every tool in workers/lib/tools.ts uses — is a
 * 400, a tool answer without one is a 200 carrying the tool's own return, and
 * a thrown error is logged and answered 500.
 */
export async function runScopedTool(
	env: Env,
	auth: ScopedAuthSuccess,
	toolName: string,
	args: unknown,
): Promise<ScopedToolResult> {
	const scope = SCOPED_TOOL_SCOPES[toolName];
	if (!scope) {
		return { status: 404, body: { error: `Unknown tool: ${toolName}` } };
	}

	const params = argumentObject(args);
	if ("mailboxId" in params) {
		return {
			status: 400,
			body: {
				error:
					"The scoped surface is bound to one mailbox; mailboxId is not accepted.",
			},
		};
	}

	if (!auth.scopes.includes(scope)) {
		return {
			status: 403,
			body: { error: `This token lacks the ${scope} scope` },
		};
	}

	try {
		const result = await invokeScopedTool(env, auth.mailboxId, toolName, params);
		const failure = errorMessage(result);
		if (failure !== null) {
			return { status: 400, body: { error: failure } };
		}
		return { status: 200, body: { ok: true, result } };
	} catch (e) {
		console.error(
			`Scoped tool ${toolName} failed for ${auth.mailboxId}:`,
			(e as Error).message,
		);
		return { status: 500, body: { error: (e as Error).message } };
	}
}
