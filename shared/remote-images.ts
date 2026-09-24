// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Remote-image blocking for email bodies, shared by the browser UI, the
 * Worker and unit tests.
 *
 * Email HTML routinely carries remote images that double as tracking pixels:
 * one load tells the sender the message was opened, when, and from which IP.
 * Messages therefore render with remote images blocked, and only load them
 * after the user opts in — per message ("Show images", session only) or per
 * sender (the mailbox's `imageAllowlist`).
 *
 * The rewriting is deliberately DOM-free so the same code runs in the browser
 * bundle, in the Worker, and in vitest without a DOM. `cid:` and `data:`
 * images are never touched: they are part of the message (inline attachments
 * are rewritten to same-origin API URLs before rendering) and cannot phone
 * home.
 *
 * Follow-up (not this wave): a Worker/Cloudflare-Images proxy that fetches
 * remote images server-side. An open proxy is an SSRF risk, so it needs a
 * destination allowlist plus size/type limits before it can ship.
 */

/** 1x1 transparent GIF used as the stand-in for every blocked remote image. */
export const BLOCKED_IMAGE_DATA_URI =
	"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Cap on the per-mailbox sender allowlist; keeps stored settings bounded. */
export const MAX_IMAGE_ALLOWLIST_ENTRIES = 100;

/** Longest accepted allowlist entry (RFC 5321 caps an address at 320 chars). */
const MAX_ALLOWLIST_ENTRY_LENGTH = 320;

/** `<img ...>` tags, tolerating quoted attribute values that contain `>`. */
const IMG_TAG_RE = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

/** A srcset candidate URL: preceded by the value start, whitespace or comma. */
const SRCSET_CANDIDATE_RE = /(^|[\s,])((?:https?:)?\/\/[^\s,]+)/gi;

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/;

function isWhitespace(ch: string): boolean {
	return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

/**
 * True when `url` points at a remote host, i.e. it would load over the
 * network the moment the message is opened:
 *   - absolute `http:`/`https:` URLs (scheme is case-insensitive),
 *   - protocol-relative `//host/...` URLs, which inherit the page scheme.
 *
 * `cid:`, `data:`, `blob:`, relative and same-origin URLs are not remote.
 * Control characters browsers ignore while parsing URLs are stripped first,
 * so a `ht\ntp://` style obfuscation cannot slip past the check.
 */
export function isRemoteImageUrl(url: string): boolean {
	if (typeof url !== "string") return false;
	const cleaned = url.replace(/[\u0000-\u0020]/g, "");
	return /^(?:https?:)?\/\//i.test(cleaned);
}

/**
 * Rewrite the remote candidate URLs inside one `srcset` value, keeping
 * descriptors (`2x`, `640w`) and non-remote candidates (`cid:`, `data:`)
 * intact. Values are scanned rather than split on commas because `data:`
 * URIs legitimately contain commas.
 */
function blockRemoteSrcset(value: string): { value: string; count: number } {
	let count = 0;
	const rewritten = value.replace(SRCSET_CANDIDATE_RE, (_match, separator: string) => {
		count++;
		return `${separator}${BLOCKED_IMAGE_DATA_URI}`;
	});
	return { value: rewritten, count };
}

/**
 * Rewrite a single `<img ...>` tag: every remote `src`/`srcset` value becomes
 * the placeholder. Attribute names are matched case-insensitively and
 * everything else in the tag is copied byte for byte, so attribute values of
 * other attributes (e.g. `alt="src=..."`) are never rewritten.
 */
function rewriteImgTag(tag: string): { tag: string; blockedCount: number } {
	const len = tag.length;
	let i = 4; // past `<img`
	let out = tag.slice(0, i);
	let blockedCount = 0;

	while (i < len) {
		const ch = tag[i];
		if (ch === ">" || ch === "/") {
			out += tag.slice(i);
			break;
		}
		if (isWhitespace(ch)) {
			out += ch;
			i++;
			continue;
		}

		// Attribute name.
		const nameStart = i;
		while (i < len) {
			const c = tag[i];
			if (c === "=" || c === ">" || c === "/" || isWhitespace(c)) break;
			i++;
		}
		const name = tag.slice(nameStart, i);

		// Whitespace, `=` and whitespace between name and value.
		const separatorStart = i;
		while (i < len && isWhitespace(tag[i])) i++;
		const hasEquals = i < len && tag[i] === "=";
		if (hasEquals) {
			i++;
			while (i < len && isWhitespace(tag[i])) i++;
		}
		const separator = tag.slice(separatorStart, i);
		if (!hasEquals) {
			out += name + separator;
			continue;
		}

		// Value, quoted or unquoted.
		let quote = "";
		let value = "";
		if (i < len && (tag[i] === '"' || tag[i] === "'")) {
			quote = tag[i];
			const valueStart = ++i;
			while (i < len && tag[i] !== quote) i++;
			value = tag.slice(valueStart, i);
			if (i < len) i++; // closing quote
		} else {
			const valueStart = i;
			while (i < len && !isWhitespace(tag[i]) && tag[i] !== ">") i++;
			value = tag.slice(valueStart, i);
		}

		const lowerName = name.toLowerCase();
		if (lowerName === "src" && isRemoteImageUrl(value)) {
			blockedCount++;
			// Unquoted values cannot hold the placeholder (`=` is illegal
			// there), so a blocked unquoted src comes back quoted.
			out += `${name}${separator}${quote || '"'}${BLOCKED_IMAGE_DATA_URI}${quote || '"'}`;
		} else if (lowerName === "srcset") {
			const blocked = blockRemoteSrcset(value);
			if (blocked.count > 0) {
				blockedCount += blocked.count;
				out += `${name}${separator}${quote || '"'}${blocked.value}${quote || '"'}`;
			} else {
				out += `${name}${separator}${quote}${value}${quote}`;
			}
		} else {
			out += `${name}${separator}${quote}${value}${quote}`;
		}
	}

	return { tag: out, blockedCount };
}

export interface BlockedImagesResult {
	/** The body with every remote image reference swapped for the placeholder. */
	html: string;
	/** How many references were blocked (one per remote src/srcset candidate). */
	blockedCount: number;
}

/**
 * Produce the blocked variant of an email body: every remote `img` src/srcset
 * becomes a 1x1 transparent data URI, while `cid:`/`data:` images and all
 * other markup pass through untouched.
 */
export function blockRemoteImages(html: string): BlockedImagesResult {
	if (!html) return { html: html ?? "", blockedCount: 0 };
	let blockedCount = 0;
	const blocked = html.replace(IMG_TAG_RE, (tag) => {
		const result = rewriteImgTag(tag);
		blockedCount += result.blockedCount;
		return result.tag;
	});
	return { html: blocked, blockedCount };
}

/** True when the body contains at least one remote image reference. */
export function hasRemoteImages(html: string): boolean {
	if (!html) return false;
	return blockRemoteImages(html).blockedCount > 0;
}

/**
 * Content-Security-Policy for the sandboxed email iframe (defense in depth on
 * top of the rewriting above).
 *
 * Images are the only resource a body may load. With remote images blocked,
 * `img-src` allows `data:`, `cid:` and the app's own origin (`appOrigin`):
 * inline attachments are rewritten to same-origin API URLs, so they keep
 * working while every remote host stays blocked. With remote images allowed
 * the iframe additionally allows `https:`.
 */
export function buildEmailIframeCsp(
	allowRemoteImages: boolean,
	appOrigin = "",
): string {
	const imageSources = allowRemoteImages
		? "data: cid: https:"
		: appOrigin
			? `data: cid: ${appOrigin}`
			: "data: cid:";
	return `default-src 'none'; style-src 'unsafe-inline'; img-src ${imageSources}; script-src 'unsafe-inline';`;
}

/**
 * The bare address inside a sender value: `"Ada <ada@example.com>"` and
 * `"ada@example.com"` both yield `"ada@example.com"`, lowercased. Returns an
 * empty string when no address can be found.
 */
export function senderAddress(sender: string | null | undefined): string {
	if (typeof sender !== "string") return "";
	const bracketed = sender.match(/<([^<>]+)>/);
	const raw = (bracketed ? bracketed[1] : sender).trim().toLowerCase();
	return raw.startsWith("mailto:") ? raw.slice("mailto:".length) : raw;
}

/** An allowlist entry is a bare address, or `@domain` for a whole domain. */
function isValidAllowlistEntry(value: string): boolean {
	if (value.startsWith("@")) return DOMAIN_RE.test(value.slice(1));
	return EMAIL_RE.test(value);
}

/**
 * Turn arbitrary stored JSON into a safe allowlist: lowercase, trimmed,
 * deduped, validated and capped. Accepts exact addresses
 * (`alerts@example.com`) and domain entries (`@example.com`); anything else is
 * dropped, so a hand-edited settings file cannot smuggle junk in.
 */
export function normalizeImageAllowlist(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const allowlist: string[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const value = trimmed.startsWith("@")
			? trimmed.toLowerCase()
			: senderAddress(trimmed);
		if (!value || value.length > MAX_ALLOWLIST_ENTRY_LENGTH) continue;
		if (!isValidAllowlistEntry(value)) continue;
		if (seen.has(value)) continue;
		seen.add(value);
		allowlist.push(value);
		if (allowlist.length >= MAX_IMAGE_ALLOWLIST_ENTRIES) break;
	}
	return allowlist;
}

/**
 * True when `sender` may load remote images for a mailbox.
 *
 * Matching is exact on the address (`"Ada <ada@example.com>"` matches an
 * `ada@example.com` entry), case-insensitively, plus one explicit domain form:
 * an `@example.com` entry matches every sender at that domain. There is no
 * implicit suffix matching — an `example.com` entry (no leading `@`) never
 * matches — and subdomains are not implied.
 */
export function isSenderAllowlisted(
	sender: string,
	allowlist: readonly string[] | null | undefined,
): boolean {
	if (!allowlist || allowlist.length === 0) return false;
	const address = senderAddress(sender);
	if (!address) return false;
	for (const rawEntry of allowlist) {
		if (typeof rawEntry !== "string") continue;
		const entry = rawEntry.trim().toLowerCase();
		if (!entry) continue;
		if (entry.startsWith("@")) {
			const at = address.lastIndexOf("@");
			if (at > 0 && address.slice(at + 1) === entry.slice(1)) return true;
			continue;
		}
		// Tolerate a hand-edited display-name entry ("Ada <ada@example.com>").
		if (senderAddress(entry) === address) return true;
	}
	return false;
}
