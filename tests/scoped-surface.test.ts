// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Scoped automation surface tests (`POST /api/v1/scoped/<tool>`).
 *
 * Covers the frozen contract of workers/lib/scoped-surface.ts: bearer
 * authentication with per-mailbox access tokens minted through the admin
 * routes, the per-tool scope matrix, the single no-oracle 401, the request
 * refusals (mailboxId, unknown tool, malformed JSON), the guarded send path
 * and the scoped rows in the mailbox audit log.
 *
 * The pool has no Cloudflare Access layer, so the middleware exemption in
 * workers/app.ts cannot be exercised here — the deploy's live probe verifies
 * it instead.
 */

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import {
	formatAccessToken,
	type AccessTokenRecord,
} from "../shared/access-tokens";
import { setToolSendEmailSenderFactory } from "../workers/lib/tools";
import type { SendEmailParams } from "../workers/email-sender";

type Stub = ReturnType<typeof stubFor>;

/** The JSON answer of one scoped call, plus the 401 challenge header. */
interface ScopedAnswer {
	status: number;
	body: { ok?: boolean; result?: unknown; error?: string };
	wwwAuthenticate: string | null;
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

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

/** Register the mailbox record the admin routes check before routing. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
}

/** Seed one stored message. */
async function seedEmail(
	stub: Stub,
	id: string,
	folder: string = Folders.INBOX,
) {
	await stub.createEmail(
		folder,
		{
			id,
			subject: `Subject ${id}`,
			sender: "sender@example.org",
			recipient: "scoped-surface@example.com",
			date: new Date().toISOString(),
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: id,
		},
		[],
	);
}

/** Mint one access token through the admin route and keep its plaintext. */
async function mintToken(
	mailbox: string,
	scopes: string[],
	name = "Scoped test token",
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
	return (await response.json()) as {
		token: string;
		record: AccessTokenRecord;
	};
}

/** Revoke one access token through the admin route; answers the status. */
async function revokeToken(mailbox: string, id: string): Promise<number> {
	const response = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/access-tokens/${id}`,
		{ method: "DELETE" },
	);
	return response.status;
}

/** POST one scoped call with the raw header value and body text a test needs. */
async function scopedPost(
	tool: string,
	init: { authorization?: string; body?: string } = {},
): Promise<ScopedAnswer> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (init.authorization !== undefined) {
		headers["authorization"] = init.authorization;
	}
	const response = await SELF.fetch(
		`http://example.com/api/v1/scoped/${tool}`,
		{
			method: "POST",
			headers,
			body: init.body ?? "{}",
		},
	);
	return {
		status: response.status,
		body: (await response.json()) as ScopedAnswer["body"],
		wwwAuthenticate: response.headers.get("www-authenticate"),
	};
}

/** POST one scoped call as a token holder. */
async function scopedCall(
	tool: string,
	token: string,
	body: unknown = {},
): Promise<ScopedAnswer> {
	return scopedPost(tool, {
		authorization: `Bearer ${token}`,
		body: JSON.stringify(body),
	});
}

/** A sender that records what it was asked to deliver. */
function fakeSender() {
	const sent: SendEmailParams[] = [];
	const sender = {
		send: async (params: SendEmailParams) => {
			sent.push(params);
			return { messageId: `fake-${sent.length}` };
		},
	};
	return { sender, sent };
}

/** The mailbox's audit rows, newest first. */
async function auditRows(stub: Stub): Promise<AuditRow[]> {
	return (await stub.listAgentActions(50)) as unknown as AuditRow[];
}

/** A syntactically valid 43-character base64url secret no token was minted with. */
const WRONG_SECRET = "B".repeat(43);

// ── Reads ──────────────────────────────────────────────────────────

