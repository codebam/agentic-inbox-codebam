// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Files uploaded ahead of a queued send.
 *
 * A scheduled send's stored payload is bounded JSON and can never hold file
 * bytes, so a message that carries files rides the queue by id: the composer
 * uploads each file first (POST /api/v1/mailboxes/:mailboxId/uploads), the
 * bytes go to R2 under `uploads/{mailbox_id}/{id}/{filename}`, and one
 * `pending_uploads` row per file (migration 33) records what the id names.
 * The queued payload stores the ids in its `upload_ids` array; the fire path
 * resolves them back to bytes immediately before the send call, so a queued
 * message never goes out short a file.
 *
 * The caps are the linked-attachment caps (workers/lib/attachment-links.ts):
 * the upload route refuses exactly what the linked path would refuse, so
 * nothing can be queued that an immediate send could not carry.
 *
 * Lifecycle: an upload's row and object are dropped when the send that used
 * them succeeds, by the DELETE route, or by the daily sweep once the row has
 * sat unconsumed for PENDING_UPLOAD_TTL_DAYS. The sweep never touches a
 * consumed row, so it cannot take bytes out from under a send in flight.
 */

import { isLinkableAttachment } from "../../app/lib/attachments";
import type { SendEmailParams } from "../email-sender";
import type { Env } from "../types";
import {
	LINK_TTL_DAYS,
	buildDownloadUrl,
	buildLinkedAttachmentSection,
	buildLinkedAttachmentText,
	createLinkToken,
	linkExpiryIso,
	type LinkedAttachmentLink,
} from "./attachment-links";
import {
	attachmentR2Key,
	encodeBase64Bytes,
	type StoredAttachment,
} from "./attachments";
import { getMailboxStub, listMailboxes } from "./email-helpers";

// ── Rows ───────────────────────────────────────────────────────────

/** One `pending_uploads` row, as the Durable Object and the routes return it. */
export interface PendingUploadRow {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	/** R2 key of the bytes (`uploads/{mailbox_id}/{id}/{filename}`). */
	r2_key: string;
	created_at: string;
	/** 1 once a send has used the bytes; 0 while the upload may still ride one. */
	consumed: number;
}

/** The input MailboxDO.createPendingUpload stores. */
export interface CreatePendingUploadInput {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	/** R2 key of the bytes (pendingUploadR2Key). */
	r2Key: string;
	/** ISO instant the row was created; defaults to now. */
	createdAt?: string;
}

// ── Limits and keys ────────────────────────────────────────────────

/**
 * How long an unconsumed upload survives before the daily sweep may delete
 * it. A send queued further ahead than this cannot resolve its files and is
 * recorded `failed` with the reason, rather than sending without them.
 */
export const PENDING_UPLOAD_TTL_DAYS = 7;

/** Rows one Durable Object round trip may hand back to the sweep. */
export const PENDING_UPLOAD_SWEEP_BATCH = 100;

/** Most uploads one mailbox's sweep handles in a single run, so it stays bounded. */
export const PENDING_UPLOAD_SWEEP_MAX_PER_MAILBOX = 500;

/**
 * Longest upload id a queued payload may carry. Real ids are
 * crypto.randomUUID() values (36 characters); the cap only keeps a
 * hand-built payload from smuggling anything oversized into the row.
 */
export const MAX_UPLOAD_ID_CHARS = 64;

/**
 * R2 key an upload's bytes live at: `uploads/{mailbox_id}/{upload_id}/{filename}`,
 * the upload counterpart of attachmentR2Key. The filename is already
 * sanitized when the row is created (sanitizeAttachmentFilename), exactly as
 * the attachment paths sanitize theirs.
 */
export function pendingUploadR2Key(upload: {
	mailboxId: string;
	id: string;
	filename: string;
}): string {
	return `uploads/${upload.mailboxId}/${upload.id}/${upload.filename}`;
}

/** ISO instant before which an upload counts as stale, for the sweep. */
export function pendingUploadCutoff(
	now: Date,
	ttlDays: number = PENDING_UPLOAD_TTL_DAYS,
): string {
	return new Date(now.getTime() - ttlDays * 24 * 60 * 60 * 1000).toISOString();
}

