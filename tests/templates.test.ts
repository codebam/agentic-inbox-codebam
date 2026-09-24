/**
 * Templates (per-mailbox reusable snippets) tests.
 *
 * Covers, in order: migration 24's table on a fresh DO, the Durable Object
 * CRUD (create, name-then-created_at ordering, partial updates, delete
 * semantics, the per-write bounds and the 200-per-mailbox cap), the
 * templates routes (GET/POST/PUT/DELETE with their 200/201/204/400/404
 * answers), and the read-only list_templates tool — the function itself, the
 * agent tool map and a live /mcp tools/call.
 *
 * Nothing here sends mail: templates are operator-authored content, and the
 * only tool surface is read-only.
 */

import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createEmailTools } from "../workers/agent/index";
import { toolListTemplates } from "../workers/lib/tools";
import {
	MAX_TEMPLATES,
	MAX_TEMPLATE_BODY_LENGTH,
	MAX_TEMPLATE_NAME_LENGTH,
	MAX_TEMPLATE_SUBJECT_LENGTH,
	type Template,
	type TemplateInput,
} from "../workers/lib/templates";

type Stub = ReturnType<typeof stubFor>;

/** Answer shape of the templates routes. */
interface TemplatesResponse {
	templates?: Template[];
	error?: string;
}

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
async function createOn(
	stub: Stub,
	input: TemplateInput,
): Promise<Template> {
	return (await stub.createTemplate(input)) as unknown as Template;
}

/**
 * Replace the mailbox's templates with exactly these rows, directly — the
 * ordering and cap tests need controlled names and timestamps. Idempotent:
 * a repeated call reseeds instead of accumulating, because Durable Object
 * storage is not isolated per test.
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
	return new Date(
		Date.parse("2026-01-01T00:00:00.000Z") + offsetMs,
	).toISOString();
}

const MINUTE_MS = 60_000;

/** Fetch the mailbox's template list. */
async function getTemplates(
	mailbox: string,
): Promise<{ status: number; body: TemplatesResponse }> {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/templates`,
	);
	return { status: res.status, body: (await res.json()) as TemplatesResponse };
}

/** POST one template body and answer the raw response. */
async function postTemplate(mailbox: string, body: unknown) {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/templates`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	return { status: res.status, body: (await res.json()) as TemplatesResponse };
}

/** PUT a partial change to one template and answer the raw response. */
async function putTemplate(mailbox: string, id: string, body: unknown) {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/templates/${id}`,
		{
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	return { status: res.status, body: (await res.json()) as TemplatesResponse };
}

/** DELETE one template; a 204 answers with no body to parse. */
async function deleteTemplate(mailbox: string, id: string) {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/templates/${id}`,
		{ method: "DELETE" },
	);
	const body = res.status === 204 ? null : ((await res.json()) as TemplatesResponse);
	return { status: res.status, body };
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

describe("migration 24_add_templates", () => {
	it("creates the templates table on a fresh DO", async () => {
		const stub = stubFor("templates-migration@example.com");

		const migration = await runInDurableObject(stub, async (_instance, state) => {
			const table = [
				...state.storage.sql.exec(
					"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'templates'",
				),
			][0] as { sql: string } | undefined;
			const applied = [
				...state.storage.sql.exec(
					"SELECT name FROM d1_migrations WHERE name = '24_add_templates'",
				),
			];
			return { sql: table?.sql ?? null, applied: applied.length };
		});

		expect(migration.applied).toBe(1);
		const sql = migration.sql ?? "";
		for (const column of [
			"id TEXT PRIMARY KEY",
			"name TEXT NOT NULL",
			"subject TEXT",
			"body TEXT NOT NULL",
			"created_at TEXT NOT NULL",
			"updated_at TEXT NOT NULL",
		]) {
			expect(sql).toContain(column);
		}
	});
});

// ── Durable Object CRUD ────────────────────────────────────────────

