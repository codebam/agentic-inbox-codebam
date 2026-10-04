// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * apply_rule, get_calendar_invite and respond_to_invite: the tools that wrap
 * the retroactive rule-apply route and the two iMIP invite routes.
 *
 * The tools are called directly (like the other tool tests) and every
 * assertion reads real Durable Object state — stored mail, the
 * calendar_invites row, the Sent copy and the agent_actions log. The iMIP
 * reply's delivery cannot be exercised in the pool — wrangler.test.jsonc
 * carries no send_email binding — so the awaited send fails and only logs,
 * exactly like the route tests; the stored Sent copy and the recorded answer
 * are what the tests pin. The audit rows are exercised through the live
 * agent and MCP wrappers, where runAudited records them.
 */

import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { Folders } from "../shared/folders";
import { createEmailTools } from "../workers/agent/index";
import type {
	CalendarInviteFields,
} from "../workers/lib/calendar";
import type { RuleDraft } from "../workers/lib/rules";
import {
	toolApplyRule,
	toolGetCalendarInvite,
	toolRespondToInvite,
} from "../workers/lib/tools";


type Stub = ReturnType<typeof stubFor>;


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


/** Register the mailbox record the /mcp verifyMailbox gate checks. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
}


/** Seed one stored message, the shape createEmail takes. */
async function seedEmail(
	stub: Stub,
	id: string,
	folder: string,
	options: { subject?: string; category?: string | null } = {},
) {
	await stub.createEmail(
		folder,
		{
			id,
			subject: options.subject ?? `Subject ${id}`,
			sender: "sender@example.org",
			recipient: "seed@example.com",
			date: new Date().toISOString(),
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: id,
			category: options.category ?? null,
		},
		[],
	);
}


/** A complete rule draft, mirroring what the editor sends. */
function ruleDraft(overrides: Partial<RuleDraft> = {}): RuleDraft {
	return {
		name: overrides.name ?? "Test rule",
		match: overrides.match ?? {
			mode: "all",
			conditions: { subject_contains: "invoice" },
		},
		actions: overrides.actions ?? { star: true },
		...(overrides.enabled === undefined ? {} : { enabled: overrides.enabled }),
		...(overrides.priority === undefined ? {} : { priority: overrides.priority }),
	};
}


/** Run one raw SQL query inside a mailbox DO. */
function sqlRows<T>(stub: Stub, query: string): Promise<T[]> {
	return runInDurableObject(stub, async (_instance, state) => {
		return [...state.storage.sql.exec(query)] as unknown as T[];
	});
}


/** The mailbox's audit rows, newest first. */
async function actionsOf(stub: Stub) {
	return (await stub.listAgentActions(50)) as unknown as {
		tool: string;
		source: string;
		email_id: string | null;
		args: string | null;
		undoable: boolean;
	}[];
}


/** The rows now in the mailbox's Sent folder. */
async function sentRows(stub: Stub) {
	return (await stub.getEmails({ folder: Folders.SENT })) as {
		id: string;
		subject: string;
		sender: string;
		recipient: string;
	}[];
}


/** The invite fields the ingest path would have stored for one message. */
function inviteFields(
	emailId: string,
	overrides: Partial<CalendarInviteFields> = {},
): CalendarInviteFields & { email_id: string } {
	return {
		email_id: emailId,
		uid: "standup-123@example.org",
		method: "REQUEST",
		summary: "Standup, daily",
		organizer: "Organizer <organizer@example.org>",
		location: "Room 1",
		start_at: "20260925T140000Z (2026-09-25T14:00:00.000Z)",
		end_at: null,
		attendee: "Box <calendar@example.com>",
		...overrides,
	};
}


