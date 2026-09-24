/**
 * Remote-image proxy tests.
 *
 * Nothing here touches the network: `guardedFetchImage` and `proxyImage`
 * take an injected fetch, and the route specs swap the isolate's global
 * fetch instead (see tests/unsubscribe.test.ts — a SELF.fetch-dispatched
 * route runs in this isolate, so it sees the stub too).
 *
 * The sweep runs against the real R2 binding where it can. This pool's R2
 * `put` ignores a custom `uploaded` timestamp (verified against the pool),
 * so the retention window is exercised by pinning the sweep's clock, and
 * the mixed-age case within one run uses a minimal bucket face that reports
 * exact upload dates.
 */

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MAX_PROXY_IMAGE_BYTES,
	PROXY_IMAGE_CONTENT_TYPES,
	guardedFetchImage,
} from "../workers/lib/ssrf-guard";
import {
	IMAGE_PROXY_CACHE_PREFIX,
	IMAGE_PROXY_SWEEP_MAX_PAGES,
	imageProxyCacheKey,
	proxyImage,
	sweepImageProxyCache,
} from "../workers/lib/image-proxy";
import type { Env } from "../workers/types";

/** The worker's bindings; the test config omits account-level vars. */
const appEnv = env as unknown as Env;

/** A stand-in for image bytes; the proxy never decodes them. */
const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const TARGET = "https://cdn.example.com/pixel.png";
const DAY_MS = 24 * 60 * 60 * 1000;


// ── Guard (image mode) ─────────────────────────────────────────────


describe("guardedFetchImage", () => {
	it("never touches the network when the guard rejects the URL", async () => {
		const cases: [string, string][] = [
			["http://cdn.example.com/a.png", "https"],
			["https://user:secret@cdn.example.com/a.png", "credentials"],
			["https://127.0.0.1/a.png", "IP literal"],
			["https://[::1]/a.png", "IP literal"],
			["https://localhost/a.png", "local or internal"],
			["https://printer.local/a.png", "local or internal"],
			["https://vault.internal/a.png", "local or internal"],
			["https://cdn.example.com:8080/a.png", "port"],
		];

		for (const [url, expected] of cases) {
			const fetchImpl = vi.fn<typeof fetch>();
			const result = await guardedFetchImage(url, { fetchImpl });

			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("unreachable");
			expect(result.reason).toBe("url");
			expect(result.status).toBeNull();
			expect(result.error).toContain(expected);
			expect(fetchImpl).not.toHaveBeenCalled();
		}
	});

	it("sends a minimal credential-free GET and returns the bytes and type", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async (request: Request) => {
			expect(request.method).toBe("GET");
			expect(request.url).toBe(TARGET);
			expect(request.redirect).toBe("manual");
			expect(request.signal).toBeInstanceOf(AbortSignal);
			// Exactly one header — and never credentials, Referer or Origin.
			expect([...request.headers.keys()]).toEqual(["accept"]);
			expect(request.headers.get("referer")).toBeNull();
			expect(request.headers.get("origin")).toBeNull();
			expect(request.headers.get("cookie")).toBeNull();
			return new Response(IMAGE_BYTES, {
				status: 200,
				headers: { "content-type": "image/png; charset=binary" },
			});
		});

		const result = await guardedFetchImage(TARGET, { fetchImpl });

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		if (!result.ok) throw new Error(result.error);
		// Only the essence survives: the parameter after `;` is dropped.
		expect(result.contentType).toBe("image/png");
		expect(new Uint8Array(result.bytes)).toEqual(IMAGE_BYTES);
	});

	it("refuses a 3xx instead of following it", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 302 }));

		const result = await guardedFetchImage(TARGET, { fetchImpl });

		expect(result).toEqual({
			ok: false,
			status: 302,
			error: "Redirect refused (302)",
			reason: "redirect",
		});
	});

	it("reports a non-2xx answer and a network error without throwing", async () => {
		const failing = vi.fn<typeof fetch>(async () => new Response("nope", { status: 500 }));
		expect(await guardedFetchImage(TARGET, { fetchImpl: failing })).toEqual({
			ok: false,
			status: 500,
			error: "Endpoint responded 500",
			reason: "upstream",
		});

		const unreachable = vi.fn<typeof fetch>(async () => {
			throw new Error("connection refused");
		});
		const result = await guardedFetchImage(TARGET, { fetchImpl: unreachable });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.status).toBeNull();
		expect(result.reason).toBe("upstream");
		expect(result.error).toContain("connection refused");
	});

	it("rejects non-image types, including SVG, without reading the body", async () => {
		for (const contentType of ["text/html", "image/svg+xml", "application/octet-stream", ""]) {
			let cancelled = false;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(IMAGE_BYTES);
				},
				cancel() {
					cancelled = true;
				},
			});
			const fetchImpl = vi.fn<typeof fetch>(async () =>
				new Response(body, {
					status: 200,
					headers: contentType ? { "content-type": contentType } : {},
				}),
			);

			const result = await guardedFetchImage(TARGET, { fetchImpl });

			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("unreachable");
			expect(result.reason).toBe("content-type");
			expect(result.status).toBe(200);
			expect(cancelled).toBe(true);
		}
	});

	it("refuses a declared length over the cap before reading the body", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		const fetchImpl = vi.fn<typeof fetch>(async () =>
			new Response(body, {
				status: 200,
				headers: {
					"content-type": "image/png",
					"content-length": String(MAX_PROXY_IMAGE_BYTES + 1),
				},
			}),
		);

		const result = await guardedFetchImage(TARGET, { fetchImpl });

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.reason).toBe("oversize");
		expect(result.error).toContain(String(MAX_PROXY_IMAGE_BYTES));
		expect(cancelled).toBe(true);
	});

	it("cancels a streamed body that crosses the cap", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(8));
				controller.enqueue(new Uint8Array(8));
				controller.enqueue(new Uint8Array(8));
			},
			cancel() {
				cancelled = true;
			},
		});
		const fetchImpl = vi.fn<typeof fetch>(async () =>
			new Response(body, { status: 200, headers: { "content-type": "image/png" } }),
		);

		const result = await guardedFetchImage(TARGET, { fetchImpl, maxBytes: 16 });

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.reason).toBe("oversize");
		expect(cancelled).toBe(true);
	});

	it("accepts a body of exactly the cap", async () => {
		const bytes = new Uint8Array(16).fill(7);
		const fetchImpl = vi.fn<typeof fetch>(async () =>
			new Response(bytes, { status: 200, headers: { "content-type": "image/png" } }),
		);

		const result = await guardedFetchImage(TARGET, { fetchImpl, maxBytes: 16 });

		if (!result.ok) throw new Error(result.error);
		expect(new Uint8Array(result.bytes)).toEqual(bytes);
	});

	it("pins the content-type allowlist and the byte cap", () => {
		expect(PROXY_IMAGE_CONTENT_TYPES).toEqual(
			expect.arrayContaining([
				"image/png",
				"image/jpeg",
				"image/gif",
				"image/webp",
				"image/avif",
			]),
		);
		expect(PROXY_IMAGE_CONTENT_TYPES).not.toContain("image/svg+xml");
		expect(MAX_PROXY_IMAGE_BYTES).toBe(5 * 1024 * 1024);
	});
});


