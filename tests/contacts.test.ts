/**
 * Contacts store tests.
 *
 * Covers, in order: migration 21's table and both indexes on a fresh DO, the
 * createEmail feed (an inbound message bumps the sender's received_count and
 * captures the display name; a Sent-folder message bumps recipient, cc and
 * bcc; repeated mail increments instead of duplicating; addresses match
 * case-insensitively; a duplicate delivery is not counted twice), the
 * 5000-contact prune, searchContacts (ranking, prefix matching on address and
 * name, the limit, the empty-query page) and getContact, the contacts route
 * (default limit, clamp, cap, absent q, shape, unknown mailbox), and the
 * search_contacts tool on both surfaces — the agent tool map and the live
 * /mcp handshake, including one real tools/call.
 *
 * Nothing here sends mail: the store is fed by stored messages, and every
 * assertion is metadata (address, display name, counts, timestamps).
 */

import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { createEmailTools } from "../workers/agent/index";
import {
	DEFAULT_CONTACT_SEARCH_LIMIT,
	MAX_CONTACTS,
	MAX_CONTACT_SEARCH_LIMIT,
	type ContactRow,
} from "../workers/lib/contacts";
import {
	handleInboundRuleOutbound,
	setRuleOutboundSenderFactory,
} from "../workers/lib/rule-outbound";
import { toolSearchContacts } from "../workers/lib/tools";

type Stub = ReturnType<typeof stubFor>;

/** Answer shape of the contacts route. */
interface ContactsResponse {
	contacts?: ContactRow[];
	totalCount?: number;
	error?: string;
}

/** One row to insert directly, for the ranking, cap and prune tests. */
interface ContactSeed {
	id: string;
	email: string;
	name?: string | null;
	sent?: number;
	received?: number;
	lastSeenAt: string;
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
	options: {
		folder?: string;
		sender?: string;
		senderName?: string | null;
		recipient?: string;
		cc?: string | null;
		bcc?: string | null;
		messageId?: string;
	} = {},
) {
	await stub.createEmail(
		options.folder ?? Folders.INBOX,
		{
			id,
			subject: `Subject ${id}`,
			sender: options.sender ?? "sender@example.org",
			sender_name: options.senderName ?? null,
			recipient: options.recipient ?? "contacts@example.com",
			cc: options.cc ?? null,
			bcc: options.bcc ?? null,
			date: new Date().toISOString(),
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: id,
			message_id: options.messageId ?? null,
		},
		[],
	);
}

/** One stored contact, or null when the mailbox has never seen it. */
async function contactOf(stub: Stub, email: string): Promise<ContactRow | null> {
	return (await stub.getContact(email)) as unknown as ContactRow | null;
}

/** The ranked contact page for one query. */
async function searchOf(
	stub: Stub,
	query: string,
	limit?: number,
): Promise<ContactRow[]> {
	return (await stub.searchContacts(query, limit)) as unknown as ContactRow[];
}

/**
 * Replace the mailbox's contacts with exactly these rows, directly — the
 * ranking, cap and prune tests need controlled timestamps that
 * recordContacts (which always stamps "now") cannot produce. Idempotent:
 * a repeated call in one file reseeds instead of hitting the UNIQUE email
 * constraint, because Durable Object storage is not isolated per test.
 */
