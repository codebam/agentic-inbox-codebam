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
 * App-level (`ain2`) tokens get the same treatment in their own describes:
 * the app branch of authenticateMcpRequest (a minted token binding its
 * scopes and no mailbox, a revoked token and a never-minted secret answering
 * the same one no-oracle 401), an app session's MCP surface (list_mailboxes
 * answering every mailbox, the scoped tools running against any mailbox,
 * search_all_mailboxes passing through, everything outside the app set
 * refused with the app message, a missing scope refused exactly as a mailbox
 * token refuses it), and forged markers unable to bind or widen an app
 * session either.
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
	formatAppAccessToken,
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

/** The app-token admin route the Global Settings card calls. */
const APP_TOKENS_URL = "http://example.com/api/v1/app-tokens";

/**
 * Mint one app-level access token through the real admin route — the same
 * POST /api/v1/app-tokens a client calls — so the tests authenticate the
 * exact wire format a 201 hands out, never a store-side shortcut.
 */
async function mintAppToken(scopes: AccessTokenScope[]) {
	const response = await SELF.fetch(APP_TOKENS_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "MCP app auth test", scopes }),
	});
	expect(response.status).toBe(201);
	const body = (await response.json()) as {
		token: string;
		record: { id: string };
	};
	expect(body.token.startsWith("ain2_")).toBe(true);
	return body;
}

/** Revoke one app token through the real admin route. */
async function revokeAppToken(tokenId: string) {
	const response = await SELF.fetch(`${APP_TOKENS_URL}/${tokenId}`, {
		method: "DELETE",
	});
	expect(response.status).toBe(200);
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
			kind: "mailbox",
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
			scopedSession: {
				kind: "mailbox",
				mailboxId: mailbox,
				scopes: ["read"],
				tokenId: record.id,
			},
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
			// The union is strict: no kind, an unknown kind, a mailbox
			// binding missing its mailboxId, and an app binding carrying
			// one (a value no reader may honor) are all junk.
			JSON.stringify({ scopes: ["read"], tokenId: "x" }),
			JSON.stringify({ kind: "admin", scopes: ["read"], tokenId: "x" }),
			JSON.stringify({ kind: "mailbox", scopes: ["read"], tokenId: "x" }),
			JSON.stringify({
				kind: "app",
				mailboxId: "a@b.c",
				scopes: ["read"],
				tokenId: "x",
			}),
			JSON.stringify({ kind: "app", scopes: ["read"], tokenId: "" }),
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

describe("app-level access tokens on /mcp", () => {
	it("accepts a minted app token and binds the session to its scopes — and to no mailbox", async () => {
		const { record, token } = await mintAppToken(["read", "draft"]);

		const result = await authenticateMcpRequest(`Bearer ${token}`, env);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// An app token has no Cloudflare identity: it is the binding, and
		// the binding deliberately carries no mailboxId.
		expect(result.identity).toBeUndefined();
		expect(result.binding).toEqual({
			kind: "app",
			scopes: ["read", "draft"],
			tokenId: record.id,
		});
	});

	it("answers the scoped surface's one 401 once the app token is revoked, with no cached success in between", async () => {
		const { record, token } = await mintAppToken(["read"]);

		// A verified success first: if this branch consulted the auth
		// cache, the revocation below would have to wait out a TTL.
		expect((await authenticateMcpRequest(`Bearer ${token}`, env)).ok).toBe(true);
		await revokeAppToken(record.id);

		const result = await authenticateMcpRequest(`Bearer ${token}`, env);
		expect(result).toMatchObject({
			ok: false,
			status: 401,
			error: "invalid_token",
			message: "Invalid or revoked access token",
		});
	});

	it("answers the same 401 for an app token whose secret was never minted", async () => {
		// The right shape, a secret no create ever stored: the same
		// refusal as a revoked token, so the endpoint is no oracle.
		const never = formatAppAccessToken("A".repeat(43));

		const result = await authenticateMcpRequest(`Bearer ${never}`, env);
		expect(result).toMatchObject({
			ok: false,
			status: 401,
			error: "invalid_token",
			message: "Invalid or revoked access token",
		});
	});

	it("only the exact app-token shape is app-scoped: an ain2 lookalike stays a Wrangler credential", async () => {
		// Near misses are not guessed at: a bearer that is not exactly the
		// `ain2_<43 chars>` wire format never reaches the app-token store,
		// and goes down the unchanged Cloudflare path.
		const result = await verifyWranglerCredential("ain2_zz_lookalike");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.binding).toBeUndefined();
	});
});

