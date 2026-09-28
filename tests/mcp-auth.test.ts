import { describe, expect, it } from "vitest";
import { authenticateMcpRequest, verifyMcpToken } from "../workers/lib/mcp-auth";

/**
 * The native `fetch` in workerd enforces a `this` brand check: invoking it as
 * a method of some other object (`context.fetcher(url)`) throws
 *
 *   TypeError: Illegal invocation: function called with incorrect `this` reference.
 *
 * The verifier used to call its fetcher exactly that way, so every live /mcp
 * request answered 502 "Failed to reach the Cloudflare API while verifying
 * the token" — invisible here because every other test injected a plain JS
 * function, which the brand check ignores. These tests inject a fetcher that
 * reproduces the brand check, so a wrong invocation style fails the suite
 * instead of production.
 */

function nativeStyleFetcher(payload: unknown, status = 200) {
	return function fetcher(this: unknown): Promise<Response> {
		if (this !== undefined && this !== globalThis) {
			throw new TypeError(
				"Illegal invocation: function called with incorrect `this` reference.",
			);
		}
		return Promise.resolve(
			new Response(JSON.stringify(payload), {
				status,
				headers: { "content-type": "application/json" },
			}),
		);
	};
}

function envWithDomains(): Parameters<typeof verifyMcpToken>[1] {
	return { DOMAINS: "example.com" } as unknown as Parameters<typeof verifyMcpToken>[1];
}

function zonePayload(name: string, accountId: string) {
	return {
		success: true,
		result: [{ name, account: { id: accountId, name: "Example Account" } }],
	};
}

describe("mcp-auth fetch invocation", () => {
	it("verifies a bearer when the fetcher enforces workerd's native `this` brand check", async () => {
		const fetcher = nativeStyleFetcher(zonePayload("example.com", "acct-1"));
		const result = await verifyMcpToken("ok-token", envWithDomains(), {
			fetcher: fetcher as unknown as typeof fetch,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.identity.authMethod).toBe("domain");
			expect(result.identity.matchedAccountId).toBe("acct-1");
		}
	});

	it("authenticates through the middleware entry with the same fetcher", async () => {
		const fetcher = nativeStyleFetcher(zonePayload("example.com", "acct-1"));
		const result = await authenticateMcpRequest("Bearer ok-token", envWithDomains(), {
			fetcher: fetcher as unknown as typeof fetch,
		});

		expect(result.ok).toBe(true);
	});

	it("maps an API rejection through the same brand-checked fetcher", async () => {
		const fetcher = nativeStyleFetcher(
			{
				success: false,
				errors: [{ code: 6003, message: "Invalid request headers" }],
			},
			400,
		);
		const result = await verifyMcpToken("bad-token", envWithDomains(), {
			fetcher: fetcher as unknown as typeof fetch,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.status).toBe(500);
			expect(result.error).toBe("configuration_error");
			expect(result.message).toContain("rejected an inbox domain lookup");
		}
	});
});
