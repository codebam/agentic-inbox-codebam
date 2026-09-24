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
import { authenticateMcpRequest, type McpAuthFailure } from "./lib/mcp-auth";
import { sweepDueMail } from "./lib/mail-sweep";
import { sweepImageProxyCache } from "./lib/image-proxy";
import { sweepTrash } from "./lib/trash-retention";
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
// * All other routes keep the original Cloudflare Access gate.
app.use("*", async (c: AuthContext, next) => {
	// Skip validation in development. Local MCP and UI traffic is already
	// loopback-only in `wrangler dev`.
	if (import.meta.env.DEV) {
		return next();
	}

	const pathname = new URL(c.req.url).pathname;
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
app.all("/mcp", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});
app.all("/mcp/*", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all
app.all("/agents/*", async (c) => {
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
	 * Cron entry point for automatic Trash retention, the remote-image proxy
	 * cache sweep and the due-mail backstop (snoozes, reminders and scheduled
	 * sends; see the `triggers` block in wrangler.jsonc). Every sweep logs its
	 * own summary and tolerates a single failure; the extra catch only guards
	 * its own listing. They run as separate waitUntils so a failure in one
	 * never delays or cancels the others.
	 */
	scheduled(
		_event: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	) {
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
