// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Authentication for the agent-facing MCP endpoint.
 *
 * Agents authenticate with a Cloudflare API credential produced by the
 * Wrangler CLI:
 *
 *   npx wrangler auth token
 *
 * That command returns whichever credential Wrangler is configured to use --
 * a `wrangler login` OAuth access token or the `CLOUDFLARE_API_TOKEN`
 * environment variable. Both are valid Bearer credentials for the Cloudflare
 * API, so we verify them by asking Cloudflare whether the token can read one
 * of the domains this inbox is configured to manage.
 *
 * As alternatives, operator-minted access tokens (shared/access-tokens.ts)
 * authenticate too, in either of their two kinds. A Settings access token
 * (the `ain1` wire format) is verified in the mailbox its string names,
 * exactly like the scoped automation surface verifies it
 * (workers/lib/scoped-surface.ts), and the session it authenticates is BOUND
 * to that mailbox with the token's read/draft/send scopes. An app-level token
 * (the `ain2` wire format) is verified against the deployment-wide R2 store
 * (workers/lib/app-tokens.ts), and the session it authenticates reaches
 * EVERY mailbox with the token's read/draft/send scopes. Neither kind ever
 * reaches the full multi-mailbox operator surface.
 *
 * The browser UI remains protected by Cloudflare Access. This module is only
 * used for `/mcp`, where browser cookies and Access JWTs are not available to
 * most MCP clients.
 */

import { z } from "zod";
import {
	isAccessTokenScope,
	parseAccessToken,
	parseAppAccessToken,
	type AccessTokenScope,
} from "../../shared/access-tokens";
import { hashAccessToken } from "./access-tokens";
import { verifyAppAccessToken } from "./app-tokens";
import { getMailboxStub } from "./email-helpers";
import type { Env } from "../types";

const DEFAULT_CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const MAX_AUTHORIZATION_LENGTH = 8 * 1024;
const MAX_TOKEN_LENGTH = 4 * 1024;
const DEFAULT_SUCCESS_CACHE_TTL_SECONDS = 5 * 60;
const DEFAULT_FAILURE_CACHE_TTL_SECONDS = 30;
const MAX_CACHE_TTL_SECONDS = 60 * 60;
const CLOUDFLARE_API_TIMEOUT_MS = 10_000;
const TOKEN_PATTERN = /^[!-~]+$/;

/**
 * The subset of Worker environment bindings and variables used by MCP auth.
 * Keeping this structural (instead of importing Env) makes the module easy to
 * unit test and keeps the auth logic decoupled from the rest of the app.
 */
export interface McpAuthEnv {
	/** Comma-separated inbox domains from `wrangler.jsonc` (for example `example.com`). */
	DOMAINS?: string | string[];
	/** Comma-separated optional address allowlist used to infer domains. */
	EMAIL_ADDRESSES?: string[];
	/**
	 * Optional comma-separated Cloudflare account IDs. When set, this overrides
	 * domain-based binding and accepts any Wrangler credential with access to
	 * one of the listed accounts.
	 */
	MCP_ALLOWED_ACCOUNT_IDS?: string;
	/** Override for tests or non-default Cloudflare API deployments. */
	CLOUDFLARE_API_BASE?: string;
	/** Optional override for the success cache TTL, in seconds. */
	MCP_AUTH_CACHE_TTL_SECONDS?: string;
	/** Set to `"true"` to disable the per-colo auth cache entirely. */
	MCP_AUTH_DISABLE_CACHE?: string;
	/**
	 * Durable Object namespace for the mailboxes. Required to verify Settings
	 * access tokens: a token is looked up in the mailbox its string names, so
	 * only the mailbox it was minted for can ever accept it.
	 */
	MAILBOX?: Env["MAILBOX"];
	/**
	 * R2 bucket holding the deployment-wide app access tokens
	 * (`config/app-tokens.json`, workers/lib/app-tokens.ts). Required to
	 * verify app-level (`ain2`) tokens: the token is matched against the
	 * single stored object every mailbox shares.
	 */
	BUCKET?: Env["BUCKET"];
}