/** Seed one inbox message plus its stored invite row. */
async function seedInvite(
	stub: Stub,
	emailId: string,
	overrides: Partial<CalendarInviteFields> = {},
) {
	await seedEmail(stub, emailId, Folders.INBOX, {
		subject: "Invitation: Standup",
	});
	await stub.recordCalendarInvite(inviteFields(emailId, overrides));
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


describe("toolApplyRule", () => {
	it("applies the rule's local actions to exactly the matching mail", async () => {
		const mailbox = "apply-tool@example.com";
		const stub = stubFor(mailbox);
		await stub.createFolder("archive-tool", "Archive Tool");
		await seedEmail(stub, "t-1", Folders.INBOX, { subject: "Invoice 1" });
		await seedEmail(stub, "t-2", Folders.INBOX, { subject: "Invoice 2" });
		await seedEmail(stub, "t-3", Folders.INBOX, { subject: "Lunch on Friday?" });

		const rule = await stub.createRule(
			ruleDraft({
				name: "File invoices",
				match: { mode: "all", conditions: { subject_contains: "invoice" } },
				actions: {
					move_to_folder: "archive-tool",
					set_category: "invoices",
					mark_read: true,
					star: true,
				},
			}),
		);

		const result = await toolApplyRule(env, mailbox, { ruleId: rule.id });
		expect(result).toEqual({
			rule_id: rule.id,
			applied: 2,
			skipped: 0,
			matched: 2,
			remaining: 0,
			scanned: 3,
			scan_limit: 2000,
		});

		// Exactly the two matching messages changed; the third is untouched.
		const rows = await sqlRows<{
			id: string;
			folder_id: string;
			category: string | null;
			read: number;
			starred: number;
		}>(
			stub,
			"SELECT id, folder_id, category, read, starred FROM emails ORDER BY id",
		);
		expect(rows).toEqual([
			{
				id: "t-1",
				folder_id: "archive-tool",
				category: "invoices",
				read: 1,
				starred: 1,
			},
			{
				id: "t-2",
				folder_id: "archive-tool",
				category: "invoices",
				read: 1,
				starred: 1,
			},
			{
				id: "t-3",
				folder_id: Folders.INBOX,
				category: null,
				read: 0,
				starred: 0,
			},
		]);

		// A retroactive apply is not a firing: no stats, no stamp.
		expect((await stub.listRules())[0]?.fired_count).toBe(0);
	});

	it("honours the limit and reports the overflow as remaining", async () => {
		const mailbox = "apply-tool-limit@example.com";
		const stub = stubFor(mailbox);
		for (let index = 0; index < 3; index += 1) {
			await seedEmail(stub, `l-${index}`, Folders.INBOX, {
				subject: "Invoice bulk",
			});
		}
		const rule = await stub.createRule(ruleDraft({ actions: { star: true } }));

		const first = await toolApplyRule(env, mailbox, {
			ruleId: rule.id,
			limit: 2,
		});
		expect(first).toMatchObject({
			rule_id: rule.id,
			applied: 2,
			skipped: 0,
			matched: 3,
			remaining: 1,
		});

		// The overflow is what the next batch applies.
		const second = await toolApplyRule(env, mailbox, {
			ruleId: rule.id,
			limit: 2,
		});
		expect(second).toMatchObject({
			applied: 1,
			skipped: 2,
			matched: 3,
			remaining: 0,
		});
	});

	it("answers the route's refusals for an unknown rule, a bad limit, no local actions and a dead folder", async () => {
		const mailbox = "apply-tool-errors@example.com";
		const stub = stubFor(mailbox);
		await stub.createFolder("temp-tool", "Temp Tool");
		await seedEmail(stub, "e-1", Folders.INBOX, { subject: "Invoice 20" });

		expect(await toolApplyRule(env, mailbox, { ruleId: "no-such-rule" })).toEqual({
			error: "Rule not found",
		});

		const rule = await stub.createRule(
			ruleDraft({ actions: { move_to_folder: "temp-tool", star: true } }),
		);
		// The route's body-schema 400 message, limit bounds included.
		expect(
			await toolApplyRule(env, mailbox, { ruleId: rule.id, limit: 0 }),
		).toEqual({
			error: "Invalid rule — limit: Number must be greater than or equal to 1",
		});

		// A rule with no stored-mail actions refuses with the route's message.
		const forwardOnly = await stub.createRule(
			ruleDraft({
				name: "Forward only",
				actions: { forward_to: "ops@example.org" },
			}),
		);
		expect(await toolApplyRule(env, mailbox, { ruleId: forwardOnly.id })).toEqual({
			error:
				"This rule has no folder, category, read or star action to apply to existing mail",
		});

		// Folder validation mirrors the route: a dead target is an error, not
		// a rejected RPC call.
		await stub.deleteFolder("temp-tool");
		expect(await toolApplyRule(env, mailbox, { ruleId: rule.id })).toEqual({
			error: "Unknown folder: temp-tool",
		});

		// The refusals changed nothing and never recorded a firing.
		const rows = await sqlRows<{
			folder_id: string;
			read: number;
			starred: number;
		}>(stub, "SELECT folder_id, read, starred FROM emails");
		expect(rows).toEqual([
			{ folder_id: Folders.INBOX, read: 0, starred: 0 },
		]);
		expect(
			(await stub.listRules()).every((item) => item.fired_count === 0),
		).toBe(true);
	});
});


describe("toolGetCalendarInvite", () => {
	it("returns the stored invite, and null when the message carried none", async () => {
		const mailbox = "invite-tool@example.com";
		const stub = stubFor(mailbox);
		await seedInvite(stub, "i-1");

		const result = await toolGetCalendarInvite(env, mailbox, { emailId: "i-1" });
		expect(result.invite).toMatchObject({
			email_id: "i-1",
			uid: "standup-123@example.org",
			method: "REQUEST",
			summary: "Standup, daily",
			organizer: "Organizer <organizer@example.org>",
			location: "Room 1",
			start_at: "20260925T140000Z (2026-09-25T14:00:00.000Z)",
			response: null,
		});

		// A message with no calendar part answers null — deliberately not an
		// error — and so does an unknown message id.
		await seedEmail(stub, "i-plain", Folders.INBOX, { subject: "Hello" });
		expect(
			await toolGetCalendarInvite(env, mailbox, { emailId: "i-plain" }),
		).toEqual({ invite: null });
		expect(
			await toolGetCalendarInvite(env, mailbox, { emailId: "no-such-email" }),
		).toEqual({ invite: null });
	});
});


describe("toolRespondToInvite", () => {
	it("records an acceptance and leaves the Sent copy", async () => {
		const mailbox = "respond-tool@example.com";
		const stub = stubFor(mailbox);
		await seedInvite(stub, "r-1");

		// The pool has no EMAIL binding: the awaited send fails and only
		// logs, exactly like the route's deferred send.
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const result = await toolRespondToInvite(env, mailbox, {
			emailId: "r-1",
			response: "accepted",
		});
		expect(
			errorSpy.mock.calls.some((call) =>
				String(call[0]).includes("Invite reply delivery failed"),
			),
		).toBe(true);
		errorSpy.mockRestore();

		if ("error" in result) throw new Error(result.error);
		expect(result.status).toBe("sent");
		expect(result.invite?.response).toBe("accepted");

		// The route's own id is the Sent copy's id, so the panel and the
		// mailbox agree on which message went out.
		const sent = await sentRows(stub);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.id).toBe(result.id);
		expect(sent[0]?.subject).toBe("Accepted: Standup, daily");
		expect(sent[0]?.sender).toBe(mailbox);
		expect(sent[0]?.recipient).toBe("organizer@example.org");

		// The recorded answer is what the GET tool reports next.
		const stored = await toolGetCalendarInvite(env, mailbox, { emailId: "r-1" });
		expect(stored.invite?.response).toBe("accepted");
	});

	it("maps declined and tentative to their subject prefixes", async () => {
		const mailbox = "respond-tool-choices@example.com";
		const stub = stubFor(mailbox);
		await seedInvite(stub, "c-1");
		await seedInvite(stub, "c-2", { uid: "standup-456@example.org" });

		const declined = await toolRespondToInvite(env, mailbox, {
			emailId: "c-1",
			response: "declined",
		});
		const tentative = await toolRespondToInvite(env, mailbox, {
			emailId: "c-2",
			response: "tentative",
		});
		if ("error" in declined || "error" in tentative) {
			throw new Error("respond failed");
		}

		const sent = await sentRows(stub);
		expect(sent.map((row) => row.subject).sort()).toEqual([
			"Declined: Standup, daily",
			"Tentative: Standup, daily",
		]);
		expect(
			(await toolGetCalendarInvite(env, mailbox, { emailId: "c-1" })).invite
				?.response,
		).toBe("declined");
		expect(
			(await toolGetCalendarInvite(env, mailbox, { emailId: "c-2" })).invite
				?.response,
		).toBe("tentative");
	});

	it("answers the route's refusals and sends nothing", async () => {
		const mailbox = "respond-tool-refusals@example.com";
		const stub = stubFor(mailbox);
		await seedInvite(stub, "f-request");
		await seedInvite(stub, "f-reply", { method: "REPLY" });
		await seedInvite(stub, "f-no-organizer", { organizer: null });
		await seedEmail(stub, "f-plain", Folders.INBOX, { subject: "Hello" });

		expect(
			await toolRespondToInvite(env, mailbox, {
				emailId: "f-request",
				response: "maybe",
			}),
		).toEqual({ error: "response must be one of accepted, declined, tentative" });

		expect(
			await toolRespondToInvite(env, mailbox, {
				emailId: "no-such-email",
				response: "accepted",
			}),
		).toEqual({ error: "Email not found" });

		expect(
			await toolRespondToInvite(env, mailbox, {
				emailId: "f-plain",
				response: "accepted",
			}),
		).toEqual({ error: "This message carries no calendar invite" });

		expect(
			await toolRespondToInvite(env, mailbox, {
				emailId: "f-reply",
				response: "accepted",
			}),
		).toEqual({ error: "This invite is a REPLY and cannot be answered" });

		expect(
			await toolRespondToInvite(env, mailbox, {
				emailId: "f-no-organizer",
				response: "accepted",
			}),
		).toEqual({ error: "This invite names no organizer to answer" });

		// Nothing went out and nothing was answered.
		expect(await sentRows(stub)).toHaveLength(0);
		for (const emailId of ["f-request", "f-reply", "f-no-organizer"]) {
			expect((await stub.getCalendarInvite(emailId))?.response).toBeNull();
		}
	});
});


