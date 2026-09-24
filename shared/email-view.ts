// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Email view settings (HTML vs plain text) and the HTML -> plain-text
 * fallback renderer.
 *
 * The module is pure and DOM-free so the same output is produced inside
 * workerd and in the browser. `htmlToPlainText` is deliberately not a full
 * HTML parser: it handles the markup real email contains (block elements,
 * links, entities, inline formatting) and never keeps script/style content.
 */


export type EmailViewMode = "html" | "text";


/** Stable iteration order for the message-view toggle and the settings UI. */
export const EMAIL_VIEW_MODES: readonly EmailViewMode[] = ["html", "text"];


/** Built-in default view, used when neither scope configures one. */
export const DEFAULT_EMAIL_VIEW: EmailViewMode = "html";


/** Human-readable labels shared by the toggle and the settings cards. */
export const EMAIL_VIEW_LABELS: Record<EmailViewMode, string> = {
	html: "HTML",
	text: "Plain text",
};


/** App-wide email view settings stored in R2 (`config/email-view.json`). */
export interface GlobalEmailViewSettings {
	/** Blank/absent means the built-in default (`html`). */
	defaultEmailView?: EmailViewMode | undefined;
}


export function isEmailViewMode(value: unknown): value is EmailViewMode {
	return value === "html" || value === "text";
}


/**
 * Trim and validate a single view mode. Blank, null and unknown values mean
 * "inherit" and resolve to undefined.
 */
export function normalizeEmailViewMode(
	value: unknown,
): EmailViewMode | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().toLowerCase();
	return isEmailViewMode(trimmed) ? trimmed : undefined;
}


/** Read the `defaultEmailView` field of a settings object. */
function readDefaultEmailView(raw: unknown): EmailViewMode | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	return normalizeEmailViewMode(
		(raw as { defaultEmailView?: unknown }).defaultEmailView,
	);
}


/** Normalize the app-wide email view settings payload. */
export function normalizeGlobalEmailViewSettings(
	raw: unknown,
): GlobalEmailViewSettings {
	const defaultEmailView = readDefaultEmailView(raw);
	return defaultEmailView ? { defaultEmailView } : {};
}


/**
 * Resolve the effective default view: mailbox override, then the app-wide
 * setting, then the built-in default. Blank values are ignored at every level.
 */
export function resolveDefaultEmailView(
	mailboxSettings?: unknown,
	globalSettings?: unknown,
): EmailViewMode {
	return (
		readDefaultEmailView(mailboxSettings) ??
		readDefaultEmailView(globalSettings) ??
		DEFAULT_EMAIL_VIEW
	);
}


/**
 * Validate a settings payload's `defaultEmailView` for the API.
 * @returns an error message, or null when the value is usable.
 */
export function emailViewSettingError(raw: unknown): string | null {
	if (!raw || typeof raw !== "object") return null;
	const value = (raw as { defaultEmailView?: unknown }).defaultEmailView;
	// Blank, null and missing all mean "inherit" and are always acceptable.
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || !value.trim()) return null;
	return normalizeEmailViewMode(value)
		? null
		: 'Default email view must be "html", "text" or blank.';
}


// ── HTML -> plain text ─────────────────────────────────────────────


/** Elements whose content never belongs in the text rendering. */
const DROP_CONTENT_TAGS = [
	"script", "style", "head", "title", "noscript", "template", "iframe",
	"object", "embed", "svg", "canvas",
];


/** Block-level elements: every boundary becomes a line break. */
const BLOCK_TAGS = [
	"address", "article", "aside", "blockquote", "dd", "div", "dl", "dt",
	"fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
	"h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre",
	"section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
];


const COMMENT_RE = /<!--[\s\S]*?-->/g;
/** Two or more <br> in a row are a deliberate blank line. */
const MULTI_BR_RE = /(?:<br\b[^>]*>\s*){2,}/gi;
/**
 * Temporary marker for a deliberate blank line. Block boundaries collapse to
 * a single newline (so `<div>a</div><div>b</div>` reads as two lines, not
 * two lines plus an empty one); the marker is restored to "\n\n" afterwards.
 */
const BLANK_LINE_MARKER = "\u0000";
const BLOCK_BOUNDARY_RE = new RegExp(
	`<br\\b[^>]*>|<hr\\b[^>]*>|<\\/?(?:${BLOCK_TAGS.join("|")})\\b[^>]*>`,
	"gi",
);
const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const HREF_RE = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const TAG_RE = /<\/?[a-zA-Z][^>]*>/g;
const UNSAFE_URL_RE = /^(?:javascript|data|vbscript):/i;


/** The named entities email actually uses; anything else is left verbatim. */
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
	nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
	mdash: "—", ndash: "–", hellip: "…",
	lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
	laquo: "«", raquo: "»", bull: "•", middot: "·",
	copy: "©", reg: "®", trade: "™", sect: "§", para: "¶",
	deg: "°", plusmn: "±", times: "×", divide: "÷", frac12: "½",
	euro: "€", pound: "£", yen: "¥", cent: "¢",
	larr: "←", rarr: "→", harr: "↔", uarr: "↑", darr: "↓",
};


/** Decode HTML entities in a single pass (so `&amp;lt;` stays literal). */
function decodeEntities(value: string): string {
	return value.replace(
		/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
		(match, entity: string) => {
			if (entity.startsWith("#")) {
				const hex = entity[1] === "x" || entity[1] === "X";
				const code = Number.parseInt(
					hex ? entity.slice(2) : entity.slice(1),
					hex ? 16 : 10,
				);
				if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) {
					return match;
				}
				try {
					return String.fromCodePoint(code);
				} catch {
					return match;
				}
			}
			return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
		},
	);
}


/** Collapse horizontal whitespace, blank lines and surrounding padding. */
function collapseWhitespace(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		.replace(/[^\S\n]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}


/**
 * Render HTML email as readable plain text.
 *
 * - script/style/head content is dropped outright
 * - block elements and <br> become line breaks (a run of <br> keeps its blank
 *   line; consecutive block boundaries do not add one)
 * - links keep their target as `label (href)`; unsafe URL schemes are dropped
 * - entities are decoded and whitespace is collapsed
 */
export function htmlToPlainText(html: string): string {
	if (typeof html !== "string" || html.length === 0) return "";

	let text = html.replace(COMMENT_RE, "").replaceAll(BLANK_LINE_MARKER, "");
	for (const tag of DROP_CONTENT_TAGS) {
		text = text.replace(
			new RegExp(`<${tag}\\b[^>]*(?:/>|>[\\s\\S]*?<\\/${tag}\\s*>|>[\\s\\S]*$)`, "gi"),
			"",
		);
	}

	text = text.replace(ANCHOR_RE, (_match, attrs: string, inner: string) => {
		const label = collapseWhitespace(inner.replace(TAG_RE, " "));
		const href = HREF_RE.exec(attrs);
		const rawUrl = (href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
		const url =
			rawUrl && !UNSAFE_URL_RE.test(rawUrl) ? decodeEntities(rawUrl) : "";
		if (!url) return label;
		if (!label || label === url || label.includes(url)) return label || url;
		return `${label} (${url})`;
	});

	text = text.replace(MULTI_BR_RE, BLANK_LINE_MARKER);
	text = text.replace(BLOCK_BOUNDARY_RE, "\n");
	// Consecutive block boundaries are one line break, never a blank line.
	text = text.replace(/\n{2,}/g, "\n");
	text = text.replaceAll(BLANK_LINE_MARKER, "\n\n");
	text = text.replace(TAG_RE, "");
	text = decodeEntities(text);
	return collapseWhitespace(text);
}