export type McpAuthErrorCode =
	| "missing_token"
	| "invalid_token"
	| "insufficient_scope"
	| "temporarily_unavailable"
	| "server_error"
	| "configuration_error";

export interface McpAuthIdentity {
	/** How the token was matched back to this inbox. */
	authMethod: "account" | "domain";
	/** Account that owns the matched inbox domain, or the matched account allowlist entry. */
	matchedAccountId: string;
	/** Inbox domain that proved the credential, when `authMethod` is `domain`. */
	matchedDomain?: string;
	/** All accounts the credential appears to have access to. */
	accounts: Array<{ id: string; name?: string | undefined }>;
}

/**
 * The scoped binding an operator-minted access token carries into an MCP
 * session, built from the verified stored record alone. Two kinds exist:
 *
 * - `mailbox` — a Settings access token (the `ain1` wire format). The token
 *   string names one mailbox, and the session is BOUND to it: that mailbox
 *   is the only one the session may act on (`mailboxId`).
 * - `app` — an app-level token (the `ain2` wire format). The token carries
 *   no mailbox segment, and the session reaches EVERY mailbox: there is
 *   deliberately no `mailboxId` to bind, filter or widen by.
 *
 * Both carry the scopes the stored record holds (`read`, `draft`, `send`)
 * and the id of that record, for the audit log.
 */
export type McpScopedBinding =
	| {
			kind: "mailbox";
			/** The mailbox the token was minted for; the only one the session may act on. */
			mailboxId: string;
			scopes: AccessTokenScope[];
			tokenId: string;
	  }
	| {
			kind: "app";
			scopes: AccessTokenScope[];
			tokenId: string;
	  };

export interface McpAuthSuccess {
	ok: true;
	/**
	 * Cloudflare-credential identity. Present when a Wrangler credential
	 * (account or domain match) authenticated the request, absent for a
	 * Settings access token.
	 */
	identity?: McpAuthIdentity;
	/** Scoped binding. Present only when a Settings access token authenticated. */
	binding?: McpScopedBinding;
}

export type McpAuthFailureStatus = 400 | 401 | 403 | 429 | 500 | 502 | 504;

export interface McpAuthFailure {
	ok: false;
	status: McpAuthFailureStatus;
	error: McpAuthErrorCode;
	message: string;
}

export type McpAuthResult = McpAuthSuccess | McpAuthFailure;

export interface McpAuthOptions {
	/** Inject a fetch implementation in tests. Supplying one disables the cache. */
	fetcher?: typeof fetch;
	/** Override the Cloudflare API base URL. */
	apiBase?: string;
	/** Disable the per-colo Cloudflare Cache API auth cache. */
	disableCache?: boolean;
}

/** A response body from Cloudflare's REST API envelope. */
const CloudflareErrorSchema = z.object({
	code: z.number().optional(),
	message: z.string().optional(),
});

const CloudflareEnvelopeSchema = z.object({
	success: z.boolean().optional(),
	errors: z.array(CloudflareErrorSchema).optional(),
	result: z.unknown().optional(),
});

const AccountSchema = z.object({
	id: z.string().min(1),
	name: z.string().optional(),
});

const ZoneSchema = z.object({
	id: z.string().optional(),
	name: z.string().optional(),
	account: z
		.object({
			id: z.string().min(1),
			name: z.string().optional(),
		})
		.optional(),
});

interface CloudflareApiResponse {
	status: number;
	ok: boolean;
	data: unknown;
	rawText: string;
}

interface CloudflareApiContext {
	apiBase: string;
	fetcher: typeof fetch;
}

function failure(
	status: McpAuthFailureStatus,
	error: McpAuthErrorCode,
	message: string,
): McpAuthFailure {
	return { ok: false, status, error, message };
}

