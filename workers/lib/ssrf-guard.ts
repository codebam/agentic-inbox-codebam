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
 * `guardedFetchImage` applies the same allowlist in image mode: it fetches
 * one remote image's bytes for the same-origin proxy route, with a
 * content-type allowlist that never includes SVG, a declared-length check, a
 * hard byte cap on the body, and the same no-redirect, no-credential rules.
 * Its result carries the bytes, so an opted-in message renders through the
 * app's own origin instead of leaking the reader's IP to the sender.
 *
 * This module deliberately has no agent/MCP wiring: nothing here is
 * reachable by a model, only by explicit operator actions (the one-click
 * unsubscribe route, and the image-proxy route the browser calls after the
 * operator opted in).
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

// ── Image mode ─────────────────────────────────────────────────────


/** Hard cap on one proxied image body: 5 MiB. */
export const MAX_PROXY_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Content types the image proxy will relay. SVG is deliberately absent: it
 * is an active document format (scripts, external references), so relaying
 * it same-origin would hand a sender script execution on the app's origin.
 * Anything else — including a missing type — is refused as well.
 */
export const PROXY_IMAGE_CONTENT_TYPES: readonly string[] = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
];

/** The one header a proxied image request carries; never credentials. */
const PROXY_IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/avif";

/**
 * Why an image fetch failed. The route maps each reason to a status:
 * `url` -> 400, `oversize` -> 413, `content-type` -> 415, everything else
 * (redirect, non-2xx, network error, body read failure) -> 502.
 */
export type GuardedImageFailureReason =
	| "url"
	| "redirect"
	| "upstream"
	| "content-type"
	| "oversize";

/** The outcome of a guarded image fetch: bytes + type, or a reason. */
export type GuardedImageFetchResult =
	| { ok: true; bytes: ArrayBuffer; contentType: string }
	| {
			ok: false;
			status: number | null;
			error: string;
			reason: GuardedImageFailureReason;
		};

export interface GuardedImageFetchOptions {
	/**
	 * Injectable fetch so tests can assert the exact request without a
	 * network; production callers omit it and the global fetch is used
	 * (read at call time, so a test-installed stub is honoured).
	 */
	fetchImpl?: typeof fetch;
	/**
	 * Override the byte cap. Production callers omit it; tests use a tiny
	 * cap to exercise the streaming cut-off without a multi-megabyte body.
	 */
	maxBytes?: number;
}

/**
 * Fetch one remote image through the guard, the image-mode sibling of
 * `guardedFetch`.
 *
 * Differences from `guardedFetch` — and why:
 * - The response *is* read, so the read is bounded: a declared
 *   `content-length` above the cap is refused before the body is touched,
 *   and a streamed body is cancelled as soon as it crosses the cap, so a
 *   hostile endpoint cannot stream data into the Worker indefinitely.
 * - The `content-type` must be in the allowlist (compared before any `;`,
 *   e.g. `image/png; charset=binary` is fine) and can never be SVG.
 * - The request is a bare GET: `redirect: "manual"`, a 10-second abort
 *   timeout, and exactly one header (`Accept`). No credentials, Referer or
 *   Origin are ever attached, so the sender's server cannot correlate the
 *   request with the reader's mailbox.
 *
 * Like `guardedFetch` it never follows a redirect and never throws: every
 * failure comes back as a discriminated result for the caller to map.
 */
export async function guardedFetchImage(
	raw: string,
	opts: GuardedImageFetchOptions = {},
): Promise<GuardedImageFetchResult> {
	const checked = checkOutboundUrl(raw);
	if (typeof checked === "string") {
		return { ok: false, status: null, error: checked, reason: "url" };
	}
	const fetchImpl = opts.fetchImpl ?? fetch;
	const maxBytes = opts.maxBytes ?? MAX_PROXY_IMAGE_BYTES;

	let response: Response;
	try {
		response = await fetchImpl(
			new Request(checked, {
				method: "GET",
				headers: { accept: PROXY_IMAGE_ACCEPT },
				redirect: "manual",
				signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
			}),
		);
	} catch (e) {
		const message = (e as Error).message || "request failed";
		return { ok: false, status: null, error: message, reason: "upstream" };
	}

	if (response.status >= 300 && response.status < 400) {
		await discardBody(response);
		return {
			ok: false,
			status: response.status,
			error: `Redirect refused (${response.status})`,
			reason: "redirect",
		};
	}
	if (!response.ok) {
		await discardBody(response);
		return {
			ok: false,
			status: response.status,
			error: `Endpoint responded ${response.status}`,
			reason: "upstream",
		};
	}

	// Compare only the essence: a bogus parameter (`text/html; charset=` ) must
	// not slip through on the strength of what follows the semicolon.
	const contentType = (response.headers.get("content-type") ?? "")
		.split(";")[0]!
		.trim()
		.toLowerCase();
	if (!PROXY_IMAGE_CONTENT_TYPES.includes(contentType)) {
		await discardBody(response);
		return {
			ok: false,
			status: response.status,
			error: `Unsupported image content type: ${contentType || "(missing)"}`,
			reason: "content-type",
		};
	}

	// A declared oversize length is refused before any byte is read.
	const declaredLength = Number(response.headers.get("content-length") ?? "");
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		await discardBody(response);
		return {
			ok: false,
			status: response.status,
			error: `Image is larger than ${maxBytes} bytes`,
			reason: "oversize",
		};
	}

	if (!response.body) {
		return { ok: true, bytes: new ArrayBuffer(0), contentType };
	}

	// Read under the cap: the first chunk that would cross it cancels the
	// stream and fails, so at most cap + one chunk is ever buffered.
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		let read: ReadableStreamReadResult<Uint8Array>;
		try {
			read = await reader.read();
		} catch (e) {
			await reader.cancel().catch(() => {});
			const message = (e as Error).message || "body read failed";
			return { ok: false, status: response.status, error: message, reason: "upstream" };
		}
		if (read.done) break;
		if (total + read.value.byteLength > maxBytes) {
			await reader.cancel().catch(() => {});
			return {
				ok: false,
				status: response.status,
				error: `Image is larger than ${maxBytes} bytes`,
				reason: "oversize",
			};
		}
		total += read.value.byteLength;
		chunks.push(read.value);
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { ok: true, bytes: bytes.buffer, contentType };
}

/** Cancel a response body that is not going to be read, ignoring failures. */
async function discardBody(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => {});
}
