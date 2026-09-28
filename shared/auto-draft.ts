// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-mailbox auto-draft switch.
 *
 * New mail normally makes the agent draft a reply for the operator to review
 * before sending. Only an explicit `false` turns that off, so mailboxes whose
 * stored settings predate the switch keep auto-drafting. The Jev reply gate
 * (see `shared/categories.ts` and `workers/lib/categorize.ts`) can hold
 * individual drafts back; `storedExpectsReply` reads its verdict off a
 * stored email row.
 */

/** Whether a mailbox auto-drafts replies to new mail. Defaults to enabled. */
export function normalizeAutoDraft(value: unknown): boolean {
	return value !== false;
}

/**
 * Read the Jev "reply expected" verdict stored in an email row's
 * classification audit trail (serialized by `workers/lib/categorize.ts`).
 *
 * Returns the recorded boolean when the classifier stored one, and null when
 * there is no verdict to read: mail received before the question existed, a
 * mailbox with the reply gate disabled, or a classification that failed. A
 * null verdict means "unknown" and callers keep drafting, matching the
 * classifier's best-effort contract.
 */
export function storedExpectsReply(
	classification: string | Record<string, unknown> | null | undefined,
): boolean | null {
	if (!classification) return null;
	let parsed: Record<string, unknown> | null;
	if (typeof classification === "string") {
		try {
			const value = JSON.parse(classification) as unknown;
			parsed =
				value && typeof value === "object" && !Array.isArray(value)
					? (value as Record<string, unknown>)
					: null;
		} catch {
			return null;
		}
	} else {
		parsed = classification;
	}
	if (!parsed) return null;
	const value = parsed["expects_reply"];
	return typeof value === "boolean" ? value : null;
}
