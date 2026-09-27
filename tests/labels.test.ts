/**
 * Labels (per-mailbox tags) tests.
 *
 * Covers, in order: migration 34's tables on a fresh DO, the Durable Object
 * label CRUD (create, ordering, partial updates, delete semantics, the name
 * rules and the 100-per-mailbox cap), attaching and detaching labels, the
 * search label filter (exact, case-insensitive, and its count agreeing with
 * the page), the delete paths that must drop assignment rows with their
 * label or message, the labels routes (GET/POST/PATCH/DELETE plus the
 * email attach/detach with their 200/201/400/404 answers) and the
 * list_labels/add_label/remove_label tools on both surfaces.
 *
 * Nothing here sends mail: labels never do, and the mutating tools only
 * tag or untag a message.
 */

import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { createEmailTools } from "../workers/agent/index";
import {
	toolAddLabel,
	toolListLabels,
	toolRemoveLabel,
} from "../workers/lib/tools";
import {
	MAX_LABELS,
	MAX_LABEL_NAME_LENGTH,
	type Label,
} from "../workers/lib/labels";

type Stub = ReturnType<typeof stubFor>;

/** Answer shape of the labels routes. */
interface LabelsResponse {
	labels?: Label[];
	error?: string;
	ok?: boolean;
}

/** One label row as the label tools answer with. */
interface ToolLabel {
	id: string;
	name: string;
	color: string | null;
	created_at: string;
}

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

/** Register the mailbox record the API middleware checks before routing. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
}

/** Seed one stored message; the label tests only need ids, folders and dates. */
async function seedEmail(
	stub: Stub,
	mailbox: string,
	id: string,
	options: { folder?: string; date?: string } = {},
) {
	await stub.createEmail(
		options.folder ?? Folders.INBOX,
		{
			id,
			subject: `Subject ${id}`,
			sender: "sender@example.org",
			recipient: mailbox,
			date: options.date ?? "2026-01-02T10:00:00.000Z",
			body: `<p>body ${id}</p>`,
			read: false,
			starred: false,
			thread_id: id,
		},
		[],
	);
}

/**
 * Replace the mailbox's labels with exactly these rows, directly — the
 * ordering and cap tests need controlled names and timestamps. Idempotent:
 * a repeated call reseeds instead of accumulating, because Durable Object
 * storage is not isolated per test.
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

/** A fixed instant plus `offsetMs`, as an ISO string. */
function isoAt(offsetMs: number): string {
	return new Date(Date.parse("2026-01-01T00:00:00.000Z") + offsetMs).toISOString();
}

/** Extract result ids (rows come back ordered by date DESC). */
function ids(rows: unknown[]): string[] {
	return (rows as { id: string }[]).map((row) => row.id);
}

// ── Route helpers ──────────────────────────────────────────────────

async function getLabels(mailbox: string): Promise<{ status: number; body: LabelsResponse }> {
	const res = await SELF.fetch(`http://example.com/api/v1/mailboxes/${mailbox}/labels`);
	return { status: res.status, body: (await res.json()) as LabelsResponse };
}

async function postLabel(mailbox: string, body: unknown) {
	const res = await SELF.fetch(`http://example.com/api/v1/mailboxes/${mailbox}/labels`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as LabelsResponse };
}

async function patchLabel(mailbox: string, id: string, body: unknown) {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/labels/${id}`,
		{
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	return { status: res.status, body: (await res.json()) as LabelsResponse };
}

async function deleteLabelRoute(mailbox: string, id: string) {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/labels/${id}`,
		{ method: "DELETE" },
	);
	return { status: res.status, body: (await res.json()) as LabelsResponse };
}

async function attachLabel(mailbox: string, emailId: string, labelId: string) {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/emails/${emailId}/labels/${labelId}`,
		{ method: "POST" },
	);
	return { status: res.status, body: (await res.json()) as LabelsResponse };
}

async function detachLabel(mailbox: string, emailId: string, labelId: string) {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/emails/${emailId}/labels/${labelId}`,
		{ method: "DELETE" },
	);
	return { status: res.status, body: (await res.json()) as LabelsResponse };
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

// ── Migration ──────────────────────────────────────────────────────

