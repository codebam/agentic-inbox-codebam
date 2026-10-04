import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import {
	toolCreateFolder,
	toolCreateRule,
	toolDeleteFolder,
	toolDeleteRule,
	toolListFolders,
	toolPreviewRule,
	toolReorderRules,
	toolUpdateFolder,
} from "../workers/lib/tools";

type Stub = ReturnType<typeof stubFor>;

/** The folder row shape the list/create tools answer with. */
interface FolderRow {
	id: string;
	name: string;
	unreadCount: number;
}

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

/** Seed one email into a folder; subject and sender drive preview matches. */
async function seedEmail(
	stub: Stub,
	id: string,
	folder: string,
	options: { subject?: string; sender?: string } = {},
) {
	await stub.createEmail(
		folder,
		{
			id,
			subject: options.subject ?? `Subject ${id}`,
			sender: options.sender ?? "sender@example.org",
			recipient: "rule-folder-tools@example.com",
			date: new Date().toISOString(),
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: id,
		},
		[],
	);
}

/** Create one rule through the create_rule tool and return it. */
async function makeRule(
	mailbox: string,
	name: string,
	conditions: Record<string, string> = { subject_contains: name },
) {
	const result = (await toolCreateRule(env, mailbox, {
		name,
		match: { mode: "all", conditions },
		actions: { mark_read: true },
	})) as {
		rule?: { id: string; name: string; priority: number };
		error?: string;
	};
	if (!result.rule) throw new Error(`rule seed failed: ${result.error}`);
	return result.rule;
}

describe("toolDeleteRule", () => {
	it("deletes a stored rule and reports an unknown one", async () => {
		const mailbox = "tools-delete-rule@example.com";
		const stub = stubFor(mailbox);
		const rule = await makeRule(mailbox, "Junk filter");

		const result = await toolDeleteRule(env, mailbox, { ruleId: rule.id });
		expect(result).toEqual({ status: "deleted", ruleId: rule.id });

		// The row is really gone from the Durable Object.
		const rules = (await stub.listRules()) as { id: string }[];
		expect(rules.some((item) => item.id === rule.id)).toBe(false);

		expect(await toolDeleteRule(env, mailbox, { ruleId: rule.id })).toEqual({
			error: "Rule not found",
		});
	});
});

describe("toolPreviewRule", () => {
	it("matches seeded emails with the live matcher and writes nothing", async () => {
		const mailbox = "tools-preview-rule@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "pv-1", Folders.INBOX, {
			subject: "Invoice 42",
			sender: "billing@vendor.example",
		});
		await seedEmail(stub, "pv-2", Folders.INBOX, {
			subject: "Lunch on Friday?",
			sender: "friend@example.org",
		});
		await seedEmail(stub, "pv-3", Folders.ARCHIVE, {
			subject: "Invoice 43",
		});

		const result = (await toolPreviewRule(env, mailbox, {
			name: "Invoices",
			match: { mode: "all", conditions: { subject_contains: "invoice" } },
			actions: { move_to_folder: Folders.ARCHIVE },
		})) as {
			total: number;
			scanned: number;
			matches: { id: string; subject: string; folder_id: string }[];
		};

		expect(result.total).toBe(2);
		expect(result.scanned).toBe(3);
		expect(result.matches.map((match) => match.id).sort()).toEqual([
			"pv-1",
			"pv-3",
		]);
		expect(result.matches[0]).toMatchObject({
			subject: expect.stringContaining("Invoice"),
		});

		// Nothing was written: no rule, no folder change, no read flag.
		expect((await stub.listRules()) as unknown[]).toHaveLength(0);
		const inbox = (await stub.getEmails({ folder: Folders.INBOX })) as {
			id: string;
			folder_id: string;
		}[];
		expect(inbox.map((email) => email.id).sort()).toEqual(["pv-1", "pv-2"]);
	});

	it("accepts a stored folder name as a move target and strips outbound actions", async () => {
		const mailbox = "tools-preview-folder@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "pv-4", Folders.INBOX, { subject: "Receipt" });

		const result = (await toolPreviewRule(env, mailbox, {
			match: { mode: "all", conditions: { subject_contains: "receipt" } },
			// forward_to is operator-only; the tool strips it and the preview
			// still runs.
			actions: { move_to_folder: "Inbox", forward_to: "ops@example.org" },
		})) as { total?: number; error?: string };

		expect(result.error).toBeUndefined();
		expect(result.total).toBe(1);
	});

	it("answers the route's validation errors and nothing else", async () => {
		const mailbox = "tools-preview-invalid@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "pv-5", Folders.INBOX, { subject: "Invoice" });

		// The same folder check POST /rules/preview runs.
		const badFolder = (await toolPreviewRule(env, mailbox, {
			match: { mode: "all", conditions: { subject_contains: "invoice" } },
			actions: { move_to_folder: "no-such-folder" },
		})) as { error?: string };
		expect(badFolder.error).toBe("Unknown folder: no-such-folder");

		// The same body-schema 400 message the route answers.
		const noConditions = (await toolPreviewRule(env, mailbox, {
			match: { mode: "all", conditions: { subject_contains: "   " } },
		})) as { error?: string };
		expect(noConditions.error).toBe(
			"Invalid rule — match.conditions: A rule needs at least one match condition",
		);
	});
});

