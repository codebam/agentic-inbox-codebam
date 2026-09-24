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
 * Opted-in remote images are not loaded from the sender's servers directly,
 * either: `proxyRemoteImages` rewrites every https or protocol-relative
 * candidate to the same-origin `/api/v1/mailboxes/<id>/image-proxy` route,
 * so the Worker fetches it through the shared SSRF guard
 * (workers/lib/ssrf-guard.ts) and the sender only ever sees Cloudflare's
 * egress. `http:` candidates cannot be relayed (the guard is https-only) and
 * are left for the iframe CSP to block, which is why the CSP never allows
 * `https:`.
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

/** Whitespace the tag parser skips; an out-of-range read (`undefined`) is not whitespace. */
function isWhitespace(ch: string | undefined): boolean {
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
	// eslint-disable-next-line no-control-regex -- deliberate: control characters are what browsers strip while parsing a URL
	const cleaned = url.replace(/[\u0000-\u0020]/g, "");
	return /^(?:https?:)?\/\//i.test(cleaned);
}

/** A rewritten attribute value plus how many references it replaced. */
interface RewrittenValue {
	value: string;
	count: number;
}


/**
 * How one `<img>` tag's `src`/`srcset` values are rewritten: each callback
 * returns the replacement (and how many references it covered), or null to
 * keep the original value byte for byte. Blocking and the proxy differ only
 * in these callbacks, so the tag walker — the fiddly part — is shared and
 * the two modes cannot drift apart.
 */
interface ImageRewriter {
	src: (value: string) => RewrittenValue | null;
	srcset: (value: string) => RewrittenValue | null;
}


/**
 * Rewrite the candidate URLs inside one `srcset` value, keeping descriptors
 * (`2x`, `640w`) intact. Values are scanned rather than split on commas
 * because `data:` URIs legitimately contain commas, and a candidate the
 * callback declines is copied back unchanged.
 */
function rewriteSrcsetCandidates(
	value: string,
	rewriteCandidate: (url: string) => string | null,
): RewrittenValue | null {
	let count = 0;
	const rewritten = value.replace(
		SRCSET_CANDIDATE_RE,
		(match: string, separator: string, candidate: string) => {
			const replacement = rewriteCandidate(candidate);
			if (replacement === null) return match;
			count++;
			return `${separator}${replacement}`;
		},
	);
	return count > 0 ? { value: rewritten, count } : null;
}

/**
 * Rewrite a single `<img ...>` tag through `rewriter`: each `src`/`srcset`
 * value the rewriter accepts is replaced, and everything else in the tag is
 * copied byte for byte. Attribute names are matched case-insensitively, so
 * attribute values of other attributes (e.g. `alt="src=..."`) are never
 * rewritten.
 */
function rewriteImgTag(
	tag: string,
	rewriter: ImageRewriter,
): { tag: string; rewriteCount: number } {
	const len = tag.length;
	let i = 4; // past `<img`
	let out = tag.slice(0, i);
	let rewriteCount = 0;

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
		let value: string;
		if (i < len && (tag[i] === '"' || tag[i] === "'")) {
			quote = tag[i] ?? "";
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
		const rewritten =
			lowerName === "src"
				? rewriter.src(value)
				: lowerName === "srcset"
					? rewriter.srcset(value)
					: null;
		if (rewritten) {
			rewriteCount += rewritten.count;
			// A rewritten unquoted value comes back quoted: the replacement
			// can hold characters (`=`, `&`) that are legal in a quoted
			// attribute but not in an unquoted one.
			out += `${name}${separator}${quote || '"'}${rewritten.value}${quote || '"'}`;
		} else {
			out += `${name}${separator}${quote}${value}${quote}`;
		}
	}

	return { tag: out, rewriteCount };
}

/** The blocking rewriter: every remote reference becomes the placeholder. */
const BLOCKING_REWRITER: ImageRewriter = {
	src: (value) =>
		isRemoteImageUrl(value) ? { value: BLOCKED_IMAGE_DATA_URI, count: 1 } : null,
	srcset: (value) =>
		rewriteSrcsetCandidates(value, (candidate) =>
			isRemoteImageUrl(candidate) ? BLOCKED_IMAGE_DATA_URI : null,
		),
};


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
		const result = rewriteImgTag(tag, BLOCKING_REWRITER);
		blockedCount += result.rewriteCount;
		return result.tag;
	});
	return { html: blocked, blockedCount };
}

/** True when the body contains at least one remote image reference. */
export function hasRemoteImages(html: string): boolean {
	if (!html) return false;
	return blockRemoteImages(html).blockedCount > 0;
}