function parseList(value: unknown): string[] {
	const parts = Array.isArray(value)
		? value.map((part) => String(part))
		: typeof value === "string"
			? value.split(",")
			: [];

	const seen = new Set<string>();
	const output: string[] = [];
	for (const part of parts) {
		const normalized = part.trim();
		if (!normalized) continue;
		const key = normalized.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		output.push(normalized);
	}
	return output;
}

function getInboxDomains(env: McpAuthEnv): string[] {
	const domains = parseList(env.DOMAINS);
	if (domains.length > 0) return domains.map((domain) => domain.toLowerCase());

	// A deployment can choose to configure explicit mailbox addresses instead
	// of DOMAINS. Derive the proving domains from those addresses.
	for (const address of parseList(env.EMAIL_ADDRESSES)) {
		const at = address.lastIndexOf("@");
		if (at > 0 && at < address.length - 1) {
			domains.push(address.slice(at + 1).toLowerCase());
		}
	}
	return parseList(domains).map((domain) => domain.toLowerCase());
}

function parseFirstApiError(data: unknown): string | undefined {
	const parsed = CloudflareEnvelopeSchema.safeParse(data);
	if (!parsed.success) return undefined;
	for (const error of parsed.data.errors ?? []) {
		if (error.message?.trim()) return error.message.trim().slice(0, 300);
	}
	return undefined;
}

function mapApiResponseToFailure(
	response: CloudflareApiResponse,
	context: "domain" | "account",
): McpAuthFailure {
	const apiMessage = parseFirstApiError(response.data);

	if (response.status === 401) {
		return failure(
			401,
			"invalid_token",
			"Your Wrangler credential is invalid or expired. Run `npx wrangler auth token` again after re-authenticating.",
		);
	}

	if (response.status === 403) {
		return failure(
			403,
			"insufficient_scope",
			context === "domain"
				? "Your Wrangler credential does not have permission to read the domains configured for this inbox (Zone:Read is required)."
				: apiMessage
					? `Your Wrangler credential cannot read the configured Cloudflare account: ${apiMessage}`
					: "Your Wrangler credential cannot read the configured Cloudflare account.",
		);
	}

	if (response.status === 429) {
		return failure(
			429,
			"temporarily_unavailable",
			"Cloudflare is rate limiting token verification. Wait a moment and try again.",
		);
	}

	if (response.status >= 500) {
		return failure(
			502,
			"server_error",
			"Cloudflare API is unavailable while verifying your Wrangler credential. Try again shortly.",
		);
	}

	if (response.status === 400 && context === "domain") {
		return failure(
			500,
			"configuration_error",
			apiMessage
				? `The Cloudflare API rejected an inbox domain lookup: ${apiMessage}`
				: "The Cloudflare API rejected an inbox domain lookup. Check the DOMAINS worker variable.",
		);
	}

	return failure(
		context === "domain" ? 403 : 500,
		context === "domain" ? "insufficient_scope" : "server_error",
		apiMessage
			? `Cloudflare could not verify this credential: ${apiMessage}`
			: "Cloudflare could not verify this credential.",
	);
}

function parseMatchingZone(data: unknown, domain: string): z.infer<typeof ZoneSchema> | null {
	const parsed = CloudflareEnvelopeSchema.safeParse(data);
	if (!parsed.success || !Array.isArray(parsed.data.result)) return null;

	const expected = domain.toLowerCase();
	for (const rawZone of parsed.data.result) {
		const zone = ZoneSchema.safeParse(rawZone);
		if (zone.success && zone.data.name?.toLowerCase() === expected && zone.data.account?.id) {
			return zone.data;
		}
	}
	return null;
}

function parseAccount(data: unknown, fallbackId: string): { id: string; name?: string | undefined } {
	const parsed = CloudflareEnvelopeSchema.safeParse(data);
	if (parsed.success) {
		const account = AccountSchema.safeParse(parsed.data.result);
		if (account.success) return account.data;
	}
	return { id: fallbackId };
}

