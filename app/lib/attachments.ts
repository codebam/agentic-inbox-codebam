// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Attachment helpers for the composer.
 *
 * The limits mirror the Cloudflare Email Service outbound message limit: a
 * message — headers, body and attachments together — may total 25 MiB. The
 * composer therefore caps a single file and the sum of all attachments at
 * 25 MB, and refuses to add more than 20 files. They live here, in one pure
 * module, so the picker, the tests and any future caller read the same
 * numbers: tune them in this block.
 *
 * Files at or above LINK_THRESHOLD_BYTES are too large for the send binding,
 * so the composer routes them into the linked list instead: their bytes are
 * stored in R2 and the message carries a public download link. That list has
 * its own caps (MAX_LINKED_*), enforced here in the composer and again on the
 * send route.
 *
 * Everything in this file except `blobToBase64` is pure, so it can be unit
 * tested inside workerd without a DOM.
 */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 20;

/**
 * Files at or above this size are too large to travel in the message: the
 * Cloudflare Email Service send binding rejects a message — headers, body and
 * attachments together — over its documented total-message limit, so the
 * composer routes them into the linked list instead. Their bytes are stored
 * in R2 and the message carries a public download link.
 * https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 *
 * These five numbers are the single source of truth for both the composer and
 * the server-side enforcement on the send route (workers/lib/attachment-links.ts
 * re-exports them for the worker).
 */
export const LINK_THRESHOLD_BYTES = 5 * 1024 * 1024;
/** Largest single file that may be shared as a download link. */
export const MAX_LINKED_FILE_BYTES = 60 * 1024 * 1024;
/** Largest combined size of the files shared as links in one message. */
export const MAX_LINKED_TOTAL_BYTES = 100 * 1024 * 1024;
/** Most files one message may share as download links. */
export const MAX_LINKED_FILES = 5;
/** How long a public download link stays valid, in days. */
export const LINK_TTL_DAYS = 30;


export const DEFAULT_ATTACHMENT_TYPE = "application/octet-stream";


export type AttachmentDisposition = "attachment" | "inline";


/** A file the user picked, before its bytes have been read. */
export interface AttachmentCandidate {
	filename: string;
	type: string;
	size: number;
}


/** A file held in composer state, with its bytes already base64-encoded. */
export interface PendingAttachment {
	/** Local id, used as the React key. Never sent to the server. */
	id: string;
	filename: string;
	type: string;
	size: number;
	/** base64 without a `data:` prefix — the shape the API expects. */
	content: string;
	disposition: AttachmentDisposition;
	contentId?: string;
}


/** One entry of the `attachments[]` array accepted by the send/draft APIs. */
export interface AttachmentPayload {
	content: string;
	filename: string;
	type: string;
	disposition: AttachmentDisposition;
	contentId?: string;
}


/**
 * One entry of the `linked_attachments[]` array the send API accepts: a file
 * whose bytes are stored in R2 and whose row carries a public download link.
 * Mirrors the `attachments[]` entry — `type` is the mime type — plus the
 * declared `size` the server's cap check reads before storing anything.
 */
export interface LinkedAttachmentPayload extends AttachmentPayload {
	size: number;
}


/** The stored-attachment metadata the API returns for a saved draft. */
export interface StoredAttachmentInfo {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}


export interface AttachmentSelectionResult {
	accepted: AttachmentCandidate[];
	errors: string[];
}


/**
 * Format a byte count for display ("1.5 MB").
 *
 * Mirrors `formatBytes` from app/lib/utils.ts, but stays dependency-free so
 * it can be imported from pure modules and tested in workerd.
 */
export function formatFileSize(bytes: number, decimals = 1): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const k = 1024;
	const dm = decimals < 0 ? 0 : decimals;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
	return `${Number.parseFloat((bytes / k ** i).toFixed(dm))} ${sizes[i]}`;
}


/** Sum of the byte sizes of a set of attachments. */
export function getAttachmentTotalBytes(
	items: readonly { size: number }[],
): number {
	return items.reduce(
		(total, item) => total + (Number.isFinite(item.size) ? item.size : 0),
		0,
	);
}


/**
 * Apply the size and count limits to a batch of picked files, given what is
 * already attached. Every rejected file gets a message the picker shows
 * inline; accepted files are returned in the order they were picked.
 */
export function validateAttachmentSelection(
	candidates: readonly AttachmentCandidate[],
	existing: readonly { size: number }[] = [],
): AttachmentSelectionResult {
	const accepted: AttachmentCandidate[] = [];
	const errors: string[] = [];
	let count = existing.length;
	let totalBytes = getAttachmentTotalBytes(existing);


	for (const candidate of candidates) {
		const name = candidate.filename || "file";


		if (candidate.size <= 0) {
			errors.push(`"${name}" is empty and was not attached.`);
			continue;
		}
		if (candidate.size > MAX_FILE_BYTES) {
			errors.push(
				`"${name}" is ${formatFileSize(candidate.size)} — over the ${formatFileSize(MAX_FILE_BYTES)} per-file limit.`,
			);
			continue;
		}
		if (count >= MAX_FILES) {
			errors.push(
				`"${name}" was not attached — up to ${MAX_FILES} files can be attached.`,
			);
			continue;
		}
		if (totalBytes + candidate.size > MAX_TOTAL_BYTES) {
			errors.push(
				`"${name}" was not attached — attachments would exceed the ${formatFileSize(MAX_TOTAL_BYTES)} total limit.`,
			);
			continue;
		}


		accepted.push(candidate);
		count += 1;
		totalBytes += candidate.size;
	}


	return { accepted, errors };
}


