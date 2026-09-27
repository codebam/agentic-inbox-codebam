// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The AI surfaces are opt-out (issue #68): ENABLE_AI_AGENT and ENABLE_MCP
 * default to enabled, and only the exact values "false"/"0" (trimmed, any
 * case) turn a surface off. This covers the helpers' truth table, the 404
 * gates on /mcp and /agents/*, the config route's flags, and the unchanged
 * behaviour while neither flag is set. The test pool's config deliberately
 * omits both vars, so the default-enabled path here is the real one.
 */

import { createExecutionContext, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isAiAgentEnabled, isMcpEnabled } from "../shared/agent-flags";
import worker from "../workers/app";
import type { Env } from "../workers/types";

/** The pool's env, typed the way the worker sees it. */
const appEnv = env as unknown as Env;

/** The pool's env plus flag overrides, the way a deploy configures them. */
function withFlags(overrides: { ENABLE_AI_AGENT?: string; ENABLE_MCP?: string }): Env {
	return { ...env, ...overrides } as unknown as Env;
}

/** One unauthenticated request through the real worker fetch. */
function fetchWith(request: Request, requestEnv: Env): Promise<Response> {
	return worker.fetch(request, requestEnv, createExecutionContext());
}

describe("agent flag helpers", () => {
	const enabledValues: (string | undefined)[] = [undefined, "", "true", "TRUE", "1", "yes"];
	const disabledValues: string[] = ["false", "FALSE", "  false  ", "0"];

	it("keeps both surfaces enabled for every value but false and 0", () => {
		for (const value of enabledValues) {
			expect(isAiAgentEnabled({ ENABLE_AI_AGENT: value })).toBe(true);
			expect(isMcpEnabled({ ENABLE_MCP: value })).toBe(true);
		}
	});

	it("disables the matching surface for false, padded false and 0", () => {
		for (const value of disabledValues) {
			expect(isAiAgentEnabled({ ENABLE_AI_AGENT: value })).toBe(false);
			expect(isMcpEnabled({ ENABLE_MCP: value })).toBe(false);
		}
	});

	it("reads only its own variable", () => {
		expect(isAiAgentEnabled({ ENABLE_MCP: "false" })).toBe(true);
		expect(isMcpEnabled({ ENABLE_AI_AGENT: "false" })).toBe(true);
		expect(isAiAgentEnabled({})).toBe(true);
		expect(isMcpEnabled({})).toBe(true);
	});
});

describe("disabled surfaces", () => {
	it("answers 404 with a JSON error on /mcp when ENABLE_MCP is false", async () => {
		const res = await fetchWith(
			new Request("https://example.com/mcp"),
			withFlags({ ENABLE_MCP: "false" }),
		);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "MCP server is disabled." });
	});

	it("gates every /mcp subpath too", async () => {
		const res = await fetchWith(
			new Request("https://example.com/mcp/messages"),
			withFlags({ ENABLE_MCP: "false" }),
		);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "MCP server is disabled." });
	});

	it("answers 404 with a JSON error on /agents/* when ENABLE_AI_AGENT is false", async () => {
		const res = await fetchWith(
			new Request("https://example.com/agents/something"),
			withFlags({ ENABLE_AI_AGENT: "false" }),
		);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "AI agent is disabled." });
	});

	it("leaves the MCP endpoint alone when only the agent is disabled", async () => {
		const res = await fetchWith(
			new Request("https://example.com/mcp"),
			withFlags({ ENABLE_AI_AGENT: "false" }),
		);
		// The MCP handler's own answer, never the gate's 404.
		expect(res.status).toBe(406);
	});

	it("leaves the agent routes alone when only MCP is disabled", async () => {
		const res = await fetchWith(
			new Request("https://example.com/agents/unknown"),
			withFlags({ ENABLE_MCP: "false" }),
		);
		expect(res.status).toBe(404);
		expect(await res.text()).toBe("Agent not found");
	});
});

describe("enabled surfaces behave as before", () => {
	// The pool runs in dev mode, so the Access middleware steps aside and the
	// MCP handler itself answers an unauthenticated request. Measured before
	// the gate was added: 406 with the SDK's "Not Acceptable" error.
	it("an unauthenticated /mcp request still reaches the MCP handler", async () => {
		const res = await fetchWith(new Request("https://example.com/mcp"), appEnv);
		expect(res.status).toBe(406);
		const body = (await res.json()) as { jsonrpc?: string; error?: { message?: string } };
		expect(body.jsonrpc).toBe("2.0");
		expect(body.error?.message).toBe("Not Acceptable: Client must accept text/event-stream");
	});

	it("unknown agents keep answering the Agent not found 404", async () => {
		const res = await fetchWith(new Request("https://example.com/agents/unknown"), appEnv);
		expect(res.status).toBe(404);
		expect(await res.text()).toBe("Agent not found");
	});
});

describe("config route reports the flags", () => {
	it("reports both surfaces enabled through SELF by default", async () => {
		const res = await SELF.fetch("https://example.com/api/v1/config");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { agentEnabled: boolean; mcpEnabled: boolean };
		expect(body.agentEnabled).toBe(true);
		expect(body.mcpEnabled).toBe(true);
	});

	it("reports both disabled through an env with both flags off", async () => {
		const res = await fetchWith(
			new Request("https://example.com/api/v1/config"),
			withFlags({ ENABLE_AI_AGENT: "false", ENABLE_MCP: "false" }),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { agentEnabled: boolean; mcpEnabled: boolean };
		expect(body.agentEnabled).toBe(false);
		expect(body.mcpEnabled).toBe(false);
	});
});
