// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Unit tests for the keyboard triage table and its guards. `shared/keyboard.ts`
 * is pure (no DOM, no React), so every rule — typing contexts, modifiers,
 * unknown keys, key repeat, Escape/Enter precedence — is exercised here
 * without a browser; fake targets stand in for real elements.
 */


import { describe, expect, it } from "vitest";
import {
	COMPOSER_ROOT_SELECTOR,
	CONTENTEDITABLE_SELECTOR,
	INTERACTIVE_TARGET_SELECTOR,
	KEY_BINDINGS,
	TRIAGE_SECTIONS,
	bindingsForSection,
	bindingForKey,
	formatKeyToken,
	hasCommandModifier,
	isInsideComposer,
	isInteractiveTarget,
	isTypingTarget,
	keysForAction,
	normalizeKeyToken,
	resolveKeyAction,
	type IgnoreReason,
	type KeyEventLike,
	type ResolveOptions,
	type TriageActionId,
} from "../shared/keyboard";


function keyEvent(key: string, init: Partial<KeyEventLike> = {}): KeyEventLike {
	return { key, ...init };
}


function expectAction(event: KeyEventLike, action: TriageActionId, options?: ResolveOptions) {
	const resolution = resolveKeyAction(event, options);
	if (resolution.type !== "action") {
		throw new Error(`expected action ${action}, got ignore: ${resolution.reason}`);
	}
	expect(resolution.action).toBe(action);
	expect(resolution.binding.action).toBe(action);
	return resolution;
}


function expectIgnore(event: KeyEventLike, reason: IgnoreReason, options?: ResolveOptions) {
	const resolution = resolveKeyAction(event, options);
	if (resolution.type !== "ignore") {
		throw new Error(`expected ignore ${reason}, got action: ${resolution.action}`);
	}
	expect(resolution.reason).toBe(reason);
}


// Fake targets: the module only ever reads tagName / isContentEditable /
// closest(selector), so these are enough to exercise every guard branch.
const BODY = { tagName: "BODY" };
const INPUT = { tagName: "INPUT" };
const TEXTAREA = { tagName: "TEXTAREA" };
const SELECT = { tagName: "SELECT" };
const CONTENTEDITABLE = { tagName: "DIV", isContentEditable: true };
const CONTENTEDITABLE_NESTED = {
	tagName: "SPAN",
	closest: (selector: string) => (selector === CONTENTEDITABLE_SELECTOR ? {} : null),
};
const COMPOSER_FIELD = {
	tagName: "DIV",
	closest: (selector: string) =>
		selector === COMPOSER_ROOT_SELECTOR ? {} : null,
};
const COMPOSER_FIELD_INPUT = {
	tagName: "INPUT",
	closest: (selector: string) => (selector === COMPOSER_ROOT_SELECTOR ? {} : null),
};
const BUTTON = {
	tagName: "BUTTON",
	closest: (selector: string) => (selector === INTERACTIVE_TARGET_SELECTOR ? {} : null),
};
const LINK = {
	tagName: "A",
	closest: (selector: string) => (selector === INTERACTIVE_TARGET_SELECTOR ? {} : null),
};
// A list row is role="button" tabIndex=0 — interactive, so it keeps Enter.
const FOCUSED_ROW = {
	tagName: "DIV",
	closest: (selector: string) => (selector === INTERACTIVE_TARGET_SELECTOR ? {} : null),
};


describe("key → action table", () => {
	it("maps every shortcut in the spec", () => {
		const expected: Array<[string, TriageActionId]> = [
			["j", "next"],
			["k", "previous"],
			["Enter", "open"],
			["o", "open"],
			["e", "archive"],
			["#", "trash"],
			["s", "star"],
			["u", "unread"],
			["r", "reply"],
			["a", "reply-all"],
			["f", "forward"],
			["c", "compose"],
			["/", "search"],
			["x", "select"],
			["Escape", "clear-selection"],
			["?", "help"],
		];
		for (const [key, action] of expected) {
			expectAction(keyEvent(key, { target: BODY }), action);
		}
	});

	it("keeps one binding per key token", () => {
		const tokens = KEY_BINDINGS.flatMap((binding) => [...binding.keys]);
		expect(new Set(tokens).size).toBe(tokens.length);
	});

	it("resolves the aliases of an action to the same binding", () => {
		expect(keysForAction("open")).toEqual(["Enter", "o"]);
		expect(keysForAction("trash")).toEqual(["#"]);
		expect(bindingForKey("o")).toBe(bindingForKey("Enter"));
		expect(bindingForKey("q")).toBeUndefined();
	});

	it("groups every binding into a cheatsheet section", () => {
		const grouped = TRIAGE_SECTIONS.flatMap((section) => bindingsForSection(section.id));
		expect(grouped.length).toBe(KEY_BINDINGS.length);
		for (const section of TRIAGE_SECTIONS) {
			expect(bindingsForSection(section.id).length).toBeGreaterThan(0);
		}
	});

	it("never repeats a mutating binding while its key is held", () => {
		for (const binding of KEY_BINDINGS) {
			if (binding.mutating) expect(binding.allowRepeat).toBe(false);
		}
	});

	it("exposes no send action — compose shortcuts only open the composer", () => {
		const actions = KEY_BINDINGS.map((binding) => binding.action);
		expect(actions).not.toContain("send" as TriageActionId);
		for (const action of ["reply", "reply-all", "forward", "compose"] as const) {
			expect(bindingForKey(keysForAction(action)[0])?.mutating).toBe(false);
		}
	});

	it("renders Escape as Esc in the cheatsheet", () => {
		expect(formatKeyToken("Escape")).toBe("Esc");
		expect(formatKeyToken("j")).toBe("j");
	});
});


