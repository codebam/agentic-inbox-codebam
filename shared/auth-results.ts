// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Email authentication results parsed out of the stored `raw_headers` audit
 * trail: `Authentication-Results` (RFC 8601) with a `Received-SPF` fallback.
 *
 * Pure module — no I/O, no DOM — so the Worker, the Durable Object, the agent,
 * and the inbox UI all read the same values. Parsing never throws: absent or
 * malformed headers produce an empty result (`{}`), never a half-parsed badge.
 *
 * Deliberate choices:
 *   - Header names match case-insensitively (`authentication-results`,
 *     `Authentication-Results`, ...). `X-Authentication-Results` is not
 *     matched: it predates RFC 8601 and its authserv-id conventions vary too
 *     much to trust.
 *   - Only the standard result tokens (see AUTH_RESULT_TOKENS) are accepted. A
 *     method whose result token is unknown (`spf=whatever`) is treated as
 *     malformed and skipped — rendering an unrecognized token as a trust badge
 *     would mis-signal the outcome.
 *   - A message may carry several `dkim=` entries (one per signature). DKIM is
 *     therefore reported as `pass` when at least one signature verified, and
 *     as the first entry otherwise. SPF and DMARC are single-valued per hop,
 *     so for those the first entry encountered wins.
 *   - Entries are scanned in stored header order: the first header in the
 *     array is the topmost one, i.e. the most recent hop to add a result.
 *   - Comments (`(...)`) are stripped before splitting on `;`, so nested
 *     parentheses and semicolons inside a reason never break the parse.
 */


/** Standard RFC 8601 result tokens (plus SPF's `softfail`). */
export const AUTH_RESULT_TOKENS = [
	"pass",
	"fail",
	"softfail",
	"neutral",
	"none",
	"temperror",
	"permerror",
	"policy",
] as const;


export type AuthResultToken = (typeof AUTH_RESULT_TOKENS)[number];


/** Authentication methods the inbox explains; everything else is ignored. */
export type AuthMethod = "spf" | "dkim" | "dmarc";


export interface AuthMethodResult {
	method: AuthMethod;
	/** Normalized result token. */
	result: AuthResultToken;
	/** Domain the result applies to, when one could be determined. */
	domain?: string;
	/**
	 * Raw entry this result was read from: the `method=result` segment for
	 * `Authentication-Results`, the header value for `Received-SPF`.
	 */
	raw: string;
	/** Header the entry came from. */
	headerName: "Authentication-Results" | "Received-SPF";
	/** Full raw header value (comments included), for tooltips/expansion. */
	headerValue: string;
	/** authserv-id of the containing header, when present. */
	authservId?: string;
}


export interface AuthResults {
	spf?: AuthMethodResult;
	dkim?: AuthMethodResult;
	dmarc?: AuthMethodResult;
}


/** One `{key, value}` pair as stored in `emails.raw_headers`. */
export interface RawHeaderEntry {
	key: string;
	value: string;
}


const AUTH_RESULT_TOKEN_SET: ReadonlySet<string> = new Set(AUTH_RESULT_TOKENS);
const METHODS: readonly AuthMethod[] = ["spf", "dkim", "dmarc"];
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const METHOD_ENTRY_RE = /^([a-z][a-z0-9_-]*)\s*=\s*([a-z][a-z0-9_-]*)/i;
const PROPERTY_RE = /([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)?)\s*=\s*("[^"]*"|[^\s;]+)/gi;


function isAuthResultToken(token: string): token is AuthResultToken {
	return AUTH_RESULT_TOKEN_SET.has(token);
}


function isAuthMethod(value: string): value is AuthMethod {
	return (METHODS as readonly string[]).includes(value);
}


/**
 * Remove RFC 5322 comments (which may nest and contain `;`) while keeping
 * quoted strings intact, so splitting on `;` afterwards is safe.
 */
