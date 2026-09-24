// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Audit wrapper for the mutating agent/MCP tools.
 *
 * Every mutating call made through the agent or the MCP server is recorded in
 * the mailbox's `agent_actions` table (migration 20) so the operator can see
 * what the model did and roll back the reversible part of it. The log is
 * deliberately metadata-only: ids, flags, folder names, a subject and a
 * thread id. Message bodies, attachment bytes and credentials are never
 * stored, and every JSON column is bounded before it reaches the database.
 *
 * Guardrails:
 * - Recording never changes the result `fn` returns, and never swallows a
 *   tool error: a throwing mutation propagates before anything is written,
 *   so a failed call is never recorded as if it had happened.
 * - `undoable` is set only for the reversible tools (move_email, star_email,
 *   mark_email_read), whose whole effect is the recorded read/starred/folder
 *   state. delete_email is recorded, but never undoable.
 * - Nothing here sends or deletes mail; undo restores the three reversible
 *   fields and nothing else.
 */

import { getMailboxStub } from "./email-helpers";
import type { AgentActionInput } from "../durableObject";
import type { Env } from "../types";

/** Longest JSON string stored in one audit metadata column. */
export const AGENT_ACTION_JSON_LIMIT = 1000;

/** Longest single string value kept inside a bounded metadata object. */
const AGENT_ACTION_VALUE_LIMIT = 200;

/** The surfaces a recorded action can come from. */
export type AgentActionSource = "agent" | "mcp";

/**
 * Tools whose whole effect undo_action can restore from `before_state`.
 * Everything else is recorded for the operator, but not undoable.
 */
export const REVERSIBLE_AGENT_TOOLS: readonly string[] = [
	"move_email",
	"star_email",
	"mark_email_read",
];

/** The message fields the audit log snapshots before and after a mutation. */
export interface AgentActionState {
	read: boolean;
	starred: boolean;
	folder_id: string | null;
	subject: string | null;
	thread_id: string | null;
}

/** What runAudited needs to know about the call it wraps. */
export interface AgentActionContext {
	source: AgentActionSource;
	tool: string;
	mailboxId: string;
	/** The message the call acts on; null for a call that targets no message. */
	emailId: string | null;
	/** The tool's own arguments, stored as bounded JSON metadata. */
	args?: Record<string, unknown> | null;
}

/** The mailbox stub shape these helpers use. */
type MailboxStub = ReturnType<typeof getMailboxStub>;

/**
 * Clip every string leaf of a JSON-safe value, so a long subject or id
 * cannot bloat a metadata column.
 */
function boundLeaves(value: unknown): unknown {
	if (typeof value === "string") {
		return value.length > AGENT_ACTION_VALUE_LIMIT
			? `${value.slice(0, AGENT_ACTION_VALUE_LIMIT)}...`
			: value;
	}
	if (Array.isArray(value)) return value.map((entry) => boundLeaves(entry));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
				key,
				boundLeaves(entry),
			]),
		);
	}
	return value;
}

/**
 * JSON string of a metadata object, bounded to AGENT_ACTION_JSON_LIMIT
 * characters. String values are clipped first — the audited payloads are
 * ids, flags, folder names, subjects — and the final slice is
 * a last-resort cap that those payloads never reach.
 */
export function boundActionJson(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	const json = JSON.stringify(boundLeaves(value));
	return json.length > AGENT_ACTION_JSON_LIMIT
		? json.slice(0, AGENT_ACTION_JSON_LIMIT)
		: json;
}

/** Read the audited fields off a stored message; null when the id is unknown. */
async function readState(
	stub: MailboxStub,
	emailId: string,
): Promise<AgentActionState | null> {
	const email = (await stub.getEmail(emailId)) as unknown as {
		read?: unknown;
		starred?: unknown;
		folder_id?: unknown;
		subject?: unknown;
		thread_id?: unknown;
	} | null;
	if (!email) return null;
	return {
		read: !!email.read,
		starred: !!email.starred,
		folder_id: typeof email.folder_id === "string" ? email.folder_id : null,
		subject: typeof email.subject === "string" ? email.subject : null,
		thread_id: typeof email.thread_id === "string" ? email.thread_id : null,
	};
}

/**
 * Run one mutating tool call and record it in the mailbox's audit log.
 *
 * Reads the message's before-state, awaits `fn`, reads the after-state and
 * writes one `agent_actions` row. The helper returns `fn`'s result
 * unchanged: a throwing `fn` propagates before anything is recorded (a
 * failed mutation is not logged), and a recording failure is logged and
 * swallowed so the audit log can never turn a successful mutation into an
 * error for the caller. `undoable` is true only for the reversible tools,
 * and only when a before-state was actually recorded.
 */
export async function runAudited<T>(
	env: Env,
	context: AgentActionContext,
	fn: () => Promise<T>,
): Promise<T> {
	const stub = getMailboxStub(env, context.mailboxId);
	const before = context.emailId ? await readState(stub, context.emailId) : null;

	const result = await fn();

	try {
		const after = context.emailId ? await readState(stub, context.emailId) : null;
		const action: AgentActionInput = {
			id: crypto.randomUUID(),
			source: context.source,
			tool: context.tool,
			emailId: context.emailId,
			emailSubject: before?.subject ?? after?.subject ?? null,
			threadId: before?.thread_id ?? after?.thread_id ?? null,
			args: boundActionJson(context.args ?? null),
			beforeState: boundActionJson(before),
			afterState: boundActionJson(after),
			undoable: REVERSIBLE_AGENT_TOOLS.includes(context.tool) && before !== null,
		};
		await stub.recordAgentAction(action);
	} catch (e) {
		console.error(
			`Failed to record agent action ${context.tool} for ${context.mailboxId}:`,
			(e as Error).message,
		);
	}

	return result;
}
