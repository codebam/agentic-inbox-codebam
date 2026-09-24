/**
 * Agent action audit tests.
 *
 * Covers, in order: migration 20's table and index, the runAudited wrapper
 * for each audited tool (delete_email is recorded but not undoable), the
 * failure path (a throwing mutation is not recorded), the 500-row prune, the
 * MailboxDO undo (restore + refusal on a second call), the two audit routes
 * (list ordering/limit/cap, undo 200/400/404), and the two new tools on both
 * surfaces — the agent tool map and the live /mcp endpoint, including the
 * wrapped star_email recording through each surface.
 *
 * Nothing in this feature talks to the network: the log is metadata only, so
 * the tests assert exactly that shape (ids, flags, folder names, subjects).
 */

import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { createEmailTools } from "../workers/agent/index";
import {
	AGENT_ACTION_JSON_LIMIT,
	REVERSIBLE_AGENT_TOOLS,
	boundActionJson,
	runAudited,
} from "../workers/lib/agent-actions";
import {
	toolDeleteEmail,
	toolListAgentActions,
	toolMarkEmailRead,
	toolMoveEmail,
	toolStarEmail,
	toolUndoAgentAction,
} from "../workers/lib/tools";

type Stub = ReturnType<typeof stubFor>;

/** The `agent_actions` columns this feature owns. */
interface ActionRow {
	id: string;
	source: string;
	tool: string;
	email_id: string | null;
	email_subject: string | null;
	thread_id: string | null;
	args: string | null;
	before_state: string | null;
	after_state: string | null;
	undoable: boolean;
	undone_at: string | null;
	created_at: string;
}

/** The message columns the audit snapshots and the undo restores. */
interface EmailState {
	id: string;
	read: boolean;
	starred: boolean;
	folder_id: string;
	subject: string | null;
	trashed_at: string | null;
}

/** Answer shape of the list route. */
interface ActionsResponse {
	actions?: ActionRow[];
	totalCount?: number;
	error?: string;
}

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

/** Register the mailbox record the API middleware checks before routing. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
}

/** Seed one stored message. */
async function seedEmail(
	stub: Stub,
	id: string,
	folder: string = Folders.INBOX,
	fields: { read?: boolean; starred?: boolean } = {},
) {
	await stub.createEmail(
		folder,
		{
			id,
			subject: `Subject ${id}`,
			sender: "sender@example.org",
			recipient: "agent-actions@example.com",
			date: new Date().toISOString(),
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: id,
			...fields,
		},
		[],
	);
}

/** Read a message back through the DO. */
async function readRow(stub: Stub, id: string): Promise<EmailState | null> {
	return (await stub.getEmail(id)) as unknown as EmailState | null;
}

/** The mailbox's audit rows, newest first. */
async function actionsOf(stub: Stub, limit = 50): Promise<ActionRow[]> {
	return (await stub.listAgentActions(limit)) as unknown as ActionRow[];
}

/** Write one audit row directly, for the prune and route-ordering tests. */
async function recordAction(
	stub: Stub,
	id: string,
	createdAt: string,
	overrides: {
		tool?: string;
		source?: "agent" | "mcp";
		undoable?: boolean;
		emailId?: string | null;
	} = {},
) {
	await stub.recordAgentAction({
		id,
		createdAt,
		source: overrides.source ?? "agent",
		tool: overrides.tool ?? "star_email",
		undoable: overrides.undoable ?? true,
		emailId: overrides.emailId ?? null,
	});
}

/** Parse a JSON body of one of the audit routes. */
async function getActions(
	mailbox: string,
	query = "",
): Promise<{ status: number; body: ActionsResponse }> {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/agent-actions${query}`,
	);
	return { status: res.status, body: (await res.json()) as ActionsResponse };
}

/** POST the undo route and parse its answer. */
async function postUndo(
	mailbox: string,
	actionId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/agent-actions/${actionId}/undo`,
		{ method: "POST" },
	);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Narrow an undo answer without fighting the RPC union type. */
function undoOk(result: unknown): { action: ActionRow; email: EmailState } {
	const answer = result as { ok?: boolean } | null;
	expect(answer?.ok).toBe(true);
	return result as { action: ActionRow; email: EmailState };
}

