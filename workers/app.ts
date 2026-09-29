// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import type { Context } from "hono";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { createRequestHandler } from "react-router";
import { app as apiApp, receiveEmail } from "./index";
import { EmailMCP } from "./mcp";
import {
	authenticateMcpRequest,
	bindMcpSessionMarker,
	mcpSessionProps,
	stripMcpSessionMarker,
	type McpAuthFailure,
} from "./lib/mcp-auth";
import { sweepDueMail } from "./lib/mail-sweep";
import { DIGEST_CRON, sweepDigests } from "./lib/digest-sweep";
import { sweepImageProxyCache } from "./lib/image-proxy";
import { sweepTrash } from "./lib/trash-retention";
import { sweepAttachmentLinks } from "./lib/attachment-links";
import { sweepPendingUploads } from "./lib/pending-uploads";
import { isAiAgentEnabled, isMcpEnabled } from "../shared/agent-flags";
import type { Env } from "./types";

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	async () => {
		// The generated server-build module declares every ServerBuild field as a
		// required export, so the optional ones arrive as explicitly `undefined`
		// when unset. Under exactOptionalPropertyTypes an optional property must
		// be absent instead, so drop the ones that are unset.
		const { basename, unstable_getCriticalCss, allowedActionOrigins, ...build } =
			await import("virtual:react-router/server-build");
		return {
			...build,
			...(basename !== undefined ? { basename } : {}),
			...(unstable_getCriticalCss !== undefined
				? { unstable_getCriticalCss }
				: {}),
			...(allowedActionOrigins !== undefined
				? { allowedActionOrigins }
				: {}),
		};
	},
	import.meta.env.MODE,
);

function getAccessUrls(teamDomain: string) {
	const certsPath = "/cdn-cgi/access/certs";
	const teamUrl = new URL(teamDomain);
	const issuer = teamUrl.origin;
	const certsUrl = teamUrl.pathname.endsWith(certsPath)
		? teamUrl
		: new URL(certsPath, issuer);

	return { issuer, certsUrl };
}

const accessJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getAccessJwks(certsUrl: URL) {
	const key = certsUrl.toString();
	let jwks = accessJwks.get(key);
	if (!jwks) {
		jwks = createRemoteJWKSet(certsUrl);
		accessJwks.set(key, jwks);
	}
	return jwks;
}

/**
 * Validate a Cloudflare Access JWT. Used for the browser UI and as a fallback
 * for MCP clients that are already operating inside the Access boundary.
 */
async function verifyCloudflareAccess(env: Env, token: string): Promise<boolean> {
	if (!env.POLICY_AUD || !env.TEAM_DOMAIN) return false;

	try {
		const { issuer, certsUrl } = getAccessUrls(env.TEAM_DOMAIN);
		await jwtVerify(token, getAccessJwks(certsUrl), {
			issuer,
			audience: env.POLICY_AUD,
		});
		return true;
	} catch {
		return false;
	}
}

function isMcpPath(pathname: string) {
	return pathname === "/mcp" || pathname.startsWith("/mcp/");
}

/**
 * The scoped automation surface (workers/lib/scoped-surface.ts): token-
 * authenticated clients outside the Access boundary. Exactly this prefix is
 * exempt — nothing else that merely starts with the words.
 */
function isScopedPath(pathname: string) {
	return pathname === "/api/v1/scoped" || pathname.startsWith("/api/v1/scoped/");
}

/**
 * Public attachment download links (workers/lib/attachment-links.ts): the
 * token in the query string IS the capability, so these paths are opened by
 * recipients who have no Cloudflare Access session. Exactly this prefix is
 * exempt — nothing else outside it.
 */
function isPublicDownloadPath(pathname: string) {
	return pathname.startsWith("/api/v1/downloads/");
}

/**
 * Context of the top-level auth middleware. It is only mounted on "*" and
 * reads no route params, so the path type is pinned here rather than carrying
 * the router's inferred `any` input type into the auth helper.
 */
type AuthContext = Context<{ Bindings: Env }, "*">;

