// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-mailbox semantic (vector) search switch, plus the frozen wire values
 * the feature shares between the Worker, the Durable Object, the routes, the
 * tools and the UI.
 *
 * The switch is opt-in — the default is OFF — because it spends one embedding
 * call per message at ingest (see workers/lib/semantic.ts). A mailbox whose
 * stored settings predate the switch reads as off, so nothing starts
 * spending AI calls without an explicit choice.
 */

export interface SemanticSearchSettings {
	enabled: boolean;
}

/** Whether a mailbox embeds and indexes incoming mail. */
export function normalizeSemanticSearchSettings(value: unknown): SemanticSearchSettings {
	const raw =
		typeof value === "object" && value !== null
			? (value as Record<string, unknown>)
			: {};
	return { enabled: raw["enabled"] === true };
}


/** Most results one semantic search answers; also the route and tool cap. */
export const SEMANTIC_SEARCH_LIMIT_MAX = 20;

/**
 * Most messages one reindex batch embeds. A caller loops the route until it
 * reports nothing left, so the batch stays small enough to fit one request
 * (and one Durable Object RPC) and bounded enough to be safe to repeat.
 */
export const SEMANTIC_REINDEX_BATCH_MAX = 20;

/**
 * Answer of every entry point when the deployment has no AI + Vectorize
 * bindings: a clear not-configured result, never a thrown error and never a
 * partial write. The Vectorize binding is deliberately not declared in
 * wrangler.jsonc yet — a declared binding for a nonexistent index fails
 * `wrangler deploy` — so this is the normal state until the operator creates
 * the index and binds it.
 */
export const SEMANTIC_NOT_CONFIGURED =
	"Semantic search is not configured on this deployment: the AI and Vectorize bindings are required, and the Vectorize index must exist before the binding is declared.";
