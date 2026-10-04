/**
 * Misc maintenance tool tests: update_item, empty_trash, restore_email,
 * get_digest and get_storage — the shared implementations behind the MCP
 * server and the in-app agent.
 *
 * Each case drives the tool against real Durable Object state (and, for
 * empty_trash, the real R2 bucket) and then asserts what was actually
 * stored or removed, so a tool that only pretends to write is caught.
 */

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createEmailTools } from "../workers/agent/index";
import { Folders } from "../shared/folders";
import {
	toolEmptyTrash,
	toolGetDigest,
	toolGetStorage,
	toolRestoreEmail,
	toolUpdateItem,
} from "../workers/lib/tools";

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

type Stub = ReturnType<typeof stubFor>;

/** Register the mailbox record whose settings JSON get_storage measures. */
async function registerMailbox(
	mailbox: string,
	settings: Record<string, unknown> = {},
) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify(settings));
}

interface SeedOptions {
	attachment?: boolean;
	date?: string;
	read?: boolean;
	category?: string | null;
}

/** Seed one stored message (optionally with a single attachment row). */
async function seedEmail(
	stub: Stub,
	mailbox: string,
	id: string,
	folder: string,
	options: SeedOptions = {},
) {
	await stub.createEmail(
		folder,
		{
			id,
			subject: `Subject ${id}`,
			sender: "sender@example.org",
			recipient: mailbox,
			date: options.date ?? new Date().toISOString(),
			read: options.read ?? false,
			category: options.category ?? null,
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: id,
		},
		options.attachment
			? [
					{
						id: `${id}-attachment`,
						email_id: id,
						filename: "notes.txt",
						mimetype: "text/plain",
						size: 5,
					},
				]
			: [],
	);
}

/** R2 key for the single attachment seedEmail can create. */
function attachmentKey(emailId: string) {
	return `attachments/${emailId}/${emailId}-attachment/notes.txt`;
}

/**
 * Replace the mailbox's items with exactly these rows, directly. Durable
 * Object storage is not isolated per test, so each test seeds its own rows
 * and clears the table first.
 */