/** Narrow a refused undo answer. */
function undoError(result: unknown): string {
	const answer = result as { ok?: boolean; error?: string } | null;
	expect(answer?.ok).toBe(false);
	return answer?.error ?? "";
}

/** The JSON stored in one metadata column, parsed back. */
function parseState(raw: string | null): Record<string, unknown> {
	expect(raw).not.toBeNull();
	return JSON.parse(raw ?? "null") as Record<string, unknown>;
}

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

/** Every tool name the live /mcp endpoint advertises. */
async function mcpToolNames(): Promise<string[]> {
	const headers = await mcpHeaders();
	const list = await SELF.fetch("http://example.com/mcp", {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
	});
	expect(list.status).toBe(200);
	const messages = parseSse(await list.text());
	const tools =
		(messages[0]?.result as { tools?: { name: string }[] } | undefined)?.tools ?? [];
	return tools.map((tool) => tool.name);
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

// ── Migration ──────────────────────────────────────────────────────

describe("migration 20_add_agent_actions", () => {
	it("creates the agent_actions table on a fresh DO", async () => {
		const stub = stubFor("audit-migration@example.com");

		const migration = await runInDurableObject(stub, async (_instance, state) => {
			const table = [
				...state.storage.sql.exec(
					"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_actions'",
				),
			][0] as { sql: string } | undefined;
			const applied = [
				...state.storage.sql.exec(
					"SELECT name FROM d1_migrations WHERE name = '20_add_agent_actions'",
				),
			];
			return { sql: table?.sql ?? null, applied: applied.length };
		});

		expect(migration.applied).toBe(1);
		const sql = migration.sql ?? "";
		for (const column of [
			"id TEXT PRIMARY KEY",
			"source TEXT NOT NULL",
			"tool TEXT NOT NULL",
			"email_id TEXT",
			"email_subject TEXT",
			"thread_id TEXT",
			"args TEXT",
			"before_state TEXT",
			"after_state TEXT",
			"undoable INTEGER NOT NULL DEFAULT 0",
			"undone_at TEXT",
			"created_at TEXT NOT NULL",
		]) {
			expect(sql).toContain(column);
		}
	});

	it("ships the created_at index for newest-first reads", async () => {
		const stub = stubFor("audit-migration-index@example.com");

		const indexSql = await runInDurableObject(stub, async (_instance, state) => {
			const rows = [
				...state.storage.sql.exec(
					"SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_actions_created_at'",
				),
			];
			return (rows[0] as { sql: string } | undefined)?.sql ?? null;
		});

		expect(indexSql).toContain("idx_agent_actions_created_at");
		expect(indexSql).toContain("agent_actions(created_at)");
	});
});

// ── runAudited ─────────────────────────────────────────────────────

describe("runAudited", () => {
	it("records before/after state and the undoable flag for each audited tool", async () => {
		const cases = [
			{
				tool: "move_email",
				status: "moved",
				undoable: true,
				after: { folder_id: Folders.ARCHIVE },
				call: (mailbox: string, id: string) =>
					toolMoveEmail(env, mailbox, id, Folders.ARCHIVE),
			},
			{
				tool: "star_email",
				status: "updated",
				undoable: true,
				after: { starred: true },
				call: (mailbox: string, id: string) => toolStarEmail(env, mailbox, id, true),
			},
			{
				tool: "mark_email_read",
				status: "updated",
				undoable: true,
				after: { read: true },
				call: (mailbox: string, id: string) =>
					toolMarkEmailRead(env, mailbox, id, true),
			},
			{
				tool: "delete_email",
				status: "trashed",
				undoable: false,
				after: { folder_id: Folders.TRASH },
				call: (mailbox: string, id: string) => toolDeleteEmail(env, mailbox, id),
			},
		] as const;

		for (const [index, testCase] of cases.entries()) {
			const mailbox = `audit-${testCase.tool}@example.com`;
			const id = `audit-${index}`;
			const stub = stubFor(mailbox);
			await seedEmail(stub, id);

			const result = await runAudited(
				env,
				{
					source: "agent",
					tool: testCase.tool,
					mailboxId: mailbox,
					emailId: id,
					args: { emailId: id },
				},
				() => testCase.call(mailbox, id),
			);

			// The helper returns fn's result unchanged.
			expect(result).toMatchObject({ status: testCase.status });

			const rows = await actionsOf(stub);
			expect(rows).toHaveLength(1);
			const row = rows[0]!;
			expect(row.tool).toBe(testCase.tool);
			expect(row.source).toBe("agent");
			expect(row.email_id).toBe(id);
			expect(row.email_subject).toBe(`Subject ${id}`);
			expect(row.thread_id).toBe(id);
			expect(row.undoable).toBe(testCase.undoable);
			expect(row.undone_at).toBeNull();
			expect(parseState(row.args)).toEqual({ emailId: id });

			// before-state: an unread, unstarred Inbox message.
			const before = parseState(row.before_state);
			expect(before).toMatchObject({
				read: false,
				starred: false,
				folder_id: Folders.INBOX,
				subject: `Subject ${id}`,
			});
			// after-state: the tool's own effect, read back from the row.
			const after = parseState(row.after_state);
			expect(after).toMatchObject(testCase.after);
		}
	});

	it("propagates a failed mutation and records nothing", async () => {
		const mailbox = "audit-failure@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "audit-fail-1");

		await expect(
			runAudited(
				env,
				{
					source: "agent",
					tool: "star_email",
					mailboxId: mailbox,
					emailId: "audit-fail-1",
				},
				async () => {
					throw new Error("mutation failed");
				},
			),
		).rejects.toThrow("mutation failed");

		expect(await stub.countAgentActions()).toBe(0);
	});

	it("records delete_email without a before-state as not undoable", async () => {
		const mailbox = "audit-failure-record@example.com";
		const stub = stubFor(mailbox);

		await runAudited(
			env,
			{
				source: "agent",
				tool: "star_email",
				mailboxId: mailbox,
				emailId: "never-existed",
			},
			() => toolStarEmail(env, mailbox, "never-existed", true),
		);

		const rows = await actionsOf(stub);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.undoable).toBe(false);
		expect(rows[0]?.before_state).toBeNull();
	});
});

