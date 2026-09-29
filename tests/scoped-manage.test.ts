// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Scoped surface: the manage tools and the surface-only unsubscribe tool.
 *
 * Covers the `manage` scope (`mark_email_read`, `star_email`, `move_email`,
 * `delete_email`, `snooze_email`, `unsnooze_email`, `set_sender_policy`), the
 * `unsubscribe_email` tool that only this surface carries (the /mcp gate must
 * never share it), the scope refusals, and the audit rows each mutating call
 * writes with source "scoped".
 */

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import type { AccessTokenRecord } from "../shared/access-tokens";
import { APP_ACCESS_TOKENS_KEY } from "../workers/lib/app-tokens";
import {
	SCOPED_SURFACE_ONLY_TOOL_SCOPES,
	SCOPED_TOOL_SCOPES,
} from "../workers/lib/scoped-surface";

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
	before_state: string | null;
	after_state: string | null;
}

/** One captured outbound request. */
interface CapturedCall {
	url: string;
	method: string;
	contentType: string | null;
	body: string;
}

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

/** Register the mailbox record the admin routes check before routing. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
}

/** Seed one stored message; `extra` may add fields such as the List-Unsubscribe headers. */
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
			recipient: "scoped-manage@example.com",
			date: new Date().toISOString(),
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
	name = "Scoped manage test token",
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

/** Mint one app-level token through the admin route and keep its plaintext. */
async function mintAppToken(
	scopes: string[],
	name = "Scoped manage app token",
): Promise<{ token: string; record: AccessTokenRecord }> {
	const response = await SELF.fetch("http://example.com/api/v1/app-tokens", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name, scopes }),
	});
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

/** Seed one message that advertises a one-click unsubscribe target. */
async function seedUnsubscribable(stub: Stub, id: string) {
	await seedEmail(stub, id, Folders.INBOX, {
		list_unsubscribe: "<https://sender.example/unsub?x=1>, <mailto:unsub@sender.example>",
		list_unsubscribe_post: "List-Unsubscribe=One-Click",
	});
}

// ── The map split (imports, no network) ─────────────────────────────

describe("scoped tool maps", () => {
	it("assigns the manage tools to the manage scope", () => {
		for (const tool of [
			"mark_email_read",
			"star_email",
			"move_email",
			"delete_email",
			"snooze_email",
			"unsnooze_email",
			"set_sender_policy",
		] as const) {
			expect(SCOPED_TOOL_SCOPES[tool]).toBe("manage");
		}
		expect(SCOPED_TOOL_SCOPES["unsubscribe_email"]).toBeUndefined();
	});

	it("keeps unsubscribe_email out of the map the /mcp gate reads", () => {
		expect(SCOPED_TOOL_SCOPES).not.toHaveProperty("unsubscribe_email");
		expect(SCOPED_SURFACE_ONLY_TOOL_SCOPES).toHaveProperty(
			"unsubscribe_email",
			"send",
		);
	});
});

// ── Manage scope: state changes ─────────────────────────────────────