describe("template CRUD", () => {
	it("stores a trimmed name, an optional subject and a body", async () => {
		const stub = stubFor("templates-create@example.com");
		const row = await createOn(stub, {
			name: "  Meeting request  ",
			body: "  <p>Can we meet?</p>  ",
		});

		expect(row).toMatchObject({
			name: "Meeting request",
			subject: null,
			body: "<p>Can we meet?</p>",
		});
		expect(row.id).toEqual(expect.any(String));
		expect(row.created_at).toEqual(expect.any(String));
		expect(row.updated_at).toBe(row.created_at);

		const withSubject = await createOn(stub, {
			name: "Invoice reply",
			subject: "  Invoice 77  ",
			body: "<p>Thanks — paying today.</p>",
		});
		expect(withSubject.subject).toBe("Invoice 77");
		// Replacing the same name is allowed: only the cap bounds the list.
		const renamed = await createOn(stub, { name: "Meeting request", body: "<p>again</p>" });
		expect(renamed.id).not.toBe(row.id);
	});

	it("orders by name (case-insensitive), then creation order", async () => {
		const stub = stubFor("templates-order@example.com");
		await insertTemplates(stub, [
			{ id: "order-1", name: "zeta", body: "<p>z</p>", createdAt: isoAt(3 * MINUTE_MS) },
			{ id: "order-2", name: "Billing", body: "<p>b</p>", createdAt: isoAt(2 * MINUTE_MS) },
			// "alpha" and "Alpha" share a case-insensitive key, so the earlier
			// created_at decides which comes first.
			{ id: "order-3", name: "Alpha", body: "<p>A</p>", createdAt: isoAt(MINUTE_MS) },
			{ id: "order-4", name: "alpha", body: "<p>a</p>", createdAt: isoAt(0) },
		]);

		expect((await listOf(stub)).map((row) => row.id)).toEqual([
			"order-4",
			"order-3",
			"order-2",
			"order-1",
		]);
		expect((await listOf(stub)).map((row) => row.name)).toEqual([
			"alpha",
			"Alpha",
			"Billing",
			"zeta",
		]);
	});

	it("applies partial updates and leaves omitted fields alone", async () => {
		const stub = stubFor("templates-update@example.com");
		const created = await createOn(stub, {
			name: "Follow-up",
			subject: "Checking in",
			body: "<p>Old body</p>",
		});

		const bodyOnly = (await stub.updateTemplate(created.id, {
			body: "<p>New body</p>",
		})) as unknown as Template | null;
		expect(bodyOnly).toMatchObject({
			name: "Follow-up",
			subject: "Checking in",
			body: "<p>New body</p>",
		});

		const renamed = (await stub.updateTemplate(created.id, {
			name: "  Follow-up v2  ",
		})) as unknown as Template | null;
		expect(renamed).toMatchObject({
			name: "Follow-up v2",
			subject: "Checking in",
			body: "<p>New body</p>",
		});

		// An explicit null (or a blank string) clears the subject; it does not
		// silently keep the old one.
		const cleared = (await stub.updateTemplate(created.id, {
			subject: "  ",
		})) as unknown as Template | null;
		expect(cleared?.subject).toBeNull();

		// Every write stamps updated_at, and it never moves backwards.
		expect(cleared?.created_at).toBe(created.created_at);
		expect(Date.parse(cleared?.updated_at ?? "")).toBeGreaterThanOrEqual(
			Date.parse(created.updated_at),
		);

		// An unknown id is a miss, not a write.
		expect(await stub.updateTemplate("missing", { name: "Nope" })).toBeNull();
		expect((await listOf(stub)).map((row) => row.name)).toEqual(["Follow-up v2"]);
	});

	it("deletes a template once and reports a missing id", async () => {
		const stub = stubFor("templates-delete@example.com");
		const created = await createOn(stub, { name: "Short-lived", body: "<p>x</p>" });

		expect(await stub.deleteTemplate(created.id)).toBe(true);
		expect(await listOf(stub)).toEqual([]);
		expect(await stub.deleteTemplate(created.id)).toBe(false);
	});

	it("rejects out-of-bounds writes instead of clipping them", async () => {
		const stub = stubFor("templates-bounds@example.com");
		await insertTemplates(stub, []);

		// Asserted through the instance (not the RPC stub) so the thrown
		// TemplateValidationError keeps its class: over RPC the DO runtime
		// rebuilds it, which is what isTemplateValidationError() also covers.
		const created = await createOn(stub, { name: "Kept", body: "<p>kept</p>" });
		await runInDurableObject(stub, async (instance) => {
			expect(() =>
				instance.createTemplate({ name: "   ", body: "<p>x</p>" }),
			).toThrow(/name is required/i);
			expect(() =>
				instance.createTemplate({
					name: "x".repeat(MAX_TEMPLATE_NAME_LENGTH + 1),
					body: "<p>x</p>",
				}),
			).toThrow(/name can be at most/i);
			expect(() =>
				instance.createTemplate({ name: "Bodyless", body: "   " }),
			).toThrow(/body is required/i);
			expect(() =>
				instance.createTemplate({
					name: "Huge body",
					body: "x".repeat(MAX_TEMPLATE_BODY_LENGTH + 1),
				}),
			).toThrow(/body can be at most/i);
			expect(() =>
				instance.createTemplate({
					name: "Long subject",
					subject: "s".repeat(MAX_TEMPLATE_SUBJECT_LENGTH + 1),
					body: "<p>x</p>",
				}),
			).toThrow(/subject can be at most/i);

			// Bounds are enforced on the update path too, and a rejected
			// update leaves the stored row untouched.
			expect(() =>
				instance.updateTemplate(created.id, {
					body: "x".repeat(MAX_TEMPLATE_BODY_LENGTH + 1),
				}),
			).toThrow(/body can be at most/i);
			expect(() =>
				instance.updateTemplate(created.id, { name: "  " }),
			).toThrow(/name is required/i);
		});

		const rows = await listOf(stub);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ name: "Kept", body: "<p>kept</p>" });
	});

	it("refuses a create once the mailbox holds 200 templates", async () => {
		const stub = stubFor("templates-cap@example.com");
		await insertTemplates(
			stub,
			Array.from({ length: MAX_TEMPLATES }, (_unused, index) => ({
				id: `cap-${index}`,
				name: `Template ${String(index).padStart(3, "0")}`,
				body: `<p>body ${index}</p>`,
				createdAt: isoAt(index * 1000),
			})),
		);
		expect(await listOf(stub)).toHaveLength(MAX_TEMPLATES);

		await runInDurableObject(stub, async (instance) => {
			expect(() =>
				instance.createTemplate({ name: "One more", body: "<p>x</p>" }),
			).toThrow(/at most 200 templates/i);
		});
		expect(await listOf(stub)).toHaveLength(MAX_TEMPLATES);

		// Deleting frees a slot again.
		expect(await stub.deleteTemplate("cap-0")).toBe(true);
		const created = await createOn(stub, { name: "One more", body: "<p>x</p>" });
		expect(created.name).toBe("One more");
		expect(await listOf(stub)).toHaveLength(MAX_TEMPLATES);
	});
});