function stripComments(value: string): string {
	let out = "";
	let depth = 0;
	let inQuote = false;


	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (inQuote) {
			if (char === "\\" && index + 1 < value.length) {
				out += char + value[index + 1];
				index += 1;
				continue;
			}
			if (char === '"') inQuote = false;
			out += char;
			continue;
		}
		if (char === '"' && depth === 0) {
			inQuote = true;
			out += char;
			continue;
		}
		if (char === "(") {
			depth += 1;
			continue;
		}
		if (char === ")") {
			if (depth > 0) depth -= 1;
			continue;
		}
		if (depth === 0) out += char;
	}
	return out;
}


/** Collect `ptype.property=value` pairs from the rest of a method entry. */
function parseProperties(text: string): Record<string, string> {
	const properties: Record<string, string> = {};
	PROPERTY_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = PROPERTY_RE.exec(text)) !== null) {
		const key = match[1].toLowerCase();
		let value = match[2];
		if (value.startsWith('"') && value.endsWith('"')) {
			value = value.slice(1, -1);
		}
		properties[key] = value;
	}
	return properties;
}


/** Lowercase a domain, unwrapping `<...>`/quotes and any `@local` part. */
function normalizeDomain(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	let domain = value.trim();
	if (domain.startsWith("<") && domain.endsWith(">")) {
		domain = domain.slice(1, -1).trim();
	}
	if (domain.startsWith('"') && domain.endsWith('"')) {
		domain = domain.slice(1, -1).trim();
	}
	const at = domain.lastIndexOf("@");
	if (at >= 0) domain = domain.slice(at + 1);
	domain = domain.replace(/^\.+/, "").replace(/\.+$/, "").toLowerCase();
	if (!domain || !DOMAIN_RE.test(domain)) return undefined;
	return domain;
}


/** Domain the result is about, using the properties each method defines. */
function domainFor(
	method: AuthMethod,
	properties: Record<string, string>,
): string | undefined {
	if (method === "spf") {
		return (
			normalizeDomain(properties["smtp.mailfrom"]) ??
			normalizeDomain(properties["smtp.helo"])
		);
	}
	if (method === "dkim") {
		return (
			normalizeDomain(properties["header.d"]) ??
			normalizeDomain(properties["header.i"])
		);
	}
	return (
		normalizeDomain(properties["header.from"]) ??
		normalizeDomain(properties["header.i"])
	);
}


interface ParsedAuthEntry {
	method: AuthMethod;
	result: AuthMethodResult;
}


function parseAuthenticationResultsHeader(
	headerValue: string,
): ParsedAuthEntry[] {
	const cleaned = stripComments(headerValue.replace(/\s+/g, " ")).trim();
	const entries: ParsedAuthEntry[] = [];
	let authservId: string | undefined;


	const segments = cleaned.split(";");
	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index].trim();
		if (!segment) continue;


		const methodMatch = METHOD_ENTRY_RE.exec(segment);
		if (!methodMatch) {
			// The first segment that is not a `method=result` pair is the
			// authserv-id: the host that performed the authentication.
			if (index === 0) authservId = segment;
			continue;
		}


		const method = methodMatch[1].toLowerCase();
		const result = methodMatch[2].toLowerCase();
		if (!isAuthMethod(method) || !isAuthResultToken(result)) continue;


		const properties = parseProperties(segment.slice(methodMatch[0].length));
		const domain = domainFor(method, properties);
		entries.push({
			method,
			result: {
				method,
				result,
				...(domain ? { domain } : {}),
				raw: segment,
				headerName: "Authentication-Results",
				headerValue,
				...(authservId ? { authservId } : {}),
			},
		});
	}
	return entries;
}


/**
 * `Received-SPF: pass (…comment…) client-ip=…; envelope-from=…; helo=…`
 * Only consulted when `Authentication-Results` carried no SPF verdict.
 */
