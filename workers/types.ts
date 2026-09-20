// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	/** Optional catch-all overrides. Unset enables per-domain derived defaults. */
	CATCH_ALL_MAILBOX?: string;
	CATCH_ALL_MAILBOXES?: string | string[];
	/**
	 * Optional explicit Cloudflare account allowlist for agent MCP auth.
	 * When unset, MCP bearer credentials are accepted when they can read one of
	 * the zones configured in DOMAINS (or derived from EMAIL_ADDRESSES).
	 */
	MCP_ALLOWED_ACCOUNT_IDS?: string;
	/** Override for tests or non-default Cloudflare API deployments. */
	CLOUDFLARE_API_BASE?: string;
	/** Optional per-colo auth cache TTL in seconds. */
	MCP_AUTH_CACHE_TTL_SECONDS?: string;
	/** Set to "true" to disable the MCP auth cache. */
	MCP_AUTH_DISABLE_CACHE?: string;
}