describe("scoped manage tools", () => {
	it("moves a message and records the audit row", async () => {
		const mailbox = "scoped-manage-move@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "manage-move-1");
		const { token } = await mintToken(mailbox, ["read", "manage"]);

		const answer = await scopedCall("move_email", token, {
			emailId: "manage-move-1",
			folderId: "archive",
		});
		expect(answer.status).toBe(200);
		expect((answer.body.result as { status: string }).status).toBe("moved");

		const row = (await stub.getEmail("manage-move-1")) as { folder_id: string };
		expect(row.folder_id).toBe("archive");

		const rows = await auditRows(stub);
		expect(rows[0]?.source).toBe("scoped");
		expect(rows[0]?.tool).toBe("move_email");
		expect(rows[0]?.email_id).toBe("manage-move-1");
		expect(rows[0]?.before_state ?? "").toContain("inbox");
	});

	it("sets the read and starred state", async () => {
		const mailbox = "scoped-manage-state@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "manage-state-1");
		const { token } = await mintToken(mailbox, ["read", "manage"]);

		const marked = await scopedCall("mark_email_read", token, {
			emailId: "manage-state-1",
			read: false,
		});
		expect(marked.status).toBe(200);
		const starred = await scopedCall("star_email", token, {
			emailId: "manage-state-1",
			starred: true,
		});
		expect(starred.status).toBe(200);

		const row = (await stub.getEmail("manage-state-1")) as {
			read: boolean;
			starred: boolean;
		};
		expect(row.read).toBe(false);
		expect(row.starred).toBe(true);

		const rows = await auditRows(stub);
		expect(rows.map((audit) => audit.tool)).toEqual([
			"star_email",
			"mark_email_read",
		]);
		for (const audit of rows) {
			expect(audit.source).toBe("scoped");
			expect(audit.before_state).not.toBeNull();
		}
	});

	it("deletes through Trash, then permanently", async () => {
		const mailbox = "scoped-manage-delete@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "manage-delete-1");
		const { token } = await mintToken(mailbox, ["read", "manage"]);

		const trashed = await scopedCall("delete_email", token, {
			emailId: "manage-delete-1",
		});
		expect(trashed.status).toBe(200);
		expect((trashed.body.result as { status: string }).status).toBe("trashed");
		expect(
			((await stub.getEmail("manage-delete-1")) as { folder_id: string }).folder_id,
		).toBe("trash");

		const again = await scopedCall("delete_email", token, {
			emailId: "manage-delete-1",
		});
		expect((again.body.result as { status: string }).status).toBe(
			"already_in_trash",
		);

		const purged = await scopedCall("delete_email", token, {
			emailId: "manage-delete-1",
			permanent: true,
		});
		expect((purged.body.result as { status: string }).status).toBe(
			"deleted_permanently",
		);
		expect(await stub.getEmail("manage-delete-1")).toBeNull();
	});

	it("snoozes a message and wakes it again", async () => {
		const mailbox = "scoped-manage-snooze@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "manage-snooze-1");
		const { token } = await mintToken(mailbox, ["read", "manage"]);

		const snoozed = await scopedCall("snooze_email", token, {
			emailId: "manage-snooze-1",
			until: "1h",
		});
		expect(snoozed.status).toBe(200);
		expect(
			((await stub.getEmail("manage-snooze-1")) as { folder_id: string }).folder_id,
		).toBe(Folders.SNOOZED);

		const woken = await scopedCall("unsnooze_email", token, {
			emailId: "manage-snooze-1",
		});
		expect(woken.status).toBe(200);
		expect(
			((await stub.getEmail("manage-snooze-1")) as { folder_id: string }).folder_id,
		).toBe(Folders.INBOX);
	});

	it("records a sender policy decision", async () => {
		const mailbox = "scoped-manage-policy@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "manage-policy-1");
		const { token } = await mintToken(mailbox, ["read", "manage"]);

		const blocked = await scopedCall("set_sender_policy", token, {
			emailId: "manage-policy-1",
			policy: "block",
		});
		expect(blocked.status).toBe(200);
		expect(
			((await stub.getEmail("manage-policy-1")) as { folder_id: string }).folder_id,
		).toBe(Folders.SPAM);

		const allowed = await scopedCall("set_sender_policy", token, {
			emailId: "manage-policy-1",
			policy: "allow",
		});
		expect(allowed.status).toBe(200);
		expect(
			((await stub.getEmail("manage-policy-1")) as { folder_id: string }).folder_id,
		).toBe(Folders.INBOX);

		// An unusable policy is refused before anything runs.
		const bogus = await scopedCall("set_sender_policy", token, {
			emailId: "manage-policy-1",
			policy: "maybe",
		});
		expect(bogus.status).toBe(400);
		expect(bogus.body.error).toContain('policy must be "allow" or "block"');
	});

	it("refuses every manage tool for a token without the manage scope", async () => {
		const mailbox = "scoped-manage-scope@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "manage-scope-1");
		const { token } = await mintToken(mailbox, ["read", "draft", "send"]);

		for (const [tool, args] of Object.entries({
			move_email: { emailId: "manage-scope-1", folderId: "archive" },
			delete_email: { emailId: "manage-scope-1" },
			mark_email_read: { emailId: "manage-scope-1", read: false },
			star_email: { emailId: "manage-scope-1", starred: true },
			snooze_email: { emailId: "manage-scope-1", until: "1h" },
			unsnooze_email: { emailId: "manage-scope-1" },
			set_sender_policy: { emailId: "manage-scope-1", policy: "block" },
		})) {
			const answer = await scopedCall(tool, token, args);
			expect(answer.status).toBe(403);
			expect(answer.body.error).toBe(
				"This token lacks the manage scope",
			);
		}

		// Nothing changed.
		const row = (await stub.getEmail("manage-scope-1")) as { folder_id: string };
		expect(row.folder_id).toBe(Folders.INBOX);
	});

	it("runs the manage tools for an app token with a per-call mailboxId", async () => {
		const mailbox = "scoped-manage-app@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "manage-app-1");
		await env.BUCKET.delete(APP_ACCESS_TOKENS_KEY);
		const { token } = await mintAppToken(["read", "manage"]);

		const missing = await scopedCall("move_email", token, {
			emailId: "manage-app-1",
			folderId: "archive",
		});
		expect(missing.status).toBe(400);
		expect(missing.body.error).toContain("reaches every mailbox");

		const moved = await scopedCall("move_email", token, {
			mailboxId: mailbox,
			emailId: "manage-app-1",
			folderId: "archive",
		});
		expect(moved.status).toBe(200);
		expect(
			((await stub.getEmail("manage-app-1")) as { folder_id: string }).folder_id,
		).toBe("archive");
	});
});

