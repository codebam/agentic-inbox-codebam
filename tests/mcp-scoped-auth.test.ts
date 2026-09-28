// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Scoped `/mcp` authentication tests (workers/lib/mcp-auth.ts and the
 * enforcement in workers/mcp/index.ts).
 *
 * Covers, in order: the Settings access-token branch of
 * authenticateMcpRequest (a minted token authenticating and binding its
 * mailbox and scopes, a revoked token and a never-minted secret answering the
 * scoped surface's one no-oracle 401, and the Cloudflare-credential path
 * staying in place), the internal session marker the /mcp middleware carries
 * a verified binding in (a forged copy is dropped, a verified one replaces
 * it, junk never becomes a binding), and a scoped session's MCP surface
 * through the app's real fetch entry — the tools SCOPED_TOOL_SCOPES allows
 * gated by the scope it assigns, list_mailboxes answering the bound mailbox
 * alone, other tools, other mailboxes and forged markers refused.
 *
 * One thing the pool cannot run end to end, named rather than faked: the
 * /mcp middleware's auth branch is compiled out of a pool run
 * (`import.meta.env.DEV` is true), so a test request cannot *become* scoped
 * through the middleware. Every scoped session here is instead built from a
 * real token: authenticateMcpRequest verifies it, the middleware's own
 * strip/attach functions carry the binding, mcpSessionProps reads it back the
 * way the /mcp route does, and the answer is handed to the app's real fetch
 * entry as the request context's props — the exact value the middleware would
 * have set. The marker strip itself does run for real in these tests: it sits
 * in the middleware ahead of the DEV branch, so a forged marker is deleted on
 * every /mcp request either way.
 */

import { createExecutionContext, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	formatAccessToken,
	type AccessTokenScope,
} from "../shared/access-tokens";
import { Folders } from "../shared/folders";
import worker from "../workers/app";
import {
	MCP_SESSION_HEADER,
	authenticateMcpRequest,
	bindMcpSessionMarker,
	mcpSessionProps,
	stripMcpSessionMarker,
	type McpSessionProps,
} from "../workers/lib/mcp-auth";

const MCP_URL = "http://example.com/mcp";

/** Headers every MCP client sends: a JSON body, both answer types accepted. */
const MCP_HEADERS = {
	"content-type": "application/json",
	accept: "application/json, text/event-stream",
};

/** The initialize message the other MCP suites open sessions with. */
const INITIALIZE = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "mcp-scoped-auth-test", version: "1" },
	},
};

/** One request driver: the app's real fetch entry, or the pool's SELF. */
type Driver = (request: Request) => Promise<Response>;

const selfDriver: Driver = (request) => SELF.fetch(request);

/**
 * The app's real fetch entry as a scoped session sees it: every request
 * carries the props the /mcp middleware would have set from the verified
 * token's record.
 */
function scopedDriver(props: McpSessionProps | undefined): Driver {
	return (request) => {
		const ctx = createExecutionContext();
		// The global type marks ctx.props readonly because production only
		// ever receives it from the platform; the assignment sticks at
		// runtime, which is how the /mcp middleware hands a verified scoped
		// session to the handler.
		(ctx as { props: unknown }).props = props;
		return worker.fetch(request, env, ctx);
	};
}

/** The messages carried in one SSE answer. */
function parseSse(text: string): Record<string, unknown>[] {
	return text
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
}

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

/** Register a mailbox record in R2 (list_mailboxes and verifyMailbox read it). */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(
		`mailboxes/${mailbox}.json`,
		JSON.stringify({ categorization: { enabled: false } }),
	);
}

/** Mint one Settings access token through the mailbox's Durable Object. */
async function mintAccessToken(mailbox: string, scopes: AccessTokenScope[]) {
	const created = await stubFor(mailbox).createAccessToken(mailbox, {
		name: "MCP scoped auth test",
		scopes,
	});
	if (!created) throw new Error(`could not mint a token for ${mailbox}`);
	return created;
}

/** Seed one stored message. */
async function seedEmail(mailbox: string, id: string, subject: string) {
	await stubFor(mailbox).createEmail(
		Folders.INBOX,
		{
			id,
			subject,
			sender: "sender@example.org",
			recipient: mailbox,
			date: new Date().toISOString(),
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: id,
		},
		[],
	);
}

/** A fetcher standing in for the Cloudflare API's zone lookup. */
function zoneFetcher() {
	return () =>
		Promise.resolve(
			new Response(
				JSON.stringify({
					success: true,
					result: [
						{ name: "example.com", account: { id: "acct-1", name: "Example" } },
					],
				}),
				{ headers: { "content-type": "application/json" } },
			),
		);
}

/** Verify a wrangler-style credential without touching the network. */
function verifyWranglerCredential(credential = "a-wrangler-style-credential") {
	return authenticateMcpRequest(`Bearer ${credential}`, env, {
		fetcher: zoneFetcher() as unknown as typeof fetch,
	});
}