/** True when a picked file is too large for the send binding, so it is shared as a link. */
export function isLinkableAttachment(candidate: { size: number }): boolean {
	return candidate.size >= LINK_THRESHOLD_BYTES;
}


/**
 * Apply the linked-file limits to a batch of picked files, given the links
 * already held. Mirrors `validateAttachmentSelection`; the send route enforces
 * the same caps (workers/lib/attachment-links.ts) so a direct API caller
 * cannot store more than one message may link.
 */
export function validateLinkedAttachmentSelection(
	candidates: readonly AttachmentCandidate[],
	existing: readonly { size: number }[] = [],
): AttachmentSelectionResult {
	const accepted: AttachmentCandidate[] = [];
	const errors: string[] = [];
	let count = existing.length;
	let totalBytes = getAttachmentTotalBytes(existing);


	for (const candidate of candidates) {
		const name = candidate.filename || "file";


		if (candidate.size <= 0) {
			errors.push(`"${name}" is empty and was not attached.`);
			continue;
		}
		if (candidate.size > MAX_LINKED_FILE_BYTES) {
			errors.push(
				`"${name}" is ${formatFileSize(candidate.size)} — over the ${formatFileSize(MAX_LINKED_FILE_BYTES)} limit for a linked file.`,
			);
			continue;
		}
		if (count >= MAX_LINKED_FILES) {
			errors.push(
				`"${name}" was not attached — up to ${MAX_LINKED_FILES} files can be shared as links.`,
			);
			continue;
		}
		if (totalBytes + candidate.size > MAX_LINKED_TOTAL_BYTES) {
			errors.push(
				`"${name}" was not attached — linked files would exceed the ${formatFileSize(MAX_LINKED_TOTAL_BYTES)} total limit.`,
			);
			continue;
		}


		accepted.push(candidate);
		count += 1;
		totalBytes += candidate.size;
	}


	return { accepted, errors };
}


/** Build composer state for a picked file once its bytes are encoded. */
export function createPendingAttachment(
	candidate: AttachmentCandidate,
	content: string,
	id: string,
): PendingAttachment {
	return {
		id,
		filename: candidate.filename,
		type: candidate.type || DEFAULT_ATTACHMENT_TYPE,
		size: candidate.size,
		content,
		disposition: "attachment",
	};
}


/**
 * Rebuild a composer attachment from a stored attachment row (metadata) plus
 * the bytes re-downloaded for it, so a re-opened draft — or a forward — can be
 * sent with its files intact.
 */
export function pendingAttachmentFromStored(
	attachment: StoredAttachmentInfo,
	content: string,
): PendingAttachment {
	return {
		id: attachment.id,
		filename: attachment.filename,
		type: attachment.mimetype || DEFAULT_ATTACHMENT_TYPE,
		size: attachment.size,
		content,
		disposition: attachment.disposition === "inline" ? "inline" : "attachment",
		...(attachment.content_id ? { contentId: attachment.content_id } : {}),
	};
}


/**
 * Shape composer attachments for the API. Items whose bytes were never read
 * (a failed download) are skipped rather than sent as empty content.
 */
export function toAttachmentPayloads(
	items: readonly PendingAttachment[],
): AttachmentPayload[] {
	return items
		.filter((item) => item.content.length > 0)
		.map((item) => ({
			content: item.content,
			filename: item.filename,
			type: item.type || DEFAULT_ATTACHMENT_TYPE,
			disposition: item.disposition,
			...(item.contentId ? { contentId: item.contentId } : {}),
		}));
}


/**
 * Shape the composer's linked files for the API's `linked_attachments[]`
 * array. Same entry shape as `attachments[]` (so the send schema reads the
 * same fields), plus the declared size the server's cap check uses.
 */
export function toLinkedAttachmentPayloads(
	items: readonly PendingAttachment[],
): LinkedAttachmentPayload[] {
	return items
		.filter((item) => item.content.length > 0)
		.map((item) => ({
			content: item.content,
			filename: item.filename,
			type: item.type || DEFAULT_ATTACHMENT_TYPE,
			size: item.size,
			disposition: item.disposition,
			...(item.contentId ? { contentId: item.contentId } : {}),
		}));
}


/**
 * Composer footer summary, e.g. "2 files · 1.5 MB of 25 MB".
 * Null when nothing is attached.
 */
export function describeAttachmentSummary(
	items: readonly { size: number }[],
): string | null {
	if (items.length === 0) return null;
	const label = items.length === 1 ? "file" : "files";
	return `${items.length} ${label} · ${formatFileSize(getAttachmentTotalBytes(items))} of ${formatFileSize(MAX_TOTAL_BYTES)}`;
}


/**
 * Composer footer summary for the linked list, e.g.
 * "1 file · 12 MB shared as links". Null when nothing is linked.
 */
export function describeLinkedAttachmentSummary(
	items: readonly { size: number }[],
): string | null {
	if (items.length === 0) return null;
	const label = items.length === 1 ? "file" : "files";
	return `${items.length} ${label} · ${formatFileSize(getAttachmentTotalBytes(items))} shared as links`;
}


/** Strip the `data:<type>;base64,` prefix FileReader prepends to a data URL. */
export function stripDataUrlPrefix(dataUrl: string): string {
	const marker = ";base64,";
	const index = dataUrl.indexOf(marker);
	return index === -1 ? dataUrl : dataUrl.slice(index + marker.length);
}


/**
 * Read a File/Blob into base64 (no `data:` prefix).
 *
 * Browser-only: the picker calls this for every file the user adds and while
 * it is in flight the composer keeps Send disabled.
 */
export async function blobToBase64(blob: Blob): Promise<string> {
	const dataUrl = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
		reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
		reader.readAsDataURL(blob);
	});
	return stripDataUrlPrefix(dataUrl);
}