describe("key normalization", () => {
	it("turns Shift+3 into # (US layout)", () => {
		expect(normalizeKeyToken({ key: "3", shiftKey: true })).toBe("#");
		expectAction(keyEvent("3", { shiftKey: true, target: BODY }), "trash");
	});

	it("turns Shift+/ into ? on layouts that report the unshifted key", () => {
		expect(normalizeKeyToken({ key: "/", shiftKey: true })).toBe("?");
		expectAction(keyEvent("/", { shiftKey: true, target: BODY }), "help");
	});

	it("lowercases shifted letters so Shift+J still navigates", () => {
		expect(normalizeKeyToken({ key: "J", shiftKey: true })).toBe("j");
		expectAction(keyEvent("J", { shiftKey: true, target: BODY }), "next");
	});

	it("leaves named keys and bare digits alone", () => {
		expect(normalizeKeyToken({ key: "Enter" })).toBe("Enter");
		expect(normalizeKeyToken({ key: "3" })).toBe("3");
	});
});


describe("typing context guard", () => {
	it("ignores keys from inputs, textareas, selects and contenteditable", () => {
		for (const target of [INPUT, TEXTAREA, SELECT, CONTENTEDITABLE, CONTENTEDITABLE_NESTED]) {
			expectIgnore(keyEvent("j", { target }), "typing");
			expectIgnore(keyEvent("e", { target }), "typing");
			expectIgnore(keyEvent("Escape", { target }), "typing");
		}
		expect(isTypingTarget(INPUT)).toBe(true);
		expect(isTypingTarget(TEXTAREA)).toBe(true);
		expect(isTypingTarget(SELECT)).toBe(true);
		expect(isTypingTarget(CONTENTEDITABLE)).toBe(true);
		expect(isTypingTarget(BODY)).toBe(false);
	});

	it("checks the typing context before the modifier guard", () => {
		expectIgnore(keyEvent("e", { target: INPUT, ctrlKey: true }), "typing");
	});

	it("still ignores keys from an input inside the composer", () => {
		expectIgnore(keyEvent("j", { target: COMPOSER_FIELD_INPUT }), "typing");
	});
});


describe("composer guard", () => {
	it("ignores keys targeted inside the composer", () => {
		expect(isInsideComposer(COMPOSER_FIELD)).toBe(true);
		expect(isInsideComposer(BODY)).toBe(false);
		expectIgnore(keyEvent("j", { target: COMPOSER_FIELD }), "composer");
		expectIgnore(keyEvent("#", { target: COMPOSER_FIELD }), "composer");
		expectIgnore(keyEvent("?", { target: COMPOSER_FIELD }), "composer");
	});

	it("ignores every key while the composer is open, wherever focus is", () => {
		for (const key of ["j", "k", "Enter", "e", "#", "r", "x", "?", "Escape"]) {
			expectIgnore(keyEvent(key, { target: BODY }), "composer-open", { composerOpen: true });
		}
	});

	it("checks the composer before the unknown-key guard", () => {
		expectIgnore(keyEvent("q", { target: BODY }), "composer-open", { composerOpen: true });
	});
});


describe("modifier guard", () => {
	it("ignores Ctrl, Meta and Alt combinations", () => {
		expectIgnore(keyEvent("j", { target: BODY, ctrlKey: true }), "modifier");
		expectIgnore(keyEvent("k", { target: BODY, metaKey: true }), "modifier");
		expectIgnore(keyEvent("e", { target: BODY, altKey: true }), "modifier");
		expect(hasCommandModifier({ ctrlKey: true })).toBe(true);
		expect(hasCommandModifier({ metaKey: true })).toBe(true);
		expect(hasCommandModifier({ altKey: true })).toBe(true);
		expect(hasCommandModifier({ shiftKey: true })).toBe(false);
	});

	it("allows Shift alone, so # and ? keep working", () => {
		expectAction(keyEvent("#", { shiftKey: true, target: BODY }), "trash");
		expectAction(keyEvent("?", { shiftKey: true, target: BODY }), "help");
	});

	it("checks the modifier before the unknown-key guard", () => {
		expectIgnore(keyEvent("3", { target: BODY, ctrlKey: true }), "modifier");
	});
});


