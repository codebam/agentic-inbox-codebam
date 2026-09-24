// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Signature settings and rendering shared by the composer (client-side
 * prefill), the draft API (server-side `applySignature`) and the agent/MCP
 * draft tools.
 *
 * The module is pure and DOM-free so the same output is produced inside
 * workerd and in the browser. `sanitizeSignatureHtml` is an allowlist
 * sanitizer (not a full HTML parser): it drops scripts, event handlers and
 * dangerous URL schemes while keeping the formatting people use in email
 * signatures (bold, italics, links, lists, tables, images).
 */


export interface SignatureSettings {
	enabled: boolean;
	text: string;
	html?: string;
}


/** Inline style of the wrapper `<div>` around every rendered signature. */
export const SIGNATURE_WRAPPER_STYLE =
	"border-top: 1px solid #ccc; margin-top: 16px; padding-top: 12px;";


/** Tags kept as-is; anything else is dropped while its text content is kept. */
const ALLOWED_TAGS = new Set([
	"a", "b", "blockquote", "br", "code", "div", "em", "font", "h1", "h2",
	"h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre", "s",
	"small", "span", "strike", "strong", "sub", "sup", "table", "tbody",
	"td", "tfoot", "th", "thead", "tr", "u", "ul",
]);


const VOID_TAGS = new Set(["br", "hr", "img"]);


/**
 * Tags whose entire content is removed (not just the tag itself): their
 * content is executable, invisible or form UI, none of which belongs in a
 * signature.
 */
const DROP_CONTENT_TAGS = [
	"script", "style", "iframe", "object", "embed", "template", "noscript",
	"title", "svg", "math", "form", "textarea", "select", "button",
	"input", "link", "meta", "base",
];


const ALLOWED_ATTRS = new Set([
	"align", "alt", "bgcolor", "border", "cellpadding", "cellspacing",
	"class", "colspan", "color", "face", "height", "href", "rel", "rowspan",
	"size", "src", "style", "target", "title", "valign", "width",
]);


const URL_ATTRS = new Set(["href", "src", "background", "poster"]);


/** Escape the five OWASP-recommended HTML special characters. */
export function escapeSignatureText(text: string): string {
	if (!text) return "";
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}


/**
 * Escape an attribute value without double-escaping existing entities, so
 * `sanitizeSignatureHtml` is idempotent (`sanitize(sanitize(x)) === sanitize(x)`).
 */
function escapeAttributeValue(value: string): string {
	return value
		.replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}


/** Decode numeric/named entities so `java&#115;cript:` cannot slip past a URL check. */
function decodeEntitiesForCheck(value: string): string {
	return value
		.replace(/&#x([0-9a-f]{1,6});?/gi, (_match, hex: string) =>
			codePointToString(Number.parseInt(hex, 16)),
		)
		.replace(/&#(\d{1,7});?/g, (_match, dec: string) =>
			codePointToString(Number(dec)),
		)
		.replace(/&(?:amp|quot|apos|colon|tab|newline|lt|gt|nbsp);/gi, "");
}


function codePointToString(code: number): string {
	if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
	try {
		return String.fromCodePoint(code);
	} catch {
		return "";
	}
}


/** Reject `javascript:`, `vbscript:` and friends, including entity-smuggled forms. */
function isSafeUrl(value: string): boolean {
	const normalized = decodeEntitiesForCheck(value)
		.replace(/[\u0000-\u0020\u007f]+/g, "")
		.toLowerCase();
	return !/^(?:javascript|vbscript|data|blob|file):/.test(normalized);
}


/** Reject CSS that can execute or fetch (expression(), javascript:, behavior:). */
function isSafeStyle(value: string): boolean {
	const normalized = decodeEntitiesForCheck(value).toLowerCase();
	return !/(?:expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding)/.test(
		normalized,
	);
}


/** Remove comments and every tag whose content must never survive. */
function stripDangerousBlocks(html: string): string {
	let out = html;
	for (const tag of DROP_CONTENT_TAGS) {
		out = out.replace(
			new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"),
			"",
		);
		// Unclosed tag: drop everything from the opening tag onwards.
		out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "gi"), "");
	}
	return out
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<!--[\s\S]*$/g, "");
}


/** Index of the `>` that closes a tag, ignoring `>` inside quoted values. */
function findTagEnd(html: string, start: number): number {
	let quote: string | null = null;
	for (let index = start; index < html.length; index++) {
		const char = html[index];
		if (quote) {
			if (char === quote) quote = null;
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === ">") {
			return index;
		}
	}
	return -1;
}


const ATTRIBUTE_PATTERN =
	/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;


