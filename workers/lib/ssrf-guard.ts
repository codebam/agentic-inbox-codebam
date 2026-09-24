// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * SSRF guard for sender-controlled outbound URLs.
 *
 * One-click unsubscribe (RFC 8058) means POSTing to a URL a *sender* chose,
 * on the operator's explicit click. That is exactly the shape of an SSRF
 * primitive: without limits, a hostile message could point this Worker at
 * localhost, an internal hostname, a private IP literal, or a non-https
 * endpoint and turn the mailbox into a request proxy. `checkOutboundUrl` is
 * the allowlist for that single use — https only, no credentials, a public
 * hostname (no IP literals, no localhost/.local/.internal), the https
 * default port or 8443, and a bounded length. `guardedFetch` is the only
 * place this app performs such a request: it never follows redirects (a 3xx
 * would escape the allowlist) and never reads the response body.
 *
 * This module deliberately has no agent/MCP wiring: nothing here is
 * reachable by a model, only by an explicit operator action (the
 * POST /emails/:id/unsubscribe route).
 */

/** Longest URL that will ever be fetched on a sender's behalf. */
export const MAX_OUTBOUND_URL_LENGTH = 2048;

/** Abort an outbound request after this long; unsubscribe endpoints are tiny. */
export const OUTBOUND_TIMEOUT_MS = 10_000;

/** Ports allowed on an unsubscribe endpoint: the https default and the alt one. */
const ALLOWED_PORTS = new Set(["", "443", "8443"]);

/** Host suffixes that never name a public destination. */
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal"];

/** Dotted-quad IPv4 literal — WHATWG URL normalizes every IPv4 form to this. */
const IPV4_LITERAL_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** The outcome of a guarded outbound request: the status, or a reason. */
export type GuardedFetchResult =
	| { ok: true; status: number }
	| { ok: false; status: number | null; error: string };

/**
 * Validate a sender-supplied outbound URL. Returns the parsed URL when it is
 * safe to fetch, or a human-readable reason string when it is not — the
 * caller decides between a 502 and a log line; the guard never throws.
 *
 * The returned URL is what callers must fetch: the checks run on the parsed
 * form (the WHATWG URL parser normalizes IPv4 literals, lowercases the host
 * and drops default ports), so there is no raw-string re-parse to drift from.
 */
export function checkOutboundUrl(raw: string): URL | string {
	const value = raw.trim();
	if (!value) return "URL is empty";
	if (value.length > MAX_OUTBOUND_URL_LENGTH) {
		return `URL is longer than ${MAX_OUTBOUND_URL_LENGTH} characters`;
	}

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "URL is not a valid absolute URL";
	}

	if (url.protocol !== "https:") return "URL must use https://";
	if (url.username || url.password) return "URL must not carry credentials";

	// The WHATWG URL parser already lowercased the host. A trailing dot is
	// the same host to DNS ("localhost." === "localhost"), so it is stripped
	// before the suffix checks; a bracketed host is always an IPv6 literal.
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	if (host.startsWith("[") || IPV4_LITERAL_RE.test(host)) {
		return "URL must not use an IP literal host";
	}
	if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
		return "URL must not target a local or internal host";
	}
	if (!ALLOWED_PORTS.has(url.port)) return "URL must use port 443 or 8443";

	return url;
}

/**
 * Fetch an outbound URL through the guard.
 *
 * - `redirect: "manual"` — a 3xx is never followed and is reported as a
 *   failure, so the request can never leave the allowlist checked above.
 * - a 10-second abort timeout, so a hanging sender endpoint cannot pin the
 *   request open.
 * - the response body is never read: it is cancelled unread and only the
 *   status is reported, so a hostile endpoint cannot stream data into the
 *   Worker.
 *
 * `fetchImpl` is injectable so tests can assert the exact request without a
 * network; production callers omit it and the global fetch is used (read at
 * call time, so a test-installed stub is honoured).
 */
export async function guardedFetch(
	raw: string,
	init: RequestInit = {},
	fetchImpl: typeof fetch = fetch,
): Promise<GuardedFetchResult> {
	const checked = checkOutboundUrl(raw);
	if (typeof checked === "string") return { ok: false, status: null, error: checked };

	let response: Response;
	try {
		response = await fetchImpl(
			new Request(checked, {
				...init,
				redirect: "manual",
				signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
			}),
		);
	} catch (e) {
		const message = (e as Error).message || "request failed";
		return { ok: false, status: null, error: message };
	}

	// The sender's response body is irrelevant and must not be read.
	await response.body?.cancel().catch(() => {});

	if (response.status >= 300 && response.status < 400) {
		return { ok: false, status: response.status, error: `Redirect refused (${response.status})` };
	}
	if (!response.ok) {
		return { ok: false, status: response.status, error: `Endpoint responded ${response.status}` };
	}
	return { ok: true, status: response.status };
}
