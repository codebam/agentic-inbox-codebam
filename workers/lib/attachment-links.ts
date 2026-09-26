// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Public download links for large attachments.
 *
 * The Email Service send binding rejects a message — headers, body and
 * attachments together — over its documented total-message limit
 * (https://developers.cloudflare.com/email-service/api/send-emails/workers-api/),
 * so a file at or above LINK_THRESHOLD_BYTES never travels in the message:
 * its bytes go to R2 exactly like an ordinary attachment (the keying lives in
 * workers/lib/attachments.ts), its row carries a random capability token and a
 * 30-day expiry, and the body gains a link to
 * `GET /api/v1/downloads/:mailboxId/:attachmentId?token=…`. That route is
 * exempt from the Cloudflare Access gate — the token IS the capability.
 *
 * The caps mirror the composer's, which is where the numbers live
 * (app/lib/attachments.ts); they are re-exported here and enforced on the send
 * route, so a direct API caller cannot store more than a message may link.
 * The daily housekeeping sweep deletes the blobs of links that have expired.
 */
import {
	DEFAULT_ATTACHMENT_TYPE,
	formatFileSize,
	LINK_THRESHOLD_BYTES,
	LINK_TTL_DAYS,
	MAX_LINKED_FILE_BYTES,
	MAX_LINKED_FILES,
	MAX_LINKED_TOTAL_BYTES,
} from "../../app/lib/attachments";
import { attachmentR2Key } from "./attachments";
import { escapeHtml, getMailboxStub, listMailboxes } from "./email-helpers";
import type { Env } from "../types";

// One import site for the worker side; the numbers themselves stay with the
// composer's limits.
export {
	LINK_THRESHOLD_BYTES,
	LINK_TTL_DAYS,
	MAX_LINKED_FILE_BYTES,
	MAX_LINKED_FILES,
	MAX_LINKED_TOTAL_BYTES,
};

// ── Tokens ─────────────────────────────────────────────────────────

/** Random bytes behind a link token. */
export const LINK_TOKEN_BYTES = 32;

/**
 * A fresh capability token: 32 bytes from the platform CSPRNG, hex-encoded.
 * Hex is URL-safe without escaping, and 256 bits is far beyond guessing.
 */
export function createLinkToken(): string {
	const bytes = new Uint8Array(LINK_TOKEN_BYTES);
	crypto.getRandomValues(bytes);
	let token = "";
	for (const byte of bytes) token += byte.toString(16).padStart(2, "0");
	return token;
}

/** ISO 8601 instant a link created at `now` stops working. */
export function linkExpiryIso(now: Date, ttlDays: number = LINK_TTL_DAYS): string {
	return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
}

// ── URLs ───────────────────────────────────────────────────────────

/** The public path of an attachment's download link, token included. */
export function buildDownloadPath(
	mailboxId: string,
	attachmentId: string,
	token: string,
): string {
	return `/api/v1/downloads/${encodeURIComponent(mailboxId)}/${encodeURIComponent(attachmentId)}?token=${encodeURIComponent(token)}`;
}

/**
 * The public URL of a download link. `origin` (the request's own origin) makes
 * it absolute for the message body an external recipient reads; without it the
 * result is the path the app itself opens.
 */
export function buildDownloadUrl(
	mailboxId: string,
	attachmentId: string,
	token: string,
	origin?: string,
): string {
	const path = buildDownloadPath(mailboxId, attachmentId, token);
	return origin ? `${origin.replace(/\/+$/, "")}${path}` : path;
}

// ── Caps (enforced on the send route) ──────────────────────────────

/** One linked attachment as far as the cap check is concerned. */
export interface LinkedAttachmentSize {
	filename: string;
	size: number;
}

/**
 * Byte length a base64 payload decodes to, without decoding it: every four
 * characters carry three bytes, minus the padding.
 */
export function base64ByteLength(content: string): number {
	const padded = content.endsWith("==")
		? content.slice(0, -2)
		: content.endsWith("=")
			? content.slice(0, -1)
			: content;
	return Math.floor((padded.length * 3) / 4);
}

/**
 * The size the cap check uses for an entry before its bytes are decoded: the
 * declared `size` when the caller gave one, otherwise the byte count implied
 * by the base64 payload's length.
 */
export function linkedAttachmentSize(entry: {
	filename: string;
	size?: number | undefined;
	content: string;
}): LinkedAttachmentSize {
	const declared = entry.size;
	if (declared !== undefined && Number.isFinite(declared) && declared >= 0) {
		return { filename: entry.filename, size: declared };
	}
	return { filename: entry.filename, size: base64ByteLength(entry.content) };
}

/**
 * Why a batch of linked attachments may not be stored, or null when it may.
 * Count, per-file size and total size are checked against the caps; the send
 * route answers 400 with this message. The stored rows are checked again with
 * their exact byte lengths, so a caller cannot get past the caps by lying
 * about `size`.
 */
export function linkedAttachmentCapError(
	entries: readonly LinkedAttachmentSize[],
): string | null {
	if (entries.length > MAX_LINKED_FILES) {
		return `Up to ${MAX_LINKED_FILES} files can be shared as download links — ${entries.length} were sent.`;
	}
	let total = 0;
	for (const entry of entries) {
		if (entry.size > MAX_LINKED_FILE_BYTES) {
			return `"${entry.filename}" is ${formatFileSize(entry.size)} — over the ${formatFileSize(MAX_LINKED_FILE_BYTES)} limit for a linked file.`;
		}
		total += entry.size;
	}
	if (total > MAX_LINKED_TOTAL_BYTES) {
		return `Linked files total ${formatFileSize(total)} — over the ${formatFileSize(MAX_LINKED_TOTAL_BYTES)} limit.`;
	}
	return null;
}

// ── The body section ───────────────────────────────────────────────

/** One link as the message body renders it. */
export interface LinkedAttachmentLink {
	filename: string;
	size: number;
	url: string;
	expiresAt: string;
}

/** The expiry as a plain date ("2026-10-25") for the body's expiry note. */
function formatLinkExpiry(expiresAt: string): string {
	const parsed = Date.parse(expiresAt);
	return Number.isNaN(parsed) ? expiresAt : new Date(parsed).toISOString().slice(0, 10);
}

/**
 * The download section appended to a message's HTML body: every link with its
 * file size and the instant it stops working. The filename is escaped — it
 * comes from the sender's file picker and ends up in HTML.
 */
export function buildLinkedAttachmentSection(
	links: readonly LinkedAttachmentLink[],
): string {
	if (links.length === 0) return "";
	const items = links
		.map(
			(link) =>
				`<li><a href="${escapeHtml(link.url)}">${escapeHtml(link.filename)}</a> — ${escapeHtml(formatFileSize(link.size))} — link expires ${escapeHtml(formatLinkExpiry(link.expiresAt))}</li>`,
		)
		.join("");
	return `<hr><p><strong>Files shared as download links</strong> — the links expire, so download them soon:</p><ul>${items}</ul>`;
}

/**
 * The same section as plain text, for a message that carries no HTML part:
 * the links must reach the recipient either way.
 */
export function buildLinkedAttachmentText(
	links: readonly LinkedAttachmentLink[],
): string {
	if (links.length === 0) return "";
	const lines = links.map(
		(link) =>
			`- ${link.filename} (${formatFileSize(link.size)}): ${link.url} — expires ${formatLinkExpiry(link.expiresAt)}`,
	);
	return `\n\nFiles shared as download links — the links expire, so download them soon:\n${lines.join("\n")}`;
}

// ── Send-route plumbing ────────────────────────────────────────────

/** One file to store behind a public link, in the shape storeAttachments takes. */
export interface LinkedAttachmentInput {
	content: string;
	filename: string;
	type: string;
	disposition: "attachment" | "inline";
	contentId?: string;
}

/**
 * Normalize one `linked_attachments[]` entry for storeAttachments: `mimetype`
 * is accepted as an alias for `type` (the composer sends `type`, mirroring
 * `attachments[]`), and an omitted disposition means an ordinary attachment.
 */
export function toLinkedAttachmentInput(entry: {
	content: string;
	filename: string;
	type?: string | undefined;
	mimetype?: string | undefined;
	disposition?: "attachment" | "inline" | undefined;
	contentId?: string | undefined;
}): LinkedAttachmentInput {
	return {
		content: entry.content,
		filename: entry.filename,
		type: entry.type || entry.mimetype || DEFAULT_ATTACHMENT_TYPE,
		disposition: entry.disposition ?? "attachment",
		...(entry.contentId ? { contentId: entry.contentId } : {}),
	};
}

// ── The daily sweep ────────────────────────────────────────────────

/** Rows one Durable Object round trip may hand back to the sweep. */
export const LINK_SWEEP_BATCH = 100;
/** Most links one mailbox's sweep handles in a single run, so it stays bounded. */
export const LINK_SWEEP_MAX_PER_MAILBOX = 500;

export interface AttachmentLinkSweepSummary {
	/** Mailboxes with at least one expired link processed. */
	mailboxes: number;
	/** Expired links cleared across every swept mailbox. */
	links: number;
	/** R2 attachment blobs deleted for those links. */
	blobsDeleted: number;
}

/**
 * Delete the R2 blobs of attachment links whose expiry has passed, for every
 * mailbox. Mirrors `sweepTrash`: a Durable Object cannot touch R2, so each
 * mailbox's DO hands back its expired rows — and clears their link columns, so
 * a second run finds nothing — and the worker deletes the objects. Batches are
 * bounded per mailbox; a failure in one mailbox is logged and never stops the
 * sweep.
 */
export async function sweepAttachmentLinks(
	env: Env,
	opts: { now?: Date } = {},
): Promise<AttachmentLinkSweepSummary> {
	const now = (opts.now ?? new Date()).toISOString();
	const summary: AttachmentLinkSweepSummary = {
		mailboxes: 0,
		links: 0,
		blobsDeleted: 0,
	};

	for (const mailbox of await listMailboxes(env.BUCKET)) {
		try {
			const stub = getMailboxStub(env, mailbox.id);
			let swept = 0;
			for (;;) {
				const expired = await stub.expireAttachmentLinks(now, LINK_SWEEP_BATCH);
				if (expired.length === 0) break;
				await env.BUCKET.delete(expired.map(attachmentR2Key));
				swept += expired.length;
				if (expired.length < LINK_SWEEP_BATCH) break;
				if (swept >= LINK_SWEEP_MAX_PER_MAILBOX) break;
			}
			if (swept > 0) {
				summary.mailboxes += 1;
				summary.links += swept;
				summary.blobsDeleted += swept;
			}
		} catch (e) {
			console.error(
				`Attachment link sweep failed for ${mailbox.id}:`,
				(e as Error).message,
			);
		}
	}

	console.log(
		`Attachment link sweep: ${summary.mailboxes} mailbox(es), ` +
			`${summary.links} expired link(s), ${summary.blobsDeleted} blob(s) deleted`,
	);
	return summary;
}
