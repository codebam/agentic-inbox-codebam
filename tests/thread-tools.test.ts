// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Thread tools: the shared implementations behind the MCP and agent
 * surfaces (workers/lib/tools.ts), their real Durable Object effects, and
 * the audited mark_thread_read wrapper on both surfaces.
 *
 * The mutators are checked against real DO state — the mute row read back
 * with isThreadMuted, message read flags read back with getEmail — never
 * against their own return values alone. summarize_thread runs against the
 * module's AI-runner seam (the technique tests/thread-summary.test.ts uses),
 * so the success shape, the unknown-thread error and the unavailable-model
 * error are all exercised without the pool ever reaching a real model. The
 * surface tests drive the live /mcp endpoint and the agent tool map the same
 * way tests/agent-actions.test.ts does.
 *
 * Nothing here sends mail and nothing is deleted.
 */


import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { DEFAULT_MODELS } from "../shared/models";
import { createEmailTools } from "../workers/agent/index";
import { setThreadSummaryAiRunnerFactory } from "../workers/lib/thread-summary";
import {
	toolGetThread,
	toolMarkThreadRead,
	toolMuteThread,
	toolSummarizeThread,
	toolUnmuteThread,
} from "../workers/lib/tools";


type Stub = ReturnType<typeof stubFor>;


/** The `agent_actions` columns the mark_thread_read wrapper fills. */
interface ActionRow {
	id: string;
	source: string;
	tool: string;
	email_id: string | null;
	thread_id: string | null;
	args: string | null;
	undoable: boolean;
}


/** The message fields these tests read back off a stored row. */
interface StoredRow {
	id: string;
	read: boolean;
	thread_id: string | null;
}


/** One get_thread result, as the tool returns it. */
interface ThreadToolResult {
	thread_id: string;
	message_count: number;
	messages: StoredRow[];
	muted: boolean;
}


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


/** Register the mailbox record the /mcp verifyMailbox gate checks. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
}


/** Seed one stored message into a thread (the shape createEmail takes). */
async function seedEmail(
	stub: Stub,
	id: string,
	threadId: string,
	overrides: { read?: boolean; date?: string; body?: string } = {},
) {
	await stub.createEmail(
		Folders.INBOX,
		{
			id,
			subject: `Subject ${id}`,
			sender: "sender@example.org",
			recipient: "thread-tools@example.com",
			date: overrides.date ?? new Date().toISOString(),
			read: overrides.read ?? false,
			starred: false,
			body: overrides.body ?? "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: threadId,
		},
		[],
	);
}


/** Read a stored row back through the DO; null when the id is unknown. */
async function readRow(stub: Stub, id: string): Promise<StoredRow | null> {
	return (await stub.getEmail(id)) as StoredRow | null;
}


/** The mailbox's audit rows, newest first. */
async function actionsOf(stub: Stub): Promise<ActionRow[]> {
	return (await stub.listAgentActions(50)) as unknown as ActionRow[];
}


/** A fake AI runner that records its calls and answers `answer`. */
function fakeRunner(answer: string | null) {
	const calls: { prompt: string; model: string }[] = [];
	return {
		calls,
		runner: {
			run: async (prompt: string, model: string) => {
				calls.push({ prompt, model });
				return answer;
			},
		},
	};
}


/** Parse an SSE body into its JSON-RPC messages. */
function parseSse(text: string) {
	return text
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
}


/** Initialize an MCP session and return the headers its requests need. */
async function mcpHeaders(): Promise<Record<string, string>> {
	const init = await SELF.fetch("http://example.com/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "test", version: "1" },
			},
		}),
	});
	expect(init.status).toBe(200);
	const session = init.headers.get("mcp-session-id") ?? "";
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
	};
	if (session) headers["mcp-session-id"] = session;
	await SELF.fetch("http://example.com/mcp", {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
	});
	return headers;
}


