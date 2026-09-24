// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Spam-marking helpers shared by the Worker, agent, MCP tools, and API routes.
 *
 * An email counts as "marked as spam" when any of the following is true:
 *   - it currently sits in the Spam folder,
 *   - its category is the built-in `spam` category, or
 *   - its stored classification audit trail says `is_spam: true`.
 *
 * Drafting a reply must be refused for all three shapes, because a mailbox's
 * `moveToSpam` setting can be off while the spam category is still applied, and
 * a message can be moved into Spam manually after classification.
 */

import { SPAM_CATEGORY_ID } from "./categories";
import { Folders } from "./folders";

/** The subset of an email row needed to decide whether it is marked spam. */
export interface SpamMarkedEmailFields {
	folder_id?: string | null;
	category?: string | null;
	classification?: string | Record<string, unknown> | null;
}

function classifySpamAudit(
	classification: string | Record<string, unknown> | null | undefined,
): boolean {
	if (!classification) return false;
	if (typeof classification === "string") {
		try {
			const parsed = JSON.parse(classification) as Record<string, unknown> | null;
			return parsed?.["is_spam"] === true;
		} catch {
			return false;
		}
	}
	return classification["is_spam"] === true;
}

/**
 * True when the email is in the Spam folder, carries the spam category, or was
 * recorded as spam by the inbound classifier.
 */
export function isSpamMarkedEmail(
	email: SpamMarkedEmailFields | null | undefined,
): boolean {
	if (!email) return false;
	if (
		typeof email.folder_id === "string" &&
		email.folder_id.toLowerCase() === Folders.SPAM
	) {
		return true;
	}
	if (
		typeof email.category === "string" &&
		email.category.toLowerCase() === SPAM_CATEGORY_ID
	) {
		return true;
	}
	return classifySpamAudit(email.classification);
}