function mcpAuthErrorResponse(c: AuthContext, result: McpAuthFailure) {
	c.header("WWW-Authenticate", `Bearer realm="agentic-inbox-codebam-mcp", error="${result.error}"`);
	c.header("Access-Control-Allow-Origin", "*");
	c.header("Access-Control-Expose-Headers", "WWW-Authenticate");
	return c.json(
		{
			jsonrpc: "2.0",
			id: null,
			error: {
				code: -32001,
				message: result.message,
			},
		},
		result.status,
	);
}

// Main app that wraps the API and adds React Router fallback
const app = new Hono<{ Bindings: Env }>();

// Authentication middleware (production only).
//
// * `/mcp` is agent-facing and authenticates with a Wrangler credential via
//   `Authorization: Bearer <wrangler auth token>`. Cloudflare Access JWTs are
//   accepted as a fallback for clients already inside the Access boundary.
//   Operator-minted access tokens authenticate as well: a Settings token
//   (the `ain1` wire format) binds the session to its mailbox and scopes,
//   and an app-level token (the `ain2` wire format) reaches every mailbox
//   with its scopes. Neither is the multi-mailbox operator surface.
// * All other routes keep the original Cloudflare Access gate.
app.use("*", async (c: AuthContext, next) => {
	const pathname = new URL(c.req.url).pathname;

	// The internal scoped-session marker (workers/lib/mcp-auth.ts) is
	// deleted from every /mcp request here — in development too. Only the
	// branch below, after an access token verified, may write one back, so
	// no client-supplied copy can ever reach the MCP handler and no client
	// can forge or widen a session binding.
	if (isMcpPath(pathname)) {
		c.req.raw = stripMcpSessionMarker(c.req.raw);
	}

	// Skip validation in development. Local MCP and UI traffic is already
	// loopback-only in `wrangler dev`.
	if (import.meta.env.DEV) {
		return next();
	}

	// Public download links authenticate with their token, not an Access JWT:
	// the recipient is outside the Access boundary by definition.
	if (isPublicDownloadPath(pathname)) {
		return next();
	}
	// The scoped surface authenticates with its own per-mailbox bearer
	// tokens (workers/lib/scoped-surface.ts); an operator-side Access bypass
	// policy for this prefix is required for external clients — the deploy
	// handover names it.
	if (isScopedPath(pathname)) {
		return next();
	}
	if (isMcpPath(pathname)) {
		// CORS preflight carries no credentials and must reach the MCP handler.
		if (c.req.method === "OPTIONS") {
			return next();
		}

		const authorization = c.req.header("authorization");
		const accessToken = c.req.header("cf-access-jwt-assertion");

		if (authorization) {
			const result = await authenticateMcpRequest(authorization, c.env);
			if (result.ok) {
				// A verified scoped session gets the marker re-attached from
				// the verified record alone. A Cloudflare-credential (or
				// Access JWT) request always travels untagged: the full
				// multi-mailbox operator session.
				c.req.raw = bindMcpSessionMarker(c.req.raw, result);
				return next();
			}
			// If a client has both headers, prefer a valid Access JWT as a
			// compatibility path for browser-based MCP clients.
			if (accessToken && (await verifyCloudflareAccess(c.env, accessToken))) {
				return next();
			}
			return mcpAuthErrorResponse(c, result);
		}

		if (accessToken && (await verifyCloudflareAccess(c.env, accessToken))) {
			return next();
		}

		return mcpAuthErrorResponse(c, {
			ok: false,
			status: 401,
			error: "missing_token",
			message:
				"Missing Authorization header. Agents authenticate with `Authorization: Bearer <wrangler auth token>`; run `npx wrangler auth token` to retrieve the credential.",
		});
	}

	const { POLICY_AUD, TEAM_DOMAIN } = c.env;

	// Fail closed in production if Access is not configured.
	if (!POLICY_AUD || !TEAM_DOMAIN) {
		return c.text(
			"Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN.",
			500,
		);
	}

	const token = c.req.header("cf-access-jwt-assertion");
	if (!token) {
		return c.text("Missing required CF Access JWT", 403);
	}

	if (!(await verifyCloudflareAccess(c.env, token))) {
		return c.text("Invalid or expired Access token", 403);
	}

	// Authorization model note: once a teammate passes the shared Cloudflare
	// Access policy, they can access all mailboxes in this app by design.
	return next();
});