describe("an app session's MCP surface", () => {
	it("completes the handshake and answers list_mailboxes with every mailbox, while the mailbox-bound token still answers one", async () => {
		const mailbox = "mcp-app-all@example.com";
		const other = "mcp-app-other@example.com";
		await registerMailbox(mailbox);
		await registerMailbox(other);

		const { token: appToken } = await mintAppToken(["read"]);
		const appDriver = scopedDriver(await propsForToken(appToken));
		const appSession = await openSession(appDriver);
		const appAnswer = await callTool(appDriver, appSession, "list_mailboxes", {});
		expect(appAnswer.isError).toBe(false);
		// Every mailbox is present: this test's two and whatever other
		// tests seeded before it (the pool shares one storage bucket).
		const appIds = (JSON.parse(appAnswer.text) as { id: string }[]).map(
			(row) => row.id,
		);
		expect(appIds).toContain(mailbox);
		expect(appIds).toContain(other);

		const { token: scopedToken } = await mintAccessToken(mailbox, ["read"]);
		const mailboxDriver = scopedDriver(await propsForToken(scopedToken));
		const mailboxSession = await openSession(mailboxDriver);
		const mailboxAnswer = await callTool(
			mailboxDriver,
			mailboxSession,
			"list_mailboxes",
			{},
		);
		expect(JSON.parse(mailboxAnswer.text)).toEqual([{ id: mailbox, email: mailbox }]);
	});

	it("runs a scoped tool against any mailbox, while the mailbox-bound token still refuses another", async () => {
		const bound = "mcp-app-bound@example.com";
		const other = "mcp-app-target@example.com";
		await registerMailbox(bound);
		await registerMailbox(other);
		await seedEmail(other, "app-target-1", "App reaches this mailbox");

		const { token: appToken } = await mintAppToken(["read"]);
		const appDriver = scopedDriver(await propsForToken(appToken));
		const appSession = await openSession(appDriver);
		const appAnswer = await callTool(appDriver, appSession, "list_emails", {
			mailboxId: other,
		});
		expect(appAnswer.isError).toBe(false);
		expect(appAnswer.text).toContain("App reaches this mailbox");

		const { token: scopedToken } = await mintAccessToken(bound, ["read"]);
		const mailboxDriver = scopedDriver(await propsForToken(scopedToken));
		const mailboxSession = await openSession(mailboxDriver);
		const refused = await callTool(mailboxDriver, mailboxSession, "list_emails", {
			mailboxId: other,
		});
		expect(refused.isError).toBe(true);
		expect(errorOf(refused)).toContain(`bound to mailbox "${bound}"`);
	});

	it("passes search_all_mailboxes through to the deployment-wide handler", async () => {
		const mailbox = "mcp-app-search-all@example.com";
		await registerMailbox(mailbox);
		await seedEmail(mailbox, "app-search-1", "App search across mailboxes");

		const { token } = await mintAppToken(["read"]);
		const driver = scopedDriver(await propsForToken(token));
		const session = await openSession(driver);
		const answer = await callTool(driver, session, "search_all_mailboxes", {
			query: "across mailboxes",
		});
		expect(answer.isError).toBe(false);
		expect(answer.text).toContain("App search across mailboxes");
	});

	it("refuses every tool outside the app set, naming the allowed set exactly", async () => {
		const mailbox = "mcp-app-closed@example.com";
		await registerMailbox(mailbox);
		const { token } = await mintAppToken(["read", "draft", "send"]);
		const driver = scopedDriver(await propsForToken(token));
		const session = await openSession(driver);

		// The pinned app refusal: prose plus the full allowed set.
		const refused = await callTool(driver, session, "list_rules", {
			mailboxId: mailbox,
		});
		expect(refused.isError).toBe(true);
		expect(errorOf(refused)).toBe(
			'App access tokens cannot use the "list_rules" tool. An app token reaches every mailbox and may only call: create_draft, discard_draft, draft_reply, get_attachment, get_email, get_thread, list_emails, list_mailboxes, search_all_mailboxes, search_emails, send_email, send_reply, update_draft.',
		);

		// Every other operator-only tool reads the same way. All three
		// scopes present, so only the tool set can be the reason.
		const calls: Record<string, Record<string, unknown>> = {
			delete_email: { mailboxId: mailbox, emailId: "missing" },
			undo_action: { mailboxId: mailbox, actionId: "missing" },
			list_snoozed: { mailboxId: mailbox },
			search_contacts: { mailboxId: mailbox },
		};
		for (const [name, args] of Object.entries(calls)) {
			const answer = await callTool(driver, session, name, args);
			expect(answer.isError).toBe(true);
			expect(errorOf(answer)).toContain(
				`App access tokens cannot use the "${name}" tool`,
			);
			expect(errorOf(answer)).toContain("An app token reaches every mailbox");
		}
	});

	it("refuses a tool the app token's scopes do not reach, exactly as a mailbox token does", async () => {
		const mailbox = "mcp-app-scope@example.com";
		await registerMailbox(mailbox);

		const { token: appToken } = await mintAppToken(["read"]);
		const appDriver = scopedDriver(await propsForToken(appToken));
		const appSession = await openSession(appDriver);
		const draftRefusal = await callTool(appDriver, appSession, "create_draft", {
			mailboxId: mailbox,
			subject: "Not allowed",
			bodyHtml: "<p>hi</p>",
		});
		expect(draftRefusal.isError).toBe(true);
		expect(errorOf(draftRefusal)).toContain("lacks the draft scope");

		const { token: scopedToken } = await mintAccessToken(mailbox, ["read"]);
		const mailboxDriver = scopedDriver(await propsForToken(scopedToken));
		const mailboxSession = await openSession(mailboxDriver);

		const sendArgs = {
			mailboxId: mailbox,
			to: "someone@example.org",
			subject: "Not allowed",
			bodyHtml: "<p>no</p>",
		};
		const appAnswer = await callTool(appDriver, appSession, "send_email", sendArgs);
		const mailboxAnswer = await callTool(
			mailboxDriver,
			mailboxSession,
			"send_email",
			sendArgs,
		);
		expect(appAnswer.isError).toBe(true);
		expect(mailboxAnswer.isError).toBe(true);
		// The identical wording either way: the scope check does not
		// distinguish the token kind.
		expect(errorOf(appAnswer)).toBe(
			'This token lacks the send scope, which "send_email" requires.',
		);
		expect(errorOf(appAnswer)).toBe(errorOf(mailboxAnswer));
	});
});

