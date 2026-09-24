import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { createEmailTools } from "../workers/agent/index";
import { toolSetSenderPolicy, toolStarEmail } from "../workers/lib/tools";

/** Every tool the MCP server exposes, as a contract for the surface. */
const MCP_TOOLS = [
	"clear_reminder",
	"create_draft",
	"create_rule",
	"delete_email",
	"delete_spam_emails",
	"discard_draft",
	"draft_reply",
	"get_email",
	"get_thread",
	"list_agent_actions",
	"list_emails",
	"list_mailboxes",
	"list_rules",
	"list_snoozed",
	"mark_email_read",
	"move_email",
	"search_all_mailboxes",
	"search_contacts",
	"search_emails",
	"send_email",
	"send_reply",
	"set_reminder",
	"set_sender_policy",
	"snooze_email",
	"star_email",
	"undo_action",
	"unsnooze_email",
	"update_draft",
	"update_rule",
];

/** Agent tool names for a chat scoped to a single mailbox. */
const AGENT_SCOPED_TOOLS = [
	"clear_reminder",
	"create_rule",
	"delete_email",
	"delete_spam_emails",
	"discard_draft",
	"draft_email",
	"draft_reply",
	"get_email",
	"get_thread",
	"list_agent_actions",
	"list_emails",
	"list_rules",
	"list_snoozed",
	"mark_email_read",
	"move_email",
	"search_contacts",
	"search_emails",
	"set_reminder",
	"set_sender_policy",
	"snooze_email",
	"star_email",
	"undo_action",
	"unsnooze_email",
	"update_draft",
	"update_rule",
];

/** Agent tools that only make sense when the chat spans mailboxes. */
const AGENT_GLOBAL_ONLY = ["list_mailboxes", "search_all_mailboxes"];

function parseSse(text: string) {
	return text
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
}

async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(
		`mailboxes/${mailbox}.json`,
		JSON.stringify({ categorization: { enabled: false } }),
	);
}

async function seed(
	mailbox: string,
	id: string,
	options: { sender?: string; folder?: string } = {},
) {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
	await stub.createEmail(
		options.folder ?? Folders.INBOX,
		{
			id,
			subject: `Subject ${id}`,
			sender: options.sender ?? "sender@example.org",
			recipient: mailbox,
			date: new Date().toISOString(),
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: id,
		},
		[],
	);
	return stub;
}

describe("MCP tool surface", () => {
	it("exposes the documented tool list over /mcp", async () => {
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
		const headers = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(session ? { "mcp-session-id": session } : {}),
		};
		await SELF.fetch("http://example.com/mcp", {
			method: "POST",
			headers,
			body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
		});
		const list = await SELF.fetch("http://example.com/mcp", {
			method: "POST",
			headers,
			body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
		});
		expect(list.status).toBe(200);
		const messages = parseSse(await list.text());
		const tools =
			(messages[0]?.result as { tools?: { name: string }[] } | undefined)?.tools ?? [];
		expect(tools.map((tool) => tool.name).sort()).toEqual(MCP_TOOLS);
	});
});

describe("agent tool surface", () => {
	it("scopes a per-mailbox chat to that mailbox", () => {
		const tools = createEmailTools(env, "scoped@example.com");
		expect(Object.keys(tools).sort()).toEqual(AGENT_SCOPED_TOOLS);
	});

	it("adds the cross-mailbox tools only for global chats", () => {
		const tools = createEmailTools(env, null);
		expect(Object.keys(tools).sort()).toEqual(
			[...AGENT_SCOPED_TOOLS, ...AGENT_GLOBAL_ONLY].sort(),
		);
	});
});

describe("star_email", () => {
	it("stars and unstars a stored email", async () => {
		const mailbox = "parity-star@example.com";
		const stub = await seed(mailbox, "star-1");

		expect(await toolStarEmail(env, mailbox, "star-1", true)).toEqual({
			status: "updated",
			emailId: "star-1",
			starred: true,
		});
		expect(((await stub.getEmail("star-1")) as { starred: boolean }).starred).toBe(true);

		await toolStarEmail(env, mailbox, "star-1", false);
		expect(((await stub.getEmail("star-1")) as { starred: boolean }).starred).toBe(false);
	});

	it("reports a missing email instead of quietly succeeding", async () => {
		const mailbox = "parity-star-missing@example.com";
		await seed(mailbox, "star-2");
		expect(await toolStarEmail(env, mailbox, "missing", true)).toEqual({
			error: "Email not found",
		});
	});
});

describe("set_sender_policy", () => {
	it("records the sender and files the message in Spam on block", async () => {
		const mailbox = "parity-block@example.com";
		await registerMailbox(mailbox);
		const stub = await seed(mailbox, "block-1", { sender: "spammer@example.org" });

		const result = await toolSetSenderPolicy(env, mailbox, "block-1", "block");
		expect(result).toMatchObject({ status: "updated", action: "block" });

		const stored = (await stub.getEmail("block-1")) as { folder_id: string };
		expect(stored.folder_id).toBe(Folders.SPAM);
		const entries = (await stub.listSenderPolicy()) as { address: string }[];
		expect(entries.map((entry) => entry.address)).toContain("spammer@example.org");
	});

	it("moves the message back to the Inbox on allow", async () => {
		const mailbox = "parity-allow@example.com";
		await registerMailbox(mailbox);
		const stub = await seed(mailbox, "allow-1", {
			sender: "friend@example.org",
			folder: Folders.SPAM,
		});

		const result = await toolSetSenderPolicy(env, mailbox, "allow-1", "allow");
		expect(result).toMatchObject({ status: "updated", action: "allow" });

		const stored = (await stub.getEmail("allow-1")) as { folder_id: string };
		expect(stored.folder_id).toBe(Folders.INBOX);
	});

	it("reports a missing email", async () => {
		const mailbox = "parity-policy-missing@example.com";
		await registerMailbox(mailbox);
		await seed(mailbox, "policy-1");
		expect(await toolSetSenderPolicy(env, mailbox, "missing", "block")).toEqual({
			error: "Email not found",
		});
	});
});