describe("boundActionJson", () => {
	it("returns null for an absent value and clips oversized metadata", () => {
		expect(boundActionJson(null)).toBeNull();
		expect(boundActionJson(undefined)).toBeNull();
		expect(boundActionJson({ emailId: "x" })).toBe('{"emailId":"x"}');

		const clipped = boundActionJson({ subject: "x".repeat(5000) });
		expect(clipped).not.toBeNull();
		expect((clipped ?? "").length).toBeLessThanOrEqual(AGENT_ACTION_JSON_LIMIT);
		expect((clipped ?? "").startsWith('{"subject":"')).toBe(true);
	});

	it("names exactly the reversible tools", () => {
		expect([...REVERSIBLE_AGENT_TOOLS].sort()).toEqual([
			"mark_email_read",
			"move_email",
			"star_email",
		]);
	});
});

// ── MailboxDO.recordAgentAction / listAgentActions ─────────────────

describe("MailboxDO.recordAgentAction", () => {
	it("prunes the mailbox to the newest 500 rows", async () => {
		const stub = stubFor("audit-prune@example.com");
		const base = Date.parse("2026-01-01T00:00:00.000Z");

		for (let i = 0; i < 505; i++) {
			await recordAction(
				stub,
				`prune-${i}`,
				new Date(base + i * 1000).toISOString(),
			);
		}

		expect(await stub.countAgentActions()).toBe(500);
		const rows = await actionsOf(stub, 500);
		expect(rows).toHaveLength(500);
		expect(rows[0]?.id).toBe("prune-504");
		expect(rows[rows.length - 1]?.id).toBe("prune-5");
		const ids = new Set(rows.map((row) => row.id));
		for (const dropped of ["prune-0", "prune-1", "prune-4"]) {
			expect(ids.has(dropped)).toBe(false);
		}
	});
});

// ── MailboxDO.undoAgentAction ──────────────────────────────────────

