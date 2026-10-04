/**
 * Label management tools (create_label, update_label, delete_label) tests.
 *
 * Covers, against real Durable Object state: the create/update/delete happy
 * paths and their route-mirroring error messages (missing and oversized
 * names, case-insensitive duplicates, oversized colors and the 100-per-
 * mailbox cap), name-or-id resolution, the detach-on-delete semantics — a
 * message that carried the label no longer does, asserted through the
 * Durable Object — and both surfaces: the agent tool map and live /mcp
 * calls.
 *
 * Nothing here sends mail: these tools only manage label rows and their
 * message assignments.
 */

import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { createEmailTools } from "../workers/agent/index";
import {
	toolAddLabel,
	toolCreateLabel,
	toolDeleteLabel,
	toolUpdateLabel,
} from "../workers/lib/tools";
import {
	MAX_LABELS,
	MAX_LABEL_COLOR_LENGTH,
	MAX_LABEL_NAME_LENGTH,
	type Label,
} from "../workers/lib/labels";

type Stub = ReturnType<typeof stubFor>;

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

/** Register the mailbox record the API middleware checks before routing. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
}

/** Seed one stored message; these tests only need ids and folders. */
async function seedEmail(stub: Stub, mailbox: string, id: string) {
	await stub.createEmail(
		Folders.INBOX,
		{
			id,
			subject: `Subject ${id}`,
			sender: "sender@example.org",
			recipient: mailbox,
			date: "2026-01-02T10:00:00.000Z",
			body: `<p>body ${id}</p>`,
			read: false,
			starred: false,
			thread_id: id,
		},
		[],
	);
}

/**
 * Replace the mailbox's labels with exactly these rows, directly — the cap
 * test needs controlled names. Idempotent: a repeated call reseeds instead
 * of accumulating, because Durable Object storage is not isolated per test.
 */
async function insertLabels(
	stub: Stub,
	rows: { id: string; name: string; color?: string | null; createdAt: string }[],
) {
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec("DELETE FROM email_labels");
		state.storage.sql.exec("DELETE FROM labels");
		for (const row of rows) {
			state.storage.sql.exec(
				`INSERT INTO labels (id, name, color, created_at)
				 VALUES (?1, ?2, ?3, ?4)`,
				row.id,
				row.name,
				row.color ?? null,
				row.createdAt,
			);
		}
	});
}

/** A fixed instant plus `offsetMs`, as an ISO string. */
function isoAt(offsetMs: number): string {
	return new Date(Date.parse("2026-01-01T00:00:00.000Z") + offsetMs).toISOString();
}

/** How many label assignment rows exist, optionally for one message. */
async function countAssignments(stub: Stub, emailId?: string): Promise<number> {
	return runInDurableObject(stub, async (_instance, state) => {
		const rows = emailId
			? [
					...state.storage.sql.exec(
						"SELECT COUNT(*) AS total FROM email_labels WHERE email_id = ?1",
						emailId,
					),
				]
			: [...state.storage.sql.exec("SELECT COUNT(*) AS total FROM email_labels")];
		return (rows[0] as { total: number }).total;
	});
}

/** The mailbox's labels, as MailboxDO.listLabels returns them. */
async function listOf(stub: Stub): Promise<Label[]> {
	return (await stub.listLabels()) as unknown as Label[];
}

