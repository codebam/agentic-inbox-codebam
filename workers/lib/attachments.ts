// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared attachment storage logic.
 * Eliminates the triplicated atob → Uint8Array → R2.put pattern.
 */
import { LINK_TTL_DAYS } from "../../app/lib/attachments";
import type { Env } from "../types";
import { createLinkToken, linkExpiryIso } from "./attachment-links";

export interface StoredAttachment {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string;
	/** Capability token of the file's public download link; set only when it was stored as one. */
	link_token?: string | null;
	/** ISO 8601 instant that link stops working; null when there is no link. */
	link_expires_at?: string | null;
}

/**
 * R2 key an attachment's bytes live at. One layout for every caller:
 * `attachments/{email_id}/{attachment_id}/{filename}` — the send route, the
 * download routes, the trash purge and the link sweep all read it here.
 */
export function attachmentR2Key(attachment: {
	email_id: string;
	id: string;
	filename: string;
}): string {
	return `attachments/${attachment.email_id}/${attachment.id}/${attachment.filename}`;
}

/**
 * Decode a base64 string to bytes with the runtime's native decoder.
 *
 * The obvious `Uint8Array.from(atob(content), (c) => c.charCodeAt(0))` is a
 * per-character JS loop: measured at 376 ms of CPU for a 6.5 MB file, where
 * the native decoder does the same work in about 1 ms. A Worker is killed
 * when it exceeds its CPU budget and answers 500 — and the loop only ever
 * shows up at the sizes the download-link feature exists to send, never with
 * a small test payload. Keep this native.
 */
export function decodeBase64Bytes(content: string): Uint8Array {
	// The base64 proposal is native in the runtime (workerd, compatibility
	// date 2025-11-28); the cast keeps the call typed if the TypeScript lib
	// lags behind. `nodejs_compat` is enabled in wrangler.jsonc, so Buffer
	// covers any runtime without it — both are native and fast.
	const fromBase64 = (Uint8Array as unknown as {
		fromBase64?: (value: string) => Uint8Array;
	}).fromBase64;
	if (typeof fromBase64 === "function") return fromBase64.call(Uint8Array, content);
	const buffer = (globalThis as unknown as {
		Buffer?: { from(value: string, encoding: string): Uint8Array };
	}).Buffer;
	if (buffer) return buffer.from(content, "base64");
	throw new Error("No native base64 decoder is available in this runtime");
}

export interface StoreAttachmentOptions {
	/**
	 * Store the files as public download links: each row gets a fresh
	 * capability token and a LINK_TTL_DAYS expiry, so the file is reachable
	 * through GET /api/v1/downloads/:mailboxId/:attachmentId. The bytes are
	 * stored exactly like an ordinary attachment — only the row differs.
	 */
	linked?: boolean;
}

/**
 * Store base64-encoded attachments to R2 and return metadata for the DO.
 */
export async function storeAttachments(
	bucket: Env["BUCKET"],
	emailId: string,
	attachments?: {
		content: string;
		filename: string;
		type: string;
		disposition: string;
		contentId?: string | undefined;
	}[],
	options: StoreAttachmentOptions = {},
): Promise<StoredAttachment[]> {
	if (!attachments?.length) return [];

	const linkExpiresAt = options.linked ? linkExpiryIso(new Date(), LINK_TTL_DAYS) : null;
	const results: StoredAttachment[] = [];
	for (const att of attachments) {
		const attachmentId = crypto.randomUUID();
		// Sanitize filename to prevent path traversal in R2 keys
		const safeFilename = (att.filename || "untitled").replace(/[/\\:*?"<>|\p{Cc}]/gu, "_");
		const key = `attachments/${emailId}/${attachmentId}/${safeFilename}`;
		const bytes = decodeBase64Bytes(att.content);
		await bucket.put(key, bytes);
		results.push({
			id: attachmentId,
			email_id: emailId,
			filename: safeFilename,
			mimetype: att.type,
			size: bytes.byteLength,
			content_id: att.contentId || null,
			disposition: att.disposition,
			...(options.linked
				? { link_token: createLinkToken(), link_expires_at: linkExpiresAt }
				: {}),
		});
	}
	return results;
}