describe("MailboxDO.undoAgentAction", () => {
	it("restores read, starred and folder, stamps undone_at, then refuses a second undo", async () => {
		const mailbox = "audit-undo@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "undo-1", Folders.ARCHIVE);

		await runAudited(
			env,
			{ source: "agent", tool: "star_email", mailboxId: mailbox, emailId: "undo-1" },
			() => toolStarEmail(env, mailbox, "undo-1", true),
		);
		await runAudited(
			env,
			{ source: "agent", tool: "mark_email_read", mailboxId: mailbox, emailId: "undo-1" },
			() => toolMarkEmailRead(env, mailbox, "undo-1", true),
		);
		expect(await readRow(stub, "undo-1")).toMatchObject({ starred: true, read: true });

		// Undo the star. It restores all three reversible fields from that
		// action's before-state, so the later read change goes back too --
		// that is the specified contract, not an accident.
		const [readAction, starAction] = await actionsOf(stub);
		expect(readAction?.tool).toBe("mark_email_read");
		expect(starAction?.tool).toBe("star_email");

		const undone = undoOk(await stub.undoAgentAction(starAction!.id));
		expect(undone.email).toMatchObject({
			id: "undo-1",
			starred: false,
			read: false,
			folder_id: Folders.ARCHIVE,
		});
		expect(undone.action.undone_at).not.toBeNull();
		expect(undone.action.id).toBe(starAction!.id);

		// The stamp is stored, not just returned.
		const stamped = (await actionsOf(stub)).find((row) => row.id === starAction!.id);
		expect(stamped?.undone_at).toBe(undone.action.undone_at);

		// A second undo fails and changes nothing.
		const second = await stub.undoAgentAction(starAction!.id);
		expect(undoError(second)).toContain("already been undone");
		const after = await readRow(stub, "undo-1");
		expect(after).toMatchObject({ starred: false, read: false, folder_id: Folders.ARCHIVE });
		const stillStamped = (await actionsOf(stub)).find((row) => row.id === starAction!.id);
		expect(stillStamped?.undone_at).toBe(undone.action.undone_at);

		// The later action is still pending: only the undone row is stamped.
		expect((await actionsOf(stub)).find((row) => row.id === readAction!.id)?.undone_at).toBeNull();
	});

	it("restores the folder through folderMoveFields, keeping the Trash stamp honest", async () => {
		const mailbox = "audit-undo-folder@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "undo-folder-1", Folders.INBOX);

		// Into Trash, then undo: the message leaves Trash, so trashed_at clears.
		await runAudited(
			env,
			{ source: "agent", tool: "move_email", mailboxId: mailbox, emailId: "undo-folder-1" },
			() => toolMoveEmail(env, mailbox, "undo-folder-1", Folders.TRASH),
		);
		expect((await readRow(stub, "undo-folder-1"))?.trashed_at).not.toBeNull();
		const trashed = (await actionsOf(stub))[0]!;
		undoOk(await stub.undoAgentAction(trashed.id));
		const restored = await readRow(stub, "undo-folder-1");
		expect(restored?.folder_id).toBe(Folders.INBOX);
		expect(restored?.trashed_at).toBeNull();

		// Out of Trash, then undo: the message goes back to Trash, so
		// trashed_at is stamped again instead of staying cleared.
		await runAudited(
			env,
			{ source: "agent", tool: "move_email", mailboxId: mailbox, emailId: "undo-folder-1" },
			() => toolMoveEmail(env, mailbox, "undo-folder-1", Folders.TRASH),
		);
		await runAudited(
			env,
			{ source: "agent", tool: "move_email", mailboxId: mailbox, emailId: "undo-folder-1" },
			() => toolMoveEmail(env, mailbox, "undo-folder-1", Folders.ARCHIVE),
		);
		expect((await readRow(stub, "undo-folder-1"))?.trashed_at).toBeNull();
		const outOfTrash = (await actionsOf(stub))[0]!;
		undoOk(await stub.undoAgentAction(outOfTrash.id));
		const backInTrash = await readRow(stub, "undo-folder-1");
		expect(backInTrash?.folder_id).toBe(Folders.TRASH);
		expect(backInTrash?.trashed_at).not.toBeNull();
	});

	it("refuses a not-undoable action and leaves the message alone", async () => {
		const mailbox = "audit-undo-delete@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "undo-delete-1");

		await runAudited(
			env,
			{ source: "agent", tool: "delete_email", mailboxId: mailbox, emailId: "undo-delete-1" },
			() => toolDeleteEmail(env, mailbox, "undo-delete-1"),
		);

		const [action] = await actionsOf(stub);
		expect(undoError(await stub.undoAgentAction(action!.id))).toContain("not undoable");
		expect((await readRow(stub, "undo-delete-1"))?.folder_id).toBe(Folders.TRASH);
		expect((await actionsOf(stub))[0]?.undone_at).toBeNull();
	});

	it("returns null for an unknown id", async () => {
		const stub = stubFor("audit-undo-missing@example.com");
		expect(await stub.undoAgentAction("nope")).toBeNull();
	});
});

