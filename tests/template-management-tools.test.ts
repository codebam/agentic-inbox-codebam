/**
 * Template management tools (create_template, update_template,
 * delete_template) tests.
 *
 * Covers, against real Durable Object state: the create/update/delete happy
 * paths and their route-mirroring error messages (missing/blank names and
 * bodies, oversized name, subject and body, and the 200-per-mailbox cap),
 * partial updates with explicit-null subject clearing, unknown-template
 * answers, and both surfaces: the agent tool map and live /mcp calls.
 *
 * Nothing here sends mail: templates are operator-authored content, and
 * these tools only manage their rows.
 */

import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createEmailTools } from "../workers/agent/index";
import {
	toolCreateTemplate,
	toolDeleteTemplate,
	toolUpdateTemplate,
} from "../workers/lib/tools";
import {
	MAX_TEMPLATES,
	MAX_TEMPLATE_BODY_LENGTH,
	MAX_TEMPLATE_NAME_LENGTH,
	MAX_TEMPLATE_SUBJECT_LENGTH,
	type Template,
	type TemplateInput,
} from "../workers/lib/templates";

type Stub = ReturnType<typeof stubFor>;

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

/** Register the mailbox record the API middleware checks before routing. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
}

/** The mailbox's templates, as MailboxDO.listTemplates returns them. */
async function listOf(stub: Stub): Promise<Template[]> {
	return (await stub.listTemplates()) as unknown as Template[];
}

/** Create one template through the Durable Object and answer the stored row. */
async function createOn(stub: Stub, input: TemplateInput): Promise<Template> {
	return (await stub.createTemplate(input)) as unknown as Template;
}

/**
 * Replace the mailbox's templates with exactly these rows, directly — the
 * cap test needs 200 controlled rows. Idempotent: a repeated call reseeds
 * instead of accumulating, because Durable Object storage is not isolated
 * per test.
 */