describe("unknown keys", () => {
	it("ignores keys that are not in the table", () => {
		expectIgnore(keyEvent("q", { target: BODY }), "unknown-key");
		expectIgnore(keyEvent("3", { target: BODY }), "unknown-key");
		expectIgnore(keyEvent("ArrowDown", { target: BODY }), "unknown-key");
		expectIgnore(keyEvent(" ", { target: BODY }), "unknown-key");
	});

	it("resolves known keys that are not letters", () => {
		expectAction(keyEvent("#", { target: BODY }), "trash");
		expectAction(keyEvent("/", { target: BODY }), "search");
		expectAction(keyEvent("Enter", { target: BODY }), "open");
	});
});


describe("key repeat handling", () => {
	it("lets held navigation keys repeat", () => {
		expectAction(keyEvent("j", { target: BODY, repeat: true }), "next");
		expectAction(keyEvent("k", { target: BODY, repeat: true }), "previous");
		expectAction(keyEvent("Enter", { target: BODY, repeat: true }), "open");
	});

	it("ignores a repeated destructive key (archive, trash)", () => {
		expectIgnore(keyEvent("e", { target: BODY, repeat: true }), "key-repeat");
		expectIgnore(keyEvent("#", { target: BODY, repeat: true }), "key-repeat");
	});

	it("ignores a repeated mutating toggle (star, unread, select)", () => {
		expectIgnore(keyEvent("s", { target: BODY, repeat: true }), "key-repeat");
		expectIgnore(keyEvent("u", { target: BODY, repeat: true }), "key-repeat");
		expectIgnore(keyEvent("x", { target: BODY, repeat: true }), "key-repeat");
	});

	it("allows a repeated compose or help key", () => {
		expectAction(keyEvent("r", { target: BODY, repeat: true }), "reply");
		expectAction(keyEvent("?", { target: BODY, repeat: true }), "help");
	});

	it("does not ignore the first press of a mutating key", () => {
		expectAction(keyEvent("e", { target: BODY, repeat: false }), "archive");
	});
});


describe("interactive target guard", () => {
	it("never steals keys from a focused button, link or list row", () => {
		for (const target of [BUTTON, LINK, FOCUSED_ROW]) {
			expectIgnore(keyEvent("j", { target }), "interactive-target");
			expectIgnore(keyEvent("e", { target }), "interactive-target");
			expectIgnore(keyEvent("#", { target }), "interactive-target");
			expectIgnore(keyEvent("Escape", { target }), "interactive-target");
		}
		expect(isInteractiveTarget(BUTTON)).toBe(true);
		expect(isInteractiveTarget(FOCUSED_ROW)).toBe(true);
		expect(isInteractiveTarget(BODY)).toBe(false);
		expect(isInteractiveTarget(INPUT)).toBe(true);
	});

	it("checks the interactive target after the unknown-key guard", () => {
		expectIgnore(keyEvent("q", { target: BUTTON }), "unknown-key");
	});

	it("still resolves actions when focus is on the page body", () => {
		expectAction(keyEvent("j", { target: BODY }), "next");
		expectAction(keyEvent("j", { target: undefined }), "next");
		expectAction(keyEvent("j"), "next");
	});
});


describe("Escape and Enter precedence", () => {
	it("Escape from the page clears the selection", () => {
		expectAction(keyEvent("Escape", { target: BODY }), "clear-selection");
	});

	it("Escape is not stolen from a field, a button or an open overlay", () => {
		expectIgnore(keyEvent("Escape", { target: INPUT }), "typing");
		expectIgnore(keyEvent("Escape", { target: COMPOSER_FIELD }), "composer");
		expectIgnore(keyEvent("Escape", { target: BUTTON }), "interactive-target");
		expectIgnore(keyEvent("Escape", { target: BODY }), "overlay-open", { overlayOpen: true });
	});

	it("Enter from the page opens the current message", () => {
		expectAction(keyEvent("Enter", { target: BODY }), "open");
		expectAction(keyEvent("o", { target: BODY }), "open");
	});

	it("Enter already handled by the focused row is left alone", () => {
		expectIgnore(
			keyEvent("Enter", { target: FOCUSED_ROW, defaultPrevented: true }),
			"already-handled",
		);
	});

	it("Enter on a focused button activates the button instead", () => {
		expectIgnore(keyEvent("Enter", { target: BUTTON }), "interactive-target");
	});

	it("never re-handles an event another handler consumed", () => {
		expectIgnore(keyEvent("j", { target: BODY, defaultPrevented: true }), "already-handled");
		expectIgnore(
			keyEvent("e", { target: BODY, defaultPrevented: true }),
			"already-handled",
		);
	});

	it("ignores every key while an overlay (the cheatsheet) is open", () => {
		for (const key of ["j", "Enter", "e", "#", "?", "Escape"]) {
			expectIgnore(keyEvent(key, { target: BODY }), "overlay-open", { overlayOpen: true });
		}
	});
});