// MCP server endpoint — used by AI coding tools and autonomous agents.
// Must be before API routes and React Router catch-all.
const mcpHandler = EmailMCP.serve("/mcp", {
	binding: "EMAIL_MCP",
	corsOptions: {
		origin: "*",
		methods: "GET,POST,DELETE,OPTIONS",
		headers: "authorization,content-type,mcp-session-id,mcp-protocol-version,last-event-id",
		exposeHeaders: "mcp-session-id",
		maxAge: 86400,
	},
});

/**
 * Hand one /mcp request to the MCP handler.
 *
 * A verified scoped session (workers/lib/mcp-auth.ts) becomes execution-
 * context props here: per-request state a client cannot set, which
 * McpAgent.serve reads and carries into the agent. The internal marker
 * header the middleware carried the binding in on is not itself trusted —
 * it is deleted from every request on the way in and only the middleware
 * ever writes one, after the token verified.
 */
function handleMcpRequest(c: Context<{ Bindings: Env }>) {
	const props = mcpSessionProps(c.req.raw);
	if (props) {
		c.executionCtx.props = props;
	}
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
}

// The MCP server is opt-out (ENABLE_MCP): a disabled deployment answers 404
// here, before the handler does any auth or session work.
app.all("/mcp", async (c) => {
	if (!isMcpEnabled(c.env)) {
		return c.json({ error: "MCP server is disabled." }, 404);
	}
	return handleMcpRequest(c);
});
app.all("/mcp/*", async (c) => {
	if (!isMcpEnabled(c.env)) {
		return c.json({ error: "MCP server is disabled." }, 404);
	}
	return handleMcpRequest(c);
});

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all
// The agent surface is opt-out (ENABLE_AI_AGENT): a disabled deployment
// answers 404 before any agent routing happens.
app.all("/agents/*", async (c) => {
	if (!isAiAgentEnabled(c.env)) {
		return c.json({ error: "AI agent is disabled." }, 404);
	}
	const response = await routeAgentRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Agent not found", 404);
});

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	return requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
});

// Export the Hono app as the default export with an email handler
export default {
	fetch: app.fetch,
	async email(
		event: ForwardableEmailMessage,
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			await receiveEmail(event, env, ctx);
		} catch (e) {
			console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
			// Swallowing the error would silently drop the email.
			throw e;
		}
	},
	/**
	 * Cron entry point. The trigger that fired decides what runs (see the
	 * `triggers` block in wrangler.jsonc): the morning-digest cron builds and
	 * delivers every opted-in mailbox's digest, and every other trigger runs
	 * the housekeeping sweeps — automatic Trash retention, the remote-image
	 * proxy cache sweep, expired attachment-link cleanup, stale pending-upload
	 * cleanup and the due-mail backstop (snoozes, reminders and scheduled
	 * sends). Every sweep logs its
	 * own summary and tolerates a single failure; the extra catch only guards
	 * its own listing. They run as separate waitUntils so a failure in one
	 * never delays or cancels the others.
	 */
	scheduled(
		event: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	) {
		// The digest is its own daily trigger: it neither needs nor waits on
		// the housekeeping sweeps below, so it returns here.
		if (event.cron === DIGEST_CRON) {
			ctx.waitUntil(
				sweepDigests(env).catch((e) =>
					console.error("Digest sweep failed:", (e as Error).message),
				),
			);
			return;
		}

		ctx.waitUntil(
			sweepTrash(env).catch((e) =>
				console.error("Trash retention sweep failed:", (e as Error).message),
			),
		);
		ctx.waitUntil(
			sweepImageProxyCache(env).catch((e) =>
				console.error("Image proxy cache sweep failed:", (e as Error).message),
			),
		);
		ctx.waitUntil(
			sweepAttachmentLinks(env).catch((e) =>
				console.error("Attachment link sweep failed:", (e as Error).message),
			),
		);
		ctx.waitUntil(
			sweepPendingUploads(env).catch((e) =>
				console.error("Pending upload sweep failed:", (e as Error).message),
			),
		);
		// Mailboxes fire their own snoozes, reminders and scheduled sends via
		// DO alarms; this is the backstop for an alarm that never ran
		// (throttled DO, evicted mid-flight).
		ctx.waitUntil(
			sweepDueMail(env).catch((e) =>
				console.error("Mail sweep failed:", (e as Error).message),
			),
		);
	},
};