/** True when an upload has outlived the retention window (unreadable stamp: yes). */
export function pendingUploadExpired(
	upload: { created_at: string },
	now: Date,
	ttlDays: number = PENDING_UPLOAD_TTL_DAYS,
): boolean {
	const created = Date.parse(upload.created_at);
	if (Number.isNaN(created)) return true;
	return now.getTime() - created > ttlDays * 24 * 60 * 60 * 1000;
}

// ── Fire-time resolution ───────────────────────────────────────────

/** One queued upload resolved to its bytes, ready to ride a send. */
export interface ResolvedScheduledUpload {
	row: PendingUploadRow;
	bytes: Uint8Array;
	/** The Sent copy's attachment id; also the download link's attachment id. */
	attachmentId: string;
	/** Fresh download-link capability for a file at or above the threshold; null below it. */
	link: { token: string; expiresAt: string } | null;
}

export type ResolveScheduledUploadsResult =
	| { ok: true; uploads: ResolvedScheduledUpload[] }
	| { ok: false; error: string };

/**
 * Resolve queued upload ids to their bytes, immediately before a send.
 *
 * All-or-nothing: one id that is missing, already consumed or past its
 * retention window — or whose bytes are gone from R2 — fails the whole set
 * with the reason, so a queued message never goes out short a file. A file
 * at or above LINK_THRESHOLD_BYTES is marked with a fresh link (token plus
 * expiry): it follows the linked rule unchanged and stays in R2 behind a
 * download link instead of travelling in the message.
 */
export async function resolveScheduledSendUploads(
	bucket: Env["BUCKET"],
	readRow: (id: string) => PendingUploadRow | null,
	ids: readonly string[],
	now: Date = new Date(),
): Promise<ResolveScheduledUploadsResult> {
	const uploads: ResolvedScheduledUpload[] = [];
	for (const id of ids) {
		const row = readRow(id);
		if (!row) {
			return {
				ok: false,
				error: `Attachment upload ${id} is missing — nothing was sent.`,
			};
		}
		if (row.consumed === 1) {
			return {
				ok: false,
				error: `Attachment upload "${row.filename}" has already been used — nothing was sent.`,
			};
		}
		if (pendingUploadExpired(row, now)) {
			return {
				ok: false,
				error: `Attachment upload "${row.filename}" expired before the send — nothing was sent.`,
			};
		}
		const object = await bucket.get(row.r2_key);
		if (!object) {
			return {
				ok: false,
				error: `The stored bytes of attachment "${row.filename}" are gone — nothing was sent.`,
			};
		}
		const bytes = await object.bytes();
		uploads.push({
			row,
			bytes,
			attachmentId: crypto.randomUUID(),
			link: isLinkableAttachment({ size: bytes.byteLength })
				? { token: createLinkToken(), expiresAt: linkExpiryIso(now, LINK_TTL_DAYS) }
				: null,
		});
	}
	return { ok: true, uploads };
}

/**
 * The send binding's attachment entries for the files that travel in the
 * message: every resolved upload below the link threshold, base64-encoded
 * exactly like the immediate send route hands its `attachments[]` over.
 */
export function scheduledUploadInlineAttachments(
	uploads: readonly ResolvedScheduledUpload[],
): NonNullable<SendEmailParams["attachments"]> {
	return uploads.flatMap((upload) =>
		upload.link
			? []
			: [
					{
						content: encodeBase64Bytes(upload.bytes),
						filename: upload.row.filename,
						type: upload.row.mimetype,
						disposition: "attachment" as const,
					},
				],
	);
}

/**
 * The download-link section the body gains for the files that do not travel
 * in the message — the same section the immediate send route appends
 * (buildLinkedAttachmentSection / buildLinkedAttachmentText). The fire path
 * runs without a request, so the link is the app-relative path
 * `buildDownloadUrl` produces without an origin.
 */
export function scheduledUploadLinkedSection(
	uploads: readonly ResolvedScheduledUpload[],
	mailboxId: string,
): { html: string; text: string } {
	const links: LinkedAttachmentLink[] = uploads.flatMap((upload) =>
		upload.link
			? [
					{
						filename: upload.row.filename,
						size: upload.bytes.byteLength,
						url: buildDownloadUrl(mailboxId, upload.attachmentId, upload.link.token),
						expiresAt: upload.link.expiresAt,
					},
				]
			: [],
	);
	return {
		html: buildLinkedAttachmentSection(links),
		text: buildLinkedAttachmentText(links),
	};
}