async function insertContacts(stub: Stub, rows: ContactSeed[]) {
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec("DELETE FROM contacts");
		for (const row of rows) {
			state.storage.sql.exec(
				`INSERT INTO contacts (id, email, name, sent_count, received_count, first_seen_at, last_seen_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
				row.id,
				row.email,
				row.name ?? null,
				row.sent ?? 0,
				row.received ?? 0,
				row.lastSeenAt,
			);
		}
	});
}

/** Fetch one page of the contacts route. */
async function getContacts(
	mailbox: string,
	query = "",
): Promise<{ status: number; body: ContactsResponse }> {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/contacts${query}`,
	);
	return { status: res.status, body: (await res.json()) as ContactsResponse };
}

/** A fixed instant plus `offsetMs`, as an ISO string. */
function isoAt(offsetMs: number): string {
	return new Date(Date.parse("2026-01-01T00:00:00.000Z") + offsetMs).toISOString();
}

const DAY_MS = 24 * 60 * 60 * 1000;

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

describe("migration 21_add_contacts", () => {
	it("creates the contacts table on a fresh DO", async () => {
		const stub = stubFor("contacts-migration@example.com");

		const migration = await runInDurableObject(stub, async (_instance, state) => {
			const table = [
				...state.storage.sql.exec(
					"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'contacts'",
				),
			][0] as { sql: string } | undefined;
			const applied = [
				...state.storage.sql.exec(
					"SELECT name FROM d1_migrations WHERE name = '21_add_contacts'",
				),
			];
			return { sql: table?.sql ?? null, applied: applied.length };
		});

		expect(migration.applied).toBe(1);
		const sql = migration.sql ?? "";
		for (const column of [
			"id TEXT PRIMARY KEY",
			"email TEXT NOT NULL UNIQUE",
			"name TEXT",
			"sent_count INTEGER NOT NULL DEFAULT 0",
			"received_count INTEGER NOT NULL DEFAULT 0",
			"first_seen_at TEXT NOT NULL",
			"last_seen_at TEXT NOT NULL",
		]) {
			expect(sql).toContain(column);
		}
	});

	it("ships the email and last_seen_at indexes", async () => {
		const stub = stubFor("contacts-migration-index@example.com");

		const indexes = await runInDurableObject(stub, async (_instance, state) => {
			const rows = [
				...state.storage.sql.exec(
					"SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'contacts'",
				),
			] as { name: string; sql: string | null }[];
			return rows.map((row) => `${row.name}: ${row.sql ?? ""}`);
		});

		const all = indexes.join("\n");
		expect(all).toContain("idx_contacts_email");
		expect(all).toContain("contacts(email)");
		expect(all).toContain("idx_contacts_last_seen_at");
		expect(all).toContain("contacts(last_seen_at)");
	});
});

// ── Feed (createEmail) ─────────────────────────────────────────────

describe("createEmail feeds the contacts store", () => {
	it("bumps the sender's received_count and stores the display name", async () => {
		const stub = stubFor("contacts-received@example.com");
		await seedEmail(stub, "received-1", {
			sender: "Alice@Example.com",
			senderName: "Alice Anderson",
		});

		const contact = await contactOf(stub, "alice@example.com");
		expect(contact).toMatchObject({
			email: "alice@example.com",
			name: "Alice Anderson",
			sent_count: 0,
			received_count: 1,
		});
		expect(contact?.first_seen_at).toEqual(expect.any(String));
		expect(contact?.last_seen_at).toEqual(expect.any(String));
		expect(await stub.countContacts("")).toBe(1);
	});

	it("bumps sent_count for recipient, cc and bcc on a Sent-folder message", async () => {
		const stub = stubFor("contacts-sent@example.com");
		await seedEmail(stub, "sent-1", {
			folder: Folders.SENT,
			sender: "me@example.com",
			recipient: "bob@example.org",
			cc: "carol@example.org",
			bcc: "dave@example.org",
		});

		for (const address of [
			"bob@example.org",
			"carol@example.org",
			"dave@example.org",
		]) {
			expect(await contactOf(stub, address)).toMatchObject({
				sent_count: 1,
				received_count: 0,
			});
		}
		// The sender of a Sent copy is the mailbox itself: no contact row.
		expect(await contactOf(stub, "me@example.com")).toBeNull();
		expect(await stub.countContacts("")).toBe(3);
	});

	it("increments counts instead of duplicating rows on repeated mail", async () => {
		const stub = stubFor("contacts-repeat@example.com");
		await seedEmail(stub, "repeat-1", {
			sender: "repeat@example.org",
			senderName: "Repeat Sender",
		});
		await seedEmail(stub, "repeat-2", { sender: "repeat@example.org" });
		await seedEmail(stub, "repeat-3", {
			folder: Folders.SENT,
			recipient: "repeat@example.org",
		});
		await seedEmail(stub, "repeat-4", {
			folder: Folders.SENT,
			recipient: "repeat@example.org",
		});

		expect(await contactOf(stub, "repeat@example.org")).toMatchObject({
			sent_count: 2,
			received_count: 2,
			// A later message without a display name keeps the stored one.
			name: "Repeat Sender",
		});
		expect(await stub.countContacts("")).toBe(1);
	});

	it("matches the address case-insensitively", async () => {
		const stub = stubFor("contacts-case@example.com");
		await seedEmail(stub, "case-1", {
			sender: "Mixed.Case@Example.ORG",
			senderName: "Mixed",
		});
		await seedEmail(stub, "case-2", { sender: "mixed.case@example.org" });

		expect(await stub.countContacts("")).toBe(1);
		expect(await contactOf(stub, "MIXED.CASE@EXAMPLE.ORG")).toMatchObject({
			email: "mixed.case@example.org",
			received_count: 2,
		});
		expect((await searchOf(stub, "Mixed.Case")).map((row) => row.email)).toEqual([
			"mixed.case@example.org",
		]);
	});

	it("does not count a duplicate delivery twice", async () => {
		const stub = stubFor("contacts-duplicate@example.com");
		await seedEmail(stub, "dup-1", {
			sender: "dup@example.org",
			messageId: "dup-message",
		});
		await seedEmail(stub, "dup-2", {
			sender: "dup@example.org",
			messageId: "dup-message",
		});

		expect(await contactOf(stub, "dup@example.org")).toMatchObject({
			received_count: 1,
		});
	});
});

// ── searchContacts / getContact ────────────────────────────────────

describe("searchContacts", () => {
	it("ranks by sent count, then received count, then recency", async () => {
		const stub = stubFor("contacts-rank@example.com");
		await insertContacts(stub, [
			{
				id: "rank-1",
				email: "tie-old@example.com",
				sent: 2,
				received: 5,
				lastSeenAt: isoAt(0),
			},
			{
				id: "rank-2",
				email: "tie-new@example.com",
				sent: 2,
				received: 5,
				lastSeenAt: isoAt(DAY_MS),
			},
			{
				id: "rank-3",
				email: "less-sent@example.com",
				sent: 1,
				received: 99,
				lastSeenAt: isoAt(2 * DAY_MS),
			},
			{
				id: "rank-4",
				email: "more-received@example.com",
				sent: 2,
				received: 6,
				lastSeenAt: isoAt(3 * DAY_MS),
			},
		]);

		expect((await searchOf(stub, "", 10)).map((row) => row.email)).toEqual([
			"more-received@example.com",
			"tie-new@example.com",
			"tie-old@example.com",
			"less-sent@example.com",
		]);
	});

	it("prefix-matches the address and the display name case-insensitively", async () => {
		const stub = stubFor("contacts-prefix@example.com");
		await insertContacts(stub, [
			{
				id: "prefix-1",
				email: "tie-one@example.com",
				sent: 1,
				received: 0,
				lastSeenAt: isoAt(0),
			},
			{
				id: "prefix-2",
				email: "tie-two@example.com",
				sent: 1,
				received: 0,
				lastSeenAt: isoAt(DAY_MS),
			},
			{
				id: "prefix-3",
				email: "who@example.com",
				name: "Nightowl Reader",
				received: 1,
				lastSeenAt: isoAt(2 * DAY_MS),
			},
			{
				id: "prefix-4",
				email: "in-fix@example.com",
				name: "Owl Post",
				received: 1,
				lastSeenAt: isoAt(3 * DAY_MS),
			},
		]);

		// Address prefix, case-insensitive; the tie falls to recency.
		expect((await searchOf(stub, "TIE")).map((row) => row.email)).toEqual([
			"tie-two@example.com",
			"tie-one@example.com",
		]);
		// Name prefix, case-insensitive.
		expect((await searchOf(stub, "night")).map((row) => row.email)).toEqual([
			"who@example.com",
		]);
		// Prefix only: "owl" matches the name that STARTS with it, and never
		// "Nightowl Reader", where it only appears inside.
		expect((await searchOf(stub, "owl")).map((row) => row.email)).toEqual([
			"in-fix@example.com",
		]);
		expect(await searchOf(stub, "reader")).toEqual([]);
		expect((await searchOf(stub, "in-")).map((row) => row.email)).toEqual([
			"in-fix@example.com",
		]);
	});

	it("returns the top-ranked contacts for an empty query and honours the limit", async () => {
		const stub = stubFor("contacts-limit@example.com");
		await insertContacts(stub, [
			{
				id: "limit-1",
				email: "one@example.com",
				sent: 3,
				received: 0,
				lastSeenAt: isoAt(0),
			},
			{
				id: "limit-2",
				email: "two@example.com",
				sent: 2,
				received: 0,
				lastSeenAt: isoAt(DAY_MS),
			},
			{
				id: "limit-3",
				email: "three@example.com",
				sent: 1,
				received: 0,
				lastSeenAt: isoAt(2 * DAY_MS),
			},
		]);

		expect((await searchOf(stub, "", 10)).map((row) => row.email)).toEqual([
			"one@example.com",
			"two@example.com",
			"three@example.com",
		]);
		expect((await searchOf(stub, "", 2)).map((row) => row.email)).toEqual([
			"one@example.com",
			"two@example.com",
		]);
		// A limit below 1 clamps to one row.
		expect(await searchOf(stub, "", 0)).toHaveLength(1);
	});

	it("caps the page at 50 rows", async () => {
		const stub = stubFor("contacts-cap@example.com");
		await insertContacts(
			stub,
			Array.from({ length: 60 }, (_unused, index) => ({
				id: `cap-${index}`,
				email: `cap-${String(index).padStart(2, "0")}@example.org`,
				sent: 0,
				received: 1,
				lastSeenAt: isoAt(index * 1000),
			})),
		);

		expect(await searchOf(stub, "", 1000)).toHaveLength(MAX_CONTACT_SEARCH_LIMIT);
		expect(await stub.countContacts("")).toBe(60);
	});

	it("returns one contact by address and null for an unknown one", async () => {
		const stub = stubFor("contacts-get@example.com");
		await seedEmail(stub, "get-1", {
			sender: "single@example.org",
			senderName: "Single",
		});

		expect(await contactOf(stub, "single@example.org")).toMatchObject({
			id: expect.any(String),
			email: "single@example.org",
			name: "Single",
			sent_count: 0,
			received_count: 1,
		});
		expect(await contactOf(stub, "nobody@example.org")).toBeNull();
		expect(await contactOf(stub, "not-an-address")).toBeNull();
	});
});

// ── Pruning ────────────────────────────────────────────────────────

describe("recordContacts pruning", () => {
	it("keeps the newest 5000 contacts", async () => {
		const stub = stubFor("contacts-prune@example.com");
		const seeded = MAX_CONTACTS + 5;
		await insertContacts(
			stub,
			Array.from({ length: seeded }, (_unused, index) => ({
				id: `seed-${index}`,
				email: `seed-${String(index).padStart(4, "0")}@example.org`,
				received: 1,
				lastSeenAt: isoAt(index * 1000),
			})),
		);
		expect(await stub.countContacts("")).toBe(seeded);

		await stub.recordContacts([{ email: "fresh@example.com", received: 1 }]);

		expect(await stub.countContacts("")).toBe(MAX_CONTACTS);
		// The six oldest rows are gone; the newest seeded row and the fresh
		// one are kept.
		expect(await contactOf(stub, "seed-0000@example.org")).toBeNull();
		expect(await contactOf(stub, "seed-0005@example.org")).toBeNull();
		expect(await contactOf(stub, "seed-0006@example.org")).not.toBeNull();
		expect(await contactOf(stub, "fresh@example.com")).not.toBeNull();
	});
});

// ── Route ──────────────────────────────────────────────────────────

describe("GET /api/v1/mailboxes/:mailboxId/contacts", () => {
	const mailbox = "contacts-route@example.com";

	/** 12 contacts with a deterministic ranking (sent_count 1..12). */
	async function seedRouteMailbox() {
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await insertContacts(
			stub,
			Array.from({ length: 12 }, (_unused, index) => ({
				id: `route-${index}`,
				email: `route-${String(index).padStart(2, "0")}@example.org`,
				name: index % 2 === 0 ? `Route ${index}` : null,
				sent: index + 1,
				received: 0,
				lastSeenAt: isoAt(index * 1000),
			})),
		);
		return stub;
	}

	it("returns the ranked page and the matching total, defaulting the limit", async () => {
		await seedRouteMailbox();
		const { status, body } = await getContacts(mailbox);
		expect(status).toBe(200);
		expect(body.totalCount).toBe(12);
		expect(body.contacts).toHaveLength(DEFAULT_CONTACT_SEARCH_LIMIT);
		// Highest sent_count first.
		expect(body.contacts?.[0]?.email).toBe("route-11@example.org");
		// The rows are contact metadata only — never message fields.
		expect(Object.keys(body.contacts?.[0] ?? {}).sort()).toEqual([
			"email",
			"first_seen_at",
			"id",
			"last_seen_at",
			"name",
			"received_count",
			"sent_count",
		]);
	});

	it("clamps a low limit and falls back on an unusable one", async () => {
		await seedRouteMailbox();
		expect((await getContacts(mailbox, "?limit=3")).body.contacts).toHaveLength(3);
		expect((await getContacts(mailbox, "?limit=0")).body.contacts).toHaveLength(1);
		expect(
			(await getContacts(mailbox, "?limit=nonsense")).body.contacts,
		).toHaveLength(DEFAULT_CONTACT_SEARCH_LIMIT);
	});

	it("caps the limit at 50", async () => {
		const capped = "contacts-route-cap@example.com";
		await registerMailbox(capped);
		const stub = stubFor(capped);
		await insertContacts(
			stub,
			Array.from({ length: 60 }, (_unused, index) => ({
				id: `capped-${index}`,
				email: `capped-${String(index).padStart(2, "0")}@example.org`,
				sent: 1,
				received: 0,
				lastSeenAt: isoAt(index * 1000),
			})),
		);

		const { body } = await getContacts(capped, "?limit=1000");
		expect(body.contacts).toHaveLength(MAX_CONTACT_SEARCH_LIMIT);
		expect(body.totalCount).toBe(60);
	});

	it("tolerates an absent q and filters on a present one", async () => {
		await seedRouteMailbox();
		const absent = await getContacts(mailbox, "?limit=50");
		expect(absent.status).toBe(200);
		expect(absent.body.totalCount).toBe(12);

		// "route-0" would match route-00..route-09; "route-1" narrows to two.
		const filtered = await getContacts(mailbox, "?q=route-1");
		expect(filtered.body.contacts?.map((row) => row.email)).toEqual([
			"route-11@example.org",
			"route-10@example.org",
		]);
		expect(filtered.body.totalCount).toBe(2);
	});

	it("404s for an unknown mailbox", async () => {
		const { status } = await getContacts("no-such-mailbox@example.com");
		expect(status).toBe(404);
	});
});

// ── Rule-driven sends ──────────────────────────────────────────────

describe("rule-driven outbound sends", () => {
	it("stores a Sent copy and counts the recipient as sent", async () => {
		const mailbox = "contacts-rule-outbound@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		const sent: { to?: unknown; subject?: unknown }[] = [];
		setRuleOutboundSenderFactory(() => ({
			send: async (params) => {
				sent.push({ to: params.to, subject: params.subject });
				return { messageId: "rule-outbound-1" };
			},
		}));
		try {
			const report = await handleInboundRuleOutbound(
				env,
				stub,
				{
					mailboxId: mailbox,
					sender: "billing@vendor.example",
					subject: "Invoice 77",
					body: "<p>invoice</p>",
					rawHeaders: null,
				},
				[
					{
						kind: "forward",
						rule_id: "rule-1",
						rule_name: "Forward invoices",
						to: "archive@example.org",
					},
				],
			);
			expect(report.sent).toBe(1);
		} finally {
			setRuleOutboundSenderFactory(null);
		}

		expect(sent).toEqual([
			{ to: "archive@example.org", subject: "Fwd: Invoice 77" },
		]);
		// The rule-driven forward leaves a Sent copy like every other send
		// path, so its recipient counts as a sent contact.
		const stored = (await stub.getEmails({ folder: Folders.SENT })) as {
			recipient: string | null;
		}[];
		expect(stored.map((row) => row.recipient)).toEqual(["archive@example.org"]);
		expect(await contactOf(stub, "archive@example.org")).toMatchObject({
			sent_count: 1,
			received_count: 0,
		});
	});
});

// ── Tools & surfaces ───────────────────────────────────────────────

describe("search_contacts tool", () => {
	it("returns the mailbox, query, ranked contacts and matching total", async () => {
		const mailbox = "contacts-tool@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "tool-1", {
			sender: "alice@example.org",
			senderName: "Alice",
		});
		await seedEmail(stub, "tool-2", {
			folder: Folders.SENT,
			recipient: "alice@example.org",
		});
		await seedEmail(stub, "tool-3", { sender: "bob@example.org" });

		const result = await toolSearchContacts(env, mailbox, "ali", 5);
		expect(result.mailboxId).toBe(mailbox);
		expect(result.query).toBe("ali");
		expect(result.totalCount).toBe(1);
		expect(result.contacts.map((row) => row.email)).toEqual(["alice@example.org"]);
		expect(result.contacts[0]).toMatchObject({ sent_count: 1, received_count: 1 });

		const all = await toolSearchContacts(env, mailbox);
		expect(all.query).toBe("");
		expect(all.totalCount).toBe(2);
		expect(all.contacts.map((row) => row.email)).toEqual([
			"alice@example.org",
			"bob@example.org",
		]);
	});

	it("is on the agent tool map, scoped and global", async () => {
		const scoped = createEmailTools(env, "contacts-agent-map@example.com");
		expect(Object.keys(scoped)).toContain("search_contacts");
		const global = createEmailTools(env, null);
		expect(Object.keys(global)).toContain("search_contacts");
	});

	it("is advertised on the live /mcp handshake and answers a call", async () => {
		const mailbox = "contacts-mcp@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, "mcp-1", {
			sender: "mcp-contact@example.org",
			senderName: "MCP",
		});

		expect(await mcpToolNames()).toContain("search_contacts");

		const answer = await mcpCall("search_contacts", {
			mailboxId: mailbox,
			query: "mcp-",
		});
		expect(answer.isError).toBe(false);
		expect(answer.text).toContain("mcp-contact@example.org");
	});
});
