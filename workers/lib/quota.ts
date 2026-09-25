// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Per-mailbox storage accounting: the one shape shared by the Durable
 * Object's getStorageUsage, the GET /api/v1/mailboxes/:mailboxId/storage
 * route and the settings StorageCard. The three *_bytes fields are byte
 * counts, the two *_count fields are row counts, and nothing here enforces
 * a limit.
 */
export interface StorageUsage {
	/** Bytes the mailbox's SQLite database occupies. */
	database_bytes: number;
	/** SUM(size) over the attachments table — the source of truth for attachment bytes. */
	attachment_bytes: number;
	/** Rows in the attachments table. */
	attachment_count: number;
	/** Rows in the emails table. */
	email_count: number;
	/** Bytes of the mailbox's settings JSON object in R2; 0 when absent. */
	mailbox_json_bytes: number;
}