// ── Routes ─────────────────────────────────────────────────────────

describe("GET /api/v1/mailboxes/:mailboxId/agent-actions", () => {
	it("orders newest first, defaults the limit and counts every stored row", async () => {
		const mailbox = "audit-route-list@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		const base = Date.parse("2026-02-01T00:00:00.000Z");
		for (const [index, id] of ["list-1", "list-2", "list-3"].entries()) {
			await recordAction(stub, id, new Date(base + index * 1000).toISOString());
		}

		const all = await getActions(mailbox);
		expect(all.status).toBe(200);
		expect(all.body.totalCount).toBe(3);
		expect(all.body.actions?.map((row) => row.id)).toEqual([
			"list-3",
			"list-2",
			"list-1",
		]);

		const limited = await getActions(mailbox, "?limit=2");
		expect(limited.body.actions?.map((row) => row.id)).toEqual(["list-3", "list-2"]);
		expect(limited.body.totalCount).toBe(3);

		// A limit below 1 clamps to 1, and an unusable limit falls back to 50.
		expect((await getActions(mailbox, "?limit=0")).body.actions).toHaveLength(1);
		expect((await getActions(mailbox, "?limit=nonsense")).body.actions).toHaveLength(3);
	});

	it("caps the limit at 200", async () => {
		const mailbox = "audit-route-cap@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		const base = Date.parse("2026-02-02T00:00:00.000Z");
		for (let i = 0; i < 205; i++) {
			await recordAction(stub, `cap-${i}`, new Date(base + i * 1000).toISOString());
		}

		const { status, body } = await getActions(mailbox, "?limit=1000");
		expect(status).toBe(200);
		expect(body.actions).toHaveLength(200);
		expect(body.totalCount).toBe(205);
		expect(body.actions?.[0]?.id).toBe("cap-204");
	});
});

describe("POST /api/v1/mailboxes/:mailboxId/agent-actions/:actionId/undo", () => {
	it("answers 200 with the restored action and the updated email", async () => {
		const mailbox = "audit-route-undo@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, "route-undo-1", Folders.ARCHIVE);

		await runAudited(
			env,
			{ source: "agent", tool: "star_email", mailboxId: mailbox, emailId: "route-undo-1" },
			() => toolStarEmail(env, mailbox, "route-undo-1", true),
		);
		const actionId = (await getActions(mailbox)).body.actions?.[0]?.id ?? "";

		const { status, body } = await postUndo(mailbox, actionId);
		expect(status).toBe(200);
		expect(body).toMatchObject({
			action: { id: actionId, tool: "star_email" },
			email: { id: "route-undo-1", starred: false, folder_id: Folders.ARCHIVE },
		});
		expect((body.action as ActionRow).undone_at).not.toBeNull();
	});

	it("answers 400 for an already-undone action", async () => {
		const mailbox = "audit-route-undo-again@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, "route-undo-2");

		await runAudited(
			env,
			{ source: "mcp", tool: "mark_email_read", mailboxId: mailbox, emailId: "route-undo-2" },
			() => toolMarkEmailRead(env, mailbox, "route-undo-2", true),
		);
		const actionId = (await getActions(mailbox)).body.actions?.[0]?.id ?? "";

		expect((await postUndo(mailbox, actionId)).status).toBe(200);
		const again = await postUndo(mailbox, actionId);
		expect(again.status).toBe(400);
		expect(String(again.body.error)).toContain("already been undone");
	});

	it("answers 400 for a not-undoable action", async () => {
		const mailbox = "audit-route-undo-delete@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, "route-undo-3");

		await runAudited(
			env,
			{ source: "agent", tool: "delete_email", mailboxId: mailbox, emailId: "route-undo-3" },
			() => toolDeleteEmail(env, mailbox, "route-undo-3"),
		);
		const actionId = (await getActions(mailbox)).body.actions?.[0]?.id ?? "";

		const { status, body } = await postUndo(mailbox, actionId);
		expect(status).toBe(400);
		expect(String(body.error)).toContain("not undoable");
		expect((await readRow(stub, "route-undo-3"))?.folder_id).toBe(Folders.TRASH);
	});

	it("answers 404 for an unknown action id", async () => {
		const mailbox = "audit-route-undo-missing@example.com";
		await registerMailbox(mailbox);
		const { status, body } = await postUndo(mailbox, "no-such-action");
		expect(status).toBe(404);
		expect(String(body.error)).toContain("not found");
	});
});