// ── Routes ─────────────────────────────────────────────────────────

describe("templates routes", () => {
	const mailbox = "templates-route@example.com";

	it("creates, lists and reads one template back", async () => {
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await insertTemplates(stub, []);

		const created = await postTemplate(mailbox, {
			name: "Meeting request",
			subject: "Meeting request",
			body: "<p>Can we meet this week?</p>",
		});
		expect(created.status).toBe(201);
		expect(created.body).toMatchObject({
			name: "Meeting request",
			subject: "Meeting request",
			body: "<p>Can we meet this week?</p>",
		});
		expect(created.body.id).toEqual(expect.any(String));

		// A subject is optional.
		const subjectless = await postTemplate(mailbox, {
			name: "Thanks",
			body: "<p>Thanks!</p>",
		});
		expect(subjectless.status).toBe(201);
		expect(subjectless.body.subject).toBeNull();

		const list = await getTemplates(mailbox);
		expect(list.status).toBe(200);
		expect(list.body.templates).toHaveLength(2);
		// Ordered by name, case-insensitive: "Meeting request" < "Thanks".
		expect(list.body.templates?.map((row) => row.name)).toEqual([
			"Meeting request",
			"Thanks",
		]);
		expect(Object.keys(list.body.templates?.[0] ?? {}).sort()).toEqual([
			"body",
			"created_at",
			"id",
			"name",
			"subject",
			"updated_at",
		]);
	});

	it("rejects an unusable payload with a 400", async () => {
		const invalid = "templates-route-invalid@example.com";
		await registerMailbox(invalid);
		await insertTemplates(stubFor(invalid), []);

		const noName = await postTemplate(invalid, {
			name: "   ",
			body: "<p>x</p>",
		});
		expect(noName.status).toBe(400);
		expect(noName.body.error).toMatch(/^Invalid template — name:/);

		const noBody = await postTemplate(invalid, { name: "Bodyless" });
		expect(noBody.status).toBe(400);
		expect(noBody.body.error).toMatch(/^Invalid template — body:/);

		const hugeBody = await postTemplate(invalid, {
			name: "Huge",
			body: "x".repeat(MAX_TEMPLATE_BODY_LENGTH + 1),
		});
		expect(hugeBody.status).toBe(400);
		expect(hugeBody.body.error).toMatch(/^Invalid template — body:/);

		const longSubject = await postTemplate(invalid, {
			name: "Long",
			subject: "s".repeat(MAX_TEMPLATE_SUBJECT_LENGTH + 1),
			body: "<p>x</p>",
		});
		expect(longSubject.status).toBe(400);
		expect(longSubject.body.error).toMatch(/^Invalid template — subject:/);

		// Nothing was stored by any of the rejected writes.
		expect((await getTemplates(invalid)).body.templates).toEqual([]);
	});

	it("surfaces the Durable Object's cap as a 400", async () => {
		// The one path where the Durable Object itself rejects rather than the
		// zod schema, so it proves the route's 400 survives the RPC rebuild of
		// the thrown error (isTemplateValidationError's name/message check).
		// The worker harness logs that cross-RPC rejection as an "uncaught
		// exception" even though the route handles it; the run still passes.
		const capped = "templates-route-cap@example.com";
		await registerMailbox(capped);
		await insertTemplates(
			stubFor(capped),
			Array.from({ length: MAX_TEMPLATES }, (_unused, index) => ({
				id: `route-cap-${index}`,
				name: `Template ${String(index).padStart(3, "0")}`,
				body: `<p>body ${index}</p>`,
				createdAt: isoAt(index * 1000),
			})),
		);

		const created = await postTemplate(capped, {
			name: "One more",
			body: "<p>x</p>",
		});
		expect(created.status).toBe(400);
		expect(created.body.error).toMatch(/at most 200 templates/i);
	});

	it("updates one template and 404s for an unknown id", async () => {
		const updatable = "templates-route-put@example.com";
		await registerMailbox(updatable);
		await insertTemplates(stubFor(updatable), []);
		const created = await postTemplate(updatable, {
			name: "Draft snippet",
			subject: "Sub",
			body: "<p>Original</p>",
		});
		const id = created.body.id as string;

		const updated = await putTemplate(updatable, id, { body: "<p>Edited</p>" });
		expect(updated.status).toBe(200);
		expect(updated.body).toMatchObject({
			id,
			name: "Draft snippet",
			subject: "Sub",
			body: "<p>Edited</p>",
		});

		const cleared = await putTemplate(updatable, id, { subject: null });
		expect(cleared.status).toBe(200);
		expect(cleared.body.subject).toBeNull();

		expect((await putTemplate(updatable, id, { name: "  " })).status).toBe(400);
		expect((await putTemplate(updatable, "missing", { name: "Nope" })).status).toBe(404);
	});

	it("deletes one template with a 204 and 404s the second time", async () => {
		const deletable = "templates-route-delete@example.com";
		await registerMailbox(deletable);
		await insertTemplates(stubFor(deletable), []);
		const created = await postTemplate(deletable, {
			name: "Doomed",
			body: "<p>x</p>",
		});
		const id = created.body.id as string;

		const first = await deleteTemplate(deletable, id);
		expect(first.status).toBe(204);
		expect(first.body).toBeNull();
		expect((await getTemplates(deletable)).body.templates).toEqual([]);

		const second = await deleteTemplate(deletable, id);
		expect(second.status).toBe(404);
		expect(second.body?.error).toBe("Template not found");
	});

	it("404s for an unknown mailbox", async () => {
		const { status } = await getTemplates("no-such-mailbox@example.com");
		expect(status).toBe(404);
	});
});

