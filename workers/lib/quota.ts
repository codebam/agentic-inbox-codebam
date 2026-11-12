// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Per-mailbox storage accounting: the one shape shared by the Durable
 * Object's getStorageUsage, the GET /api/v1/mailboxes/:mailboxId/storage
 * route and the settings StorageCard. The three *_bytes fields are byte
 * counts, the two *_count fields are row counts.
 *
 * A soft quota is enforced on `database_bytes` (see MAX_DATABASE_BYTES
 * below): MailboxDO.createEmail checks the mailbox's SQLite
 * `databaseSize` and refuses new rows once it is over the threshold.
 * HTTP callers map that refusal to 503 + Retry-After (see
 * workers/index.ts onError); the inbound `receiveEmail` path lets the
 * quota error propagate so Email Routing can retry later. A measurement
 * failure is fail-open (logged, ingest continues) — the quota is a
 * safety rail, not a hard correctness invariant.
 */

/**
 * Retention / archive note (documented, not yet implemented).
 *
 * The hard ceiling is the Durable Object SQLite storage limit: 10 GB per
 * SQLite-backed DO on Workers Paid (1 GB on the Free plan), per
 * https://developers.cloudflare.com/durable-objects/platform/limits/
 * Once that ceiling is reached every write fails with
 * `database or disk is full: SQLITE_FULL`, which would surface as opaque
 * 500s. The soft threshold below exists so new mail is refused with a
 * clear 503 + Retry-After well before that hard failure.
 *
 * The planned relief valve is to archive large message bodies out of
 * SQLite into R2 after N days (N = 90):
 *   - stub key: `archives/<emailId>.html` (compressed body bytes),
 *   - the `emails.body` column would be truncated to a placeholder and
 *     the read paths (getEmail, export, search) would fall back to R2.
 * That read-path change is risky to land without a migration and a
 * backfill, so this change deliberately documents the stub path only
 * and surfaces a warning in StorageCard.tsx once `database_bytes` is
 * at or over the threshold (approaching at 80%). Until archiving lands,
 * the operator must reclaim space by deleting mail (Trash retention,
 * purge) — the warning copy says so.
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

/**
 * Soft quota for one mailbox's SQLite database, in bytes.
 *
 * 800 MiB sits below both DO SQLite ceilings (1 GB Free, 10 GB Paid)
 * with headroom for WAL growth, index maintenance and migrations, so a
 * mailbox asks the operator to make room long before SQLite fills.
 * Enforcement is deliberately coarse: a mailbox over this threshold
 * refuses *new* rows (inbound, drafts and sent copies alike) with a 503
 * + Retry-After, while reads, moves and deletes keep working so the
 * operator can always reclaim space.
 *
 * Keep in sync with the mirror constant in app/components/StorageCard.tsx
 * — the app bundle cannot import from workers/, so the card duplicates
 * this value (the same pattern app/queries/storage.ts uses for
 * StorageUsage).
 */
export const MAX_DATABASE_BYTES = 800 * 1024 * 1024;

/**
 * "Approaching quota" warning threshold: 80% of MAX_DATABASE_BYTES.
 * StorageCard shows an amber warning at this level and a red
 * over-quota banner at MAX_DATABASE_BYTES.
 */
export const QUOTA_WARN_BYTES = Math.floor(MAX_DATABASE_BYTES * 0.8);

/**
 * Seconds advertised in `Retry-After` when the quota refuses a write
 * (one hour: long enough for the operator to delete mail, short enough
 * to retry the same day). Exported so callers and tests share it.
 */
export const QUOTA_RETRY_AFTER_SECONDS = 3600;

/**
 * HTTP status returned when the soft quota refuses a write. 503 (not
 * 429 — that is the send rate limit) says "service unavailable for
 * lack of space; retry later". The inbound email path has no HTTP
 * response, so it surfaces the same status on the thrown error.
 */
export const QUOTA_STATUS = 503;

/**
 * Whether a database of `databaseSizeBytes` is over the soft quota.
 *
 * Fail-open on a bad measurement: null/undefined/NaN/negative sizes are
 * treated as under quota so a broken measurement never blocks ingest —
 * the caller (MailboxDO.createEmail) logs the failure and continues.
 */
export function shouldEnforceQuota(databaseSizeBytes: number | null | undefined): boolean {
	if (databaseSizeBytes === null || databaseSizeBytes === undefined) return false;
	if (!Number.isFinite(databaseSizeBytes) || databaseSizeBytes < 0) return false;
	return databaseSizeBytes >= MAX_DATABASE_BYTES;
}

/**
 * Whether a database of `databaseSizeBytes` has reached the
 * approaching-quota warning level (80% of the soft quota). Fail-open on
 * a bad measurement, like shouldEnforceQuota.
 */
export function isQuotaWarning(databaseSizeBytes: number | null | undefined): boolean {
	if (databaseSizeBytes === null || databaseSizeBytes === undefined) return false;
	if (!Number.isFinite(databaseSizeBytes) || databaseSizeBytes < 0) return false;
	return databaseSizeBytes >= QUOTA_WARN_BYTES;
}

/** Thrown by MailboxDO.createEmail when the soft quota is exceeded. */
export class QuotaExceededError extends Error {
	readonly quotaExceeded = true as const;
	readonly status = QUOTA_STATUS;
	readonly retryAfter = QUOTA_RETRY_AFTER_SECONDS;
	readonly databaseSizeBytes: number;
	readonly quotaBytes = MAX_DATABASE_BYTES;

	constructor(databaseSizeBytes: number) {
		super(
			`Mailbox storage quota exceeded: database is ${databaseSizeBytes} bytes ` +
				`(limit ${MAX_DATABASE_BYTES} bytes). Delete mail to make room and retry.`,
		);
		this.name = "QuotaExceededError";
		this.databaseSizeBytes = databaseSizeBytes;
	}
}

/** True when `e` is a quota refusal (vs an unexpected failure). */
export function isQuotaExceededError(e: unknown): e is QuotaExceededError {
	return e instanceof QuotaExceededError;
}

/**
 * Assert the mailbox may store one more row. Returns normally when the
 * database is under quota; throws QuotaExceededError when it is over.
 * Callers that need a status + Retry-After read those off the error
 * (status/retryAfter) — see workers/index.ts onError.
 */
export function assertSendQuota(databaseSizeBytes: number | null | undefined): void {
	if (shouldEnforceQuota(databaseSizeBytes)) {
		throw new QuotaExceededError(databaseSizeBytes as number);
	}
}
