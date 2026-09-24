// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Remote-image proxy: R2-cached relay for the images of a message the
 * operator opted into ("Show images" or the per-sender allowlist).
 *
 * Why a proxy at all: loading a remote image straight from the sender's
 * server hands that server the reader's IP, user agent and reading time —
 * the whole reason messages render with images blocked. The browser asks
 * this module's route for the image instead, so the fetch happens
 * server-side and the sender only ever sees Cloudflare's egress.
 *
 * Why this is not an open proxy: every fetch goes through
 * `guardedFetchImage` (workers/lib/ssrf-guard.ts) — the one shared guard —
 * so it is https-only, credential-free, public-host-only, never follows
 * redirects, and bounds the body by declared length and by a hard byte cap,
 * with a content-type allowlist that can never include SVG. Fetched bytes
 * are cached in R2 keyed by the sha256 of the URL, and a cache hit is
 * served without any fetch at all. Nothing server-side ever calls this on
 * its own and there is no agent/MCP wiring: the browser hits the route only
 * after the operator opted in for the message or the sender.
 */

import type { Env } from "../types";
import {
	guardedFetchImage,
	type GuardedImageFailureReason,
} from "./ssrf-guard";

// ── Cache constants ────────────────────────────────────────────────

/** Every cache key lives under this R2 prefix, so the sweep can list it alone. */
export const IMAGE_PROXY_CACHE_PREFIX = "image-proxy/";

/**
 * Cache-Control for a proxied image: keep it in the browser, never in a
 * shared cache. A week is long enough that a re-opened message does not
 * re-fetch, and short enough that a rotated tracking image does not stick
 * around forever.
 */
export const IMAGE_PROXY_CACHE_CONTROL = "private, max-age=604800";

/** Cached images untouched for this long are deleted by the sweep. */
export const IMAGE_PROXY_CACHE_MAX_AGE_DAYS = 30;

/**
 * List pages one sweep may walk. The cron runs daily and a skipped entry is
 * simply swept on a later run, so the sweep stays bounded instead of paging
 * through an arbitrarily large cache in one invocation.
 */
export const IMAGE_PROXY_SWEEP_MAX_PAGES = 3;

/** Objects per sweep list call — R2's maximum page size. */
const IMAGE_PROXY_SWEEP_PAGE_SIZE = 1000;

/** Milliseconds in a day, for the retention window. */
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Cache key ──────────────────────────────────────────────────────

/**
 * Cache key for one remote URL: the `image-proxy/` prefix plus the
 * sha256-hex of the exact URL string.
 *
 * The URL is hashed rather than embedded so no sender-controlled string ever
 * becomes an R2 key: no path traversal, no control characters, no keys that
 * collide across encodings. Two spellings of the same URL (`%2F` vs `/`,
 * different casing) hash apart and simply fetch twice, which costs one
 * extra request, not correctness — and an entry can only exist at all
 * after that exact string passed the guard in `guardedFetchImage`.
 */
export async function imageProxyCacheKey(url: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(url),
	);
	const hex = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${IMAGE_PROXY_CACHE_PREFIX}${hex}`;
}

// ── Proxy ──────────────────────────────────────────────────────────

/**
 * The result of proxying one image: the bytes and their content type, with
 * `cached` telling whether they came from R2, or the guard's failure.
 */
export type ProxyImageResult =
	| { ok: true; bytes: ArrayBuffer; contentType: string; cached: boolean }
	| {
			ok: false;
			status: number | null;
			error: string;
			reason: GuardedImageFailureReason;
	  };

/**
 * Serve one remote image: from the R2 cache when it was fetched before,
 * otherwise through the guard, storing the bytes only on success so a failed
 * or refused fetch never poisons the cache.
 *
 * `opts.fetchImpl` is injectable for tests; production callers omit it.
 * The stored content type comes from the guard, which has already verified
 * it against the allowlist — a cache hit trusts that stored value and never
 * touches the network.
 */
export async function proxyImage(
	env: Env,
	url: string,
	opts: { fetchImpl?: typeof fetch } = {},
): Promise<ProxyImageResult> {
	const key = await imageProxyCacheKey(url);
	const cached = await env.BUCKET.get(key);
	if (cached) {
		return {
			ok: true,
			bytes: await cached.arrayBuffer(),
			// Every write sets this; the fallback only guards a hand-edited
			// object and keeps the route from answering 200 with no type.
			contentType: cached.httpMetadata?.contentType ?? "application/octet-stream",
			cached: true,
		};
	}

	const result = await guardedFetchImage(url, opts);
	if (!result.ok) return result;

	await env.BUCKET.put(key, result.bytes, {
		httpMetadata: { contentType: result.contentType },
	});
	return { ok: true, bytes: result.bytes, contentType: result.contentType, cached: false };
}

// ── Sweep ──────────────────────────────────────────────────────────

export interface ImageProxySweepSummary {
	/** Cache objects examined. */
	scanned: number;
	/** Cache objects deleted as expired. */
	deleted: number;
}

/**
 * Delete cached images older than the retention window.
 *
 * Runs on the daily cron trigger (see `scheduled` in workers/app.ts). Walks
 * at most `IMAGE_PROXY_SWEEP_MAX_PAGES` list pages, deletes the expired keys
 * of each page in one call, and reports how many objects it deleted. The
 * page bound is deliberate: the cache is a convenience, not data, so a
 * backlog is fine to leave for the next run.
 *
 * `opts.now` pins the clock (tests use it to stay deterministic); production
 * callers omit it.
 */
export async function sweepImageProxyCache(
	env: Env,
	opts: { now?: Date } = {},
): Promise<ImageProxySweepSummary> {
	const now = opts.now ?? new Date();
	const cutoff = now.getTime() - IMAGE_PROXY_CACHE_MAX_AGE_DAYS * DAY_MS;
	const summary: ImageProxySweepSummary = { scanned: 0, deleted: 0 };

	let cursor: string | undefined;
	for (let page = 0; page < IMAGE_PROXY_SWEEP_MAX_PAGES; page++) {
		const listed = await env.BUCKET.list({
			prefix: IMAGE_PROXY_CACHE_PREFIX,
			limit: IMAGE_PROXY_SWEEP_PAGE_SIZE,
			...(cursor ? { cursor } : {}),
		});
		summary.scanned += listed.objects.length;

		const expired = listed.objects
			.filter((object) => object.uploaded.getTime() < cutoff)
			.map((object) => object.key);
		if (expired.length > 0) {
			await env.BUCKET.delete(expired);
			summary.deleted += expired.length;
		}

		if (!listed.truncated) break;
		cursor = listed.cursor;
	}

	console.log(
		`Image proxy cache sweep: ${summary.scanned} object(s) scanned, ` +
			`${summary.deleted} expired object(s) deleted`,
	);
	return summary;
}