/**
 * The session props a verified /mcp request carries: authenticate the token
 * the way the middleware does, run a request carrying an optional forged
 * marker through the middleware's own binding functions, and read the props
 * back the way the /mcp route does. Undefined when the token did not verify.
 */
async function propsForToken(
	token: string,
	forgedMarker?: string,
): Promise<McpSessionProps | undefined> {
	const request = new Request(MCP_URL, {
		method: "POST",
		headers: {
			...MCP_HEADERS,
			...(forgedMarker === undefined
				? {}
				: { [MCP_SESSION_HEADER]: forgedMarker }),
		},
		body: "{}",
	});
	const result = await authenticateMcpRequest(`Bearer ${token}`, env);
	return mcpSessionProps(bindMcpSessionMarker(request, result));
}

/** POST one JSON-RPC message and answer its SSE messages. */
async function post(
	driver: Driver,
	session: string | null,
	message: unknown,
	headers: Record<string, string> = {},
) {
	const response = await driver(
		new Request(MCP_URL, {
			method: "POST",
			headers: {
				...MCP_HEADERS,
				...(session === null ? {} : { "mcp-session-id": session }),
				...headers,
			},
			body: JSON.stringify(message),
		}),
	);
	return { response, messages: parseSse(await response.text()) };
}

/** Open one /mcp session and answer its id. */
async function openSession(
	driver: Driver,
	headers: Record<string, string> = {},
) {
	const { response } = await post(driver, null, INITIALIZE, headers);
	expect(response.status).toBe(200);
	const session = response.headers.get("mcp-session-id");
	if (session === null) throw new Error("the MCP handler answered no session id");
	await post(driver, session, {
		jsonrpc: "2.0",
		method: "notifications/initialized",
	});
	return session;
}

/** One tools/call answer: the isError flag and the text it carried. */
async function callTool(
	driver: Driver,
	session: string,
	name: string,
	args: Record<string, unknown>,
	headers: Record<string, string> = {},
) {
	const { response, messages } = await post(
		driver,
		session,
		{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
		headers,
	);
	expect(response.status).toBe(200);
	const result = messages.find((message) => "result" in message)?.["result"] as
		| { isError?: boolean; content?: { text?: string }[] }
		| undefined;
	if (result === undefined) {
		throw new Error(`no tool result in ${JSON.stringify(messages)}`);
	}
	return {
		isError: result.isError === true,
		text: (result.content ?? []).map((part) => part.text ?? "").join(""),
	};
}

/** The error message inside one tool answer. */
function errorOf(answer: { text: string }): string {
	return (JSON.parse(answer.text) as { error: string }).error;
}

describe("Settings access tokens on /mcp", () => {
	it("accepts a minted token and binds the session to its mailbox and scopes", async () => {
		const mailbox = "mcp-scoped-valid@example.com";
		await registerMailbox(mailbox);
		const { record, token } = await mintAccessToken(mailbox, ["read", "draft"]);

		const result = await authenticateMcpRequest(`Bearer ${token}`, env);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// A scoped token has no Cloudflare identity: it is the binding.
		expect(result.identity).toBeUndefined();
		expect(result.binding).toEqual({
			mailboxId: mailbox,
			scopes: ["read", "draft"],
			tokenId: record.id,
		});
	});

	it("answers the scoped surface's one 401 once the token is revoked", async () => {
		const mailbox = "mcp-scoped-revoked@example.com";
		const { record, token } = await mintAccessToken(mailbox, ["read"]);
		expect(await stubFor(mailbox).revokeAccessToken(record.id)).toBe(true);

		const result = await authenticateMcpRequest(`Bearer ${token}`, env);
		expect(result).toMatchObject({
			ok: false,
			status: 401,
			error: "invalid_token",
			message: "Invalid or revoked access token",
		});
	});

	it("answers the same 401 for a token whose secret was never minted", async () => {
		const mailbox = "mcp-scoped-never-minted@example.com";
		await registerMailbox(mailbox);
		// The right shape for this mailbox, a secret no create ever stored:
		// the same refusal as a revoked token, so the endpoint is no oracle.
		const never = formatAccessToken(mailbox, "A".repeat(43));

		const result = await authenticateMcpRequest(`Bearer ${never}`, env);
		expect(result).toMatchObject({
			ok: false,
			status: 401,
			error: "invalid_token",
			message: "Invalid or revoked access token",
		});
	});

	it("keeps the Cloudflare-credential path for a bearer that is not an access token", async () => {
		const result = await verifyWranglerCredential();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// A Wrangler credential is the full operator identity, never scoped.
		expect(result.identity?.authMethod).toBe("domain");
		expect(result.binding).toBeUndefined();
	});

	it("only the exact access-token shape is scoped: an ain1 lookalike stays a Wrangler credential", async () => {
		// Near misses are not guessed at: a bearer that is not exactly the
		// `ain1_<hex>_<43 chars>` wire format never reaches the mailbox
		// lookup, and goes down the unchanged Cloudflare path.
		const result = await verifyWranglerCredential("ain1_zz_lookalike");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.binding).toBeUndefined();
	});
});