/** Drive one tool call through the live /mcp endpoint. */
async function mcpCall(
	name: string,
	args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
	const headers = await mcpHeaders();
	const res = await SELF.fetch("http://example.com/mcp", {
		method: "POST",
		headers,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
	expect(res.status).toBe(200);
	const messages = parseSse(await res.text());
	const result = messages[0]?.result as
		| { content?: { text?: string }[]; isError?: boolean }
		| undefined;
	return {
		isError: result?.isError === true,
		text: result?.content?.[0]?.text ?? "",
	};
}


// The runner seam is module-level: every test that sets it resets it.
afterEach(() => setThreadSummaryAiRunnerFactory(null));


describe("toolMuteThread / toolUnmuteThread", () => {
	it("mutes a thread and unmutes it, with the DO state agreeing", async () => {
		const mailbox = "tools-mute@example.com";
		const stub = stubFor(mailbox);

		expect(
			await toolMuteThread(env, mailbox, { threadId: "thread-mute-1" }),
		).toEqual({ muted: true });
		expect(await stub.isThreadMuted("thread-mute-1")).toBe(true);

		expect(
			await toolUnmuteThread(env, mailbox, { threadId: "thread-mute-1" }),
		).toEqual({ muted: false });
		expect(await stub.isThreadMuted("thread-mute-1")).toBe(false);
	});

	it("mutes an id with no stored messages, and muting twice is idempotent", async () => {
		const mailbox = "tools-mute-empty@example.com";
		const stub = stubFor(mailbox);

		expect(
			await toolMuteThread(env, mailbox, { threadId: "not-yet-seen" }),
		).toEqual({ muted: true });
		expect(
			await toolMuteThread(env, mailbox, { threadId: "not-yet-seen" }),
		).toEqual({ muted: true });
		expect(await stub.isThreadMuted("not-yet-seen")).toBe(true);

		// Unmuting an already unmuted thread stays idempotent too.
		expect(
			await toolUnmuteThread(env, mailbox, { threadId: "never-muted" }),
		).toEqual({ muted: false });
	});

	it("trims the id like the mute route, and rejects a bad one with the route's error", async () => {
		const mailbox = "tools-mute-invalid@example.com";
		const stub = stubFor(mailbox);

		await toolMuteThread(env, mailbox, { threadId: "  spaced-thread  " });
		expect(await stub.isThreadMuted("spaced-thread")).toBe(true);

		for (const bad of ["", "   ", "x".repeat(321)]) {
			expect(await toolMuteThread(env, mailbox, { threadId: bad })).toEqual({
				error: "threadId must be 1 to 320 characters",
			});
		}
	});
});


describe("toolMarkThreadRead", () => {
	it("marks every message in the thread read and leaves other threads alone", async () => {
		const mailbox = "tools-thread-read@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "tr-1", "thread-read-1");
		await seedEmail(stub, "tr-2", "thread-read-1");
		await seedEmail(stub, "tr-3", "thread-read-1", { read: true });
		await seedEmail(stub, "tr-other", "thread-read-other");

		expect(
			await toolMarkThreadRead(env, mailbox, { threadId: "thread-read-1" }),
		).toEqual({ status: "marked_read" });

		for (const id of ["tr-1", "tr-2", "tr-3"]) {
			expect((await readRow(stub, id))?.read).toBe(true);
		}
		expect((await readRow(stub, "tr-other"))?.read).toBe(false);
	});
});


describe("toolGetThread", () => {
	it("returns the thread's messages plus the muted flag", async () => {
		const mailbox = "tools-get-thread@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "gt-1", "thread-get-1", {
			date: "2026-09-20T10:00:00.000Z",
		});
		await seedEmail(stub, "gt-2", "thread-get-1", {
			date: "2026-09-20T11:00:00.000Z",
		});

		const before = (await toolGetThread(
			env,
			mailbox,
			"thread-get-1",
		)) as ThreadToolResult;
		expect(Object.keys(before).sort()).toEqual([
			"message_count",
			"messages",
			"muted",
			"thread_id",
		]);
		expect(before.thread_id).toBe("thread-get-1");
		expect(before.message_count).toBe(2);
		expect(before.messages.map((message) => message.id)).toEqual(["gt-1", "gt-2"]);
		expect(before.muted).toBe(false);

		await toolMuteThread(env, mailbox, { threadId: "thread-get-1" });
		const after = (await toolGetThread(
			env,
			mailbox,
			"thread-get-1",
		)) as ThreadToolResult;
		expect(after.muted).toBe(true);
	});
});


