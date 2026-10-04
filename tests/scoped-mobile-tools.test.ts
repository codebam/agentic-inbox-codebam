// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Scoped surface: the wave-17 automation tools — label, template and
 * saved-search management, thread actions, trash restore and purge, the
 * scheduled-send queue, and the sender-policy reads — exercised through
 * `POST /api/v1/scoped/<tool>` against real Durable Object state, plus the
 * scope refusals and the audit rows the guarded calls write.
 */

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import type { AccessTokenRecord } from "../shared/access-tokens";
import { serializeScheduledSendPayload } from "../workers/lib/scheduled-sends";
import { SCOPED_TOOL_SCOPES } from "../workers/lib/scoped-surface";

type Stub = ReturnType<typeof stubFor>;

/** The JSON answer of one scoped call. */
interface ScopedAnswer {
	status: number;
	body: { ok?: boolean; result?: unknown; error?: string };
}

/** One stored audit row, typed loosely: the assertions name the fields. */
interface AuditRow {
	source: string;
	tool: string;
	email_id: string | null;
	args: string | null;
}

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

/** Register the mailbox record the admin routes check before routing. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
}

/** Seed one stored message; `extra` may add fields such as the read flag. */
async function seedEmail(
	stub: Stub,
	id: string,
	folder: string = Folders.INBOX,
	extra: Record<string, unknown> = {},
) {
	await stub.createEmail(
		folder,
		{
			id,
			subject: `Subject ${id}`,
			sender: "sender@example.org",
			recipient: "scoped-mobile@example.com",
			date: new Date().toISOString(),
			read: false,
			starred: false,
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: id,
			...extra,
		},
		[],
	);
}

/** Mint one access token through the admin route and keep its plaintext. */
async function mintToken(
	mailbox: string,
	scopes: string[],
	name = "Scoped mobile test token",
): Promise<{ token: string; record: AccessTokenRecord }> {
	await registerMailbox(mailbox);
	const response = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/access-tokens`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name, scopes }),
		},
	);
	expect(response.status).toBe(201);
	return (await response.json()) as { token: string; record: AccessTokenRecord };
}

/** POST one scoped call as a token holder. */
async function scopedCall(
	tool: string,
	token: string,
	body: unknown = {},
): Promise<ScopedAnswer> {
	const response = await SELF.fetch(`http://example.com/api/v1/scoped/${tool}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(body),
	});
	return {
		status: response.status,
		body: (await response.json()) as ScopedAnswer["body"],
	};
}

/** The mailbox's audit rows, newest first. */
async function auditRows(stub: Stub): Promise<AuditRow[]> {
	return (await stub.listAgentActions(50)) as unknown as AuditRow[];
}

// ── The scope map additions (imports, no network) ───────────────────

describe("scoped tool map additions", () => {
	it("assigns the read additions to the read scope", () => {
		for (const tool of [
			"list_labels",
			"list_templates",
			"list_saved_searches",
			"summarize_thread",
			"list_scheduled_sends",
			"get_sender_policy",
		] as const) {
			expect(SCOPED_TOOL_SCOPES[tool]).toBe("read");
		}
	});

	it("assigns the management additions to the manage scope", () => {
		for (const tool of [
			"add_label",
			"remove_label",
			"create_label",
			"update_label",
			"delete_label",
			"create_template",
			"update_template",
			"delete_template",
			"create_saved_search",
			"update_saved_search",
			"delete_saved_search",
			"mute_thread",
			"unmute_thread",
			"mark_thread_read",
			"empty_trash",
			"restore_email",
			"remove_sender_policy",
		] as const) {
			expect(SCOPED_TOOL_SCOPES[tool]).toBe("manage");
		}
	});

	it("assigns the queue additions to the send scope", () => {
		for (const tool of [
			"cancel_scheduled_send",
			"schedule_send",
			"retry_scheduled_send",
		] as const) {
			expect(SCOPED_TOOL_SCOPES[tool]).toBe("send");
		}
	});
});