describe("scoped surface reads", () => {
	it("lists and reads only the token's mailbox, never another one", async () => {
		const mailbox = "scoped-read@example.com";
		const other = "scoped-read-other@example.com";
		await seedEmail(stubFor(mailbox), "scoped-read-1");
		await seedEmail(stubFor(other), "scoped-read-other-1");
		const { token } = await mintToken(mailbox, ["read"]);

		const answer = await scopedCall("list_emails", token);
		expect(answer.status).toBe(200);
		expect(answer.body.ok).toBe(true);
		const rows = answer.body.result as { id: string; subject: string }[];
		expect(rows.map((row) => row.id)).toEqual(["scoped-read-1"]);
		expect(rows[0]?.subject).toBe("Subject scoped-read-1");

		// The token is bound to one mailbox: the other mailbox's message is
		// unreachable, and its id never appears in the answer.
		expect(JSON.stringify(answer.body.result)).not.toContain(
			"scoped-read-other-1",
		);

		// The same token reads one message by id.
		const one = await scopedCall("get_email", token, {
			emailId: "scoped-read-1",
		});
		expect(one.status).toBe(200);
		expect((one.body.result as { id: string }).id).toBe("scoped-read-1");
	});
});

// ── Scopes ─────────────────────────────────────────────────────────

describe("scoped surface scopes", () => {
	it("refuses a tool the token's scopes do not cover, naming the scope", async () => {
		const mailbox = "scoped-scopes@example.com";
		const { token: readToken } = await mintToken(mailbox, ["read"], "Read token");
		const { token: draftToken } = await mintToken(
			mailbox,
			["draft"],
			"Draft token",
		);

		const denied = await scopedCall("create_draft", readToken, {
			to: "recipient@example.org",
			subject: "Nope",
			bodyHtml: "<p>Nope</p>",
		});
		expect(denied.status).toBe(403);
		expect(denied.body.error).toMatch(/lacks the draft scope/);

		const deniedSend = await scopedCall("send_email", draftToken, {
			to: "recipient@example.org",
			subject: "Nope",
			bodyHtml: "<p>Nope</p>",
		});
		expect(deniedSend.status).toBe(403);
		expect(deniedSend.body.error).toMatch(/lacks the send scope/);

		// The read token still reads: the refusal is per tool, not per token.
		const allowed = await scopedCall("list_emails", readToken);
		expect(allowed.status).toBe(200);
		expect(allowed.body.ok).toBe(true);
	});
});

// ── Authentication ─────────────────────────────────────────────────

describe("scoped surface authentication", () => {
	it("answers one indistinguishable 401 for every failure", async () => {
		const mailbox = "scoped-auth@example.com";
		const { token, record } = await mintToken(mailbox, ["read"]);
		const wrongSecret = formatAccessToken(mailbox, WRONG_SECRET);

		const missing = await scopedPost("list_emails");
		expect(missing.status).toBe(401);
		expect(missing.wwwAuthenticate).toBe("Bearer");

		const otherScheme = await scopedPost("list_emails", {
			authorization: `Basic ${token}`,
		});
		expect(otherScheme.status).toBe(401);

		const garbage = await scopedPost("list_emails", {
			authorization: "Bearer not-a-token",
		});
		expect(garbage.status).toBe(401);

		// A well-formed token whose secret was never minted for this mailbox
		// reads exactly like garbage.
		const nearMiss = await scopedPost("list_emails", {
			authorization: `Bearer ${wrongSecret}`,
		});
		expect(nearMiss.status).toBe(401);

		// A revoked token stops resolving immediately.
		expect(await revokeToken(mailbox, record.id)).toBe(200);
		const revoked = await scopedPost("list_emails", {
			authorization: `Bearer ${token}`,
		});
		expect(revoked.status).toBe(401);

		// No oracle: every failure answers the identical body and challenge.
		for (const answer of [missing, otherScheme, garbage, nearMiss, revoked]) {
			expect(answer.body).toEqual({ error: "Invalid or revoked access token" });
			expect(answer.wwwAuthenticate).toBe("Bearer");
		}
	});
});

// ── Refusals ───────────────────────────────────────────────────────

describe("scoped surface refusals", () => {
	it("refuses a mailboxId body, an unknown tool and malformed JSON", async () => {
		const mailbox = "scoped-refusals@example.com";
		const { token } = await mintToken(mailbox, ["read"]);

		const bound = await scopedCall("list_emails", token, {
			mailboxId: "other@example.com",
		});
		expect(bound.status).toBe(400);
		expect(bound.body.error).toBe(
			"The scoped surface is bound to one mailbox; mailboxId is not accepted.",
		);

		// The unknown-tool answer names the tool and nothing else of the
		// request — even a body that also carries a mailboxId.
		const unknown = await scopedCall("delete_everything", token, {
			mailboxId: "other@example.com",
		});
		expect(unknown.status).toBe(404);
		expect(unknown.body).toEqual({ error: "Unknown tool: delete_everything" });

		const malformed = await scopedPost("list_emails", {
			authorization: `Bearer ${token}`,
			body: "{not json",
		});
		expect(malformed.status).toBe(400);
		expect(malformed.body.error).toBe("Invalid request: malformed JSON body");
	});
});

