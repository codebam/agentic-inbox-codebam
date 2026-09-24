// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-mailbox morning-digest switch.
 *
 * The digest is an outbound POST to the mailbox's notification webhook, so it
 * is opt-in: only an explicit `true` turns it on, and a mailbox without a
 * webhook URL never delivers one.
 */

/** Whether a mailbox delivers a daily digest to its notification webhook. */
export function normalizeDigestEnabled(value: unknown): boolean {
	return value === true;
}