// ── unsubscribe_email (surface-only) ────────────────────────────────

describe("scoped unsubscribe_email", () => {
	const originalFetch = globalThis.fetch;
	const calls: CapturedCall[] = [];

	afterEach(() => {
		globalThis.fetch = originalFetch;
		calls.length = 0;
	});

	/** Capture outbound requests the way the SSRF guard will send them. */
	function captureFetch(): void {
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const request = new Request(input as RequestInfo, init);
			calls.push({
				url: request.url,
				method: request.method,
				contentType: request.headers.get("content-type"),
				body: await request.clone().text(),
			});
			return new Response("", { status: 200 });
		}) as typeof fetch;
	}

	it("posts the one-click body through the guard and stamps unsubscribed_at", async () => {
		const mailbox = "scoped-unsub@example.com";
		const stub = stubFor(mailbox);
		await seedUnsubscribable(stub, "unsub-1");
		const { token } = await mintToken(mailbox, ["read", "send"]);
		captureFetch();

		const answer = await scopedCall("unsubscribe_email", token, {
			emailId: "unsub-1",
		});
		expect(answer.status).toBe(200);
		const result = answer.body.result as { status: string; unsubscribedAt: string };
		expect(result.status).toBe("unsubscribed");
		expect(result.unsubscribedAt).toBeTruthy();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://sender.example/unsub?x=1");
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.body).toBe("List-Unsubscribe=One-Click");
		expect(calls[0]?.contentType ?? "").toContain(
			"application/x-www-form-urlencoded",
		);

		const row = (await stub.getEmail("unsub-1")) as { unsubscribed_at: string | null };
		expect(row.unsubscribed_at).toBeTruthy();

		const rows = await auditRows(stub);
		expect(rows[0]?.tool).toBe("unsubscribe_email");
		expect(rows[0]?.source).toBe("scoped");
	});

	it("refuses a message without a one-click target, and a token without the send scope", async () => {
		const mailbox = "scoped-unsub-refuse@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "unsub-plain-1");
		await seedUnsubscribable(stub, "unsub-target-1");
		captureFetch();

		const { token: reader } = await mintToken(mailbox, ["read"]);
		const noTargetCall = await scopedCall("unsubscribe_email", reader, {
			emailId: "unsub-plain-1",
		});
		expect(noTargetCall.status).toBe(403);
		expect(noTargetCall.body.error).toBe("This token lacks the send scope");

		const { token: sender } = await mintToken(mailbox, ["read", "send"]);
		const noTarget = await scopedCall("unsubscribe_email", sender, {
			emailId: "unsub-plain-1",
		});
		expect(noTarget.status).toBe(400);
		expect(noTarget.body.error).toBe(
			"This message has no one-click unsubscribe target",
		);

		// Neither refused call reached the sender's server.
		expect(calls).toHaveLength(0);
	});

	it("answers an upstream failure without stamping the row", async () => {
		const mailbox = "scoped-unsub-fail@example.com";
		const stub = stubFor(mailbox);
		await seedUnsubscribable(stub, "unsub-fail-1");
		const { token } = await mintToken(mailbox, ["read", "send"]);
		globalThis.fetch = (async () =>
			new Response("nope", { status: 500 })) as typeof fetch;

		const answer = await scopedCall("unsubscribe_email", token, {
			emailId: "unsub-fail-1",
		});
		expect(answer.status).toBe(400);
		expect(answer.body.error ?? "").toContain("Unsubscribe request failed:");

		const row = (await stub.getEmail("unsub-fail-1")) as {
			unsubscribed_at: string | null;
		};
		expect(row.unsubscribed_at).toBeNull();
	});
});
