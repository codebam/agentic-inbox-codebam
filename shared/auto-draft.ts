// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-mailbox auto-draft switch.
 *
 * New mail normally makes the agent draft a reply for the operator to review
 * before sending. Only an explicit `false` turns that off, so mailboxes whose
 * stored settings predate the switch keep auto-drafting.
 */

/** Whether a mailbox auto-drafts replies to new mail. Defaults to enabled. */
export function normalizeAutoDraft(value: unknown): boolean {
	return value !== false;
}