describe("migration 34_add_labels", () => {
	it("creates the labels and email_labels tables on a fresh DO", async () => {
		const stub = stubFor("labels-migration@example.com");

		const migration = await runInDurableObject(stub, async (_instance, state) => {
			const table = (name: string) =>
				[
					...state.storage.sql.exec(
						"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
						name,
					),
				][0] as { sql: string } | undefined;
			const index = (name: string) =>
				[
					...state.storage.sql.exec(
						"SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?1",
						name,
					),
				].length;
			const applied = [
				...state.storage.sql.exec(
					"SELECT name FROM d1_migrations WHERE name = '34_add_labels'",
				),
			].length;
			return {
				labelsSql: table("labels")?.sql ?? null,
				emailLabelsSql: table("email_labels")?.sql ?? null,
				nameIndex: index("idx_labels_name_nocase"),
				labelIdIndex: index("idx_email_labels_label_id"),
				applied,
			};
		});

		expect(migration.applied).toBe(1);
		const labelsSql = migration.labelsSql ?? "";
		for (const column of [
			"id TEXT PRIMARY KEY",
			"name TEXT NOT NULL",
			"color TEXT",
			"created_at TEXT NOT NULL",
		]) {
			expect(labelsSql).toContain(column);
		}
		const emailLabelsSql = migration.emailLabelsSql ?? "";
		for (const column of [
			"email_id TEXT NOT NULL",
			"label_id TEXT NOT NULL",
			"created_at TEXT NOT NULL",
			"PRIMARY KEY (email_id, label_id)",
		]) {
			expect(emailLabelsSql).toContain(column);
		}
		expect(migration.nameIndex).toBe(1);
		expect(migration.labelIdIndex).toBe(1);
	});
});

// ── Durable Object CRUD ────────────────────────────────────────────