describe("forged markers cannot escalate an app session", () => {
	it("cannot give an unauthenticated /mcp session an app binding", async () => {
		const mailbox = "mcp-app-forge-bound@example.com";
		const other = "mcp-app-forge-other@example.com";
		await registerMailbox(mailbox);
		await registerMailbox(other);

		// A forged app marker on the session's very first request. If the
		// middleware did not delete the client's copy, this read-scoped
		// session would refuse list_rules with the app message; unbound,
		// it is the full operator surface.
		const forged = JSON.stringify({
			kind: "app",
			scopes: ["read"],
			tokenId: "forged",
		});
		const session = await openSession(selfDriver, {
			[MCP_SESSION_HEADER]: forged,
		});

		const listed = await callTool(selfDriver, session, "list_mailboxes", {});
		expect(listed.isError).toBe(false);
		const ids = (JSON.parse(listed.text) as { id: string }[]).map((row) => row.id);
		expect(ids).toContain(mailbox);
		expect(ids).toContain(other);

		const rules = await callTool(selfDriver, session, "list_rules", {
			mailboxId: mailbox,
		});
		expect(rules.isError).toBe(false);
	});

	it("cannot widen an app session with a marker claiming more scopes or a mailbox", async () => {
		const mailbox = "mcp-app-forge-scoped@example.com";
		const other = "mcp-app-forge-widened@example.com";
		await registerMailbox(mailbox);
		await registerMailbox(other);
		const { token } = await mintAppToken(["read"]);
		const driver = scopedDriver(await propsForToken(token));
		const session = await openSession(driver);

		const forged = JSON.stringify({
			kind: "app",
			scopes: ["read", "draft", "send"],
			tokenId: "forged",
		});

		// Every further request carries the forgery, through the real
		// middleware (which deletes it) and the real route.
		const refusedScope = await callTool(
			selfDriver,
			session,
			"create_draft",
			{ mailboxId: mailbox, subject: "Widened?", bodyHtml: "<p>no</p>" },
			{ [MCP_SESSION_HEADER]: forged },
		);
		expect(refusedScope.isError).toBe(true);
		expect(errorOf(refusedScope)).toContain("lacks the draft scope");

		const refusedTool = await callTool(
			selfDriver,
			session,
			"list_rules",
			{ mailboxId: mailbox },
			{ [MCP_SESSION_HEADER]: forged },
		);
		expect(refusedTool.isError).toBe(true);
		expect(errorOf(refusedTool)).toContain(
			'App access tokens cannot use the "list_rules" tool',
		);

		// A forged mailbox binding cannot narrow the app session either:
		// list_mailboxes still answers the whole deployment.
		const narrowed = await callTool(
			selfDriver,
			session,
			"list_mailboxes",
			{},
			{
				[MCP_SESSION_HEADER]: JSON.stringify({
					kind: "mailbox",
					mailboxId: other,
					scopes: ["read"],
					tokenId: "forged",
				}),
			},
		);
		expect(narrowed.isError).toBe(false);
		const narrowedIds = (JSON.parse(narrowed.text) as { id: string }[]).map(
			(row) => row.id,
		);
		expect(narrowedIds).toContain(mailbox);
		expect(narrowedIds).toContain(other);
	});
});