// ── Label management ────────────────────────────────────────────────

describe("scoped label management", () => {
	it("creates, applies, removes and deletes a label", async () => {
		const mailbox = "scoped-mobile-labels@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "mobile-label-1");
		const { token } = await mintToken(mailbox, ["read", "manage"]);

		const created = await scopedCall("create_label", token, {
			name: "Urgent",
			color: "#f59e0b",
		});
		expect(created.status).toBe(200);
		expect((created.body.result as { name: string }).name).toBe("Urgent");
		const stored = (await stub.listLabels()) as { name: string }[];
		expect(stored.map((label) => label.name)).toContain("Urgent");

		const listed = await scopedCall("list_labels", token);
		expect(listed.status).toBe(200);
		expect(
			(listed.body.result as { labels: { name: string }[] }).labels.map(
				(label) => label.name,
			),
		).toContain("Urgent");

		const added = await scopedCall("add_label", token, {
			emailId: "mobile-label-1",
			label: "Urgent",
		});
		expect(added.status).toBe(200);
		expect(
			(added.body.result as { labels: { name: string }[] }).labels.map(
				(label) => label.name,
			),
		).toContain("Urgent");
		const afterAdd = await auditRows(stub);
		expect(afterAdd[0]?.source).toBe("scoped");
		expect(afterAdd[0]?.tool).toBe("add_label");

		// Detach by name, case-insensitively.
		const removed = await scopedCall("remove_label", token, {
			emailId: "mobile-label-1",
			label: "urgent",
		});
		expect(removed.status).toBe(200);

		const updated = await scopedCall("update_label", token, {
			label: "Urgent",
			name: "Priority",
		});
		expect(updated.status).toBe(200);
		expect((updated.body.result as { name: string }).name).toBe("Priority");

		const deleted = await scopedCall("delete_label", token, { label: "Priority" });
		expect(deleted.status).toBe(200);
		expect((await stub.listLabels()) as unknown[]).toHaveLength(0);
	});

	it("refuses a read-only token the manage scope and keeps the read scope working", async () => {
		const mailbox = "scoped-mobile-label-scope@example.com";
		const { token } = await mintToken(mailbox, ["read"]);

		const refused = await scopedCall("create_label", token, { name: "Nope" });
		expect(refused.status).toBe(403);
		expect(refused.body.error).toBe("This token lacks the manage scope");

		const allowed = await scopedCall("list_labels", token);
		expect(allowed.status).toBe(200);
	});
});

// ── Template management ─────────────────────────────────────────────

describe("scoped template management", () => {
	it("creates, updates, lists and deletes a template", async () => {
		const mailbox = "scoped-mobile-templates@example.com";
		const stub = stubFor(mailbox);
		const { token } = await mintToken(mailbox, ["read", "manage"]);

		const created = await scopedCall("create_template", token, {
			name: "Welcome",
			subject: "Hello there",
			body: "Thanks for signing up.",
		});
		expect(created.status).toBe(200);
		const template = created.body.result as { id: string; name: string };

		const updated = await scopedCall("update_template", token, {
			templateId: template.id,
			name: "Welcome v2",
		});
		expect(updated.status).toBe(200);
		expect((updated.body.result as { name: string }).name).toBe("Welcome v2");

		const listed = await scopedCall("list_templates", token);
		expect(
			(listed.body.result as { templates: { name: string }[] }).templates.map(
				(entry) => entry.name,
			),
		).toContain("Welcome v2");

		const deleted = await scopedCall("delete_template", token, {
			templateId: template.id,
		});
		expect(deleted.status).toBe(200);
		expect((await stub.listTemplates()) as unknown[]).toHaveLength(0);
	});
});

// ── Saved searches ──────────────────────────────────────────────────

