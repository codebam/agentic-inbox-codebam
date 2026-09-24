// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Keyboard triage for the email list: the key → action table and every guard,
 * as pure functions. No DOM and no React, so the mapping and the guards are
 * unit-testable without a browser (see tests/keyboard-triage.test.ts).
 *
 * `resolveKeyAction` is the single entry point. First match wins:
 *   1. `defaultPrevented`   — another handler (a focused row, the search input)
 *                             already consumed the event
 *   2. overlay open         — a modal (the cheatsheet) owns the keyboard
 *   3. composer open        — the compose session owns the keyboard
 *   4. typing context       — input / textarea / select / contenteditable
 *   5. inside the composer  — target sits inside `[data-composer-root]`
 *   6. command modifier     — Ctrl / Meta / Alt held. Shift is allowed: the
 *                             spec's `#` and `?` are Shift combinations.
 *   7. unknown key          — not in the table
 *   8. interactive target   — never steal a key from a focused interactive
 *                             element (button, link, checkbox, role=button …)
 *   9. key repeat           — a held key only repeats bindings that opt in
 */


export type TriageActionId =
	| "next"
	| "previous"
	| "open"
	| "archive"
	| "trash"
	| "star"
	| "unread"
	| "reply"
	| "reply-all"
	| "forward"
	| "compose"
	| "search"
	| "select"
	| "clear-selection"
	| "help";


export type TriageSection = "navigation" | "actions" | "compose" | "selection" | "help";


export interface TriageBinding {
	/** Key tokens that resolve to this action; the first one is canonical. */
	keys: readonly string[];
	action: TriageActionId;
	/** Cheatsheet label. */
	label: string;
	section: TriageSection;
	/** A held key may repeat this action (navigation, open and compose are safe). */
	allowRepeat: boolean;
	/** Touches stored mail (archive / trash / star / unread / select). */
	mutating: boolean;
}


export const TRIAGE_SECTIONS: readonly { id: TriageSection; title: string }[] = [
	{ id: "navigation", title: "Navigation" },
	{ id: "actions", title: "Message actions" },
	{ id: "compose", title: "Compose" },
	{ id: "selection", title: "Selection" },
	{ id: "help", title: "Help" },
];


/**
 * Every shortcut, in cheatsheet order. Reply / reply-all / forward / compose
 * only ever open the composer — no binding sends mail.
 */
export const KEY_BINDINGS: readonly TriageBinding[] = [
	{ keys: ["j"], action: "next", label: "Next message", section: "navigation", allowRepeat: true, mutating: false },
	{ keys: ["k"], action: "previous", label: "Previous message", section: "navigation", allowRepeat: true, mutating: false },
	{ keys: ["Enter", "o"], action: "open", label: "Open message", section: "navigation", allowRepeat: true, mutating: false },
	{ keys: ["/"], action: "search", label: "Focus search", section: "navigation", allowRepeat: true, mutating: false },
	{ keys: ["e"], action: "archive", label: "Archive", section: "actions", allowRepeat: false, mutating: true },
	{ keys: ["#"], action: "trash", label: "Move to Trash", section: "actions", allowRepeat: false, mutating: true },
	{ keys: ["s"], action: "star", label: "Toggle star", section: "actions", allowRepeat: false, mutating: true },
	{ keys: ["u"], action: "unread", label: "Toggle read / unread", section: "actions", allowRepeat: false, mutating: true },
	{ keys: ["r"], action: "reply", label: "Reply", section: "compose", allowRepeat: true, mutating: false },
	{ keys: ["a"], action: "reply-all", label: "Reply all", section: "compose", allowRepeat: true, mutating: false },
	{ keys: ["f"], action: "forward", label: "Forward", section: "compose", allowRepeat: true, mutating: false },
	{ keys: ["c"], action: "compose", label: "Compose new email", section: "compose", allowRepeat: true, mutating: false },
	{ keys: ["x"], action: "select", label: "Select current row", section: "selection", allowRepeat: false, mutating: true },
	{ keys: ["Escape"], action: "clear-selection", label: "Clear selection", section: "selection", allowRepeat: true, mutating: false },
	{ keys: ["?"], action: "help", label: "Show keyboard shortcuts", section: "help", allowRepeat: true, mutating: false },
];


const BINDING_BY_KEY: ReadonlyMap<string, TriageBinding> = (() => {
	const map = new Map<string, TriageBinding>();
	for (const binding of KEY_BINDINGS) {
		for (const key of binding.keys) map.set(key, binding);
	}
	return map;
})();


/** The binding for a canonical key token, if any. */
export function bindingForKey(key: string): TriageBinding | undefined {
	return BINDING_BY_KEY.get(key);
}


/** Bindings in one cheatsheet section, in table order. */
export function bindingsForSection(section: TriageSection): TriageBinding[] {
	return KEY_BINDINGS.filter((binding) => binding.section === section);
}


/** Key tokens that resolve to an action (aliases included). */
export function keysForAction(action: TriageActionId): string[] {
	return KEY_BINDINGS.find((binding) => binding.action === action)?.keys.slice() ?? [];
}


/** How a key token is rendered in the cheatsheet. */
export function formatKeyToken(token: string): string {
	return token === "Escape" ? "Esc" : token;
}


/** Wrapper ComposePanel renders around every composer field. */
export const COMPOSER_ROOT_SELECTOR = "[data-composer-root]";