describe("label CRUD", () => {
	it("stores a trimmed name and an optional color", async () => {
		const stub = stubFor("labels-create@example.com");
		await insertLabels(stub, []);

		const row = (await stub.createLabel({
			name: "  Receipts  ",
			color: "  #f59e0b  ",
		})) as unknown as Label;
		expect(row).toMatchObject({ name: "Receipts", color: "#f59e0b" });
		expect(row.id).toEqual(expect.any(String));
		expect(row.created_at).toEqual(expect.any(String));

		const colorless = (await stub.createLabel({ name: "Later" })) as unknown as Label;
		expect(colorless.color).toBeNull();

		// A blank color is stored as null, not as an empty string.
		const blank = (await stub.createLabel({
			name: "Blank",
			color: "   ",
		})) as unknown as Label;
		expect(blank.color).toBeNull();
	});

	it("orders by name (case-insensitive)", async () => {
		const stub = stubFor("labels-order@example.com");
		await insertLabels(stub, [
			{ id: "order-1", name: "zeta", createdAt: isoAt(3_000) },
			{ id: "order-2", name: "Billing", createdAt: isoAt(2_000) },
			// Case-insensitive order: "Alpha" sorts before "Billing" (a binary
			// collation would sort it after, by its lowercase code points).
			// Two names that differ only in case cannot coexist — the unique
			// NOCASE index and createLabel's check both refuse them.
			{ id: "order-3", name: "Alpha", createdAt: isoAt(1_000) },
		]);

		expect((await stub.listLabels()).map((row) => row.id)).toEqual([
			"order-3",
			"order-2",
			"order-1",
		]);
	});

	it("renames and recolors a label; a missing id is null", async () => {
		const stub = stubFor("labels-update@example.com");
		await insertLabels(stub, []);
		const created = (await stub.createLabel({
			name: "Follow-up",
			color: "#111111",
		})) as unknown as Label;

		const renamed = (await stub.updateLabel(created.id, {
			name: "  Follow-up v2  ",
		})) as unknown as Label | null;
		expect(renamed).toMatchObject({
			id: created.id,
			name: "Follow-up v2",
			color: "#111111",
			created_at: created.created_at,
		});

		const recolored = (await stub.updateLabel(created.id, {
			color: "#222222",
		})) as unknown as Label | null;
		expect(recolored).toMatchObject({ name: "Follow-up v2", color: "#222222" });

		// An explicit null (or a blank string) clears the color.
		const cleared = (await stub.updateLabel(created.id, {
			color: "   ",
		})) as unknown as Label | null;
		expect(cleared?.color).toBeNull();

		// An unknown id is a miss, not a write.
		expect(await stub.updateLabel("missing", { name: "Nope" })).toBeNull();
		expect((await stub.listLabels()).map((row) => row.name)).toEqual(["Follow-up v2"]);
	});

	it("deletes a label once and reports a missing id", async () => {
		const stub = stubFor("labels-delete@example.com");
		await insertLabels(stub, []);
		const created = (await stub.createLabel({ name: "Short-lived" })) as unknown as Label;

		expect(await stub.deleteLabel(created.id)).toBe(true);
		expect(await stub.listLabels()).toEqual([]);
		expect(await stub.deleteLabel(created.id)).toBe(false);
	});

	it("rejects unusable names and duplicate names, case-insensitively", async () => {
		const stub = stubFor("labels-rules@example.com");
		await insertLabels(stub, []);
		const existing = (await stub.createLabel({ name: "Receipts" })) as unknown as Label;
		const other = (await stub.createLabel({ name: "Travel" })) as unknown as Label;

		// Asserted through the instance (not the RPC stub) so the thrown
		// LabelValidationError keeps its class: over RPC the DO runtime
		// rebuilds it, which is what isLabelValidationError() also covers.
		await runInDurableObject(stub, async (instance) => {
			expect(() => instance.createLabel({ name: "   " })).toThrow(/name is required/i);
			expect(() => instance.createLabel({})).toThrow(/name is required/i);
			expect(() => instance.createLabel(null)).toThrow(/name is required/i);
			expect(() => instance.createLabel({ name: 42 })).toThrow(/name is required/i);
			expect(() =>
				instance.createLabel({ name: "x".repeat(MAX_LABEL_NAME_LENGTH + 1) }),
			).toThrow(/name can be at most 50 characters/i);
			expect(() =>
				instance.createLabel({ name: "Long color", color: "c".repeat(33) }),
			).toThrow(/color can be at most/i);

			// Duplicate names are refused case-insensitively, on create and
			// on rename, and a rejected rename leaves the row untouched.
			expect(() => instance.createLabel({ name: "receipts" })).toThrow(
				/already exists/i,
			);
			expect(() => instance.createLabel({ name: "  RECEIPTS  " })).toThrow(
				/already exists/i,
			);
			expect(() => instance.updateLabel(other.id, { name: "Receipts" })).toThrow(
				/already exists/i,
			);
			// Renaming a label to its own name in a different case is fine.
			expect(instance.updateLabel(existing.id, { name: "receipts" })?.name).toBe(
				"receipts",
			);
		});

		expect((await stub.listLabels()).map((row) => row.name)).toEqual([
			"receipts",
			"Travel",
		]);
	});

	it("refuses a create once the mailbox holds 100 labels", async () => {
		const stub = stubFor("labels-cap@example.com");
		await insertLabels(
			stub,
			Array.from({ length: MAX_LABELS }, (_unused, index) => ({
				id: `cap-${index}`,
				name: `Label ${String(index).padStart(3, "0")}`,
				createdAt: isoAt(index * 1000),
			})),
		);
		expect(await stub.listLabels()).toHaveLength(MAX_LABELS);

		await runInDurableObject(stub, async (instance) => {
			expect(() => instance.createLabel({ name: "One more" })).toThrow(
				/at most 100 labels/i,
			);
		});
		expect(await stub.listLabels()).toHaveLength(MAX_LABELS);

		// Deleting frees a slot again.
		expect(await stub.deleteLabel("cap-0")).toBe(true);
		const created = (await stub.createLabel({ name: "One more" })) as unknown as Label;
		expect(created.name).toBe("One more");
		expect(await stub.listLabels()).toHaveLength(MAX_LABELS);
	});
});

// ── Attach / detach ────────────────────────────────────────────────

