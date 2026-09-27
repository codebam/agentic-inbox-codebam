// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * The PWA manifest has to stay installable, and "installable" is a checklist
 * the browser enforces silently: Chromium offers the install only when the
 * manifest names the app, pins a start_url and a standalone display, and
 * carries a 192px and a 512px icon. Nothing else notices when one goes
 * missing — the app builds, every route answers, push works — and the only
 * symptom is an install button that never appears.
 *
 * The files are inlined as raw text because these tests run inside workerd,
 * whose node:fs cannot reach the repository. That also means the icon PNGs
 * cannot be read here; this file pins the manifest contract, which is the
 * part that broke.
 */

import { describe, expect, it } from "vitest";
import manifestSource from "../public/manifest.webmanifest?raw";
import rootSource from "../app/root.tsx?raw";
import swSource from "../public/sw.js?raw";

interface ManifestIcon {
	src: string;
	type?: string;
	sizes?: string;
	purpose?: string;
}

interface Manifest {
	name?: string;
	short_name?: string;
	start_url?: string;
	display?: string;
	icons?: ManifestIcon[];
	prefer_related_applications?: unknown;
}

const manifest = JSON.parse(manifestSource) as Manifest;

describe("PWA manifest", () => {
	it("carries every member Chromium requires before it offers the install", () => {
		expect(manifest.name ?? manifest.short_name).toBeTruthy();
		expect(manifest.short_name ?? manifest.name).toBeTruthy();
		expect(manifest.start_url).toBe("/");
		expect(["fullscreen", "standalone", "minimal-ui"]).toContain(manifest.display);
		// Chromium refuses the install outright when this is true.
		expect(manifest.prefer_related_applications ?? false).toBe(false);
	});

	it("declares the 192px and 512px PNG icons the install criteria demand", () => {
		const pngIcons = (manifest.icons ?? []).filter((icon) => icon.type === "image/png");
		const sizes = pngIcons.map((icon) => icon.sizes);
		expect(sizes).toContain("192x192");
		expect(sizes).toContain("512x512");
	});

	it("declares every icon with an absolute path and a matchable size", () => {
		expect((manifest.icons ?? []).length).toBeGreaterThan(0);
		for (const icon of manifest.icons ?? []) {
			expect(icon.src.startsWith("/")).toBe(true);
			// `sizes: "any"` is the vector entry; everything else must be WxH.
			if (icon.type === "image/svg+xml") continue;
			expect(icon.sizes).toMatch(/^\d+x\d+$/);
		}
	});

	it("keeps a maskable icon for Android's mask and an apple touch icon for iOS", () => {
		const maskable = (manifest.icons ?? []).filter((icon) => icon.purpose === "maskable");
		expect(maskable.length).toBeGreaterThan(0);
		expect(rootSource).toContain('rel="apple-touch-icon"');
	});

	it("links the manifest from the document head, with credentials", () => {
		expect(rootSource).toContain('rel="manifest"');
		expect(rootSource).toContain("/manifest.webmanifest");
		// Behind Cloudflare Access an uncredentialed manifest fetch returns the
		// sign-in page, and Chromium then has no manifest to install from.
		expect(rootSource).toContain('crossOrigin="use-credentials"');
	});

	it("carries per-scheme theme-color metas for the standalone window", () => {
		// The manifest can only give one theme_color, so the installed app's
		// title bar would stay white in dark mode without these; the script
		// re-points them the way it re-points the favicons.
		expect(rootSource).toContain('name="theme-color"');
		expect(rootSource).toContain("data-theme-color");
		expect(rootSource).toContain("#0f0f0f");
		expect(rootSource).toContain("meta[data-theme-color]");
	});

	it("ships a service worker with a real fetch handler, registered on load", () => {
		// Chromium on Android will not mint a WebAPK without one, and an empty
		// listener does not count.
		expect(swSource).toContain('addEventListener("fetch"');
		expect(swSource).toContain("respondWith");
		expect(rootSource).toContain("serviceWorker.register");
	});
});