describe("scoped saved searches", () => {
	it("creates, updates, lists and deletes a saved search", async () => {
		const mailbox = "scoped-mobile-searches@example.com";
		const stub = stubFor(mailbox);
		const { token } = await mintToken(mailbox, ["read", "manage"]);

		const created = await scopedCall("create_saved_search", token, {
			name: "Unread from boss",
			query: "from:boss is:unread",
		});
		expect(created.status).toBe(200);
		const search = created.body.result as { id: string; name: string };

		const updated = await scopedCall("update_saved_search", token, {
			searchId: search.id,
			name: "Boss mail",
		});
		expect(updated.status).toBe(200);
		expect((updated.body.result as { name: string }).name).toBe("Boss mail");

		const listed = await scopedCall("list_saved_searches", token);
		expect(
			(listed.body.result as { searches: { name: string }[] }).searches.map(
				(entry) => entry.name,
			),
		).toContain("Boss mail");

		const deleted = await scopedCall("delete_saved_search", token, {
			searchId: search.id,
		});
		expect(deleted.status).toBe(200);
		expect((await stub.listSavedSearches()) as unknown[]).toHaveLength(0);
	});
});

// ── Thread actions ──────────────────────────────────────────────────

describe("scoped thread actions", () => {
	it("mutes, unmutes and marks a thread read against real state", async () => {
		const mailbox = "scoped-mobile-threads@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "thread-a", Folders.INBOX, { thread_id: "thread-keep" });
		await seedEmail(stub, "thread-b", Folders.INBOX, { thread_id: "thread-keep" });
		const { token } = await mintToken(mailbox, ["read", "manage"]);

		const muted = await scopedCall("mute_thread", token, { threadId: "thread-keep" });
		expect(muted.status).toBe(200);
		expect((muted.body.result as { muted: boolean }).muted).toBe(true);
		expect(await stub.isThreadMuted("thread-keep")).toBe(true);

		const unmuted = await scopedCall("unmute_thread", token, { threadId: "thread-keep" });
		expect(unmuted.status).toBe(200);
		expect(await stub.isThreadMuted("thread-keep")).toBe(false);

		const marked = await scopedCall("mark_thread_read", token, { threadId: "thread-keep" });
		expect(marked.status).toBe(200);
		expect((marked.body.result as { status: string }).status).toBe("marked_read");
		for (const id of ["thread-a", "thread-b"]) {
			expect(((await stub.getEmail(id)) as { read: boolean }).read).toBe(true);
		}
		const rows = await auditRows(stub);
		expect(rows[0]?.tool).toBe("mark_thread_read");
		expect(rows[0]?.source).toBe("scoped");

		const summarized = await scopedCall("summarize_thread", token, {
			threadId: "no-such-thread",
		});
		expect(summarized.status).toBe(400);
		expect(summarized.body.error).toBe("Thread not found");
	});
});

// ── Trash ───────────────────────────────────────────────────────────

describe("scoped trash tools", () => {
	it("restores one trashed message and audits it", async () => {
		const mailbox = "scoped-mobile-restore@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "restore-1", Folders.TRASH);
		const { token } = await mintToken(mailbox, ["read", "manage"]);

		const restored = await scopedCall("restore_email", token, {
			emailId: "restore-1",
		});
		expect(restored.status).toBe(200);
		expect((restored.body.result as { restored: number }).restored).toBe(1);
		const row = (await stub.getEmail("restore-1")) as { folder_id: string };
		expect(row.folder_id).toBe(Folders.INBOX);
		const rows = await auditRows(stub);
		expect(rows[0]?.tool).toBe("restore_email");
		expect(rows[0]?.source).toBe("scoped");
	});

	it("purges the Trash only, and audits the purge", async () => {
		const mailbox = "scoped-mobile-empty@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "keep-1");
		await seedEmail(stub, "purge-1", Folders.TRASH);
		await seedEmail(stub, "purge-2", Folders.TRASH);
		const { token } = await mintToken(mailbox, ["read", "manage"]);

		const emptied = await scopedCall("empty_trash", token);
		expect(emptied.status).toBe(200);
		expect((emptied.body.result as { purged: number }).purged).toBe(2);
		const remaining = (await stub.getEmails({})) as unknown[];
		expect(remaining).toHaveLength(1);
		const rows = await auditRows(stub);
		expect(rows[0]?.tool).toBe("empty_trash");
		expect(rows[0]?.source).toBe("scoped");
	});
});