/** The labels one message carries, as MailboxDO.listLabelsForEmail returns them. */
async function labelsOf(stub: Stub, emailId: string): Promise<Label[]> {
	return (await stub.listLabelsForEmail(emailId)) as unknown as Label[];
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

// ── create_label ───────────────────────────────────────────────────

describe("create_label", () => {
	it("stores a trimmed name and an optional color, answering the stored row", async () => {
		const mailbox = "label-admin-create@example.com";
		const stub = stubFor(mailbox);
		await insertLabels(stub, []);

		const created = await toolCreateLabel(env, mailbox, {
			name: "  Work  ",
			color: "  #f59e0b  ",
		});
		expect(created).toMatchObject({ name: "Work", color: "#f59e0b" });
		expect((created as { id: string }).id).toEqual(expect.any(String));
		expect((created as { created_at: string }).created_at).toEqual(expect.any(String));

		// An omitted color stores null, never a missing key.
		const plain = await toolCreateLabel(env, mailbox, { name: "Later" });
		expect(plain).toMatchObject({ name: "Later", color: null });

		const rows = await listOf(stub);
		expect(rows.map((row) => row.name)).toEqual(["Later", "Work"]);
		expect(rows[1]).toMatchObject({
			id: (created as { id: string }).id,
			color: "#f59e0b",
		});
	});

	it("rejects unusable names and colors with the web route's messages", async () => {
		const mailbox = "label-admin-create-invalid@example.com";
		const stub = stubFor(mailbox);
		await insertLabels(stub, []);

		expect(errorOf(await toolCreateLabel(env, mailbox, {}))).toMatch(/name is required/i);
		expect(
			errorOf(await toolCreateLabel(env, mailbox, { name: "   " })),
		).toMatch(/name is required/i);
		expect(
			errorOf(
				await toolCreateLabel(env, mailbox, {
					name: "x".repeat(MAX_LABEL_NAME_LENGTH + 1),
				}),
			),
		).toMatch(/at most 50 characters/i);
		expect(
			errorOf(
				await toolCreateLabel(env, mailbox, {
					name: "Too colorful",
					color: "c".repeat(MAX_LABEL_COLOR_LENGTH + 1),
				}),
			),
		).toMatch(/color can be at most/i);

		// Duplicates are refused case-insensitively, naming the clash.
		await toolCreateLabel(env, mailbox, { name: "Dup" });
		const duplicate = await toolCreateLabel(env, mailbox, { name: "DUP" });
		expect(errorOf(duplicate)).toMatch(/A label named "DUP" already exists/i);

		// Nothing was stored by any of the rejected writes.
		expect((await listOf(stub)).map((row) => row.name)).toEqual(["Dup"]);
	});

	it("refuses a create once the mailbox holds 100 labels", async () => {
		const mailbox = "label-admin-cap@example.com";
		const stub = stubFor(mailbox);
		await insertLabels(
			stub,
			Array.from({ length: MAX_LABELS }, (_unused, index) => ({
				id: `admin-cap-${index}`,
				name: `Label ${String(index).padStart(3, "0")}`,
				createdAt: isoAt(index * 1000),
			})),
		);

		const overCap = await toolCreateLabel(env, mailbox, { name: "One more" });
		expect(errorOf(overCap)).toMatch(/at most 100 labels/i);
		expect(await listOf(stub)).toHaveLength(MAX_LABELS);
	});
});

// ── update_label ───────────────────────────────────────────────────

describe("update_label", () => {
	it("renames and recolors by name or id; null clears the color", async () => {
		const mailbox = "label-admin-update@example.com";
		const stub = stubFor(mailbox);
		await insertLabels(stub, []);
		const work = (await stub.createLabel({
			name: "Work",
			color: "#111111",
		})) as unknown as Label;
		const later = (await stub.createLabel({ name: "Later" })) as unknown as Label;

		// Resolved by name, case-insensitively.
		const renamed = await toolUpdateLabel(env, mailbox, {
			label: "work",
			name: "Office",
			color: "#222222",
		});
		expect(renamed).toMatchObject({
			id: work.id,
			name: "Office",
			color: "#222222",
			created_at: work.created_at,
		});

		// Resolved by id; an omitted color keeps its stored value.
		const byId = await toolUpdateLabel(env, mailbox, {
			label: later.id,
			name: "Later renamed",
		});
		expect(byId).toMatchObject({ id: later.id, name: "Later renamed", color: null });

		// An explicit null color clears it; a name-only patch leaves the color.
		await toolUpdateLabel(env, mailbox, { label: "Office", color: null });
		await toolUpdateLabel(env, mailbox, { label: work.id, color: "#333333" });
		const nameOnly = await toolUpdateLabel(env, mailbox, {
			label: "Office",
			name: "Desk",
		});
		expect(nameOnly).toMatchObject({ name: "Desk", color: "#333333" });

		expect((await listOf(stub)).map((row) => row.name)).toEqual([
			"Desk",
			"Later renamed",
		]);
	});

	it("reports an unknown label and refused renames with the web route's messages", async () => {
		const mailbox = "label-admin-update-errors@example.com";
		const stub = stubFor(mailbox);
		await insertLabels(stub, []);
		const first = (await stub.createLabel({ name: "First" })) as unknown as Label;
		await stub.createLabel({ name: "Second" });

		expect(
			await toolUpdateLabel(env, mailbox, { label: "Absent", name: "Nope" }),
		).toEqual({ error: "Label not found" });

		expect(
			errorOf(
				await toolUpdateLabel(env, mailbox, { label: "Second", name: "first" }),
			),
		).toMatch(/A label named "first" already exists/i);
		expect(
			errorOf(
				await toolUpdateLabel(env, mailbox, { label: first.id, name: "   " }),
			),
		).toMatch(/name is required/i);
		expect(
			errorOf(
				await toolUpdateLabel(env, mailbox, {
					label: first.id,
					name: "x".repeat(MAX_LABEL_NAME_LENGTH + 1),
				}),
			),
		).toMatch(/at most 50 characters/i);

		// Every refused write left the stored rows untouched.
		expect((await listOf(stub)).map((row) => row.name)).toEqual(["First", "Second"]);
	});
});

// ── delete_label ───────────────────────────────────────────────────

describe("delete_label", () => {
	it("removes the label and detaches it from every message", async () => {
		const mailbox = "label-admin-delete@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, mailbox, "detach-1");
		await seedEmail(stub, mailbox, "detach-2");
		await insertLabels(stub, []);
		const work = (await stub.createLabel({ name: "Work" })) as unknown as Label;
		await stub.createLabel({ name: "Keep" });
		await toolAddLabel(env, mailbox, "detach-1", "Work");
		await toolAddLabel(env, mailbox, "detach-1", "Keep");
		await toolAddLabel(env, mailbox, "detach-2", "Work");
		expect((await labelsOf(stub, "detach-1")).map((row) => row.name)).toEqual([
			"Keep",
			"Work",
		]);

		// Deleted by name, case-insensitively.
		const deleted = await toolDeleteLabel(env, mailbox, { label: "work" });
		expect(deleted).toEqual({ ok: true });

		// The label is gone...
		expect((await listOf(stub)).map((row) => row.name)).toEqual(["Keep"]);
		// ...and the messages that carried it no longer do, asserted through
		// the Durable Object (its label list and the join table).
		expect((await labelsOf(stub, "detach-1")).map((row) => row.name)).toEqual([
			"Keep",
		]);
		expect(await labelsOf(stub, "detach-2")).toEqual([]);
		expect(await countAssignments(stub, "detach-2")).toBe(0);
		expect(await countAssignments(stub)).toBe(1);
		// The messages themselves are untouched.
		expect(await stub.getEmail("detach-1")).not.toBeNull();
		expect(await stub.getEmail("detach-2")).not.toBeNull();
		expect(work.id).toEqual(expect.any(String));

		// A second label goes by id.
		const temp = (await stub.createLabel({ name: "Temp" })) as unknown as Label;
		expect(await toolDeleteLabel(env, mailbox, { label: temp.id })).toEqual({
			ok: true,
		});
		expect((await listOf(stub)).map((row) => row.name)).toEqual(["Keep"]);
	});

	it("reports an unknown label", async () => {
		const mailbox = "label-admin-delete-missing@example.com";
		await insertLabels(stubFor(mailbox), []);

		expect(await toolDeleteLabel(env, mailbox, { label: "Nope" })).toEqual({
			error: "Label not found",
		});
	});
});

// ── Surfaces ───────────────────────────────────────────────────────

describe("label management surfaces", () => {
	it("is on the agent tool map, scoped and global", async () => {
		const scoped = createEmailTools(env, "label-admin-agent@example.com");
		expect(Object.keys(scoped)).toContain("create_label");
		expect(Object.keys(scoped)).toContain("update_label");
		expect(Object.keys(scoped)).toContain("delete_label");
		const global = createEmailTools(env, null);
		expect(Object.keys(global)).toContain("create_label");
		expect(Object.keys(global)).toContain("update_label");
		expect(Object.keys(global)).toContain("delete_label");
	});

	it("answers live /mcp calls and surfaces refusals as errors", async () => {
		const mailbox = "label-admin-mcp@example.com";
		await registerMailbox(mailbox);
		await insertLabels(stubFor(mailbox), []);

		const created = await mcpCall("create_label", {
			mailboxId: mailbox,
			name: "Out of office",
			color: "#f59e0b",
		});
		expect(created.isError).toBe(false);
		expect(created.text).toContain("Out of office");
		expect(created.text).toContain("#f59e0b");

		const updated = await mcpCall("update_label", {
			mailboxId: mailbox,
			label: "out of office",
			name: "OOO",
		});
		expect(updated.isError).toBe(false);
		expect(updated.text).toContain("OOO");

		const duplicate = await mcpCall("create_label", {
			mailboxId: mailbox,
			name: "OOO",
		});
		expect(duplicate.isError).toBe(true);
		expect(duplicate.text).toContain("already exists");

		const deleted = await mcpCall("delete_label", {
			mailboxId: mailbox,
			label: "OOO",
		});
		expect(deleted.isError).toBe(false);
		expect(deleted.text).toContain('"ok": true');

		const missing = await mcpCall("delete_label", {
			mailboxId: mailbox,
			label: "Nope",
		});
		expect(missing.isError).toBe(true);
		expect(missing.text).toContain("Label not found");
	});
});