async function cloudflareGet(
	path: string,
	token: string,
	context: CloudflareApiContext,
): Promise<CloudflareApiResponse> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CLOUDFLARE_API_TIMEOUT_MS);

	try {
		// Call the fetcher without a receiver: workerd's native `fetch`
		// throws "Illegal invocation" when invoked as a method of a plain
		// object, so `context.fetcher(...)` fails where a bare call works.
		const fetcher = context.fetcher;
		const response = await fetcher(`${context.apiBase}${path}`, {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
				"User-Agent": "agentic-inbox-codebam-mcp/1.0",
			},
			signal: controller.signal,
		});

		let rawText = "";
		try {
			rawText = await response.text();
		} catch {
			rawText = "";
		}

		let data: unknown;
		try {
			data = rawText ? JSON.parse(rawText) : undefined;
		} catch {
			data = undefined;
		}

		return { status: response.status, ok: response.ok, data, rawText };
	} finally {
		clearTimeout(timer);
	}
}

function getApiBase(env: McpAuthEnv, options: McpAuthOptions): string {
	const configured = options.apiBase ?? env.CLOUDFLARE_API_BASE ?? DEFAULT_CLOUDFLARE_API_BASE;
	return configured.replace(/\/+$/, "");
}

async function verifyWithAccountAllowlist(
	token: string,
	accountIds: string[],
	context: CloudflareApiContext,
): Promise<McpAuthResult> {
	for (const accountId of accountIds) {
		const response = await cloudflareGet(
			`/accounts/${encodeURIComponent(accountId)}`,
			token,
			context,
		);

		if (response.ok) {
			const account = parseAccount(response.data, accountId);
			return {
				ok: true,
				identity: {
					authMethod: "account",
					matchedAccountId: account.id,
					accounts: [account],
				},
			};
		}

		// A 401 from any account probe means the credential itself is bad.
		if (response.status === 401) {
			return mapApiResponseToFailure(response, "account");
		}

		// Rate limits and Cloudflare outages should not be softened into a
		// permissions error; retrying the same credential may succeed.
		if (response.status === 429 || response.status >= 500) {
			return mapApiResponseToFailure(response, "account");
		}
	}

	return failure(
		403,
		"insufficient_scope",
		"Your Wrangler credential cannot read any account in MCP_ALLOWED_ACCOUNT_IDS.",
	);
}

async function verifyWithDomains(
	token: string,
	domains: string[],
	context: CloudflareApiContext,
): Promise<McpAuthResult> {
	const responses = await Promise.all(
		domains.map(async (domain) => ({
			domain,
			response: await cloudflareGet(
				`/zones?name=${encodeURIComponent(domain)}&per_page=1`,
				token,
				context,
			),
		})),
	);

	let transientFailure: McpAuthFailure | null = null;

	for (const { domain, response } of responses) {
		if (response.ok) {
			const zone = parseMatchingZone(response.data, domain);
			if (zone?.account?.id) {
				return {
					ok: true,
					identity: {
						authMethod: "domain",
						matchedDomain: domain,
						matchedAccountId: zone.account.id,
						accounts: [{ id: zone.account.id, name: zone.account.name }],
					},
				};
			}

			// A 200 with no matching zone means the credential is valid but
			// cannot see this particular inbox domain (for example, the token
			// belongs to another Cloudflare account).
			continue;
		}

		if (response.status === 401) {
			// A token that can read any configured domain cannot simultaneously
			// be invalid for another one. A 401 is authoritative.
			return mapApiResponseToFailure(response, "domain");
		}

		const mapped = mapApiResponseToFailure(response, "domain");
		if (mapped.status === 500 || mapped.status === 502 || mapped.status === 429) {
			transientFailure ??= mapped;
		}
	}

	if (transientFailure) return transientFailure;

	return failure(
		403,
		"insufficient_scope",
		"Your Wrangler credential cannot read any Cloudflare zone configured in DOMAINS. Sign in to the account that owns this inbox, or set MCP_ALLOWED_ACCOUNT_IDS.",
	);
}