// ── Scheduled sends ─────────────────────────────────────────────────

describe("scoped scheduled sends", () => {
	it("lists the queue, cancels a pending send, and queues its own", async () => {
		const mailbox = "scoped-mobile-scheduled@example.com";
		const stub = stubFor(mailbox);
		const { token } = await mintToken(mailbox, ["read", "send"]);

		const payload = serializeScheduledSendPayload({
			to: "later@example.org",
			from: mailbox,
			subject: "Later",
			html: "<p>hi</p>",
			text: "hi",
		});
		if ("error" in payload) throw new Error(payload.error);
		const seeded = await stub.scheduleSend({
			sendAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
			payload: payload.payload,
		});

		const listed = await scopedCall("list_scheduled_sends", token);
		expect(listed.status).toBe(200);
		expect(
			(listed.body.result as { sends: { id: string }[] }).sends.map((send) => send.id),
		).toContain(seeded.id);

		const cancelled = await scopedCall("cancel_scheduled_send", token, {
			scheduledSendId: seeded.id,
		});
		expect(cancelled.status).toBe(200);
		expect((cancelled.body.result as { status: string }).status).toBe("cancelled");

		// A short body skips the draft verifier, so this queues like the
		// route does — the row is stored, and nothing is sent here.
		const queued = await scopedCall("schedule_send", token, {
			to: "future@example.org",
			subject: "Queued hello",
			bodyHtml: "<p>hi</p>",
			sendAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
		});
		expect(queued.status).toBe(200);
		expect((queued.body.result as { status: string }).status).toBe("pending");
		// The seeded row (cancelled) and the queued one both stay recorded.
		expect(await stub.countScheduledSends()).toBe(2);

		const retried = await scopedCall("retry_scheduled_send", token, {
			scheduledSendId: "missing-id",
		});
		expect(retried.status).toBe(400);
		expect(retried.body.error).toBeTruthy();
	});

	it("refuses the queue to a token without the send scope", async () => {
		const mailbox = "scoped-mobile-send-scope@example.com";
		const { token } = await mintToken(mailbox, ["read"]);

		const queued = await scopedCall("schedule_send", token, {
			to: "future@example.org",
			subject: "Nope",
			bodyHtml: "<p>hi</p>",
			sendAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
		});
		expect(queued.status).toBe(403);
		expect(queued.body.error).toBe("This token lacks the send scope");
	});
});

// ── Sender policy ───────────────────────────────────────────────────

describe("scoped sender policy", () => {
	it("lists a blocked sender and removes the entry by address", async () => {
		const mailbox = "scoped-mobile-policy@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "policy-1", Folders.INBOX, {
			sender: "spammer@example.org",
		});
		const { token } = await mintToken(mailbox, ["read", "manage"]);

		const blocked = await scopedCall("set_sender_policy", token, {
			emailId: "policy-1",
			policy: "block",
		});
		expect(blocked.status).toBe(200);

		const listed = await scopedCall("get_sender_policy", token);
		expect(listed.status).toBe(200);
		const entries = listed.body.result as { address: string; policy: string }[];
		expect(entries.map((entry) => entry.address)).toContain("spammer@example.org");

		const removed = await scopedCall("remove_sender_policy", token, {
			address: "spammer@example.org",
		});
		expect(removed.status).toBe(200);
		expect((removed.body.result as { status: string }).status).toBe("removed");
		expect((await stub.listSenderPolicy()) as unknown[]).toHaveLength(0);
	});
});
