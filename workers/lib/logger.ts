// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Minimal structured logging for the workers.
 *
 * `log(event, fields)` emits one JSON object per line via `console.log`
 * (Workers Logs / `wrangler tail` parse each line as JSON). It is
 * additive: existing `console.log`/`console.error` call sites are kept
 * where tests or operators depend on their text, and structured entries
 * are added alongside them — never instead of them.
 *
 * Event names are snake_case (`email_stored`, `email_deduped`,
 * `email_discarded`, `email_extract_failed`, …) so they can be counted
 * in log queries. Callers always include `mailboxId` and `messageId`
 * when they are known.
 */
export function log(event: string, fields: Record<string, unknown> = {}): void {
	console.log(JSON.stringify({ event, timestamp: new Date().toISOString(), ...fields }));
}