describe("label assignments", () => {
	it("attaches labels and lists them back in name order", async () => {
		const mailbox = "labels-attach@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, mailbox, "att-1");
		await insertLabels(stub, []);
		const work = (await stub.createLabel({ name: "Work" })) as unknown as Label;
		const bills = (await stub.createLabel({ name: "bills" })) as unknown as Label;

		const first = await stub.addLabelToEmail("att-1", work.id);
		expect(first).toMatchObject({ ok: true });
		const second = await stub.addLabelToEmail("att-1", bills.id);
		expect(second).toMatchObject({ ok: true });

		// Case-insensitive name order: bills < Work.
		const labels = (await stub.listLabelsForEmail("att-1")) as unknown as Label[];
		expect(labels.map((label) => label.name)).toEqual(["bills", "Work"]);

		// Attaching the same label again is a no-op, not a duplicate.
		expect(await stub.addLabelToEmail("att-1", work.id)).toMatchObject({ ok: true });
		expect(await countAssignments(stub, "att-1")).toBe(2);
	});

	it("detaches a label and reports a missing email or label", async () => {
		const mailbox = "labels-detach@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, mailbox, "det-1");
		await insertLabels(stub, []);
		const label = (await stub.createLabel({ name: "Solo" })) as unknown as Label;
		await stub.addLabelToEmail("det-1", label.id);

		const removed = await stub.removeLabelFromEmail("det-1", label.id);
		expect(removed).toMatchObject({ ok: true, labels: [] });
		expect(await countAssignments(stub, "det-1")).toBe(0);

		// Detaching again is a no-op, not an error.
		expect(await stub.removeLabelFromEmail("det-1", label.id)).toMatchObject({
			ok: true,
		});

		// A missing side is reported by name.
		expect(await stub.addLabelToEmail("missing", label.id)).toEqual({
			ok: false,
			error: "Email not found",
		});
		expect(await stub.addLabelToEmail("det-1", "missing")).toEqual({
			ok: false,
			error: "Label not found",
		});
		expect(await stub.removeLabelFromEmail("missing", label.id)).toEqual({
			ok: false,
			error: "Email not found",
		});
		expect(await stub.removeLabelFromEmail("det-1", "missing")).toEqual({
			ok: false,
			error: "Label not found",
		});
	});
});

// ── Search filter ──────────────────────────────────────────────────