// ── Same-origin image proxy ────────────────────────────────────────


/**
 * The absolute https URL behind one image reference, or null when the proxy
 * must leave it alone: only `https:` and protocol-relative (`//host/...`)
 * references can be relayed, while `http:` (the guard is https-only),
 * `cid:` and `data:` can never be.
 *
 * Control characters browsers ignore while parsing a URL are stripped first
 * (the same cleaning `isRemoteImageUrl` applies), so a newline inside the
 * scheme cannot keep an unproxied reference past the rewrite.
 */
function proxiedHttpsUrl(value: string): string | null {
	// eslint-disable-next-line no-control-regex -- deliberate: control characters are what browsers strip while parsing a URL
	const cleaned = value.replace(/[\u0000-\u0020]/g, "");
	if (/^https:\/\//i.test(cleaned)) return cleaned;
	if (cleaned.startsWith("//")) return `https:${cleaned}`;
	return null;
}


/**
 * The same-origin image-proxy route for one mailbox: the route fetches and
 * caches the image server-side (workers/lib/image-proxy).
 */
function proxyImageRoute(absoluteHttpsUrl: string, mailboxId: string): string {
	return `/api/v1/mailboxes/${mailboxId}/image-proxy?url=${encodeURIComponent(absoluteHttpsUrl)}`;
}


export interface ProxiedImagesResult {
	/** The body with every relayable remote image rewritten to the proxy route. */
	html: string;
	/** How many references were rewritten (one per src/srcset candidate). */
	proxiedCount: number;
}


/**
 * Produce the proxied variant of an opted-in email body: every `https:` and
 * protocol-relative `img` src/srcset candidate is routed through the
 * same-origin image proxy, so the sender's server never sees the reader's
 * IP. `http:`, `cid:`, `data:` and all other markup pass through untouched —
 * `http:` cannot be relayed (the guard is https-only) and is left to the
 * iframe CSP to block, while `cid:`/`data:` images are part of the message.
 *
 * An empty `mailboxId` (a caller with no mailbox to attribute the route to)
 * returns the body unchanged, so the browser never receives a proxy route it
 * cannot use.
 */
export function proxyRemoteImages(
	html: string,
	mailboxId: string,
): ProxiedImagesResult {
	if (!html || !mailboxId) return { html: html ?? "", proxiedCount: 0 };

	const rewriter: ImageRewriter = {
		src: (value) => {
			const absolute = proxiedHttpsUrl(value);
			return absolute
				? { value: proxyImageRoute(absolute, mailboxId), count: 1 }
				: null;
		},
		srcset: (value) =>
			rewriteSrcsetCandidates(value, (candidate) => {
				const absolute = proxiedHttpsUrl(candidate);
				return absolute ? proxyImageRoute(absolute, mailboxId) : null;
			}),
	};

	let proxiedCount = 0;
	const proxied = html.replace(IMG_TAG_RE, (tag) => {
		const result = rewriteImgTag(tag, rewriter);
		proxiedCount += result.rewriteCount;
		return result.tag;
	});
	return { html: proxied, proxiedCount };
}

/**
 * Content-Security-Policy for the sandboxed email iframe (defense in depth on
 * top of the rewriting above).
 *
 * Images are the only resource a body may load, and the only sources are
 * inline material (`data:`, `cid:`) and the app's own origin (`appOrigin`):
 * inline attachments are rewritten to same-origin API URLs, and opted-in
 * remote images were rewritten to same-origin proxy route URLs by
 * `proxyRemoteImages`, so `https:` is never allowed.
 *
 * The policy is deliberately identical in both modes — the proxy made the
 * image sources mode-independent. Keeping `https:` out even when remote
 * images are allowed means a reference that somehow escaped the rewriting
 * (an unparseable URL, an `http:` one the proxy cannot relay) stays blocked
 * instead of leaking the reader's IP to the sender, while the proxy route
 * keeps working because it is on the app origin. `allowRemoteImages` stays in
 * the signature — the caller passes the mode it rendered the body in — but it
 * no longer selects a source list.
 */
export function buildEmailIframeCsp(
	allowRemoteImages: boolean,
	appOrigin = "",
): string {
	// Both modes resolve to the same sources; see the doc comment above.
	void allowRemoteImages;
	const imageSources = appOrigin ? `data: cid: ${appOrigin}` : "data: cid:";
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
	const raw = (bracketed?.[1] ?? sender).trim().toLowerCase();
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