describe("the internal session marker", () => {
	it("drops a forged marker and attaches nothing for a Cloudflare credential", async () => {
		const forged = JSON.stringify({
			mailboxId: "victim@example.com",
			scopes: ["read", "draft", "send"],
			tokenId: "forged",
		});
		const request = new Request(MCP_URL, {
			method: "POST",
			headers: { ...MCP_HEADERS, [MCP_SESSION_HEADER]: forged },
			body: "{}",
		});

		// The credential verifies — but it is not a scoped session, so no
		// marker survives and no binding comes out of it.
		const result = await verifyWranglerCredential();
		expect(result.ok).toBe(true);
		const bound = bindMcpSessionMarker(request, result);
		expect(bound.headers.get(MCP_SESSION_HEADER)).toBeNull();
		expect(mcpSessionProps(bound)).toBeUndefined();
		// The strip is the first thing the middleware does; it drops the
		// client's copy on its own (a fresh request: binding above consumed
		// the first one's body, exactly as the middleware's two passes do).
		const untouched = new Request(MCP_URL, {
			method: "POST",
			headers: { ...MCP_HEADERS, [MCP_SESSION_HEADER]: forged },
			body: "{}",
		});
		expect(stripMcpSessionMarker(untouched).headers.get(MCP_SESSION_HEADER)).toBeNull();
	});

	it("replaces a forged marker with the verified binding, never the client's copy", async () => {
		const mailbox = "mcp-scoped-marker@example.com";
		await registerMailbox(mailbox);
		const { record, token } = await mintAccessToken(mailbox, ["read"]);
		const forged = JSON.stringify({
			mailboxId: "someone-else@example.com",
			scopes: ["read", "draft", "send"],
			tokenId: "forged",
		});

		const props = await propsForToken(token, forged);
		expect(props).toEqual({
			scopedSession: { mailboxId: mailbox, scopes: ["read"], tokenId: record.id },
		});
	});

	it("ignores a marker that is not a binding the middleware could have written", () => {
		for (const junk of [
			"not json",
			"null",
			"{}",
			JSON.stringify({ mailboxId: "", scopes: ["read"], tokenId: "x" }),
			JSON.stringify({ mailboxId: "a@b.c", scopes: [], tokenId: "x" }),
			JSON.stringify({ mailboxId: "a@b.c", scopes: ["admin"], tokenId: "x" }),
			JSON.stringify({ mailboxId: "a@b.c", scopes: ["read"] }),
			JSON.stringify({ mailboxId: "a@b.c", scopes: ["read"], tokenId: 7 }),
		]) {
			const request = new Request(MCP_URL, {
				headers: { [MCP_SESSION_HEADER]: junk },
			});
			expect(mcpSessionProps(request)).toBeUndefined();
		}
	});
});