describe("toolReorderRules", () => {
	it("rewrites priorities in the given order and persists them", async () => {
		const mailbox = "tools-reorder-rules@example.com";
		const stub = stubFor(mailbox);
		const alpha = await makeRule(mailbox, "Alpha");
		const bravo = await makeRule(mailbox, "Bravo");
		const charlie = await makeRule(mailbox, "Charlie");

		const result = (await toolReorderRules(env, mailbox, {
			ruleIds: [charlie.id, alpha.id, bravo.id],
		})) as {
			mailboxId?: string;
			rules?: { id: string; name: string; priority: number }[];
			error?: string;
		};

		expect(result.error).toBeUndefined();
		expect(result.mailboxId).toBe(mailbox);
		expect(result.rules?.map((rule) => rule.name)).toEqual([
			"Charlie",
			"Alpha",
			"Bravo",
		]);
		expect(result.rules?.map((rule) => rule.priority)).toEqual([0, 1, 2]);

		// The Durable Object really stored the new order.
		const stored = (await stub.listRules()) as {
			name: string;
			priority: number;
		}[];
		expect(stored.map((rule) => rule.name)).toEqual([
			"Charlie",
			"Alpha",
			"Bravo",
		]);
		expect(stored.map((rule) => rule.priority)).toEqual([0, 1, 2]);
	});

	it("ignores unknown ids and refuses an empty list", async () => {
		const mailbox = "tools-reorder-mixed@example.com";
		const stub = stubFor(mailbox);
		const alpha = await makeRule(mailbox, "Alpha");
		const bravo = await makeRule(mailbox, "Bravo");

		const result = (await toolReorderRules(env, mailbox, {
			ruleIds: ["not-a-rule", bravo.id],
		})) as { rules?: { id: string; name: string }[]; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.rules?.[0]?.id).toBe(bravo.id);
		expect(result.rules?.[1]?.id).toBe(alpha.id);

		// The skipped id changed nothing; the stored order matches.
		const stored = (await stub.listRules()) as { id: string }[];
		expect(stored.map((rule) => rule.id)).toEqual([bravo.id, alpha.id]);

		const empty = (await toolReorderRules(env, mailbox, { ruleIds: [] })) as {
			error?: string;
		};
		expect(empty.error).toContain("Invalid rule");
	});
});

describe("toolListFolders", () => {
	it("lists the system folders and user folders with unread counts", async () => {
		const mailbox = "tools-list-folders@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "fold-1", Folders.INBOX);
		await toolCreateFolder(env, mailbox, { name: "Project Alpha" });

		const result = (await toolListFolders(env, mailbox)) as {
			mailboxId: string;
			folders: FolderRow[];
		};

		expect(result.mailboxId).toBe(mailbox);
		const ids = result.folders.map((folder) => folder.id);
		for (const system of ["inbox", "sent", "draft", "archive", "snoozed", "spam", "trash"]) {
			expect(ids).toContain(system);
		}
		const project = result.folders.find((folder) => folder.id === "project-alpha");
		expect(project).toMatchObject({ name: "Project Alpha", unreadCount: 0 });
		expect(result.folders.find((folder) => folder.id === "inbox")?.unreadCount).toBe(1);
	});
});

