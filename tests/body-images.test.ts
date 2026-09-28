import { describe, expect, it } from "vitest";
import {
	MAX_INLINE_CONCURRENCY,
	loadBodyImages,
} from "../app/lib/body-images";

/**
 * The page fetches a body's app-origin images itself (a sandboxed iframe's
 * subresource requests carry no cookies, so behind Cloudflare Access the
 * iframe could never authenticate one) and the body renders with the bytes
 * inlined as `data:` URLs. These tests pin the fetch contract: same-origin
 * credentials, dedupe, the byte budgets, and that failures are counted
 * rather than thrown.
 */

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DATA_URL = `data:image/png;base64,${btoa("\x89PNG\r\n\x1a\n")}`;

/** A response carrying image bytes; `headers` can add a declared length. */
function imageResponse(
	bytes: Uint8Array = PNG_BYTES,
	type = "image/png",
	headers: Record<string, string> = {},
): Response {
	return new Response(bytes, {
		headers: { "content-type": type, ...headers },
	});
}

describe("loadBodyImages", () => {
	it("fetches each image same-origin with credentials and returns data: URLs", async () => {
		const calls: Array<{ url: string; credentials: RequestCredentials | undefined }> = [];
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), credentials: init?.credentials });
			return imageResponse();
		}) as typeof fetch;

		const result = await loadBodyImages(
			["https://app.example.com/a.png", "https://app.example.com/b.png"],
			{ fetchImpl },
		);

		expect(result.failed).toBe(0);
		expect([...result.dataUrls.keys()]).toEqual([
			"https://app.example.com/a.png",
			"https://app.example.com/b.png",
		]);
		expect(result.dataUrls.get("https://app.example.com/a.png")).toBe(PNG_DATA_URL);
		expect(calls.map((call) => call.url)).toEqual([
			"https://app.example.com/a.png",
			"https://app.example.com/b.png",
		]);
		expect(calls.every((call) => call.credentials === "same-origin")).toBe(true);
	});

	it("fetches a repeated URL once", async () => {
		let fetches = 0;
		const fetchImpl = (async () => {
			fetches++;
			return imageResponse();
		}) as typeof fetch;

		const result = await loadBodyImages(
			["https://app.example.com/a.png", "https://app.example.com/a.png"],
			{ fetchImpl },
		);

		expect(fetches).toBe(1);
		expect(result.dataUrls.size).toBe(1);
	});

	it("counts a non-image response as failed and stores nothing", async () => {
		const fetchImpl = (async () =>
			imageResponse(new Uint8Array([1, 2, 3]), "text/html")) as typeof fetch;

		const result = await loadBodyImages(["https://app.example.com/a"], { fetchImpl });

		expect(result.failed).toBe(1);
		expect(result.dataUrls.size).toBe(0);
	});

	it("accepts a content type with parameters and normalises it", async () => {
		const fetchImpl = (async () =>
			imageResponse(PNG_BYTES, "IMAGE/PNG; charset=binary")) as typeof fetch;

		const result = await loadBodyImages(["https://app.example.com/a"], { fetchImpl });

		expect(result.dataUrls.get("https://app.example.com/a")).toBe(PNG_DATA_URL);
	});

	it("counts an HTTP error as failed", async () => {
		const fetchImpl = (async () =>
			new Response("nope", { status: 502 })) as typeof fetch;

		const result = await loadBodyImages(["https://app.example.com/a"], { fetchImpl });

		expect(result.failed).toBe(1);
		expect(result.dataUrls.size).toBe(0);
	});

	it("refuses a declared oversize image before reading it", async () => {
		let bodyRead = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(PNG_BYTES);
				controller.close();
			},
			pull() {
				bodyRead = true;
			},
		});
		const fetchImpl = (async () =>
			new Response(stream, {
				headers: { "content-type": "image/png", "content-length": "100000" },
			})) as typeof fetch;

		const result = await loadBodyImages(["https://app.example.com/big.png"], {
			fetchImpl,
			maxBytes: 16,
		});

		expect(result.failed).toBe(1);
		expect(result.dataUrls.size).toBe(0);
		expect(bodyRead).toBe(false);
	});

	it("refuses an image that is over the per-image cap once read", async () => {
		const fetchImpl = (async () =>
			imageResponse(new Uint8Array(64))) as typeof fetch;

		const result = await loadBodyImages(["https://app.example.com/a.png"], {
			fetchImpl,
			maxBytes: 16,
		});

		expect(result.failed).toBe(1);
		expect(result.dataUrls.size).toBe(0);
	});

	it("stops inlining once the total budget is spent", async () => {
		const fetchImpl = (async () =>
			imageResponse(new Uint8Array(8))) as typeof fetch;

		const result = await loadBodyImages(
			["https://app.example.com/a.png", "https://app.example.com/b.png"],
			{ fetchImpl, maxTotalBytes: 10 },
		);

		expect(result.dataUrls.size).toBe(1);
		expect(result.failed).toBe(1);
	});

	it("counts a network failure as failed and keeps the other images", async () => {
		const fetchImpl = (async (input: RequestInfo | URL) => {
			if (String(input).includes("boom")) throw new TypeError("network error");
			return imageResponse();
		}) as typeof fetch;

		const result = await loadBodyImages(
			["https://app.example.com/boom.png", "https://app.example.com/ok.png"],
			{ fetchImpl },
		);

		expect(result.failed).toBe(1);
		expect([...result.dataUrls.keys()]).toEqual(["https://app.example.com/ok.png"]);
	});

	it("treats an aborted load as cancelled, not as a failure", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchImpl = (async () => {
			throw new DOMException("aborted", "AbortError");
		}) as typeof fetch;

		const result = await loadBodyImages(["https://app.example.com/a.png"], {
			fetchImpl,
			signal: controller.signal,
		});

		expect(result.failed).toBe(0);
		expect(result.dataUrls.size).toBe(0);
	});

	it("never runs more than the concurrency cap at once", async () => {
		let inFlight = 0;
		let peak = 0;
		const fetchImpl = (async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight--;
			return imageResponse();
		}) as typeof fetch;

		const urls = Array.from({ length: MAX_INLINE_CONCURRENCY * 3 }, (_v, i) =>
			`https://app.example.com/${i}.png`,
		);
		const result = await loadBodyImages(urls, { fetchImpl });

		expect(result.dataUrls.size).toBe(urls.length);
		expect(peak).toBeLessThanOrEqual(MAX_INLINE_CONCURRENCY);
	});

	it("returns an empty result for no URLs", async () => {
		const result = await loadBodyImages([], {
			fetchImpl: (async () => imageResponse()) as typeof fetch,
		});
		expect(result.dataUrls.size).toBe(0);
		expect(result.failed).toBe(0);
	});
});