describe("the three tools on the live surfaces", () => {
	it("exposes apply_rule, get_calendar_invite and respond_to_invite on the agent map", () => {
		const tools = createEmailTools(env, "rules-invite-agent-map@example.com");
		const names = Object.keys(tools);
		for (const name of [
			"apply_rule",
			"get_calendar_invite",
			"respond_to_invite",
		]) {
			expect(names).toContain(name);
		}
	});

	it("records apply_rule through the agent and MCP wrappers", async () => {
		const agentMailbox = "rules-invite-agent-audit@example.com";
		const agentStub = stubFor(agentMailbox);
		await seedEmail(agentStub, "ag-1", Folders.INBOX, {
			subject: "Invoice agent",
		});
		const agentRule = await agentStub.createRule(
			ruleDraft({ actions: { star: true } }),
		);

		const tools = createEmailTools(env, agentMailbox);
		const result = await tools.apply_rule.execute({ ruleId: agentRule.id });
		expect(result).toMatchObject({
			rule_id: agentRule.id,
			applied: 1,
			matched: 1,
		});
		expect((await agentStub.getEmail("ag-1"))?.starred).toBe(true);

		// The wrapper records the call: rule-scoped, so email_id is null and
		// the args carry the rule id and the effective batch size.
		const [agentRow] = await actionsOf(agentStub);
		expect(agentRow).toMatchObject({
			tool: "apply_rule",
			source: "agent",
			email_id: null,
			undoable: false,
			args: JSON.stringify({ ruleId: agentRule.id, limit: 90 }),
		});

		const mcpMailbox = "rules-invite-mcp-audit@example.com";
		await registerMailbox(mcpMailbox);
		const mcpStub = stubFor(mcpMailbox);
		await seedEmail(mcpStub, "mc-1", Folders.INBOX, { subject: "Invoice mcp" });
		const mcpRule = await mcpStub.createRule(ruleDraft({ actions: { star: true } }));

		const answer = await mcpCall("apply_rule", {
			mailboxId: mcpMailbox,
			ruleId: mcpRule.id,
			limit: 10,
		});
		expect(answer.isError).toBe(false);
		expect(JSON.parse(answer.text)).toMatchObject({
			rule_id: mcpRule.id,
			applied: 1,
		});
		expect((await mcpStub.getEmail("mc-1"))?.starred).toBe(true);

		const [mcpRow] = await actionsOf(mcpStub);
		expect(mcpRow).toMatchObject({
			tool: "apply_rule",
			source: "mcp",
			email_id: null,
			undoable: false,
			args: JSON.stringify({ ruleId: mcpRule.id, limit: 10 }),
		});
	});

	it("answers an invite over /mcp without audit rows", async () => {
		const mailbox = "rules-invite-mcp-respond@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedInvite(stub, "mr-1");

		const answer = await mcpCall("respond_to_invite", {
			mailboxId: mailbox,
			emailId: "mr-1",
			response: "tentative",
		});
		expect(answer.isError).toBe(false);
		const body = JSON.parse(answer.text) as { id: string; status: string };
		expect(body.status).toBe("sent");

		const sent = await sentRows(stub);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.id).toBe(body.id);
		expect(sent[0]?.subject).toBe("Tentative: Standup, daily");

		// The answer is recorded and readable over MCP; the send path is not
		// audited.
		expect((await stub.getCalendarInvite("mr-1"))?.response).toBe("tentative");
		const fetched = await mcpCall("get_calendar_invite", {
			mailboxId: mailbox,
			emailId: "mr-1",
		});
		expect(fetched.isError).toBe(false);
		expect(JSON.parse(fetched.text)).toMatchObject({
			invite: { response: "tentative" },
		});
		expect(await actionsOf(stub)).toHaveLength(0);
	});
});
