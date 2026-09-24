// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * One-click unsubscribe (RFC 8058) helpers.
 *
 * A sender advertises unsubscribe endpoints in two headers:
 *
 *   List-Unsubscribe: <https://example.com/unsub?u=…>, <mailto:unsub@example.com>
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *
 * The https target is the one-click POST destination; the mailto target is a
 * UI concern (the composer, not the server, may offer to send it — this
 * module never sends mail). This file parses those stored header values and
 * performs exactly one request — a POST of `List-Unsubscribe=One-Click` —
 * through the SSRF guard in ./ssrf-guard.
 *
 * Guardrails: nothing here runs automatically and no agent/MCP tool exposes
 * it. The only production caller is the explicit operator action
 * (POST /api/v1/mailboxes/:mailboxId/emails/:id/unsubscribe), so a
 * sender-controlled URL can never be fetched by a model or by delivery.
 */

import { guardedFetch, type GuardedFetchResult } from "./ssrf-guard";

/** The RFC 8058 marker that advertises a one-click POST target. */
const ONE_CLICK_MARKER = "list-unsubscribe=one-click";

/** The form body RFC 8058 mandates for a one-click POST. */
const ONE_CLICK_BODY = "List-Unsubscribe=One-Click";

/** The targets a stored List-Unsubscribe header carries. */
export interface UnsubscribeTargets {
	/** The https: target (the one-click POST destination), or null when absent. */
	httpsUrl: string | null;
	/** The mailto: target (a UI concern; never posted to), or null when absent. */
	mailto: string | null;
}

/**
 * Split a List-Unsubscribe header into its entries. Commas inside angle
 * brackets belong to the entry (URLs may legitimately contain them), so only
 * top-level commas separate entries.
 */
function splitHeaderEntries(raw: string): string[] {
	const entries: string[] = [];
	let depth = 0;
	let current = "";
	for (const char of raw) {
		if (char === "<") depth += 1;
		else if (char === ">") depth = Math.max(0, depth - 1);
		if (char === "," && depth === 0) {
			entries.push(current);
			current = "";
		} else {
			current += char;
		}
	}
	entries.push(current);
	return entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/** Strip the optional angle brackets RFC 2369 wraps around an entry. */
function unwrapEntry(entry: string): string {
	const trimmed = entry.trim();
	if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

/**
 * Parse a stored List-Unsubscribe header into its https and mailto targets.
 *
 * Handles `<https://…>, <mailto:…>` and bare comma-separated forms, and
 * multiple entries: the first https: entry wins (it is the one-click
 * destination) and the first mailto: entry is reported for the UI. Returns
 * nulls for absent or unusable values; scheme matching is case-insensitive.
 */
export function parseUnsubscribeHeader(raw: string | null | undefined): UnsubscribeTargets {
	const targets: UnsubscribeTargets = { httpsUrl: null, mailto: null };
	if (!raw) return targets;

	for (const entry of splitHeaderEntries(raw)) {
		const value = unwrapEntry(entry);
		const scheme = value.toLowerCase();
		if (targets.httpsUrl === null && scheme.startsWith("https:")) {
			targets.httpsUrl = value;
		} else if (targets.mailto === null && scheme.startsWith("mailto:")) {
			targets.mailto = value;
		}
	}

	return targets;
}

/**
 * Does a stored List-Unsubscribe-Post header advertise a one-click POST?
 * RFC 8058 fixes the value to `List-Unsubscribe=One-Click`; the match is
 * case-insensitive and tolerates comma-separated extra options.
 */
export function isOneClickUnsubscribe(postHeader: string | null | undefined): boolean {
	if (!postHeader) return false;
	return postHeader
		.split(",")
		.map((part) => part.trim().replace(/\s+/g, "").toLowerCase())
		.includes(ONE_CLICK_MARKER);
}

/**
 * POST the RFC 8058 one-click body to `url`, through the SSRF guard.
 * Never throws: a guard refusal or a failed request comes back as
 * `{ ok: false, error }` so the route can answer 502 without a stack trace.
 */
export async function sendOneClickUnsubscribe(
	url: string,
	fetchImpl?: typeof fetch,
): Promise<GuardedFetchResult> {
	return guardedFetch(
		url,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: ONE_CLICK_BODY,
		},
		fetchImpl,
	);
}

/**
 * Pull the two unsubscribe headers out of a parsed message's header list.
 *
 * postal-mime lowercases `key` (the original casing survives in
 * `originalKey`); tests/unsubscribe.test.ts pins that behaviour, but both
 * sides are lowercased here anyway so a parser change or a hand-built header
 * array cannot silently drop the headers.
 */
export function extractUnsubscribeHeaders(
	headers: { key: string; value: string }[] | undefined,
): { listUnsubscribe: string | null; listUnsubscribePost: string | null } {
	const find = (name: string): string | null => {
		const wanted = name.toLowerCase();
		for (const header of headers ?? []) {
			if (header.key.toLowerCase() === wanted) return header.value;
		}
		return null;
	};
	return {
		listUnsubscribe: find("list-unsubscribe"),
		listUnsubscribePost: find("list-unsubscribe-post"),
	};
}
