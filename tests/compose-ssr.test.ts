// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The composer's helpers have to survive a server render.
 *
 * `ComposeEmail` is mounted by the mailbox route, so `useComposeForm` runs on
 * every server render, and its `bodyHasContent` / `canSaveTemplate` call
 * `htmlToPlainText` while rendering. This pool is workerd without a DOM —
 * exactly the environment that broke in production: DOMPurify's default
 * export has no `sanitize` there, so `htmlToPlainText` threw
 * "…sanitize is not a function" and every hard page load answered with the
 * root error boundary while client-side navigation stayed fine. These tests
 * pin the DOM-free fallbacks that keep the server render alive.
 */

import DOMPurify from "dompurify";
import { describe, expect, it } from "vitest";
import { getSignatureBlock, htmlToPlainText } from "../app/lib/utils";

describe("composer helpers without a DOM (server render)", () => {
	it("runs where DOMPurify cannot sanitise at all", () => {
		// The premise of every fallback below: if this ever flips, these tests
		// stop exercising the DOM-free paths and should be revisited.
		expect(DOMPurify.isSupported).toBe(false);
		expect(typeof (DOMPurify as { sanitize?: unknown }).sanitize).toBe(
			"undefined",
		);
	});

	it("extracts text through the DOM-free fallback", () => {
		expect(htmlToPlainText("<p>Hello <b>there</b></p>")).toBe("Hello there");
		expect(htmlToPlainText("")).toBe("");
	});

	it("drops script content instead of throwing", () => {
		expect(htmlToPlainText("<p>hi</p><script>alert(1)</script>")).toBe("hi");
	});

	it("escapes an HTML signature when it cannot be sanitised", () => {
		const block = getSignatureBlock({
			signature: { enabled: true, html: "<b>Sean</b>" },
		});
		expect(block).toContain("&lt;b&gt;Sean&lt;/b&gt;");
		expect(block).not.toContain("<b>Sean</b>");
		expect(block).toContain("border-top");
	});

	it("keeps the plain-text signature path unchanged", () => {
		const block = getSignatureBlock({
			signature: { enabled: true, text: "Sean" },
		});
		expect(block).toContain("Sean");
		expect(block).toContain("border-top");
	});
});