describe("toolCreateFolder", () => {
	it("creates a folder whose id is the slug of the name", async () => {
		const mailbox = "tools-create-folder@example.com";
		const stub = stubFor(mailbox);

		const result = (await toolCreateFolder(env, mailbox, {
			name: "Quarterly Reports!",
		})) as { folder?: FolderRow; error?: string };

		expect(result.error).toBeUndefined();
		expect(result.folder).toMatchObject({
			id: "quarterly-reports",
			name: "Quarterly Reports!",
			unreadCount: 0,
		});

		const folders = (await stub.getFolders()) as FolderRow[];
		expect(folders.some((folder) => folder.id === "quarterly-reports")).toBe(true);
	});

	it("refuses non-alphanumeric names and duplicates with the route's messages", async () => {
		const mailbox = "tools-create-folder-errors@example.com";
		await toolCreateFolder(env, mailbox, { name: "Saved" });

		expect(await toolCreateFolder(env, mailbox, { name: "!!!" })).toEqual({
			error: "Folder name must contain alphanumeric characters",
		});
		expect(await toolCreateFolder(env, mailbox, { name: "Saved" })).toEqual({
			error: "Folder with this name already exists",
		});
		// A different name that slugs to the same id collides too.
		expect(await toolCreateFolder(env, mailbox, { name: "saved" })).toEqual({
			error: "Folder with this name already exists",
		});
	});
});

describe("toolUpdateFolder", () => {
	it("renames a folder without changing its id", async () => {
		const mailbox = "tools-update-folder@example.com";
		const stub = stubFor(mailbox);
		await toolCreateFolder(env, mailbox, { name: "Project Alpha" });

		const result = (await toolUpdateFolder(env, mailbox, {
			folderId: "project-alpha",
			name: "Project Beta",
		})) as { folder?: { id: string; name: string }; error?: string };

		expect(result.error).toBeUndefined();
		expect(result.folder).toEqual({
			id: "project-alpha",
			name: "Project Beta",
		});

		const folders = (await stub.getFolders()) as FolderRow[];
		expect(
			folders.find((folder) => folder.id === "project-alpha")?.name,
		).toBe("Project Beta");
	});

	it("reports an unknown folder", async () => {
		const mailbox = "tools-update-folder-missing@example.com";
		expect(
			await toolUpdateFolder(env, mailbox, {
				folderId: "missing",
				name: "Nope",
			}),
		).toEqual({ error: "Folder not found" });
	});
});

describe("toolDeleteFolder", () => {
	it("deletes a user folder and keeps the system folders", async () => {
		const mailbox = "tools-delete-folder@example.com";
		const stub = stubFor(mailbox);
		await toolCreateFolder(env, mailbox, { name: "Temp" });

		expect(await toolDeleteFolder(env, mailbox, { folderId: "temp" })).toEqual({
			status: "deleted",
			folderId: "temp",
		});

		const folders = (await stub.getFolders()) as FolderRow[];
		expect(folders.some((folder) => folder.id === "temp")).toBe(false);
		expect(folders.some((folder) => folder.id === Folders.INBOX)).toBe(true);

		// A system folder refuses with the route's exact message.
		expect(
			await toolDeleteFolder(env, mailbox, { folderId: Folders.INBOX }),
		).toEqual({ error: "Folder not found or cannot be deleted" });
		// So does an unknown id.
		expect(
			await toolDeleteFolder(env, mailbox, { folderId: "missing" }),
		).toEqual({ error: "Folder not found or cannot be deleted" });
		// The refusals changed nothing.
		expect(
			((await stub.getFolders()) as FolderRow[]).some(
				(folder) => folder.id === Folders.INBOX,
			),
		).toBe(true);
	});
});