// ── Tools & surfaces ───────────────────────────────────────────────

describe("list_templates tool", () => {
	it("returns the mailbox's templates by name, bodies included", async () => {
		const mailbox = "templates-tool@example.com";
		const stub = stubFor(mailbox);
		await insertTemplates(stub, []);
		await createOn(stub, { name: "Zebra", body: "<p>z</p>" });
		const meeting = await createOn(stub, {
			name: "Meeting request",
			subject: "Meeting request",
			body: "<p>Can we meet?</p>",
		});

		const result = await toolListTemplates(env, mailbox);
		expect(result.mailboxId).toBe(mailbox);
		expect(result.templates.map((row) => row.name)).toEqual([
			"Meeting request",
			"Zebra",
		]);
		expect(result.templates[0]).toEqual({
			id: meeting.id,
			name: "Meeting request",
			subject: "Meeting request",
			body: "<p>Can we meet?</p>",
		});
		expect(result.note).toMatch(/read-only/i);
	});

	it("is on the agent tool map, scoped and global", async () => {
		const scoped = createEmailTools(env, "templates-agent-map@example.com");
		expect(Object.keys(scoped)).toContain("list_templates");
		const global = createEmailTools(env, null);
		expect(Object.keys(global)).toContain("list_templates");
	});

	it("is advertised on the live /mcp handshake and answers a call", async () => {
		const mailbox = "templates-mcp@example.com";
		await registerMailbox(mailbox);
		await createOn(stubFor(mailbox), {
			name: "Out of office",
			subject: "Out of office",
			body: "<p>I am away until Monday.</p>",
		});

		const answer = await mcpCall("list_templates", { mailboxId: mailbox });
		expect(answer.isError).toBe(false);
		expect(answer.text).toContain("Out of office");
		expect(answer.text).toContain("I am away until Monday.");
	});
});