// ── The send guard ─────────────────────────────────────────────────

describe("scoped surface send guard", () => {
	it("sends a short body and refuses a body the verifier cannot pass", async () => {
		const mailbox = "scoped-send@example.com";
		const { token } = await mintToken(mailbox, ["send"]);
		const { sender, sent } = fakeSender();
		setToolSendEmailSenderFactory(() => sender);
		try {
			// Under 20 characters of reply text, verifyDraft skips the model
			// call and the send goes out through the injected sender.
			const short = await scopedCall("send_email", token, {
				to: "recipient@example.org",
				subject: "Short body",
				bodyHtml: "<p>hi</p>",
			});
			expect(short.status).toBe(200);
			expect(short.body.ok).toBe(true);
			expect(sent).toHaveLength(1);
			expect(sent[0]).toMatchObject({
				to: "recipient@example.org",
				from: mailbox,
				subject: "Short body",
				html: "<p>hi</p>",
			});

			// Over 20 characters reaches verifyDraft. The pool's AI binding
			// cannot run, so the verifier fails and the guard refuses the send
			// (fail closed) — the same condition tests/scheduled-sends.test.ts
			// covers for the queue's fire path.
			const long = await scopedCall("send_email", token, {
				to: "recipient@example.org",
				subject: "Long body",
				bodyHtml: "<p>This body is comfortably longer than twenty characters.</p>",
			});
			expect(long.status).toBe(400);
			expect(long.body.error).toContain("Draft verification failed");
			expect(long.body.error).toContain("refusing to send unverified content");
			expect(sent).toHaveLength(1);
		} finally {
			setToolSendEmailSenderFactory(null);
		}
	});

	it("keeps the same guard on the reply path", async () => {
		const mailbox = "scoped-send-reply@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "scoped-send-reply-1");
		const { token } = await mintToken(mailbox, ["send"]);

		// The reply path runs the verifier before the send binding, so a long
		// body is refused with no delivery attempt at all.
		const answer = await scopedCall("send_reply", token, {
			originalEmailId: "scoped-send-reply-1",
			to: "recipient@example.org",
			subject: "Re: Subject scoped-send-reply-1",
			bodyHtml: "<p>This reply is comfortably longer than twenty characters.</p>",
		});
		expect(answer.status).toBe(400);
		expect(answer.body.error).toContain("refusing to send unverified content");

		// Nothing was stored in Sent: the refusal happened before delivery.
		const sentRows = await stub.getEmails({ folder: Folders.SENT });
		expect(sentRows).toHaveLength(0);
	});
});

// ── Audit ──────────────────────────────────────────────────────────

describe("scoped surface audit", () => {
	it("records a scoped mutation with its scoped source and tool name", async () => {
		const mailbox = "scoped-audit@example.com";
		const stub = stubFor(mailbox);
		const { token } = await mintToken(mailbox, ["read", "draft"]);

		const created = await scopedCall("create_draft", token, {
			to: "recipient@example.org",
			subject: "Scoped draft",
			bodyHtml: "<p>Short draft</p>",
		});
		expect(created.status).toBe(200);
		const result = created.body.result as { draftId: string };

		// The draft itself landed in the mailbox's Drafts folder.
		const draft = (await stub.getEmail(result.draftId)) as {
			folder_id: string;
			subject: string;
		} | null;
		expect(draft?.folder_id).toBe(Folders.DRAFT);
		expect(draft?.subject).toBe("Scoped draft");

		const rows = await auditRows(stub);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.source).toBe("scoped");
		expect(rows[0]?.tool).toBe("create_draft");
		expect(rows[0]?.email_id).toBeNull();
		// Metadata only: the draft body never reaches the audit log.
		expect(rows[0]?.args).not.toContain("Short draft");
		expect(rows[0]?.args).toContain("Scoped draft");

		// A read call records nothing at all.
		const listed = await scopedCall("list_emails", token);
		expect(listed.status).toBe(200);
		expect(await auditRows(stub)).toHaveLength(1);
	});
});
