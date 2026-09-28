// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * First-party loading of the images an email body references.
 *
 * A body renders inside a sandboxed iframe (app/components/EmailIframe),
 * which is what keeps a message's scripts away from the app's origin — but a
 * document in a sandbox without `allow-same-origin` has an opaque origin, and
 * Chromium then sends its subresource requests as `Sec-Fetch-Site:
 * cross-site` with NO cookies attached, whatever the cookie's SameSite.
 * Behind Cloudflare Access (production) that made every app-origin image in
 * a body unauthenticated: the edge answered its 302-to-login and the iframe
 * CSP then refused to render the login page as an image, so opted-in remote
 * images and inline attachments both came up broken while every other part of
 * the app worked.
 *
 * So the page fetches them itself — it is a first-party context and carries
 * the session — and the body is rendered with the bytes inlined as `data:`
 * URLs, which the iframe CSP already allows. The iframe then loads no
 * network image at all, and the sender's server still only ever sees the
 * Worker's egress: the proxy route does the guarded fetch server-side.
 *
 * Only app-origin URLs are fetched here (shared/remote-images.ts collects
 * them), so this never reaches a sender's host directly, and it is a plain
 * GET — no app route with a side effect is reachable through it.
 */

import { bytesToDataUrl } from "shared/remote-images";

/**
 * Largest single image inlined into a body: the image proxy's own cap, so an
 * image the proxy would refuse is never inlined either.
 */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Budget for one body's inlined bytes. Base64 inflates by a third and the
 * result lives in the iframe's srcdoc string, so a message carrying many
 * multi-megabyte images would otherwise build a document the browser cannot
 * comfortably hold. Images past the budget stay blocked.
 */
export const MAX_INLINE_TOTAL_BYTES = 12 * 1024 * 1024;

/** Fetches in flight at once; the browser caps per-host connections anyway. */
export const MAX_INLINE_CONCURRENCY = 6;

export interface BodyImageLoadResult {
	/** The bytes of each URL that loaded, as a `data:` URL. */
	dataUrls: Map<string, string>;
	/**
	 * Images that could not be used: an HTTP error (a refused proxy fetch
	 * answers 4xx/5xx), a response that is not an image, one past the
	 * per-image or total byte budget, or a network failure.
	 */
	failed: number;
}

export interface BodyImageLoadOptions {
	/** Injectable fetch, so tests assert the exact request without a network. */
	fetchImpl?: typeof fetch;
	/** Abort signal of the render that started the load. */
	signal?: AbortSignal;
	/** Override the per-image byte cap (tests use a tiny one). */
	maxBytes?: number;
	/** Override the total byte budget (tests use a tiny one). */
	maxTotalBytes?: number;
}

/**
 * Fetch the app-origin images of one body and return their bytes as `data:`
 * URLs, keyed by the absolute URL they were fetched from.
 *
 * Requests are same-origin GETs with credentials, so the session cookie
 * (Cloudflare Access in production) rides along — which is the whole point:
 * the sandboxed iframe cannot do this, the page can. Failures are counted,
 * never thrown: a body renders with the images that loaded and the blocked
 * placeholder for the ones that did not, and the notice above the body
 * reports how many failed.
 */
export async function loadBodyImages(
	urls: readonly string[],
	opts: BodyImageLoadOptions = {},
): Promise<BodyImageLoadResult> {
	const unique = [...new Set(urls)];
	const dataUrls = new Map<string, string>();
	const fetchImpl = opts.fetchImpl ?? fetch;
	const maxBytes = opts.maxBytes ?? MAX_INLINE_IMAGE_BYTES;
	const maxTotalBytes = opts.maxTotalBytes ?? MAX_INLINE_TOTAL_BYTES;
	let failed = 0;
	let total = 0;
	let next = 0;

	const loadOne = async (url: string): Promise<void> => {
		try {
			const response = await fetchImpl(url, {
				credentials: "same-origin",
				...(opts.signal ? { signal: opts.signal } : {}),
			});
			if (!response.ok) {
				failed++;
				return;
			}
			// Compare only the essence: `image/png; charset=binary` is an image.
			const contentType = (response.headers.get("content-type") ?? "")
				.split(";")[0]!
				.trim()
				.toLowerCase();
			if (!contentType.startsWith("image/")) {
				failed++;
				return;
			}
			// A declared oversize length is refused before any byte is read.
			const declaredLength = Number(response.headers.get("content-length") ?? "");
			if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
				failed++;
				await response.body?.cancel().catch(() => {});
				return;
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes.byteLength === 0 || bytes.byteLength > maxBytes || total + bytes.byteLength > maxTotalBytes) {
				failed++;
				return;
			}
			total += bytes.byteLength;
			dataUrls.set(url, bytesToDataUrl(bytes, contentType));
		} catch {
			// An aborted load is the render going away, not a failed image.
			if (opts.signal?.aborted) return;
			failed++;
		}
	};

	const worker = async (): Promise<void> => {
		for (;;) {
			const index = next++;
			const url = unique[index];
			if (url === undefined) return;
			await loadOne(url);
			if (opts.signal?.aborted) return;
		}
	};

	await Promise.all(
		Array.from({ length: Math.min(MAX_INLINE_CONCURRENCY, unique.length) }, worker),
	);
	return { dataUrls, failed };
}