/**
 * Verify a raw Bearer token against Cloudflare and bind it to this inbox.
 *
 * Precedence:
 * 1. `MCP_ALLOWED_ACCOUNT_IDS` when set (advanced deployments).
 * 2. The configured `DOMAINS` (or domains derived from `EMAIL_ADDRESSES`).
 *
 * The token is cached in the per-colo Cache API by its SHA-256 hash. Raw
 * tokens are never used as cache keys and never logged.
 */
export async function verifyMcpToken(
	token: string,
	env: McpAuthEnv,
	options: McpAuthOptions = {},
): Promise<McpAuthResult> {
	if (!token || token.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) {
		return failure(401, "invalid_token", "Invalid Wrangler auth token.");
	}

	const fetcher = options.fetcher ?? globalThis.fetch;
	if (typeof fetcher !== "function") {
		return failure(
			502,
			"server_error",
			"No fetch implementation is available to verify the token.",
		);
	}

	const context: CloudflareApiContext = {
		apiBase: getApiBase(env, options),
		fetcher,
	};

	const accountIds = parseList(env.MCP_ALLOWED_ACCOUNT_IDS);
	if (accountIds.length > 0) {
		try {
			return await verifyWithAccountAllowlist(token, accountIds, context);
		} catch {
			return failure(
				502,
				"server_error",
				"Failed to reach the Cloudflare API while verifying the token.",
			);
		}
	}

	const domains = getInboxDomains(env);
	if (domains.length > 0) {
		try {
			return await verifyWithDomains(token, domains, context);
		} catch {
			return failure(
				502,
				"server_error",
				"Failed to reach the Cloudflare API while verifying the token.",
			);
		}
	}

	return failure(
		500,
		"configuration_error",
		"MCP authentication is not configured. Set the DOMAINS worker variable, or set MCP_ALLOWED_ACCOUNT_IDS to a comma-separated Cloudflare account allowlist.",
	);
}

/** Parse an HTTP `Authorization` header into a bearer token. */
export function parseBearerToken(header: string | null | undefined): string | null {
	if (!header || header.length > MAX_AUTHORIZATION_LENGTH) return null;

	const match = /^\s*Bearer[ \t]+([^\s]+)\s*$/i.exec(header);
	if (!match) return null;

	const token = match[1];
	if (!token || token.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) return null;
	return token;
}

/**
 * The one message every scoped /mcp authentication failure answers with.
 * Identical to the scoped automation surface's (workers/lib/scoped-surface.ts):
 * a bearer credential must not be an oracle, so a token that is malformed, a
 * near miss and a revoked token all read the same.
 */
const INVALID_ACCESS_TOKEN_ERROR = "Invalid or revoked access token";

/**
 * Verify a Settings access token against the mailbox its string names.
 *
 * The recipe is exactly the scoped automation surface's
 * (workers/lib/scoped-surface.ts): parse the wire format for the mailbox id,
 * SHA-256 the FULL token string, and trust only the record the mailbox's own
 * `verifyAccessToken` answers with. A token therefore resolves in one mailbox
 * alone, and its stored scopes and id are what the session is bound to.
 *
 * Every failure answers the one indistinguishable 401, including a
 * deployment without the namespace binding: a token that cannot be verified
 * is not a credential, and saying which failure it was would turn the
 * endpoint into an oracle.
 */
async function verifyScopedAccessToken(
	token: string,
	mailboxId: string,
	env: McpAuthEnv,
): Promise<McpAuthResult> {
	// The structural env this module is typed against carries only what MCP
	// auth reads; widen it back to the app Env for the shared stub helper.
	const namespaceEnv = env as Env;
	if (!env.MAILBOX) {
		return failure(401, "invalid_token", INVALID_ACCESS_TOKEN_ERROR);
	}

	const record = await getMailboxStub(namespaceEnv, mailboxId).verifyAccessToken(
		await hashAccessToken(token),
	);
	if (!record) {
		return failure(401, "invalid_token", INVALID_ACCESS_TOKEN_ERROR);
	}

	return {
		ok: true,
		binding: {
			kind: "mailbox",
			mailboxId,
			scopes: record.scopes,
			tokenId: record.id,
		},
	};
}