async function seedItems(
	stub: Stub,
	rows: { id: string; emailId: string; status?: string; createdAt: string }[],
) {
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec("DELETE FROM extracted_items");
		for (const row of rows) {
			state.storage.sql.exec(
				`INSERT INTO extracted_items
				 (id, email_id, thread_id, kind, title, details, due_at, status, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
				row.id,
				row.emailId,
				null,
				"task",
				`Title ${row.id}`,
				null,
				null,
				row.status ?? "open",
				row.createdAt,
			);
		}
	});
}

/** The mailbox's stored items, as the DO returns them. */
async function storedItems(
	stub: Stub,
): Promise<{ id: string; status: string }[]> {
	const page = (await stub.listItems({})) as unknown as {
		items: { id: string; status: string }[];
	};
	return page.items;
}

describe("update_item tool", () => {
	it("moves an item through every status and returns the stored row", async () => {
		const mailbox = "misc-update-item@example.com";
		const stub = stubFor(mailbox);
		await seedItems(stub, [
			{ id: "ui-1", emailId: "m-1", createdAt: "2026-01-01T00:00:00.000Z" },
			{ id: "ui-2", emailId: "m-1", createdAt: "2026-01-02T00:00:00.000Z" },
		]);

		for (const status of ["done", "dismissed", "open"]) {
			const answer = await toolUpdateItem(env, mailbox, {
				itemId: "ui-1",
				status,
			});
			expect(answer).toMatchObject({ item: { id: "ui-1", status } });
			const stored = await storedItems(stub);
			expect(stored.find((item) => item.id === "ui-1")).toMatchObject({
				status,
			});
		}
	});

	it("rejects an unknown status and an unknown item without writing", async () => {
		const mailbox = "misc-update-item-errors@example.com";
		const stub = stubFor(mailbox);
		await seedItems(stub, [
			{ id: "ui-3", emailId: "m-1", createdAt: "2026-01-01T00:00:00.000Z" },
		]);

		expect(
			await toolUpdateItem(env, mailbox, { itemId: "ui-3", status: "archived" }),
		).toEqual({ error: "Invalid item status" });
		expect(
			await toolUpdateItem(env, mailbox, { itemId: "missing", status: "done" }),
		).toEqual({ error: "Item not found" });

		// Neither rejected call touched the stored row.
		expect(await storedItems(stub)).toMatchObject([
			{ id: "ui-3", status: "open" },
		]);
	});
});

describe("empty_trash tool", () => {
	it("purges trashed rows and their R2 blobs, sparing everything else", async () => {
		const mailbox = "misc-empty-trash@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, mailbox, "empty-a", Folders.TRASH, {
			attachment: true,
		});
		await seedEmail(stub, mailbox, "empty-b", Folders.TRASH);
		await seedEmail(stub, mailbox, "empty-keep", Folders.INBOX, {
			attachment: true,
		});
		await env.BUCKET.put(attachmentKey("empty-a"), "trash blob");
		await env.BUCKET.put(attachmentKey("empty-keep"), "inbox blob");

		expect(await toolEmptyTrash(env, mailbox)).toEqual({ purged: 2 });

		expect(await stub.getEmail("empty-a")).toBeNull();
		expect(await stub.getEmail("empty-b")).toBeNull();
		expect(await stub.getEmail("empty-keep")).not.toBeNull();
		expect(await env.BUCKET.head(attachmentKey("empty-a"))).toBeNull();
		expect(await env.BUCKET.head(attachmentKey("empty-keep"))).not.toBeNull();

		// The purged message's attachment rows went with it.
		const attachmentCount = await runInDurableObject(
			stub,
			async (_instance, state) => {
				const rows = [
					...state.storage.sql.exec(
						"SELECT COUNT(*) AS c FROM attachments WHERE email_id = ?1",
						"empty-a",
					),
				];
				return (rows[0] as { c: number }).c;
			},
		);
		expect(attachmentCount).toBe(0);
	});

	it("reports zero on an empty Trash and deletes no R2 objects", async () => {
		const mailbox = "misc-empty-trash-empty@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, mailbox, "empty-inbox", Folders.INBOX, {
			attachment: true,
		});
		await env.BUCKET.put(attachmentKey("empty-inbox"), "keep me");

		expect(await toolEmptyTrash(env, mailbox)).toEqual({ purged: 0 });
		expect(await stub.getEmail("empty-inbox")).not.toBeNull();
		expect(await env.BUCKET.head(attachmentKey("empty-inbox"))).not.toBeNull();
	});
});

describe("restore_email tool", () => {
	it("moves a trashed email back to the inbox and answers the count", async () => {
		const mailbox = "misc-restore@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, mailbox, "restore-a", Folders.INBOX);
		await stub.trashEmails(["restore-a"]);
		expect((await stub.getEmail("restore-a"))?.folder_id).toBe(Folders.TRASH);

		expect(
			await toolRestoreEmail(env, mailbox, { emailId: "restore-a" }),
		).toEqual({ restored: 1 });
		expect((await stub.getEmail("restore-a"))?.folder_id).toBe(
			Folders.INBOX,
		);
	});

	it("errors when the message is not in Trash or does not exist", async () => {
		const mailbox = "misc-restore-error@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, mailbox, "restore-inbox", Folders.INBOX);

		expect(
			await toolRestoreEmail(env, mailbox, { emailId: "restore-inbox" }),
		).toEqual({ error: "Email is not in Trash" });
		expect(
			await toolRestoreEmail(env, mailbox, { emailId: "restore-missing" }),
		).toEqual({ error: "Email is not in Trash" });
		expect((await stub.getEmail("restore-inbox"))?.folder_id).toBe(
			Folders.INBOX,
		);
	});
});

describe("get_digest tool", () => {
	it("returns the trailing-24-hour digest object", async () => {
		const mailbox = "misc-digest@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, mailbox, "digest-tool-1", Folders.INBOX, {
			date: new Date(Date.now() - 60_000).toISOString(),
			read: true,
			category: "work",
		});

		const digest = (await toolGetDigest(env, mailbox)) as unknown as {
			mailbox: string;
			window: { from: string; to: string };
			counts: {
				received: number;
				unread: number;
				starred: number;
				spam: number;
				needs_reply: number;
			};
			recent: { id: string }[];
			by_category: { category: string; count: number }[];
			reminders: unknown[];
		};

		expect(Object.keys(digest).sort()).toEqual([
			"by_category",
			"counts",
			"generated_at",
			"items",
			"mailbox",
			"needs_reply",
			"recent",
			"reminders",
			"window",
		]);
		expect(digest.mailbox).toBe(mailbox);
		expect(digest.counts).toEqual({
			received: 1,
			unread: 0,
			starred: 0,
			spam: 0,
			needs_reply: 1,
		});
		expect(digest.recent.map((row) => row.id)).toEqual(["digest-tool-1"]);
		expect(digest.by_category).toEqual([{ category: "work", count: 1 }]);
		expect(digest.reminders).toEqual([]);
		expect(Date.parse(digest.window.to) - Date.parse(digest.window.from)).toBe(
			86_400_000,
		);
		expect(Math.abs(Date.parse(digest.window.to) - Date.now())).toBeLessThan(
			60_000,
		);
	});
});

describe("get_storage tool", () => {
	it("returns the storage object, measuring the settings JSON in R2", async () => {
		const mailbox = "misc-storage@example.com";
		await registerMailbox(mailbox, { fromName: "Misc" });
		const stub = stubFor(mailbox);
		await seedEmail(stub, mailbox, "storage-1", Folders.INBOX, {
			attachment: true,
		});

		const storage = (await toolGetStorage(env, mailbox)) as unknown as Record<
			string,
			number
		>;
		expect(Object.keys(storage).sort()).toEqual([
			"attachment_bytes",
			"attachment_count",
			"database_bytes",
			"email_count",
			"mailbox_json_bytes",
		]);
		for (const value of Object.values(storage)) {
			expect(typeof value).toBe("number");
		}
		expect(storage.email_count).toBe(1);
		expect(storage.attachment_count).toBe(1);
		expect(storage.attachment_bytes).toBe(5);
		expect(storage.database_bytes).toBeGreaterThan(0);
		const settingsObject = await env.BUCKET.head(`mailboxes/${mailbox}.json`);
		expect(storage.mailbox_json_bytes).toBe(settingsObject?.size);
	});

	it("reports zero settings bytes when the mailbox record is absent", async () => {
		const mailbox = "misc-storage-absent@example.com";
		const storage = await toolGetStorage(env, mailbox);
		expect(storage.mailbox_json_bytes).toBe(0);
		expect(storage.email_count).toBe(0);
	});
});

describe("surface exposure", () => {
	it("registers all six tools on the agent tool map", () => {
		const tools = createEmailTools(env, "misc-agent@example.com");
		for (const name of [
			"update_item",
			"empty_trash",
			"restore_email",
			"get_digest",
			"get_storage",
			"export_email",
		]) {
			expect(Object.keys(tools)).toContain(name);
		}
	});

	it("records agent-sourced audit rows for empty_trash and restore_email", async () => {
		const mailbox = "misc-audit@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, mailbox, "audit-purge", Folders.TRASH);
		await seedEmail(stub, mailbox, "audit-restore", Folders.INBOX);
		await stub.trashEmails(["audit-restore"]);

		const tools = createEmailTools(env, mailbox) as unknown as Record<
			string,
			{ execute: (args: Record<string, unknown>) => Promise<unknown> }
		>;
		const run = (name: string, args: Record<string, unknown>) => {
			const tool = tools[name];
			if (!tool) throw new Error(`tool ${name} not registered`);
			return tool.execute(args);
		};
		await run("restore_email", { emailId: "audit-restore" });
		await run("empty_trash", {});

		// Both mutations happened...
		expect(await stub.getEmail("audit-purge")).toBeNull();
		expect((await stub.getEmail("audit-restore"))?.folder_id).toBe(
			Folders.INBOX,
		);

		// ...and both were recorded against the agent surface.
		const actions = (await stub.listAgentActions(10)) as unknown as {
			tool: string;
			source: string;
			email_id: string | null;
		}[];
		const byTool = new Map(actions.map((action) => [action.tool, action]));
		expect(byTool.get("empty_trash")).toMatchObject({
			source: "agent",
			email_id: null,
		});
		expect(byTool.get("restore_email")).toMatchObject({
			source: "agent",
			email_id: "audit-restore",
		});
	});
});