function parseReceivedSpfHeader(
	headerValue: string,
): AuthMethodResult | undefined {
	const cleaned = stripComments(headerValue.replace(/\s+/g, " ")).trim();
	const tokenMatch = /^([a-z][a-z0-9_-]*)/i.exec(cleaned);
	if (!tokenMatch) return undefined;
	const result = tokenMatch[1].toLowerCase();
	if (!isAuthResultToken(result)) return undefined;


	const properties = parseProperties(cleaned.slice(tokenMatch[0].length));
	const domain =
		normalizeDomain(properties["envelope-from"]) ??
		normalizeDomain(properties["helo"]);
	return {
		method: "spf",
		result,
		...(domain ? { domain } : {}),
		raw: cleaned,
		headerName: "Received-SPF",
		headerValue,
	};
}


/**
 * Normalize a stored `raw_headers` value into `{key, value}` pairs. Accepts the
 * JSON string as stored, an already-parsed array, or an object map (a legacy
 * shape the source-header dialog also tolerates).
 */
function headerEntries(raw: unknown): RawHeaderEntry[] {
	let value: unknown = raw;
	if (typeof value === "string") {
		if (!value.trim()) return [];
		try {
			value = JSON.parse(value);
		} catch {
			return [];
		}
	}


	if (Array.isArray(value)) {
		const entries: RawHeaderEntry[] = [];
		for (const item of value) {
			if (!item || typeof item !== "object") continue;
			const record = item as Record<string, unknown>;
			const key =
				typeof record.key === "string"
					? record.key
					: typeof record.name === "string"
						? record.name
						: "";
			const headerValue =
				typeof record.value === "string"
					? record.value
					: typeof record.value === "number"
						? String(record.value)
						: "";
			if (!key || !headerValue) continue;
			entries.push({ key, value: headerValue });
		}
		return entries;
	}


	if (value && typeof value === "object") {
		return Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => typeof item === "string" || typeof item === "number")
			.map(([key, item]) => ({ key, value: String(item) }));
	}


	return [];
}


/**
 * DKIM may have several entries (one per signature): prefer a passing one.
 * SPF/DMARC are single-valued per hop, so the first entry wins.
 */
function pickResult(
	entries: AuthMethodResult[],
	preferPass: boolean,
): AuthMethodResult | undefined {
	if (entries.length === 0) return undefined;
	if (preferPass) {
		const passed = entries.find((entry) => entry.result === "pass");
		if (passed) return passed;
	}
	return entries[0];
}


/**
 * Parse SPF/DKIM/DMARC results from a stored `raw_headers` value (JSON string
 * or already-parsed array). Returns `{}` when there is nothing usable.
 */
export function parseAuthResults(rawHeaders: unknown): AuthResults {
	const collected: Record<AuthMethod, AuthMethodResult[]> = {
		spf: [],
		dkim: [],
		dmarc: [],
	};
	let receivedSpf: AuthMethodResult | undefined;


	for (const entry of headerEntries(rawHeaders)) {
		const name = entry.key.trim().toLowerCase();
		if (name === "authentication-results") {
			for (const parsed of parseAuthenticationResultsHeader(entry.value)) {
				collected[parsed.method].push(parsed.result);
			}
		} else if (name === "received-spf" && !receivedSpf) {
			receivedSpf = parseReceivedSpfHeader(entry.value);
		}
	}


	const results: AuthResults = {};
	const spf = pickResult(collected.spf, false) ?? receivedSpf;
	if (spf) results.spf = spf;
	const dkim = pickResult(collected.dkim, true);
	if (dkim) results.dkim = dkim;
	const dmarc = pickResult(collected.dmarc, false);
	if (dmarc) results.dmarc = dmarc;
	return results;
}


/** True when at least one of SPF/DKIM/DMARC was parsed. */
export function hasAuthResults(results: AuthResults | null | undefined): boolean {
	return Boolean(results && (results.spf || results.dkim || results.dmarc));
}