describe("search label filter", () => {
	it("matches exactly the labelled message, case-insensitively", async () => {
		const mailbox = "labels-search@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, mailbox, "srch-1", { date: "2026-01-02T10:00:00.000Z" });
		await seedEmail(stub, mailbox, "srch-2", { date: "2026-01-03T10:00:00.000Z" });
		await seedEmail(stub, mailbox, "srch-3", { date: "2026-01-04T10:00:00.000Z" });
		await insertLabels(stub, []);
		const invoices = (await stub.createLabel({ name: "Invoices" })) as unknown as Label;
		await stub.addLabelToEmail("srch-2", invoices.id);

		expect(ids(await stub.searchEmails({ query: "", label: "Invoices" }))).toEqual([
			"srch-2",
		]);
		expect(await stub.countSearchResults({ query: "", label: "Invoices" })).toBe(1);

		// Case-insensitive and EXACT: the label name must match in full.
		expect(ids(await stub.searchEmails({ query: "", label: "invoices" }))).toEqual([
			"srch-2",
		]);
		expect(await stub.countSearchResults({ query: "", label: "invoices" })).toBe(1);
		expect(ids(await stub.searchEmails({ query: "", label: "Invoice" }))).toEqual([]);
		expect(await stub.countSearchResults({ query: "", label: "Invoice" })).toBe(0);

		// An unknown label matches nothing, and the unlabelled messages are
		// never returned by a label filter.
		expect(ids(await stub.searchEmails({ query: "", label: "Nope" }))).toEqual([]);
		expect(
			ids(await stub.searchEmails({ query: "Subject srch-2", label: "Invoices" })),
		).toEqual(["srch-2"]);
	});

	it("serves the same filter through the per-mailbox search route", async () => {
		const mailbox = "labels-search-route@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, mailbox, "route-srch-1");
		await seedEmail(stub, mailbox, "route-srch-2", {
			date: "2026-01-03T10:00:00.000Z",
		});
		await insertLabels(stub, []);
		const label = (await stub.createLabel({ name: "Filtered" })) as unknown as Label;
		await stub.addLabelToEmail("route-srch-2", label.id);

		const res = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/search?label=Filtered`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			emails: { id: string }[];
			totalCount: number;
		};
		expect(body.emails.map((email) => email.id)).toEqual(["route-srch-2"]);
		expect(body.totalCount).toBe(1);
	});
});

// ── Delete paths ───────────────────────────────────────────────────

describe("delete paths drop label assignments", () => {
	it("deleting a label removes its assignment rows", async () => {
		const mailbox = "labels-drop-label@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, mailbox, "drop-1");
		await insertLabels(stub, []);
		const label = (await stub.createLabel({ name: "Doomed" })) as unknown as Label;
		await stub.addLabelToEmail("drop-1", label.id);
		expect(await countAssignments(stub)).toBe(1);

		expect(await stub.deleteLabel(label.id)).toBe(true);
		expect(await countAssignments(stub)).toBe(0);
		expect(await stub.listLabelsForEmail("drop-1")).toEqual([]);
		// The message itself is untouched.
		expect(await stub.getEmail("drop-1")).not.toBeNull();
	});

	it("deleting an email removes its assignment rows", async () => {
		const mailbox = "labels-drop-email@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, mailbox, "drop-single");
		await seedEmail(stub, mailbox, "drop-bulk");
		await insertLabels(stub, []);
		const label = (await stub.createLabel({ name: "Tagged" })) as unknown as Label;
		await stub.addLabelToEmail("drop-single", label.id);
		await stub.addLabelToEmail("drop-bulk", label.id);
		expect(await countAssignments(stub)).toBe(2);

		await stub.deleteEmail("drop-single");
		expect(await countAssignments(stub, "drop-single")).toBe(0);
		expect(await countAssignments(stub)).toBe(1);
		expect(await stub.listLabelsForEmail("drop-single")).toEqual([]);

		await stub.bulkDeleteEmails(["drop-bulk"]);
		expect(await countAssignments(stub)).toBe(0);
	});

	it("emptying the trash removes assignments with the messages", async () => {
		const mailbox = "labels-drop-trash@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, mailbox, "trash-1");
		await insertLabels(stub, []);
		const label = (await stub.createLabel({ name: "Trashed" })) as unknown as Label;
		await stub.addLabelToEmail("trash-1", label.id);

		await stub.trashEmails(["trash-1"]);
		expect(await stub.emptyTrash()).toMatchObject({ purged: 1 });
		expect(await countAssignments(stub)).toBe(0);
		expect(await stub.listLabelsForEmail("trash-1")).toEqual([]);
	});

	it("the retention sweep drops assignments with its purged messages", async () => {
		const mailbox = "labels-drop-retention@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, mailbox, "ret-1");
		await insertLabels(stub, []);
		const label = (await stub.createLabel({ name: "Aged" })) as unknown as Label;
		await stub.addLabelToEmail("ret-1", label.id);

		// Entering Trash stamps trashed_at; a cutoff in the future makes the
		// message retention-eligible and the sweep purges it.
		await stub.trashEmails(["ret-1"]);
		const purged = await stub.purgeTrashedBefore(
			new Date(Date.now() + 60_000).toISOString(),
		);
		expect(purged).toMatchObject({ purged: 1 });
		expect(await countAssignments(stub)).toBe(0);
	});
});

// ── Routes ─────────────────────────────────────────────────────────

describe("labels routes", () => {
	it("creates, lists, updates and deletes a label", async () => {
		const mailbox = "labels-route@example.com";
		await registerMailbox(mailbox);
		await insertLabels(stubFor(mailbox), []);

		const created = await postLabel(mailbox, {
			name: "  Receipts  ",
			color: "  #f59e0b  ",
		});
		expect(created.status).toBe(201);
		expect(created.body).toMatchObject({ name: "Receipts", color: "#f59e0b" });
		expect(created.body.id).toEqual(expect.any(String));
		expect(created.body.created_at).toEqual(expect.any(String));

		const subjectless = await postLabel(mailbox, { name: "Plain" });
		expect(subjectless.status).toBe(201);
		expect(subjectless.body.color).toBeNull();

		const list = await getLabels(mailbox);
		expect(list.status).toBe(200);
		expect(list.body.labels?.map((label) => label.name)).toEqual(["Plain", "Receipts"]);
		expect(Object.keys(list.body.labels?.[0] ?? {}).sort()).toEqual([
			"color",
			"created_at",
			"id",
			"name",
		]);

		const updated = await patchLabel(mailbox, created.body.id as string, {
			name: "Receipts 2026",
			color: null,
		});
		expect(updated.status).toBe(200);
		expect(updated.body).toMatchObject({
			id: created.body.id,
			name: "Receipts 2026",
			color: null,
		});

		const deleted = await deleteLabelRoute(mailbox, created.body.id as string);
		expect(deleted.status).toBe(200);
		expect(deleted.body).toEqual({ ok: true });
		expect((await getLabels(mailbox)).body.labels?.map((label) => label.name)).toEqual([
			"Plain",
		]);
		expect((await deleteLabelRoute(mailbox, created.body.id as string)).status).toBe(404);
	});

	it("rejects a bad name with a 400 and surfaces the cap", async () => {
		const invalid = "labels-route-invalid@example.com";
		await registerMailbox(invalid);
		await insertLabels(stubFor(invalid), []);

		const noName = await postLabel(invalid, { name: "   " });
		expect(noName.status).toBe(400);
		expect(noName.body.error).toMatch(/name is required/i);

		const longName = await postLabel(invalid, {
			name: "x".repeat(MAX_LABEL_NAME_LENGTH + 1),
		});
		expect(longName.status).toBe(400);
		expect(longName.body.error).toMatch(/at most 50 characters/i);

		const duplicate = await postLabel(invalid, { name: "Dup" });
		expect(duplicate.status).toBe(201);
		expect((await postLabel(invalid, { name: "DUP" })).status).toBe(400);

		// The one path where the Durable Object itself rejects rather than
		// the route, so it proves the route's 400 survives the RPC rebuild
		// of the thrown error (isLabelValidationError's name/message check).
		const capped = "labels-route-cap@example.com";
		await registerMailbox(capped);
		await insertLabels(
			stubFor(capped),
			Array.from({ length: MAX_LABELS }, (_unused, index) => ({
				id: `route-cap-${index}`,
				name: `Label ${String(index).padStart(3, "0")}`,
				createdAt: isoAt(index * 1000),
			})),
		);
		const overCap = await postLabel(capped, { name: "One more" });
		expect(overCap.status).toBe(400);
		expect(overCap.body.error).toMatch(/at most 100 labels/i);

		// Nothing was stored by any of the rejected writes.
		expect((await getLabels(invalid)).body.labels?.map((label) => label.name)).toEqual([
			"Dup",
		]);
	});

	it("updates a missing label with a 404 and a bad rename with a 400", async () => {
		const mailbox = "labels-route-put@example.com";
		await registerMailbox(mailbox);
		await insertLabels(stubFor(mailbox), []);
		await postLabel(mailbox, { name: "First" });
		const second = await postLabel(mailbox, { name: "Second" });
		const firstId = (await getLabels(mailbox)).body.labels?.find(
			(label) => label.name === "First",
		)?.id as string;

		expect((await patchLabel(mailbox, "missing", { name: "Nope" })).status).toBe(404);
		const clash = await patchLabel(mailbox, firstId, { name: "second" });
		expect(clash.status).toBe(400);
		expect(clash.body.error).toMatch(/already exists/i);
		expect((await patchLabel(mailbox, second.body.id as string, { color: "#333" })).status).toBe(200);
	});

	it("attaches and detaches with the frozen shapes", async () => {
		const mailbox = "labels-route-attach@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, mailbox, "route-att-1");
		await insertLabels(stub, []);
		const label = await postLabel(mailbox, { name: "Work", color: "#0000ff" });
		const labelId = label.body.id as string;

		const attached = await attachLabel(mailbox, "route-att-1", labelId);
		expect(attached.status).toBe(200);
		expect(attached.body.labels?.map((entry) => entry.name)).toEqual(["Work"]);
		expect(attached.body.labels?.[0]?.color).toBe("#0000ff");

		// Attaching twice answers the same shape, without a duplicate.
		expect((await attachLabel(mailbox, "route-att-1", labelId)).status).toBe(200);
		expect(await countAssignments(stub, "route-att-1")).toBe(1);

		const detached = await detachLabel(mailbox, "route-att-1", labelId);
		expect(detached.status).toBe(200);
		expect(detached.body.labels).toEqual([]);

		// A missing message or label is a 404 naming it.
		const missingEmail = await attachLabel(mailbox, "missing", labelId);
		expect(missingEmail.status).toBe(404);
		expect(missingEmail.body.error).toBe("Email not found");
		const missingLabel = await attachLabel(mailbox, "route-att-1", "missing");
		expect(missingLabel.status).toBe(404);
		expect(missingLabel.body.error).toBe("Label not found");
		expect((await detachLabel(mailbox, "missing", labelId)).status).toBe(404);
		expect((await detachLabel(mailbox, "route-att-1", "missing")).status).toBe(404);
	});

	it("404s for an unknown mailbox", async () => {
		const { status } = await getLabels("no-such-mailbox@example.com");
		expect(status).toBe(404);
	});
});

// ── Tools & surfaces ───────────────────────────────────────────────

describe("label tools", () => {
	it("list_labels answers the mailbox's labels, names in order", async () => {
		const mailbox = "labels-tool-list@example.com";
		const stub = stubFor(mailbox);
		await insertLabels(stub, []);
		await stub.createLabel({ name: "Zebra" });
		const work = (await stub.createLabel({
			name: "Work",
			color: "#123456",
		})) as unknown as Label;

		const result = await toolListLabels(env, mailbox);
		expect(result.mailboxId).toBe(mailbox);
		expect(result.labels.map((row) => row.name)).toEqual(["Work", "Zebra"]);
		expect(result.labels[0]).toEqual({
			id: work.id,
			name: "Work",
			color: "#123456",
			created_at: work.created_at,
		});
		expect(result.note).toMatch(/read-only/i);
	});

	it("add_label tags a message by name or id; remove_label untags", async () => {
		const mailbox = "labels-tool-mutate@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, mailbox, "tool-1");
		await insertLabels(stub, []);
		const work = (await stub.createLabel({ name: "Work" })) as unknown as Label;

		const byName = await toolAddLabel(env, mailbox, "tool-1", "work");
		expect(byName).toMatchObject({ status: "updated", emailId: "tool-1" });
		expect((byName as { labels: ToolLabel[] }).labels.map((label) => label.name)).toEqual([
			"Work",
		]);

		const second = (await stub.createLabel({ name: "Later" })) as unknown as Label;
		const byId = await toolAddLabel(env, mailbox, "tool-1", second.id);
		expect((byId as { labels: ToolLabel[] }).labels.map((label) => label.name)).toEqual([
			"Later",
			"Work",
		]);

		const removed = await toolRemoveLabel(env, mailbox, "tool-1", "Work");
		expect(removed).toMatchObject({ status: "updated", emailId: "tool-1" });
		expect((removed as { labels: ToolLabel[] }).labels.map((label) => label.name)).toEqual([
			"Later",
		]);
		expect(await countAssignments(stub, "tool-1")).toBe(1);
		expect(work.id).toEqual(expect.any(String));
	});

	it("reports a missing email and a missing label", async () => {
		const mailbox = "labels-tool-missing@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, mailbox, "tool-missing-1");
		await insertLabels(stub, []);
		await stub.createLabel({ name: "Present" });

		expect(await toolAddLabel(env, mailbox, "missing", "Present")).toEqual({
			error: "Email not found",
		});
		expect(await toolRemoveLabel(env, mailbox, "missing", "Present")).toEqual({
			error: "Email not found",
		});
		expect(await toolAddLabel(env, mailbox, "tool-missing-1", "Absent")).toEqual({
			error: "Label not found",
		});
		expect(await toolRemoveLabel(env, mailbox, "tool-missing-1", "Absent")).toEqual({
			error: "Label not found",
		});
	});

	it("is on the agent tool map and answers live /mcp calls", async () => {
		const scoped = createEmailTools(env, "labels-agent-map@example.com");
		expect(Object.keys(scoped)).toContain("list_labels");
		expect(Object.keys(scoped)).toContain("add_label");
		expect(Object.keys(scoped)).toContain("remove_label");
		const global = createEmailTools(env, null);
		expect(Object.keys(global)).toContain("add_label");

		const mailbox = "labels-mcp@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, mailbox, "mcp-1");
		await insertLabels(stub, []);
		await stub.createLabel({ name: "Out of office" });

		const listed = await mcpCall("list_labels", { mailboxId: mailbox });
		expect(listed.isError).toBe(false);
		expect(listed.text).toContain("Out of office");

		const added = await mcpCall("add_label", {
			mailboxId: mailbox,
			emailId: "mcp-1",
			label: "Out of office",
		});
		expect(added.isError).toBe(false);
		expect(added.text).toContain("Out of office");

		const removed = await mcpCall("remove_label", {
			mailboxId: mailbox,
			emailId: "mcp-1",
			label: "Out of office",
		});
		expect(removed.isError).toBe(false);
		expect(removed.text).toContain("updated");

		const missing = await mcpCall("add_label", {
			mailboxId: mailbox,
			emailId: "missing",
			label: "Out of office",
		});
		expect(missing.isError).toBe(true);
		expect(missing.text).toContain("Email not found");
	});
});