describe("toolSummarizeThread", () => {
	it("returns the normalized summary object for a stored thread", async () => {
		const mailbox = "tools-summarize@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "sum-1", "thread-summarize-1", {
			date: "2026-09-20T10:00:00.000Z",
			body: "<p>Shall we meet at noon?</p>",
		});
		await seedEmail(stub, "sum-2", "thread-summarize-1", {
			date: "2026-09-20T11:00:00.000Z",
			body: "<p>Noon works.</p>",
		});

		const { calls, runner } = fakeRunner(
			"  Alice proposes lunch; Bob agrees to noon.  ",
		);
		setThreadSummaryAiRunnerFactory(() => runner);

		const result = await toolSummarizeThread(env, mailbox, {
			threadId: "thread-summarize-1",
		});

		expect(result).toEqual({
			text: "Alice proposes lunch; Bob agrees to noon.",
			message_count: 2,
			truncated: false,
			model: DEFAULT_MODELS.summarizer,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.prompt).toContain("Shall we meet at noon?");
	});

	it("answers the not-found error for an unknown thread and never calls the model", async () => {
		const mailbox = "tools-summarize-missing@example.com";
		// A message exists in a DIFFERENT thread, so the error comes from the
		// thread lookup, not from the mailbox being empty.
		await seedEmail(stubFor(mailbox), "other-1", "thread-summarize-other");

		const { calls, runner } = fakeRunner("should never run");
		setThreadSummaryAiRunnerFactory(() => runner);

		expect(
			await toolSummarizeThread(env, mailbox, { threadId: "no-such-thread" }),
		).toEqual({ error: "Thread not found" });
		expect(calls).toHaveLength(0);
	});

	it("answers the unavailable error when the model returns nothing usable or throws", async () => {
		const mailbox = "tools-summarize-unavailable@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "un-1", "thread-summarize-unavailable", {
			date: "2026-09-20T10:00:00.000Z",
		});

		setThreadSummaryAiRunnerFactory(() => fakeRunner("   \n  ").runner);
		expect(
			await toolSummarizeThread(env, mailbox, {
				threadId: "thread-summarize-unavailable",
			}),
		).toEqual({ error: "Thread summarization is unavailable right now." });

		setThreadSummaryAiRunnerFactory(() => ({
			run: async () => {
				throw new Error("model down");
			},
		}));
		expect(
			await toolSummarizeThread(env, mailbox, {
				threadId: "thread-summarize-unavailable",
			}),
		).toEqual({ error: "Thread summarization is unavailable right now." });
	});
});


describe("thread tools on the live surfaces", () => {
	it("exposes the four thread tools on the agent map", () => {
		const tools = createEmailTools(env, "thread-agent-map@example.com");
		const names = Object.keys(tools);
		for (const name of [
			"mute_thread",
			"unmute_thread",
			"mark_thread_read",
			"summarize_thread",
		]) {
			expect(names).toContain(name);
		}
	});

	it("mutes and unmutes a thread over /mcp without audit rows", async () => {
		const mailbox = "thread-mcp-mute@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		const muted = await mcpCall("mute_thread", {
			mailboxId: mailbox,
			threadId: "mcp-mute-1",
		});
		expect(muted.isError).toBe(false);
		expect(JSON.parse(muted.text)).toEqual({ muted: true });
		expect(await stub.isThreadMuted("mcp-mute-1")).toBe(true);

		const unmuted = await mcpCall("unmute_thread", {
			mailboxId: mailbox,
			threadId: "mcp-mute-1",
		});
		expect(unmuted.isError).toBe(false);
		expect(JSON.parse(unmuted.text)).toEqual({ muted: false });
		expect(await stub.isThreadMuted("mcp-mute-1")).toBe(false);

		// Mute is notification bookkeeping, not an audited mutation.
		expect(await actionsOf(stub)).toHaveLength(0);
	});

	it("records mark_thread_read through the agent and MCP wrappers", async () => {
		const agentMailbox = "thread-agent-audit@example.com";
		const agentStub = stubFor(agentMailbox);
		await seedEmail(agentStub, "agent-read-1", "thread-agent-1");
		await seedEmail(agentStub, "agent-read-2", "thread-agent-1");

		const tools = createEmailTools(env, agentMailbox);
		const result = await tools.mark_thread_read.execute({
			threadId: "thread-agent-1",
		});
		expect(result).toEqual({ status: "marked_read" });
		expect((await readRow(agentStub, "agent-read-1"))?.read).toBe(true);
		expect((await readRow(agentStub, "agent-read-2"))?.read).toBe(true);

		const [agentRow] = await actionsOf(agentStub);
		expect(agentRow).toMatchObject({
			tool: "mark_thread_read",
			source: "agent",
			email_id: null,
			undoable: false,
		});

		const mcpMailbox = "thread-mcp-audit@example.com";
		await registerMailbox(mcpMailbox);
		const mcpStub = stubFor(mcpMailbox);
		await seedEmail(mcpStub, "mcp-read-1", "thread-mcp-1");

		const answer = await mcpCall("mark_thread_read", {
			mailboxId: mcpMailbox,
			threadId: "thread-mcp-1",
		});
		expect(answer.isError).toBe(false);
		expect(JSON.parse(answer.text)).toEqual({ status: "marked_read" });
		expect((await readRow(mcpStub, "mcp-read-1"))?.read).toBe(true);

		const [mcpRow] = await actionsOf(mcpStub);
		expect(mcpRow).toMatchObject({
			tool: "mark_thread_read",
			source: "mcp",
			email_id: null,
			undoable: false,
			args: JSON.stringify({ threadId: "thread-mcp-1" }),
		});
	});
});