async function insertTemplates(
	stub: Stub,
	rows: {
		id: string;
		name: string;
		subject?: string | null;
		body: string;
		createdAt: string;
	}[],
) {
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec("DELETE FROM templates");
		for (const row of rows) {
			state.storage.sql.exec(
				`INSERT INTO templates (id, name, subject, body, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
				row.id,
				row.name,
				row.subject ?? null,
				row.body,
				row.createdAt,
			);
		}
	});
}

/** A fixed instant plus `offsetMs`, as an ISO string. */
function isoAt(offsetMs: number): string {
	return new Date(Date.parse("2026-01-01T00:00:00.000Z") + offsetMs).toISOString();
}

/** The `error` message of a tool result, or null when the call succeeded. */
function errorOf(result: unknown): string | null {
	const error = (result as { error?: unknown }).error;
	return typeof error === "string" ? error : null;
}

// ── MCP helpers ────────────────────────────────────────────────────

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

// ── create_template ────────────────────────────────────────────────

describe("create_template", () => {
	it("stores a trimmed name, an optional subject and a body", async () => {
		const mailbox = "template-admin-create@example.com";
		const stub = stubFor(mailbox);
		await insertTemplates(stub, []);

		const created = await toolCreateTemplate(env, mailbox, {
			name: "  Meeting request  ",
			subject: "  Meeting request  ",
			body: "<p>Can we meet?</p>",
		});
		expect(created).toMatchObject({
			name: "Meeting request",
			subject: "Meeting request",
			body: "<p>Can we meet?</p>",
		});
		expect((created as { id: string }).id).toEqual(expect.any(String));
		expect((created as { created_at: string }).created_at).toEqual(expect.any(String));
		expect((created as { updated_at: string }).updated_at).toEqual(expect.any(String));

		// An omitted subject stores null, never a missing key.
		const plain = await toolCreateTemplate(env, mailbox, {
			name: "Plain",
			body: "<p>plain</p>",
		});
		expect(plain).toMatchObject({ name: "Plain", subject: null });

		const rows = await listOf(stub);
		expect(rows.map((row) => row.name)).toEqual(["Meeting request", "Plain"]);
		expect(rows[0]).toMatchObject({
			id: (created as { id: string }).id,
			subject: "Meeting request",
			body: "<p>Can we meet?</p>",
			created_at: (created as { created_at: string }).created_at,
		});
	});

	it("rejects out-of-bounds writes with the web route's messages", async () => {
		const mailbox = "template-admin-create-invalid@example.com";
		const stub = stubFor(mailbox);
		await insertTemplates(stub, []);

		expect(
			errorOf(await toolCreateTemplate(env, mailbox, { body: "<p>x</p>" })),
		).toMatch(/name is required/i);
		expect(
			errorOf(
				await toolCreateTemplate(env, mailbox, { name: "   ", body: "<p>x</p>" }),
			),
		).toMatch(/name is required/i);
		expect(
			errorOf(await toolCreateTemplate(env, mailbox, { name: "No body", body: "   " })),
		).toMatch(/body is required/i);
		expect(
			errorOf(
				await toolCreateTemplate(env, mailbox, {
					name: "x".repeat(MAX_TEMPLATE_NAME_LENGTH + 1),
					body: "<p>x</p>",
				}),
			),
		).toMatch(/at most 120 characters/i);
		expect(
			errorOf(
				await toolCreateTemplate(env, mailbox, {
					name: "Long subject",
					subject: "s".repeat(MAX_TEMPLATE_SUBJECT_LENGTH + 1),
					body: "<p>x</p>",
				}),
			),
		).toMatch(/subject can be at most 500 characters/i);
		expect(
			errorOf(
				await toolCreateTemplate(env, mailbox, {
					name: "Long body",
					body: "b".repeat(MAX_TEMPLATE_BODY_LENGTH + 1),
				}),
			),
		).toMatch(/body can be at most 100000 characters/i);

		// Nothing was stored by any of the rejected writes.
		expect(await listOf(stub)).toEqual([]);
	});

	it("refuses a create once the mailbox holds 200 templates", async () => {
		const mailbox = "template-admin-cap@example.com";
		const stub = stubFor(mailbox);
		await insertTemplates(
			stub,
			Array.from({ length: MAX_TEMPLATES }, (_unused, index) => ({
				id: `admin-cap-${index}`,
				name: `Template ${String(index).padStart(3, "0")}`,
				body: "<p>x</p>",
				createdAt: isoAt(index * 1000),
			})),
		);

		const overCap = await toolCreateTemplate(env, mailbox, {
			name: "One more",
			body: "<p>x</p>",
		});
		expect(errorOf(overCap)).toMatch(/at most 200 templates/i);
		expect(await listOf(stub)).toHaveLength(MAX_TEMPLATES);
	});
});

// ── update_template ────────────────────────────────────────────────

describe("update_template", () => {
	it("applies partial updates; omitted fields keep their value, null clears", async () => {
		const mailbox = "template-admin-update@example.com";
		const stub = stubFor(mailbox);
		await insertTemplates(stub, []);
		const meeting = await createOn(stub, {
			name: "Meeting request",
			subject: "Meeting request",
			body: "<p>Can we meet?</p>",
		});

		const renamed = await toolUpdateTemplate(env, mailbox, {
			templateId: meeting.id,
			name: "Meeting",
			subject: "Changed",
			body: "<p>Edited</p>",
		});
		expect(renamed).toMatchObject({
			id: meeting.id,
			name: "Meeting",
			subject: "Changed",
			body: "<p>Edited</p>",
			created_at: meeting.created_at,
		});

		// Omitted fields keep their stored value.
		const kept = await toolUpdateTemplate(env, mailbox, {
			templateId: meeting.id,
			name: "Meeting v2",
		});
		expect(kept).toMatchObject({
			name: "Meeting v2",
			subject: "Changed",
			body: "<p>Edited</p>",
		});

		// An explicit null subject clears it.
		const cleared = await toolUpdateTemplate(env, mailbox, {
			templateId: meeting.id,
			subject: null,
		});
		expect(cleared).toMatchObject({ subject: null, body: "<p>Edited</p>" });

		const rows = await listOf(stub);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: meeting.id,
			name: "Meeting v2",
			subject: null,
			body: "<p>Edited</p>",
		});
	});

	it("reports an unknown template and refused writes with the web route's messages", async () => {
		const mailbox = "template-admin-update-errors@example.com";
		const stub = stubFor(mailbox);
		await insertTemplates(stub, []);
		const existing = await createOn(stub, { name: "Existing", body: "<p>x</p>" });

		expect(
			await toolUpdateTemplate(env, mailbox, { templateId: "missing", name: "Nope" }),
		).toEqual({ error: "Template not found" });

		expect(
			errorOf(
				await toolUpdateTemplate(env, mailbox, {
					templateId: existing.id,
					name: "   ",
				}),
			),
		).toMatch(/name is required/i);
		expect(
			errorOf(
				await toolUpdateTemplate(env, mailbox, {
					templateId: existing.id,
					body: "b".repeat(MAX_TEMPLATE_BODY_LENGTH + 1),
				}),
			),
		).toMatch(/body can be at most 100000 characters/i);

		// Every refused write left the stored row untouched.
		const rows = await listOf(stub);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ id: existing.id, name: "Existing", body: "<p>x</p>" });
	});
});

// ── delete_template ────────────────────────────────────────────────

describe("delete_template", () => {
	it("removes one template and reports a repeated delete as not found", async () => {
		const mailbox = "template-admin-delete@example.com";
		const stub = stubFor(mailbox);
		await insertTemplates(stub, []);
		const doomed = await createOn(stub, { name: "Doomed", body: "<p>x</p>" });
		const kept = await createOn(stub, { name: "Kept", body: "<p>y</p>" });

		expect(await toolDeleteTemplate(env, mailbox, { templateId: doomed.id })).toEqual({
			ok: true,
		});
		const rows = await listOf(stub);
		expect(rows.map((row) => row.name)).toEqual(["Kept"]);
		expect(rows[0]?.id).toBe(kept.id);

		expect(await toolDeleteTemplate(env, mailbox, { templateId: doomed.id })).toEqual({
			error: "Template not found",
		});
		expect(await toolDeleteTemplate(env, mailbox, { templateId: "missing" })).toEqual({
			error: "Template not found",
		});
		expect(await listOf(stub)).toHaveLength(1);
	});
});

// ── Surfaces ───────────────────────────────────────────────────────

describe("template management surfaces", () => {
	it("is on the agent tool map, scoped and global", async () => {
		const scoped = createEmailTools(env, "template-admin-agent@example.com");
		expect(Object.keys(scoped)).toContain("create_template");
		expect(Object.keys(scoped)).toContain("update_template");
		expect(Object.keys(scoped)).toContain("delete_template");
		const global = createEmailTools(env, null);
		expect(Object.keys(global)).toContain("create_template");
		expect(Object.keys(global)).toContain("update_template");
		expect(Object.keys(global)).toContain("delete_template");
	});

	it("answers live /mcp calls and surfaces refusals as errors", async () => {
		const mailbox = "template-admin-mcp@example.com";
		await registerMailbox(mailbox);
		await insertTemplates(stubFor(mailbox), []);

		const created = await mcpCall("create_template", {
			mailboxId: mailbox,
			name: "Out of office",
			subject: "Away",
			body: "<p>I am away until Monday.</p>",
		});
		expect(created.isError).toBe(false);
		expect(created.text).toContain("Out of office");
		expect(created.text).toContain("I am away until Monday.");
		const row = JSON.parse(created.text) as { id: string };
		expect(row.id).toEqual(expect.any(String));

		const updated = await mcpCall("update_template", {
			mailboxId: mailbox,
			templateId: row.id,
			name: "OOO",
		});
		expect(updated.isError).toBe(false);
		expect(updated.text).toContain("OOO");

		const invalid = await mcpCall("create_template", {
			mailboxId: mailbox,
			name: "   ",
			body: "<p>x</p>",
		});
		expect(invalid.isError).toBe(true);
		expect(invalid.text).toContain("name is required");

		const deleted = await mcpCall("delete_template", {
			mailboxId: mailbox,
			templateId: row.id,
		});
		expect(deleted.isError).toBe(false);
		expect(deleted.text).toContain('"ok": true');

		const missing = await mcpCall("delete_template", {
			mailboxId: mailbox,
			templateId: row.id,
		});
		expect(missing.isError).toBe(true);
		expect(missing.text).toContain("Template not found");
	});
});