// ── Tools & surfaces ───────────────────────────────────────────────

describe("audit tools", () => {
	it("lists the mailbox's actions with the stored total", async () => {
		const mailbox = "audit-tools-list@example.com";
		const stub = stubFor(mailbox);
		const base = Date.parse("2026-03-01T00:00:00.000Z");
		for (const [index, id] of ["tool-1", "tool-2"].entries()) {
			await recordAction(stub, id, new Date(base + index * 1000).toISOString());
		}

		const result = await toolListAgentActions(env, mailbox, 1);
		expect(result.mailboxId).toBe(mailbox);
		expect(result.totalCount).toBe(2);
		expect(result.actions.map((row) => row.id)).toEqual(["tool-2"]);
	});

	it("undoes an action and reports unknown or unusable ids as errors", async () => {
		const mailbox = "audit-tools-undo@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "tool-undo-1", Folders.ARCHIVE);

		await runAudited(
			env,
			{ source: "mcp", tool: "move_email", mailboxId: mailbox, emailId: "tool-undo-1" },
			() => toolMoveEmail(env, mailbox, "tool-undo-1", Folders.SPAM),
		);
		const actionId = (await actionsOf(stub))[0]!.id;

		const undone = await toolUndoAgentAction(env, mailbox, actionId);
		expect(undone).toMatchObject({
			action: { id: actionId, undone_at: expect.any(String) },
			email: { id: "tool-undo-1", folder_id: Folders.ARCHIVE },
		});

		expect(await toolUndoAgentAction(env, mailbox, "missing")).toEqual({
			error: "Agent action not found",
		});
		const second = await toolUndoAgentAction(env, mailbox, actionId);
		expect(second).toHaveProperty("error");
	});
});

describe("audit surfaces", () => {
	it("exposes both tools on the agent map", () => {
		const tools = createEmailTools(env, "audit-agent-map@example.com");
		const names = Object.keys(tools);
		expect(names).toContain("list_agent_actions");
		expect(names).toContain("undo_action");
	});

	it("advertises both tools on the live /mcp handshake", async () => {
		const names = await mcpToolNames();
		expect(names).toContain("list_agent_actions");
		expect(names).toContain("undo_action");
	});

	it("records an agent-sourced row when a wrapped tool runs", async () => {
		const mailbox = "audit-agent-wrapped@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "agent-wrap-1");

		const tools = createEmailTools(env, mailbox);
		const result = await tools.star_email.execute({
			emailId: "agent-wrap-1",
			starred: true,
		});
		expect(result).toEqual({
			status: "updated",
			emailId: "agent-wrap-1",
			starred: true,
		});

		const [row] = await actionsOf(stub);
		expect(row?.tool).toBe("star_email");
		expect(row?.source).toBe("agent");
		expect(row?.undoable).toBe(true);
	});

	it("records an mcp-sourced row when a wrapped tool runs over /mcp", async () => {
		const mailbox = "audit-mcp-wrapped@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, "mcp-wrap-1");

		const answer = await mcpCall("star_email", {
			mailboxId: mailbox,
			emailId: "mcp-wrap-1",
			starred: true,
		});
		expect(answer.isError).toBe(false);

		const [row] = await actionsOf(stub);
		expect(row?.tool).toBe("star_email");
		expect(row?.source).toBe("mcp");
		expect(row?.undoable).toBe(true);
		expect((await readRow(stub, "mcp-wrap-1"))?.starred).toBe(true);
	});
});
