// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Deployment-wide switches for the AI surfaces.
 *
 * Both flags are OPT-OUT: the AI agent (agent panels, `/agents/*`, auto-draft)
 * and the MCP server (`/mcp`) stay enabled unless the operator explicitly
 * turns one off, so deployments that predate the switches keep working. The
 * only disabling values are the strings "false" and "0" (trimmed, any case);
 * an unset variable, the empty string and every other value mean enabled.
 */

/**
 * The minimal environment shape both readers need — any env object carrying
 * the variables fits, including a plain object in a test.
 */
interface AgentFlagEnv {
	ENABLE_AI_AGENT?: string | undefined;
	ENABLE_MCP?: string | undefined;
}

/** Whether a raw flag value explicitly turns its surface off. */
function isDisabled(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "false" || normalized === "0";
}

/**
 * Whether the AI agent surfaces are enabled: the `/agents/*` routes, the
 * in-app agent panel and the auto-draft trigger on incoming mail. Defaults to
 * enabled — only `ENABLE_AI_AGENT` set to "false" or "0" disables it.
 */
export function isAiAgentEnabled(env: AgentFlagEnv): boolean {
	return !isDisabled(env.ENABLE_AI_AGENT);
}

/**
 * Whether the MCP server is enabled: the `/mcp` endpoint AI tools connect to.
 * Defaults to enabled — only `ENABLE_MCP` set to "false" or "0" disables it.
 */
export function isMcpEnabled(env: AgentFlagEnv): boolean {
	return !isDisabled(env.ENABLE_MCP);
}