// ── Cache + orchestration ──────────────────────────────────────────


describe("proxyImage", () => {
	it("derives the cache key from the sha256 of the URL", async () => {
		expect(await imageProxyCacheKey("https://cdn.example.com/fixed.png")).toBe(
			`${IMAGE_PROXY_CACHE_PREFIX}a839c9cdeb75f521eab0b84c625b43b80cf96e193b5eeb7e02bfe9764d2ae62a`,
		);
	});

	it("fetches once, stores in R2 and serves the second call from the cache", async () => {
		const url = `https://cdn.example.com/cache-${crypto.randomUUID()}.png`;
		const fetchImpl = vi.fn<typeof fetch>(async () =>
			new Response(IMAGE_BYTES, { status: 200, headers: { "content-type": "image/png" } }),
		);

		const first = await proxyImage(appEnv, url, { fetchImpl });
		expect(first).toMatchObject({ ok: true, contentType: "image/png", cached: false });
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		const key = await imageProxyCacheKey(url);
		const stored = await env.BUCKET.get(key);
		expect(stored).not.toBeNull();
		expect(stored!.httpMetadata?.contentType).toBe("image/png");
		expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(IMAGE_BYTES);

		const second = await proxyImage(appEnv, url, { fetchImpl });
		expect(second).toMatchObject({ ok: true, contentType: "image/png", cached: true });
		if (!second.ok) throw new Error(second.error);
		expect(new Uint8Array(second.bytes)).toEqual(IMAGE_BYTES);
		// The cache hit never reached the network.
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("does not cache a failed or refused fetch", async () => {
		const url = `https://cdn.example.com/failing-${crypto.randomUUID()}.png`;
		const fetchImpl = vi.fn<typeof fetch>(async () => new Response("nope", { status: 500 }));

		const failed = await proxyImage(appEnv, url, { fetchImpl });
		expect(failed.ok).toBe(false);
		expect(await env.BUCKET.head(await imageProxyCacheKey(url))).toBeNull();

		const refused = await proxyImage(appEnv, "https://127.0.0.1/a.png", { fetchImpl });
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("unreachable");
		expect(refused.reason).toBe("url");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});


describe("sweepImageProxyCache", () => {
	it("keeps fresh entries and deletes them once the window passes", async () => {
		const key = `${IMAGE_PROXY_CACHE_PREFIX}real-${crypto.randomUUID()}`;
		await env.BUCKET.put(key, "cached bytes", { httpMetadata: { contentType: "image/png" } });

		const kept = await sweepImageProxyCache(appEnv, { now: new Date() });
		expect(kept.deleted).toBe(0);
		expect(kept.scanned).toBeGreaterThanOrEqual(1);
		expect(await env.BUCKET.head(key)).not.toBeNull();

		// The same object, seen 31 days later, is past the 30-day window.
		const later = new Date(Date.now() + 31 * DAY_MS);
		const swept = await sweepImageProxyCache(appEnv, { now: later });
		expect(swept.deleted).toBeGreaterThanOrEqual(1);
		expect(await env.BUCKET.head(key)).toBeNull();
	});

	it("deletes only entries older than the window within one run", async () => {
		const now = new Date("2026-02-01T00:00:00.000Z");
		const oldKey = `${IMAGE_PROXY_CACHE_PREFIX}old-${crypto.randomUUID()}`;
		const freshKey = `${IMAGE_PROXY_CACHE_PREFIX}fresh-${crypto.randomUUID()}`;
		const deleted: string[] = [];
		// The sweep only lists and deletes, so a minimal bucket face with
		// exact upload dates is enough to distinguish old from fresh.
		const bucket = {
			async list() {
				return {
					objects: [
						{ key: oldKey, uploaded: new Date(now.getTime() - 31 * DAY_MS) },
						{ key: freshKey, uploaded: new Date(now.getTime() - 3 * DAY_MS) },
					],
					truncated: false,
				};
			},
			async delete(keys: string | string[]) {
				deleted.push(...(Array.isArray(keys) ? keys : [keys]));
			},
		};

		const summary = await sweepImageProxyCache({ BUCKET: bucket } as unknown as Env, { now });

		expect(deleted).toEqual([oldKey]);
		expect(summary).toEqual({ scanned: 2, deleted: 1 });
	});

	it("stops after the bounded number of list pages", async () => {
		const now = new Date("2026-02-01T00:00:00.000Z");
		let listCalls = 0;
		const deleted: string[] = [];
		const bucket = {
			async list() {
				listCalls++;
				return {
					objects: [
						{
							key: `${IMAGE_PROXY_CACHE_PREFIX}page-${listCalls}`,
							uploaded: new Date(now.getTime() - DAY_MS),
						},
					],
					truncated: true,
					cursor: `cursor-${listCalls}`,
				};
			},
			async delete(keys: string | string[]) {
				deleted.push(...(Array.isArray(keys) ? keys : [keys]));
			},
		};

		const summary = await sweepImageProxyCache({ BUCKET: bucket } as unknown as Env, { now });

		expect(listCalls).toBe(IMAGE_PROXY_SWEEP_MAX_PAGES);
		expect(deleted).toEqual([]);
		expect(summary).toEqual({ scanned: IMAGE_PROXY_SWEEP_MAX_PAGES, deleted: 0 });
	});
});


// ── Route ──────────────────────────────────────────────────────────


interface CapturedCall {
	url: string;
	request: Request;
}

/**
 * Swap the isolate's global fetch for a capture stub (the same trick as
 * tests/unsubscribe.test.ts): the route under test runs in this isolate, so
 * its outbound call hits the stub.
 */
function captureFetch(respond: (request: Request) => Response): CapturedCall[] {
	const calls: CapturedCall[] = [];
	vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init);
		calls.push({ url: request.url, request });
		return respond(request);
	}) as typeof fetch);
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

const PROXY_MAILBOX = "image-proxy-route@example.com";

/** The proxy URL the UI builds for one sender URL. */
function proxyUrl(target: string): string {
	return `http://example.com/api/v1/mailboxes/${PROXY_MAILBOX}/image-proxy?url=${encodeURIComponent(target)}`;
}

async function registerMailbox(): Promise<void> {
	await env.BUCKET.put(`mailboxes/${PROXY_MAILBOX}.json`, JSON.stringify({}));
}


describe("GET /api/v1/mailboxes/:mailboxId/image-proxy", () => {
	it("answers 400 for a missing url parameter", async () => {
		await registerMailbox();
		const calls = captureFetch(() => new Response(IMAGE_BYTES, { status: 200 }));

		const res = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${PROXY_MAILBOX}/image-proxy`,
		);

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("url");
		expect(calls).toHaveLength(0);
	});

	it("answers 400 with the guard's reason for an unusable url", async () => {
		await registerMailbox();
		const calls = captureFetch(() => new Response(IMAGE_BYTES, { status: 200 }));

		const cases: [string, string][] = [
			["not a url", "valid absolute URL"],
			["https://127.0.0.1/a.png", "IP literal"],
			["http://cdn.example.com/a.png", "https"],
			["https://cdn.example.com:8080/a.png", "port"],
		];
		for (const [target, expected] of cases) {
			const res = await SELF.fetch(proxyUrl(target));
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: string };
			expect(body.error).toContain(expected);
		}
		expect(calls).toHaveLength(0);
	});

	it("serves an opted-in image with the upstream type, once per URL", async () => {
		await registerMailbox();
		const target = `https://cdn.example.com/route-${crypto.randomUUID()}.png`;
		const calls = captureFetch(
			() =>
				new Response(IMAGE_BYTES, {
					status: 200,
					headers: { "content-type": "image/png" },
				}),
		);

		const res = await SELF.fetch(proxyUrl(target));

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("cache-control")).toBe("private, max-age=604800");
		expect(res.headers.get("set-cookie")).toBeNull();
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(IMAGE_BYTES);

		// The outbound request went to the sender's URL, credential-free.
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(target);
		expect(calls[0]!.request.method).toBe("GET");
		expect(calls[0]!.request.redirect).toBe("manual");
		expect(calls[0]!.request.headers.get("referer")).toBeNull();
		expect(calls[0]!.request.headers.get("origin")).toBeNull();
		expect(calls[0]!.request.headers.get("cookie")).toBeNull();

		// The second request is served from the R2 cache: no new call.
		const again = await SELF.fetch(proxyUrl(target));
		expect(again.status).toBe(200);
		expect(new Uint8Array(await again.arrayBuffer())).toEqual(IMAGE_BYTES);
		expect(calls).toHaveLength(1);
	});

	it("answers 502 when the sender's server fails or redirects", async () => {
		await registerMailbox();

		const failing = `https://cdn.example.com/route-500-${crypto.randomUUID()}.png`;
		captureFetch(() => new Response("nope", { status: 500 }));
		const failed = await SELF.fetch(proxyUrl(failing));
		expect(failed.status).toBe(502);
		expect(((await failed.json()) as { error: string }).error).toContain("500");

		const redirecting = `https://cdn.example.com/route-302-${crypto.randomUUID()}.png`;
		captureFetch(() => new Response(null, { status: 302 }));
		const redirected = await SELF.fetch(proxyUrl(redirecting));
		expect(redirected.status).toBe(502);
		expect(((await redirected.json()) as { error: string }).error).toContain(
			"Redirect refused",
		);
	});

	it("answers 415 for a non-image content type, including SVG", async () => {
		await registerMailbox();
		const target = `https://cdn.example.com/route-svg-${crypto.randomUUID()}.svg`;
		captureFetch(
			() =>
				new Response("<svg/>", {
					status: 200,
					headers: { "content-type": "image/svg+xml" },
				}),
		);

		const res = await SELF.fetch(proxyUrl(target));

		expect(res.status).toBe(415);
		expect(((await res.json()) as { error: string }).error).toContain("image/svg+xml");
		expect(await env.BUCKET.head(await imageProxyCacheKey(target))).toBeNull();
	});

	it("answers 413 for an image over the cap and caches nothing", async () => {
		await registerMailbox();
		const target = `https://cdn.example.com/route-big-${crypto.randomUUID()}.png`;
		captureFetch(() => {
			let chunks = 0;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					chunks++;
					controller.enqueue(new Uint8Array(1024 * 1024).fill(7));
					if (chunks >= 8) controller.close();
				},
			});
			return new Response(body, {
				status: 200,
				headers: { "content-type": "image/png" },
			});
		});

		const res = await SELF.fetch(proxyUrl(target));

		expect(res.status).toBe(413);
		expect(((await res.json()) as { error: string }).error).toContain("larger than");
		expect(await env.BUCKET.head(await imageProxyCacheKey(target))).toBeNull();
	});
});
