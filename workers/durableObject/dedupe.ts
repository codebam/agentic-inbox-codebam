// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";


/** The Drizzle database handle MailboxDO passes around. */
export type MailboxDb = ReturnType<typeof drizzle>;


/**
 * Result of MailboxDO.createEmail.
 *
 * `id` is the stored row's id; for a duplicate delivery it is the id of the
 * row that was already there. `duplicate` is true only when the insert was
 * skipped because this mailbox already holds a row with the same RFC 5322
 * Message-ID. Callers that ignore the return value keep working unchanged:
 * createEmail still resolves normally and still throws the same errors.
 */
export interface CreateEmailResult {
	id: string;
	duplicate: boolean;
}


/**
 * Find the id of an email already stored in this mailbox with the same
 * `message_id` (the RFC 5322 Message-ID with angle brackets stripped by the
 * ingest path). Returns null when the incoming message_id is null or empty —
 * locally-created rows (drafts, sent copies) omit it and must never be
 * deduplicated against each other.
 *
 * Folder is deliberately NOT part of the lookup: once a Message-ID is stored
 * in the mailbox it stays a duplicate wherever the user has since moved it,
 * so a redelivery can never resurrect a trashed or archived message into
 * Inbox.
 */
export function findDuplicateEmailId(
	db: MailboxDb,
	messageId: string | null | undefined,
): string | null {
	if (!messageId) return null;
	const row = db
		.select({ id: schema.emails.id })
		.from(schema.emails)
		.where(eq(schema.emails.message_id, messageId))
		.limit(1)
		.get();
	return row?.id ?? null;
}
