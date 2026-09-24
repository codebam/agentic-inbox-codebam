// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-mailbox task/deadline extraction switch.
 *
 * Extraction is on by default, mirroring auto-draft: only an explicit
 * `false` turns it off, so mailboxes whose stored settings predate the
 * switch keep extracting.
 */

export interface ItemsSettings {
	enabled: boolean;
}

/** Whether a mailbox extracts tasks and deadlines from incoming mail. */
export function normalizeItemsSettings(value: unknown): ItemsSettings {
	const raw =
		typeof value === "object" && value !== null
			? (value as Record<string, unknown>)
			: {};
	return { enabled: raw["enabled"] !== false };
}
