// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Scoped surface: the surface-only get_image tool.
 *
 * get_image relays one message image through the shared SSRF guard and R2
 * cache and answers it as base64. It must stay a scoped-surface-only tool:
 * the /mcp gate reads SCOPED_TOOL_SCOPES and must never carry it, so no
 * agent or MCP session can ever fetch a sender's image.
 */

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessTokenRecord } from "../shared/access-tokens";
import {
	SCOPED_SURFACE_ONLY_TOOL_SCOPES,
	SCOPED_TOOL_SCOPES,
} from "../workers/lib/scoped-surface";

/** The JSON answer of one scoped call. */
interface ScopedAnswer {
	status: number;
	body: { ok?: boolean; result?: unknown; error?: string };
}

/** Stand-in image bytes; base64 is asserted against exactly these. */
const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]);

/** Register the mailbox record the admin routes check before routing. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
}

/** Mint one access token through the admin route and keep its plaintext. */
async function mintToken(mailbox: string, scopes: string[]): Promise<string> {
	await registerMailbox(mailbox);
	const response = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/access-tokens`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Scoped image test token", scopes }),
		},
	);
	expect(response.status).toBe(201);
	const answer = (await response.json()) as {
		token: string;
		record: AccessTokenRecord;
	};
	return answer.token;
}

/** POST one scoped call as a token holder. */
async function scopedCall(
	tool: string,
	token: string,
	body: unknown = {},
): Promise<ScopedAnswer> {
	const response = await SELF.fetch(`http://example.com/api/v1/scoped/${tool}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(body),
	});
	return {
		status: response.status,
		body: (await response.json()) as ScopedAnswer["body"],
	};
}

/**
 * Stub the isolate's global fetch: a SELF-dispatched route runs in this
 * isolate, so the guard inside it sees the stub (same pattern as
 * tests/unsubscribe.test.ts).
 */
function stubImageFetch(contentType = "image/png"): ReturnType<typeof vi.fn> {
	const bytes = IMAGE_BYTES.slice();
	const fetchImpl = vi.fn<typeof fetch>(
		async () =>
			new Response(bytes.buffer as ArrayBuffer, {
				status: 200,
				headers: {
					"content-type": contentType,
					"content-length": String(IMAGE_BYTES.length),
				},
			}),
	);
	vi.stubGlobal("fetch", fetchImpl);
	return fetchImpl;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("scoped tool maps", () => {
	it("keeps get_image out of the map the /mcp gate reads", () => {
		expect(SCOPED_TOOL_SCOPES).not.toHaveProperty("get_image");
		expect(SCOPED_SURFACE_ONLY_TOOL_SCOPES).toHaveProperty("get_image", "read");
	});
});

describe("scoped get_image", () => {
	it("relays one image as base64 and serves a repeat from the cache", async () => {
		const mailbox = "scoped-image-basic@example.com";
		const token = await mintToken(mailbox, ["read"]);
		const url = "https://cdn.example.com/scoped-image-basic.png";
		const fetchImpl = stubImageFetch();

		const first = await scopedCall("get_image", token, { url });
		expect(first.status).toBe(200);
		const result = first.body.result as {
			contentType: string;
			bytes: number;
			cached: boolean;
			dataBase64: string;
		};
		expect(result.contentType).toBe("image/png");
		expect(result.bytes).toBe(IMAGE_BYTES.length);
		expect(result.cached).toBe(false);
		expect(atob(result.dataBase64)).toBe(
			String.fromCharCode(...IMAGE_BYTES),
		);
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		const second = await scopedCall("get_image", token, { url });
		expect(second.status).toBe(200);
		const cached = second.body.result as { cached: boolean };
		expect(cached.cached).toBe(true);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("refuses a key without the read scope before any fetch", async () => {
		const mailbox = "scoped-image-scope@example.com";
		const token = await mintToken(mailbox, ["manage"]);
		const fetchImpl = stubImageFetch();
		const answer = await scopedCall("get_image", token, {
			url: "https://cdn.example.com/scoped-image-scope.png",
		});
		expect(answer.status).toBe(403);
		expect(answer.body.error).toBe("This token lacks the read scope");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("passes the guard's refusal through and never fetches", async () => {
		const mailbox = "scoped-image-guard@example.com";
		const token = await mintToken(mailbox, ["read"]);
		const fetchImpl = stubImageFetch();
		const answer = await scopedCall("get_image", token, {
			url: "https://127.0.0.1/a.png",
		});
		expect(answer.status).toBe(400);
		expect(String(answer.body.error)).toContain("IP literal");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("refuses a call with no url", async () => {
		const mailbox = "scoped-image-missing@example.com";
		const token = await mintToken(mailbox, ["read"]);
		const answer = await scopedCall("get_image", token, {});
		expect(answer.status).toBe(400);
		expect(answer.body.error).toBe("url is required");
	});
});