/**
 * The Sent copy's attachment rows for every resolved upload: the same shape
 * the immediate send route stores, with a link token and expiry on the files
 * that are shared as links.
 */
export function scheduledUploadSentAttachments(
	uploads: readonly ResolvedScheduledUpload[],
	emailId: string,
): StoredAttachment[] {
	return uploads.map((upload) => ({
		id: upload.attachmentId,
		email_id: emailId,
		filename: upload.row.filename,
		mimetype: upload.row.mimetype,
		size: upload.bytes.byteLength,
		content_id: null,
		disposition: "attachment",
		...(upload.link
			? { link_token: upload.link.token, link_expires_at: upload.link.expiresAt }
			: {}),
	}));
}

/**
 * The attachment rows a recovered draft needs for its queued files: one
 * ordinary attachment per upload and no link token, because a draft is an
 * editable message and drafts never carry link rows. The bytes are written
 * by `scheduledUploadAttachmentCopies` under the draft's own keys.
 *
 * Used when a cancelled send is saved back as a draft
 * (MailboxDO.cancelScheduledSend), so a queued message's files survive the
 * cancellation exactly like its text does.
 */
export function scheduledUploadDraftAttachments(
	uploads: readonly ResolvedScheduledUpload[],
	emailId: string,
): StoredAttachment[] {
	return uploads.map((upload) => ({
		id: upload.attachmentId,
		email_id: emailId,
		filename: upload.row.filename,
		mimetype: upload.row.mimetype,
		size: upload.bytes.byteLength,
		content_id: null,
		disposition: "attachment",
	}));
}

/**
 * The R2 objects an email's attachment rows read: each upload's bytes copied
 * to the attachment key the download routes serve. Only possible once the
 * message id exists, so the fire path runs this after the send (for the Sent
 * copy) and the cancel path runs it before the recovered draft is stored.
 */
export function scheduledUploadAttachmentCopies(
	uploads: readonly ResolvedScheduledUpload[],
	emailId: string,
): { key: string; bytes: Uint8Array }[] {
	return uploads.map((upload) => ({
		key: attachmentR2Key({
			email_id: emailId,
			id: upload.attachmentId,
			filename: upload.row.filename,
		}),
		bytes: upload.bytes,
	}));
}

// ── The daily sweep ────────────────────────────────────────────────

export interface PendingUploadSweepSummary {
	/** Mailboxes with at least one stale upload processed. */
	mailboxes: number;
	/** Stale upload rows (and objects) deleted across every swept mailbox. */
	uploads: number;
}

/**
 * Delete the rows and R2 objects of uploads that were never used, once they
 * have outlived PENDING_UPLOAD_TTL_DAYS. Mirrors `sweepAttachmentLinks`:
 * every mailbox is visited, each batch is bounded, and a failure in one
 * mailbox is logged and never stops the sweep. Consumed rows are not listed
 * by the Durable Object, so a file a send is using is never swept.
 */
export async function sweepPendingUploads(
	env: Env,
	opts: { now?: Date } = {},
): Promise<PendingUploadSweepSummary> {
	const cutoff = pendingUploadCutoff(opts.now ?? new Date());
	const summary: PendingUploadSweepSummary = { mailboxes: 0, uploads: 0 };

	for (const mailbox of await listMailboxes(env.BUCKET)) {
		try {
			const stub = getMailboxStub(env, mailbox.id);
			let swept = 0;
			for (;;) {
				const stale = await stub.listPendingUploadsBefore(
					cutoff,
					PENDING_UPLOAD_SWEEP_BATCH,
				);
				if (stale.length === 0) break;
				for (const upload of stale) {
					await env.BUCKET.delete(upload.r2_key);
					await stub.deletePendingUpload(upload.id);
					swept += 1;
				}
				if (stale.length < PENDING_UPLOAD_SWEEP_BATCH) break;
				if (swept >= PENDING_UPLOAD_SWEEP_MAX_PER_MAILBOX) break;
			}
			if (swept > 0) {
				summary.mailboxes += 1;
				summary.uploads += swept;
			}
		} catch (e) {
			console.error(
				`Pending upload sweep failed for ${mailbox.id}:`,
				(e as Error).message,
			);
		}
	}

	console.log(
		`Pending upload sweep: ${summary.mailboxes} mailbox(es), ` +
			`${summary.uploads} stale upload(s) deleted`,
	);
	return summary;
}