function sanitizeAttributes(source: string): string {
	let out = "";
	ATTRIBUTE_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = ATTRIBUTE_PATTERN.exec(source)) !== null) {
		const name = match[1].toLowerCase();
		// Event handlers and inline JS-adjacent attributes never survive.
		if (name.startsWith("on") || name.startsWith("xmlns")) continue;
		if (!ALLOWED_ATTRS.has(name)) continue;
		const value = match[2] ?? match[3] ?? match[4] ?? "";
		if (URL_ATTRS.has(name) && !isSafeUrl(value)) continue;
		if (name === "style" && !isSafeStyle(value)) continue;
		out += ` ${name}="${escapeAttributeValue(value)}"`;
	}
	return out;
}


/** Sanitize a single raw tag (`<a href="...">`, `</p>`, ...). */
function sanitizeTag(raw: string): string {
	const inner = raw.slice(1, -1).trim();
	if (!inner) return "";
	const closing = inner.startsWith("/");
	const body = closing ? inner.slice(1).trim() : inner;
	const nameMatch = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(body);
	if (!nameMatch) return ""; // doctype, processing instruction, bogus markup
	const name = nameMatch[1].toLowerCase();
	if (!ALLOWED_TAGS.has(name)) return ""; // drop the tag, keep its content
	if (closing) return `</${name}>`;
	const attributes = sanitizeAttributes(
		body.slice(nameMatch[1].length).replace(/\/\s*$/, ""),
	);
	return VOID_TAGS.has(name) ? `<${name}${attributes}>` : `<${name}${attributes}>`;
}


/**
 * Allowlist-sanitize signature HTML. Idempotent: sanitizing an already
 * sanitized string returns it unchanged.
 */
export function sanitizeSignatureHtml(html: string): string {
	if (!html) return "";
	const source = stripDangerousBlocks(html);
	let out = "";
	let cursor = 0;
	while (cursor < source.length) {
		const open = source.indexOf("<", cursor);
		if (open === -1) {
			out += source.slice(cursor);
			break;
		}
		out += source.slice(cursor, open);
		if (source.startsWith("<!--", open)) {
			const commentEnd = source.indexOf("-->", open + 4);
			cursor = commentEnd === -1 ? source.length : commentEnd + 3;
			continue;
		}
		const close = findTagEnd(source, open + 1);
		if (close === -1) {
			// A stray "<" cannot open a tag; escape it and keep scanning.
			out += "&lt;";
			cursor = open + 1;
			continue;
		}
		out += sanitizeTag(source.slice(open, close + 1));
		cursor = close + 1;
	}
	return out;
}


/**
 * Normalize arbitrary stored signature JSON into the settings shape.
 * Returns undefined when nothing usable is present.
 */
export function normalizeSignatureSettings(
	raw: unknown,
): SignatureSettings | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const value = raw as { enabled?: unknown; text?: unknown; html?: unknown };
	const html = typeof value.html === "string" ? value.html.trim() : "";
	const text = typeof value.text === "string" ? value.text.trim() : "";
	return {
		enabled: value.enabled === true,
		text,
		...(html ? { html } : {}),
	};
}


/**
 * Build the HTML signature block, or "" when the signature is disabled or
 * empty. Text signatures are escaped (newlines become `<br>`); HTML
 * signatures are sanitized.
 */
export function buildSignatureBlock(
	signature?: SignatureSettings | null,
): string {
	if (!signature || signature.enabled !== true) return "";
	const html = typeof signature.html === "string" ? signature.html.trim() : "";
	const text = typeof signature.text === "string" ? signature.text : "";
	if (!html && !text.trim()) return "";
	const content = html
		? sanitizeSignatureHtml(html)
		: escapeSignatureText(text).replace(/\n/g, "<br>");
	if (!content.trim()) return "";
	return `<div style="${SIGNATURE_WRAPPER_STYLE}">${content}</div>`;
}


/**
 * Append a mailbox signature to a draft body.
 *
 * Idempotent: a body that already contains the same block is returned
 * unchanged, so re-saving or re-running a draft path can never produce a
 * second signature. When the body ends in a quoted reply block the signature
 * is inserted above it, matching the composer's reply prefill.
 */
export function applySignatureToBody(
	body: string,
	signature?: SignatureSettings | null,
): string {
	const block = buildSignatureBlock(signature);
	if (!block) return body;
	if (!body) return block;
	if (body.includes(block)) return body;
	const trailingQuote = body.match(
		/(\s*(?:<br\s*\/?>\s*)?<blockquote[\s\S]*<\/blockquote>\s*)$/i,
	);
	if (trailingQuote?.index !== undefined) {
		const head = body.slice(0, trailingQuote.index);
		const separator = head.trim() ? "<br>" : "";
		return `${head}${separator}${block}${trailingQuote[0]}`;
	}
	return `${body}<br>${block}`;
}