/** The list header's search input (Header.tsx). */
export const SEARCH_INPUT_SELECTOR = 'input[aria-label="Search emails"]';


/** Mobile "expand search" button, pressed when the input is not rendered yet. */
export const SEARCH_TOGGLE_SELECTOR = 'button[aria-label="Search"]';


/** Elements that own the keys they receive. */
export const INTERACTIVE_TARGET_SELECTOR = [
	"a[href]",
	"button",
	"input",
	"select",
	"textarea",
	'[contenteditable=""]',
	'[contenteditable="true"]',
	'[contenteditable="plaintext-only"]',
	'[role="button"]',
	'[role="checkbox"]',
	'[role="combobox"]',
	'[role="link"]',
	'[role="listbox"]',
	'[role="menu"]',
	'[role="menuitem"]',
	'[role="option"]',
	'[role="radio"]',
	'[role="searchbox"]',
	'[role="slider"]',
	'[role="spinbutton"]',
	'[role="switch"]',
	'[role="tab"]',
	'[role="textbox"]',
].join(", ");


/** Editable regions that are not inputs. */
export const CONTENTEDITABLE_SELECTOR =
	'[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';


/** The shape of a keydown event the guards need. */
export interface KeyEventLike {
	key: string;
	shiftKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	repeat?: boolean;
	defaultPrevented?: boolean;
	target?: unknown;
}


/** The duck-typed slice of an EventTarget the guards read. */
export interface TargetLike {
	tagName?: string;
	isContentEditable?: boolean;
	closest?: (selector: string) => unknown;
}


export interface ResolveOptions {
	/** A modal (the cheatsheet) is open and owns the keyboard. */
	overlayOpen?: boolean;
	/** The compose session is open and owns the keyboard. */
	composerOpen?: boolean;
}


export type IgnoreReason =
	| "already-handled"
	| "overlay-open"
	| "composer-open"
	| "typing"
	| "composer"
	| "modifier"
	| "unknown-key"
	| "interactive-target"
	| "key-repeat";


export type KeyResolution =
	| { type: "action"; action: TriageActionId; binding: TriageBinding }
	| { type: "ignore"; reason: IgnoreReason };


function asTarget(target: unknown): TargetLike | null {
	if (!target || typeof target !== "object") return null;
	return target;
}


/**
 * Canonical key token for a keydown: Shift+3 is `#` and Shift+/ is `?` on
 * layouts that report the unshifted character, and letters are lowercased so
 * Shift+J still navigates.
 */
export function normalizeKeyToken(event: Pick<KeyEventLike, "key" | "shiftKey">): string {
	const key = event.key ?? "";
	if (event.shiftKey && key === "3") return "#";
	if (event.shiftKey && key === "/") return "?";
	if (/^[A-Za-z]$/.test(key)) return key.toLowerCase();
	return key;
}


/** Ctrl / Meta / Alt held. Shift is deliberately not a command modifier. */
export function hasCommandModifier(
	event: Pick<KeyEventLike, "ctrlKey" | "metaKey" | "altKey">,
): boolean {
	return Boolean(event.ctrlKey || event.metaKey || event.altKey);
}


/** True for inputs, textareas, selects and contenteditable regions. */
export function isTypingTarget(target: unknown): boolean {
	const node = asTarget(target);
	if (!node) return false;
	const tag = (node.tagName ?? "").toUpperCase();
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	if (node.isContentEditable) return true;
	if (typeof node.closest === "function") {
		return Boolean(node.closest(CONTENTEDITABLE_SELECTOR));
	}
	return false;
}


/** True when the target sits inside the composer (or is the composer root). */
export function isInsideComposer(target: unknown): boolean {
	const node = asTarget(target);
	if (!node || typeof node.closest !== "function") return false;
	return Boolean(node.closest(COMPOSER_ROOT_SELECTOR));
}


/**
 * True for anything that already handles its own keys: buttons, links, form
 * fields, anything with a button-like role. Triage never steals keys from it.
 */
export function isInteractiveTarget(target: unknown): boolean {
	const node = asTarget(target);
	if (!node) return false;
	if (isTypingTarget(node)) return true;
	if (typeof node.closest !== "function") return false;
	return Boolean(node.closest(INTERACTIVE_TARGET_SELECTOR));
}


/** Map a keydown to an action, or explain why it was ignored. */
export function resolveKeyAction(
	event: KeyEventLike,
	options: ResolveOptions = {},
): KeyResolution {
	if (event.defaultPrevented) return { type: "ignore", reason: "already-handled" };
	if (options.overlayOpen) return { type: "ignore", reason: "overlay-open" };
	if (options.composerOpen) return { type: "ignore", reason: "composer-open" };
	if (isTypingTarget(event.target)) return { type: "ignore", reason: "typing" };
	if (isInsideComposer(event.target)) return { type: "ignore", reason: "composer" };
	if (hasCommandModifier(event)) return { type: "ignore", reason: "modifier" };
	const binding = bindingForKey(normalizeKeyToken(event));
	if (!binding) return { type: "ignore", reason: "unknown-key" };
	if (isInteractiveTarget(event.target)) return { type: "ignore", reason: "interactive-target" };
	if (event.repeat && !binding.allowRepeat) return { type: "ignore", reason: "key-repeat" };
	return { type: "action", action: binding.action, binding };
}