describe("a scoped session's MCP surface", () => {
	it("answers list_mailboxes with the bound mailbox alone", async () => {
		const mailbox = "mcp-scoped-bound@example.com";
		const other = "mcp-scoped-other@example.com";
		await registerMailbox(mailbox);
		await registerMailbox(other);
		const { token } = await mintAccessToken(mailbox, ["read"]);
		const driver = scopedDriver(await propsForToken(token));

		const session = await openSession(driver);
		const answer = await callTool(driver, session, "list_mailboxes", {});
		expect(answer.isError).toBe(false);
		expect(JSON.parse(answer.text)).toEqual([{ id: mailbox, email: mailbox }]);
	});

	it("runs a scoped tool the token's scope reaches, for its own mailbox", async () => {
		const mailbox = "mcp-scoped-read@example.com";
		await registerMailbox(mailbox);
		await seedEmail(mailbox, "scoped-1", "Scoped subject one");
		const { token } = await mintAccessToken(mailbox, ["read"]);
		const driver = scopedDriver(await propsForToken(token));

		const session = await openSession(driver);
		const answer = await callTool(driver, session, "list_emails", {
			mailboxId: mailbox,
		});
		expect(answer.isError).toBe(false);
		expect(answer.text).toContain("Scoped subject one");
	});

	it("refuses every tool outside the scoped set", async () => {
		const mailbox = "mcp-scoped-closed@example.com";
		await registerMailbox(mailbox);
		const { token } = await mintAccessToken(mailbox, ["read", "draft", "send"]);
		const driver = scopedDriver(await propsForToken(token));

		const session = await openSession(driver);
		// All three scopes present, so only the tool set can be the reason.
		const calls: Record<string, Record<string, unknown>> = {
			delete_email: { mailboxId: mailbox, emailId: "missing" },
			undo_action: { mailboxId: mailbox, actionId: "missing" },
			list_rules: { mailboxId: mailbox },
			list_snoozed: { mailboxId: mailbox },
			search_all_mailboxes: {},
		};
		for (const [name, args] of Object.entries(calls)) {
			const answer = await callTool(driver, session, name, args);
			expect(answer.isError).toBe(true);
			expect(errorOf(answer)).toContain(`cannot use the "${name}" tool`);
		}
	});

	it("refuses a scoped tool whose scope the token lacks", async () => {
		const mailbox = "mcp-scoped-scope@example.com";
		await registerMailbox(mailbox);
		const { token } = await mintAccessToken(mailbox, ["read"]);
		const driver = scopedDriver(await propsForToken(token));

		const session = await openSession(driver);
		const answer = await callTool(driver, session, "create_draft", {
			mailboxId: mailbox,
			subject: "Not allowed",
			bodyHtml: "<p>hi</p>",
		});
		expect(answer.isError).toBe(true);
		expect(errorOf(answer)).toContain("lacks the draft scope");
	});

	it("refuses a call naming another mailbox", async () => {
		const mailbox = "mcp-scoped-self@example.com";
		const other = "mcp-scoped-target@example.com";
		await registerMailbox(mailbox);
		await registerMailbox(other);
		await seedEmail(other, "target-1", "Someone else's mail");
		const { token } = await mintAccessToken(mailbox, ["read"]);
		const driver = scopedDriver(await propsForToken(token));

		const session = await openSession(driver);
		const answer = await callTool(driver, session, "list_emails", {
			mailboxId: other,
		});
		expect(answer.isError).toBe(true);
		expect(errorOf(answer)).toContain(`bound to mailbox "${mailbox}"`);
		expect(errorOf(answer)).toContain(`cannot act on "${other}"`);
	});
});

describe("forged markers cannot escalate", () => {
	it("cannot give an unauthenticated /mcp session a scoped binding", async () => {
		const mailbox = "mcp-forge-bound@example.com";
		const other = "mcp-forge-other@example.com";
		await registerMailbox(mailbox);
		await registerMailbox(other);

		// The marker rides the session's very first request: if the
		// middleware did not delete the client's copy, this session would
		// come up bound and list_mailboxes would answer one mailbox.
		const forged = JSON.stringify({
			mailboxId: mailbox,
			scopes: ["read"],
			tokenId: "forged",
		});
		const session = await openSession(selfDriver, {
			[MCP_SESSION_HEADER]: forged,
		});

		const answer = await callTool(selfDriver, session, "list_mailboxes", {});
		expect(answer.isError).toBe(false);
		// The session is NOT bound: every registered mailbox is answered,
		// including ones this test never mentioned. A surviving marker would
		// have narrowed the answer to the forged mailbox alone.
		const ids = (JSON.parse(answer.text) as { id: string }[]).map((row) => row.id);
		expect(ids).toContain(mailbox);
		expect(ids).toContain(other);
	});

	it("cannot widen a scoped session with a marker claiming other scopes or a mailbox", async () => {
		const mailbox = "mcp-forge-scoped@example.com";
		const other = "mcp-forge-widened@example.com";
		await registerMailbox(mailbox);
		await registerMailbox(other);
		const { token } = await mintAccessToken(mailbox, ["read"]);
		const driver = scopedDriver(await propsForToken(token));

		const session = await openSession(driver);
		const forged = JSON.stringify({
			mailboxId: other,
			scopes: ["read", "draft", "send"],
			tokenId: "forged",
		});

		// Every further request carries the forgery, through the real
		// middleware (which deletes it) and the real route.
		const refusedTool = await callTool(
			selfDriver,
			session,
			"list_rules",
			{ mailboxId: mailbox },
			{ [MCP_SESSION_HEADER]: forged },
		);
		expect(refusedTool.isError).toBe(true);
		expect(errorOf(refusedTool)).toContain('cannot use the "list_rules" tool');

		const refusedMailbox = await callTool(
			selfDriver,
			session,
			"list_emails",
			{ mailboxId: other },
			{ [MCP_SESSION_HEADER]: forged },
		);
		expect(refusedMailbox.isError).toBe(true);
		expect(errorOf(refusedMailbox)).toContain(`bound to mailbox "${mailbox}"`);

		// And the binding itself never moved: list_mailboxes still answers
		// only the mailbox the token was minted for.
		const listed = await callTool(selfDriver, session, "list_mailboxes", {});
		expect(
			(JSON.parse(listed.text) as { id: string }[]).map((row) => row.id),
		).toEqual([mailbox]);
	});
});