/**
 * Verify an app-level access token against the deployment-wide R2 store
 * (workers/lib/app-tokens.ts).
 *
 * The recipe mirrors the scoped surface's per-mailbox one — SHA-256 the FULL
 * token string and trust only the record the store answers with — except
 * that the store is the single R2 object every mailbox shares, so the token
 * resolves deployment-wide and the session it binds reaches EVERY mailbox.
 *
 * Every failure answers the same indistinguishable 401 as the mailbox
 * branch, including a deployment without the bucket binding: a token that
 * cannot be verified is not a credential, and saying which failure it was
 * would turn the endpoint into an oracle.
 */
async function verifyAppScopedAccessToken(
	token: string,
	env: McpAuthEnv,
): Promise<McpAuthResult> {
	if (!env.BUCKET) {
		return failure(401, "invalid_token", INVALID_ACCESS_TOKEN_ERROR);
	}

	const record = await verifyAppAccessToken(env.BUCKET, token);
	if (!record) {
		return failure(401, "invalid_token", INVALID_ACCESS_TOKEN_ERROR);
	}

	return {
		ok: true,
		binding: {
			kind: "app",
			scopes: record.scopes,
			tokenId: record.id,
		},
	};
}

/**
 * The internal request header a verified scoped binding travels in, from the
 * /mcp middleware to the MCP handler (workers/app.ts).
 *
 * INTERNAL ONLY. It is never itself a credential: the middleware deletes any
 * client-supplied copy of this header from every /mcp request before it
 * authenticates anything, and writes its own value only once an access
 * token verified. The /mcp route turns the middleware's header into the
 * per-request props McpAgent.serve reads, so a client can neither forge a
 * binding nor widen the one its token holds.
 */
export const MCP_SESSION_HEADER = "x-agentic-inbox-mcp-session";

/**
 * The props an MCP session carries, read by the agent from its execution
 * context. A full operator session has no props at all; only a scoped one
 * has a binding.
 */
export type McpSessionProps = { scopedSession: McpScopedBinding };

/** Drop the internal session header from a request. */
export function stripMcpSessionMarker(request: Request): Request {
	if (!request.headers.has(MCP_SESSION_HEADER)) return request;
	const headers = new Headers(request.headers);
	headers.delete(MCP_SESSION_HEADER);
	return new Request(request, { headers });
}

/**
 * The request as the MCP handler should see it: the client's copy of the
 * internal session marker is gone either way, and only a verified scoped
 * result gets a marker of this code's own — carrying exactly the binding
 * the token's record verified (a mailbox for an `ain1` Settings token, the
 * scopes and token id either way), never anything the client asked for. A
 * Cloudflare-credential (or Access JWT) request stays untagged: the full
 * multi-mailbox operator session.
 */
export function bindMcpSessionMarker(
	request: Request,
	result: McpAuthResult,
): Request {
	const stripped = stripMcpSessionMarker(request);
	if (!result.ok || !result.binding) return stripped;
	const headers = new Headers(stripped.headers);
	headers.set(MCP_SESSION_HEADER, JSON.stringify(result.binding));
	return new Request(stripped, { headers });
}

/**
 * True when `value` is a scoped binding this module could have written.
 *
 * The two kinds are validated strictly and disjointly: a `mailbox` binding
 * requires a non-empty string mailboxId, an `app` binding requires NO string
 * mailboxId, and anything else — a missing or unknown `kind` included — is
 * not a binding. Both require a non-empty token id and a non-empty list of
 * known scopes.
 */
