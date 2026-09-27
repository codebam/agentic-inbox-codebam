// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Attachment text extraction for mailbox search (migration 36).
 *
 * Mailbox search matches a free-text term against a message's own indexed
 * columns (`emails_fts`, migration 23) OR the text extracted from its
 * attachments (`attachment_text_fts`, migration 36). This module is the
 * extraction half: text-ish parts are decoded locally and synchronously, while
 * the rich formats (PDF, HTML) additionally go through Workers AI's
 * `toMarkdown` conversion. That conversion is free for most formats but is
 * still a network call, so it is best-effort by contract — it logs and answers
 * null on any failure and never throws.
 *
 * Only the receive path calls the AI conversion. The mbox/EML import path is
 * storage-only and uses the local extractor alone, and sent copies are
 * deliberately not indexed in v1: the send path is latency- and
 * guardrail-sensitive, and this feature covers received and imported mail.
 *
 * Bounds: input bytes over MAX_ATTACHMENT_TEXT_INPUT_BYTES are skipped instead
 * of decoded, stored text is capped at MAX_ATTACHMENT_TEXT_CHARS, and
 * MailboxDO.storeAttachmentText clamps a batch to MAX_ATTACHMENT_TEXT_ROWS.
 * Every function here is defensive — operator mail is arbitrary, and a file
 * that cannot be decoded simply has no search text.
 */

import type { Env } from "../types";

/** Longest text one attachment contributes to the search index. */
export const MAX_ATTACHMENT_TEXT_CHARS = 100_000;

/** Inputs larger than this are skipped instead of decoded (5 MiB). */
export const MAX_ATTACHMENT_TEXT_INPUT_BYTES = 5 * 1024 * 1024;

/** Most rows one MailboxDO.storeAttachmentText call accepts. */
export const MAX_ATTACHMENT_TEXT_ROWS = 50;

/**
 * One attachment's extracted text, in the shape MailboxDO.storeAttachmentText
 * stores: the attachment row's id and email id, its metadata, and the text.
 */
export interface AttachmentTextInput {
	attachment_id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	text: string;
}

/** MIME subtypes whose payload is text in a concrete syntax. */
const TEXT_SUBTYPE_SUFFIXES = ["+csv", "+markdown", "+yaml"];

/**
 * Normalize a mimetype for comparison: parameters (`; charset=...`) dropped,
 * then trimmed and lowercased. Postal-mime hands over whatever the sender
 * declared, so nothing about this string can be trusted.
 */
function normalizeMimetype(mimetype: string | null | undefined): string {
	return (mimetype ?? "").split(";")[0]!.trim().toLowerCase();
}

/** True when the bytes are text this module can decode without help. */
function isTextMimetype(mimetype: string): boolean {
	if (mimetype.startsWith("text/")) return true;
	if (mimetype === "application/json" || mimetype === "application/xml") return true;
	return TEXT_SUBTYPE_SUFFIXES.some((suffix) => mimetype.endsWith(suffix));
}

/**
 * True when a type should additionally go through the AI markdown conversion:
 * a PDF is binary and HTML is markup, so the converter renders both into
 * readable text far better than a raw decode does.
 */
export function needsMarkdownConversion(mimetype: string | null | undefined): boolean {
	const type = normalizeMimetype(mimetype);
	return type === "application/pdf" || type === "text/html";
}

/**
 * Decode one attachment's bytes to searchable text, locally and without any
 * network call. Returns null when the type is not text-ish, when the input is
 * over the size cap, or when nothing but whitespace is left after decoding.
 *
 * Invalid UTF-8 is not fatal: the bytes are decoded again in the default
 * (non-fatal) mode, which keeps every valid run and replaces the bad bytes
 * with U+FFFD, so a mostly-text file stays searchable. NULs are stripped
 * because workerd binds SQL parameters as C strings, where a NUL silently
 * truncates the value (the same reason lib/fts-terms.ts treats it as a
 * separator).
 */
export function extractAttachmentText(
	mimetype: string | null | undefined,
	filename: string,
	bytes: Uint8Array,
): string | null {
	const type = normalizeMimetype(mimetype);
	if (!isTextMimetype(type)) return null;
	if (bytes.byteLength > MAX_ATTACHMENT_TEXT_INPUT_BYTES) {
		console.log(
			`Attachment text skipped for ${filename}: ${bytes.byteLength} bytes exceeds the ${MAX_ATTACHMENT_TEXT_INPUT_BYTES}-byte cap`,
		);
		return null;
	}
	let decoded: string;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		decoded = new TextDecoder("utf-8").decode(bytes);
	}
	const text = decoded.replaceAll("\u0000", "").trim();
	if (text.length === 0) return null;
	return text.slice(0, MAX_ATTACHMENT_TEXT_CHARS);
}

/**
 * Convert one rich attachment (PDF, HTML) to text through Workers AI's
 * `toMarkdown`. The call is bounded — the same input and text caps as the
 * local extractor — and best-effort: any failure logs and answers null, never
 * throws, so the caller's ingest path cannot fail because a conversion was
 * unavailable. Entries the service reports with format 'error' are skipped;
 * markdown and text entries are joined in order.
 */
export async function extractAttachmentTextViaAi(
	env: Env,
	name: string,
	bytes: Uint8Array,
	mimetype: string,
): Promise<string | null> {
	try {
		if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_TEXT_INPUT_BYTES) {
			return null;
		}
		// The slice is deliberate twice over: TS 5.8 only accepts an
		// ArrayBuffer-backed view as a BlobPart, and it pins the blob to
		// exactly this attachment's bytes when the view is a window over a
		// larger buffer.
		const results = await env.AI.toMarkdown([
			{ name, blob: new Blob([bytes.slice()], { type: mimetype }) },
		]);
		const parts: string[] = [];
		for (const result of results) {
			if (result.format === "error") continue;
			if (result.data) parts.push(result.data);
		}
		const text = parts.join("\n").replaceAll("\u0000", "").trim();
		if (text.length === 0) return null;
		return text.slice(0, MAX_ATTACHMENT_TEXT_CHARS);
	} catch (e) {
		console.error(
			`Attachment conversion unavailable for ${name}; storing without it:`,
			(e as Error).message,
		);
		return null;
	}
}
