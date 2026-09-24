// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import DOMPurify from "dompurify";
import { toHtml } from "hast-util-to-html";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toHast } from "mdast-util-to-hast";
import { gfm } from "micromark-extension-gfm";
import type { Root, RootContent } from "mdast";

/**
 * Markdown helpers for the compose editor.
 *
 * The composer keeps the email body as HTML because that is what drafts store
 * and what the email service sends. Markdown mode therefore converts in both
 * directions:
 *
 * - `markdownToHtml` powers the live preview and the outgoing email body.
 * - `htmlToMarkdown` lets an existing rich-text body (reply quote, signature,
 *   loaded draft) be edited as Markdown without starting from scratch.
 */

const MARKDOWN_PATTERN =
	/(^|\n)[ \t]{0,3}(#{1,6}[ \t]|>[ \t]?|[-+*][ \t]|\d+\.[ \t]|```|~~~)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)/;

/** Heuristic used to decide whether pasted plain text is Markdown. */
export function looksLikeMarkdown(text: string): boolean {
	return MARKDOWN_PATTERN.test(text);
}

/** Render GitHub-flavored Markdown to sanitized email-safe HTML. */
export function markdownToHtml(markdown: string): string {
	if (!markdown.trim()) return "";

	const tree = fromMarkdown(markdown, {
		extensions: [gfm()],
		mdastExtensions: [gfmFromMarkdown()],
	});

	// GitHub treats a single newline as a line break; do the same so pressing
	// Enter in the composer behaves the way people expect in an email.
	splitSoftBreaks(tree);

	const html = toHtml(toHast(tree, { allowDangerousHtml: true }), {
		allowDangerousHtml: true,
	});

	// Preserve inline HTML (e.g. `<u>` or a styled `<span>`) but run the result
	// through the same sanitizer used for signatures before it reaches a draft.
	return DOMPurify.sanitize(html, {
		USE_PROFILES: { html: true },
		FORBID_TAGS: [
			"style",
			"script",
			"iframe",
			"frame",
			"object",
			"embed",
			"form",
			"meta",
			"link",
			"base",
		],
	}).trim();
}

/**
 * Convert every soft line break in the mdast tree into a `break` node, the
 * same behavior GitHub applies to comments. We walk the tree because
 * `micromark` does not expose a `breaks` option.
 */
function splitSoftBreaks(parent: Root | RootContent): void {
	if (!("children" in parent) || !Array.isArray(parent.children)) return;

	const next: RootContent[] = [];
	for (const child of parent.children) {
		if (child.type === "text" && child.value.includes("\n")) {
			child.value.split(/\r?\n/).forEach((line, index) => {
				if (index > 0) next.push({ type: "break" });
				if (line) next.push({ type: "text", value: line });
			});
			continue;
		}

		splitSoftBreaks(child);
		next.push(child);
	}

	(parent as { children: RootContent[] }).children = next;
}

/** Convert composed rich-text HTML back into Markdown for Markdown mode. */
export function htmlToMarkdown(html: string): string {
	if (!html.trim() || typeof DOMParser === "undefined") return "";

	const doc = new DOMParser().parseFromString(html, "text/html");
	if (!doc.body) return "";

	return normalizeMarkdown(serializeNode(doc.body, 0));
}

function normalizeMarkdown(markdown: string): string {
	return markdown
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const INLINE_TAGS = new Set([
	'A',
	'ABBR',
	'B',
	'BDI',
	'BDO',
	'BR',
	'CITE',
	'CODE',
	'DATA',
	'DEL',
	'DFN',
	'EM',
	'FONT',
	'I',
	'IMG',
	'INS',
	'KBD',
	'MARK',
	'Q',
	'RP',
	'RT',
	'RUBY',
	'S',
	'SAMP',
	'SMALL',
	'SPAN',
	'STRIKE',
	'STRONG',
	'SUB',
	'SUP',
	'TIME',
	'U',
	'VAR',
	'WBR',
]);

function isElement(node: Node): node is Element {
	return node.nodeType === Node.ELEMENT_NODE;
}

function serializeNode(node: Node, depth: number): string {
	if (node.nodeType === Node.TEXT_NODE) {
		return escapeMarkdownText(collapseWhitespace(node.textContent ?? ""));
	}
	if (!isElement(node)) return "";

	const el = node as HTMLElement;
	switch (el.tagName) {
		case "P":
			return `${serializeInlineChildren(el)}\n\n`;
		case "H1":
		case "H2":
		case "H3":
		case "H4":
		case "H5":
		case "H6": {
			const level = Number(el.tagName[1]);
			return `${"#".repeat(level)} ${serializeInlineChildren(el)}\n\n`;
		}
		case "UL":
		case "OL":
			return serializeList(el, depth);
		case "BLOCKQUOTE":
			return serializeBlockquote(el);
		case "PRE":
			return serializeCodeBlock(el);
		case "HR":
			return "---\n\n";
		case "IMG":
			return `${serializeInline(el)}\n\n`;
		case "DIV": {
			const content = serializeChildren(el, depth);
			if (!content.trim()) return "";
			// The signature block wraps its content in a div with a top border;
			// keep that separation when switching to Markdown.
			if (/border-(top|block-start)/i.test(el.getAttribute("style") ?? "")) {
				return `---\n\n${content.trim()}\n\n`;
			}
			return `${content.trimEnd()}\n\n`;
		}
		default: {
			if (INLINE_TAGS.has(el.tagName)) return serializeInline(el);
			const content = serializeChildren(el, depth);
			return content.trim() ? `${content.trimEnd()}\n\n` : "";
		}
	}
}

function serializeInlineChildren(el: Element): string {
	let out = "";
	el.childNodes.forEach((child) => {
		out += serializeInline(child);
	});
	return out;
}

function serializeChildren(node: Node, depth: number): string {
	let out = "";
	node.childNodes.forEach((child) => {
		out += serializeNode(child, depth);
	});
	return out;
}

function serializeInline(node: Node): string {
	if (node.nodeType === Node.TEXT_NODE) {
		return escapeMarkdownText(collapseWhitespace(node.textContent ?? ""));
	}
	if (!isElement(node)) return "";

	const el = node as HTMLElement;
	switch (el.tagName) {
		case "BR":
			return "\n";
		case "STRONG":
		case "B":
			return `**${serializeInlineChildren(el)}**`;
		case "EM":
		case "I":
			return `*${serializeInlineChildren(el)}*`;
		case "DEL":
		case "S":
		case "STRIKE":
			return `~~${serializeInlineChildren(el)}~~`;
		case "CODE":
			return serializeInlineCode(el.textContent ?? "");
		case "A": {
			const href = el.getAttribute("href") ?? "";
			const text = serializeInlineChildren(el);
			if (!href || /^(javascript|data):/i.test(href)) return text;
			return `[${text || escapeMarkdownText(href)}](${encodeMarkdownUrl(href)})`;
		}
		case "IMG": {
			const alt = escapeMarkdownText(el.getAttribute("alt") ?? "");
			return `![${alt}](${encodeMarkdownUrl(el.getAttribute("src") ?? "")})`;
		}
		case "U":
			return `<u>${serializeInlineChildren(el)}</u>`;
		case "MARK":
		case "SPAN":
		case "FONT":
			// Keep styled inline elements as raw HTML so colours, highlights and
			// other TipTap marks survive the Markdown round-trip.
			if (
				el.hasAttribute("style") ||
				el.hasAttribute("data-color") ||
				el.tagName === "FONT"
			) {
				return el.outerHTML;
			}
			return serializeInlineChildren(el);
		default:
			if (INLINE_TAGS.has(el.tagName)) return serializeInlineChildren(el);
			return serializeNode(el, 0).trim();
	}
}

function serializeList(el: HTMLElement, depth: number): string {
	const ordered = el.tagName === "OL";
	const indent = "  ".repeat(depth);
	const items = Array.from(el.children).filter(
		(child) => child.tagName === "LI",
	);
	if (items.length === 0) return "";

	const lines = items.map((item, index) => {
		const marker = ordered ? `${index + 1}. ` : "- ";
		const content = serializeListItem(item as HTMLElement, depth);
		const [first = "", ...rest] = content.split("\n");
		const continuation = rest
			.map((line) => `\n${indent}${" ".repeat(marker.length)}${line}`)
			.join("");
		return `${indent}${marker}${first}${continuation}`;
	});

	return `${lines.join("\n")}\n\n`;
}

function serializeListItem(li: HTMLElement, depth: number): string {
	const nested: string[] = [];
	let content = "";

	li.childNodes.forEach((child) => {
		if (isElement(child) && (child.tagName === "UL" || child.tagName === "OL")) {
			nested.push(serializeList(child as HTMLElement, depth + 1).trimEnd());
			return;
		}
		content += serializeNode(child, depth);
	});

	content = content.replace(/\n{2,}/g, "\n").trim();

	if (nested.length > 0) {
		content = `${content}\n${nested.join("\n")}`;
	}
	return content;
}

function serializeBlockquote(el: HTMLElement): string {
	const inner = serializeChildren(el, 0).trim();
	if (!inner) return "";
	const quoted = inner
		.split("\n")
		.map((line) => (line ? `> ${line}` : ">"))
		.join("\n");
	return `${quoted}\n\n`;
}

function serializeCodeBlock(el: HTMLElement): string {
	const codeEl = el.querySelector("code");
	const language = getCodeLanguage(codeEl);
	const text = (codeEl ?? el).textContent ?? "";
	const fence = text.includes("```") ? "````" : "```";
	return `${fence}${language}\n${text.replace(/\n+$/, "")}\n${fence}\n\n`;
}

function getCodeLanguage(codeEl: Element | null): string {
	if (!codeEl) return "";
	const match = /(?:^|\s)language-([\w-]+)/.exec(codeEl.className ?? "");
	return match?.[1] ?? "";
}

function serializeInlineCode(text: string): string {
	const fence = text.includes("`") ? "``" : "`";
	const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${fence}${padding}${text}${padding}${fence}`;
}

function collapseWhitespace(text: string): string {
	// HTML collapses newlines/indentation in text nodes; Markdown would not.
	return text.replace(/\s*\n\s*/g, " ");
}

function escapeMarkdownText(text: string): string {
	return text
		.replace(/\\/g, "\\\\")
		.replace(/([`*_[\]<>~])/g, "\\$1")
		.replace(/^([ \t]*(?:#{1,6}|>|[-+*]|\d+\.))[ \t]/gm, "$1\\ ");
}

function encodeMarkdownUrl(url: string): string {
	return url.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}