function isMcpScopedBinding(value: unknown): value is McpScopedBinding {
	if (typeof value !== "object" || value === null) return false;
	const binding = value as {
		kind?: unknown;
		mailboxId?: unknown;
		scopes?: unknown;
		tokenId?: unknown;
	};
	if (
		typeof binding.tokenId !== "string" ||
		binding.tokenId.length === 0 ||
		!Array.isArray(binding.scopes) ||
		binding.scopes.length === 0 ||
		!binding.scopes.every(isAccessTokenScope)
	) {
		return false;
	}
	if (binding.kind === "mailbox") {
		return typeof binding.mailboxId === "string" && binding.mailboxId.length > 0;
	}
	if (binding.kind === "app") {
		// An app token reaches every mailbox, so a binding carrying one
		// would be a value no reader may honor: not one this module could
		// have written.
		return typeof binding.mailboxId !== "string";
	}
	return false;
}

/**
 * The scoped-session props a request carries, or undefined for a full
 * operator session. Only the middleware above writes the marker; this reads
 * it back for the /mcp route.
 */
export function mcpSessionProps(request: Request): McpSessionProps | undefined {
	const raw = request.headers.get(MCP_SESSION_HEADER);
	if (!raw) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		return isMcpScopedBinding(parsed) ? { scopedSession: parsed } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Convenience wrapper for the Hono middleware: validates the `Authorization`
 * header shape and then verifies the credential with Cloudflare.
 *
 * A bearer that is one of the access-token wire formats is verified against
 * its own store instead of Cloudflare — `ain1` against the mailbox its
 * string names (see verifyScopedAccessToken), `ain2` against the
 * deployment-wide R2 store (see verifyAppScopedAccessToken) — and is never
 * cached: the auth cache exists to keep the Cloudflare API lookups cheap,
 * and caching a scoped success would keep a revoked token working until its
 * TTL lapsed. Everything else keeps today's path: the cache, then
 * Cloudflare.
 */
export async function authenticateMcpRequest(
	authorizationHeader: string | null | undefined,
	env: McpAuthEnv,
	options: McpAuthOptions = {},
): Promise<McpAuthResult> {
	if (!authorizationHeader) {
		return failure(
			401,
			"missing_token",
			"Missing Authorization header. Agents authenticate with `Authorization: Bearer <wrangler auth token>`.",
		);
	}

	const token = parseBearerToken(authorizationHeader);
	if (!token) {
		return failure(
			401,
			"invalid_token",
			"Authorization header must use the `Bearer <wrangler auth token>` scheme.",
		);
	}

	const parsedAccessToken = parseAccessToken(token);
	if (parsedAccessToken) {
		return verifyScopedAccessToken(token, parsedAccessToken.mailboxId, env);
	}

	// The app-token parser is disjoint from the ain1 one above, so an
	// `ain2_<secret>` string — and only that shape — reaches the app store.
	const parsedAppToken = parseAppAccessToken(token);
	if (parsedAppToken) {
		return verifyAppScopedAccessToken(token, env);
	}

	const cached = await readAuthCache(token, env, options);
	if (cached) return cached;

	const result = await verifyMcpToken(token, env, options);
	await writeAuthCache(token, result, env, options);
	return result;
}

interface CacheLike {
	match(request: Request): Promise<Response | undefined>;
	put(request: Request, response: Response): Promise<void>;
}

const MEMORY_CACHE_MAX_ENTRIES = 512;
const memoryAuthCache = new Map<string, { expiresAt: number; result: McpAuthResult }>();

function isCacheEnabled(env: McpAuthEnv, options: McpAuthOptions): boolean {
	if (options.disableCache || options.fetcher) return false;
	return env.MCP_AUTH_DISABLE_CACHE !== "true";
}

function readMemoryAuthCache(token: string): McpAuthResult | null {
	const entry = memoryAuthCache.get(token);
	if (!entry) return null;
	if (entry.expiresAt <= Date.now()) {
		memoryAuthCache.delete(token);
		return null;
	}
	return entry.result;
}

function writeMemoryAuthCache(token: string, result: McpAuthResult, ttlSeconds: number): void {
	if (ttlSeconds <= 0) return;

	// Bound per-isolate memory by evicting the oldest entries first.
	while (memoryAuthCache.size >= MEMORY_CACHE_MAX_ENTRIES) {
		const oldest = memoryAuthCache.keys().next().value;
		if (oldest === undefined) break;
		memoryAuthCache.delete(oldest);
	}
	memoryAuthCache.set(token, {
		expiresAt: Date.now() + ttlSeconds * 1000,
		result,
	});
}

function getCache(env: McpAuthEnv, options: McpAuthOptions): CacheLike | null {
	if (!isCacheEnabled(env, options)) return null;

	try {
		const cacheStorage = (globalThis as unknown as { caches?: { default?: Cache } }).caches;
		return cacheStorage?.default ?? null;
	} catch {
		return null;
	}
}

function getCacheTtlSeconds(env: McpAuthEnv, result: McpAuthResult): number {
	const raw = Number(env.MCP_AUTH_CACHE_TTL_SECONDS);
	const configured =
		Number.isFinite(raw) && raw >= 0 ? Math.min(raw, MAX_CACHE_TTL_SECONDS) : undefined;

	if (configured !== undefined) return configured;
	return result.ok ? DEFAULT_SUCCESS_CACHE_TTL_SECONDS : DEFAULT_FAILURE_CACHE_TTL_SECONDS;
}

function isMcpAuthResult(value: unknown): value is McpAuthResult {
	if (typeof value !== "object" || value === null || !("ok" in value)) return false;
	return typeof (value as { ok?: unknown }).ok === "boolean";
}

function shouldCacheResult(result: McpAuthResult): boolean {
	if (result.ok) return true;
	// Cache permissions failures briefly, but do not cache configuration or
	// Cloudflare availability errors: those should self-heal as soon as the
	// deployment is fixed.
	return result.status === 401 || result.status === 403 || result.status === 429;
}

async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function readAuthCache(
	token: string,
	env: McpAuthEnv,
	options: McpAuthOptions,
): Promise<McpAuthResult | null> {
	if (!isCacheEnabled(env, options)) return null;

	// Fast path: per-isolate memory. This keeps working even when the Worker is
	// fronted by Cloudflare Access, where the Cache API is not available.
	const memoryResult = readMemoryAuthCache(token);
	if (memoryResult) return memoryResult;

	const cache = getCache(env, options);
	if (!cache) return null;

	try {
		const key = new Request(
			`https://agentic-inbox-codebam.invalid/__mcp_auth_cache/v1/${await hashToken(token)}`,
			{ method: "GET" },
		);
		const cached = await cache.match(key);
		if (!cached) return null;

		const parsed = await cached.json();
		return isMcpAuthResult(parsed) ? parsed : null;
	} catch {
		// Cache is a performance optimization only -- never fail auth because
		// the Cache API is unavailable.
		return null;
	}
}

async function writeAuthCache(
	token: string,
	result: McpAuthResult,
	env: McpAuthEnv,
	options: McpAuthOptions,
): Promise<void> {
	if (!shouldCacheResult(result) || !isCacheEnabled(env, options)) return;

	const ttl = getCacheTtlSeconds(env, result);
	if (ttl <= 0) return;

	writeMemoryAuthCache(token, result, ttl);

	const cache = getCache(env, options);
	if (!cache) return;

	try {
		const key = new Request(
			`https://agentic-inbox-codebam.invalid/__mcp_auth_cache/v1/${await hashToken(token)}`,
			{ method: "GET" },
		);
		await cache.put(
			key,
			new Response(JSON.stringify(result), {
				headers: {
					"Cache-Control": `max-age=${ttl}`,
					"Content-Type": "application/json",
				},
			}),
		);
	} catch {
		// Ignore cache write failures.
	}
}
