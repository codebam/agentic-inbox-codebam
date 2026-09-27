// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mailbox import (mbox and EML).
 *
 * One uploaded file is staged in R2 (`imports/{mailboxId}/{jobId}.mbox`) and
 * one `import_jobs` row (migration 35) records the job. The mailbox's own
 * alarm drains the job in bounded batches — never a second timer: MailboxDO
 * reads a bounded slice of the object, splits it on mbox framing, and hands
 * each message through the same decode pipeline inbound mail uses
 * (workers/lib/mime-binary.ts, then postal-mime, then
 * workers/lib/attachment-content.ts) before storing it in the Inbox. Nothing
 * here sends mail, calls the AI, applies rules or notifies anything: an
 * import is storage only.
 *
 * The export side (workers/index.ts, reconstructedMessage/mboxRecord) is the
 * inverse of this framing: a record is the RFC 4155 separator line, the
 * reconstructed message and a closing blank line, and a stored body line
 * beginning "From " is written ">From ". parseImportMessage inverts both, so
 * an exported mailbox re-imports with the stored fields intact.
 */

import PostalMime from "postal-mime";
import { sanitizeAttachmentFilename } from "./attachments";
import { repairBase64Attachment } from "./attachment-content";
import { encodeBinaryParts } from "./mime-binary";
import { extractUnsubscribeHeaders } from "./unsubscribe";

// ── Limits ─────────────────────────────────────────────────────────

/** Largest upload the import route stages; a larger one answers 413. */
export const IMPORT_MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Bytes read from R2 per drain tick. */
export const IMPORT_SLICE_BYTES = 8 * 1024 * 1024;

/**
 * Hard cap on one tick's read, used only when a single message spans several
 * slices. A message larger than this fails its job with a clear reason
 * rather than being read without bound.
 */
export const IMPORT_MAX_SLICE_BYTES = 32 * 1024 * 1024;

/** Messages stored per drain tick; the byte and message bounds race. */
export const IMPORT_MAX_MESSAGES_PER_TICK = 100;

/** Messages one job may store; a job over it is failed with the reason. */
export const MAX_IMPORT_MESSAGES = 20_000;

/** Default and maximum page size of the import-job list route. */
export const DEFAULT_IMPORT_JOB_LIMIT = 20;
export const MAX_IMPORT_JOB_LIST = 100;

/** The error the cancel route turns into a 404. */
export const IMPORT_JOB_NOT_FOUND = "Import job not found";

// ── Rows ───────────────────────────────────────────────────────────

/** The lifecycle of one import job. `cancelled` is terminal, like done/failed. */
export type ImportJobStatus = "pending" | "running" | "done" | "failed" | "cancelled";

const IMPORT_JOB_STATUSES: readonly string[] = [
	"pending",
	"running",
	"done",
	"failed",
	"cancelled",
];

/** True when `value` is one of the stored statuses. */
export function isImportJobStatus(value: string): value is ImportJobStatus {
	return IMPORT_JOB_STATUSES.includes(value);
}

/**
 * True while a job still has work: the drain only ever picks these up, and
 * the alarm treats one of them as due right now.
 */
export function isImportJobActive(status: string): boolean {
	return status === "pending" || status === "running";
}

/**
 * One `import_jobs` row as stored (migration 35). `cursor` is a byte offset
 * into the staged object; the counts are per-message outcomes so far.
 */
export interface ImportJobDbRow {
	id: string;
	filename: string;
	/** R2 key of the staged bytes (`imports/{mailboxId}/{jobId}.mbox`). */
	r2_key: string;
	size: number;
	cursor: number;
	status: string;
	imported: number;
	skipped: number;
	failed: number;
	last_error: string | null;
	created_at: string;
	updated_at: string;
}

/** One import job as the Durable Object and the routes return it. */
export interface ImportJobRow {
	id: string;
	filename: string;
	/** R2 key of the staged bytes; kept on the row after the object is gone. */
	r2_key: string;
	size: number;
	cursor: number;
	status: ImportJobStatus;
	imported: number;
	skipped: number;
	failed: number;
	last_error: string | null;
	created_at: string;
	updated_at: string;
}

/** The input MailboxDO.createImportJob stores. */
export interface CreateImportJobInput {
	id: string;
	filename: string;
	/** R2 key of the bytes (importJobR2Key). */
	r2Key: string;
	size: number;
	/** ISO instant the row was created; defaults to now. */
	createdAt?: string;
}

/** The result of cancelling a job, mirroring the scheduled-send action shape. */
export type ImportJobCancelResult =
	| { ok: true; job: ImportJobRow }
	| { ok: false; error: string };

/** The cursor and counts one drained batch advances a job by. */
export interface ImportJobBatch {
	/** Absolute byte offset the drain has reached. */
	cursor: number;
	/** Messages stored this batch. */
	imported: number;
	/** Duplicate messages skipped this batch. */
	skipped: number;
	/** Messages that could not be parsed or stored this batch. */
	failed: number;
}

/**
 * One stored row in the API shape. An unrecognised status reads as `failed`
 * — honest, and terminal, so a corrupted row can never be drained.
 */
export function importJobRow(row: ImportJobDbRow): ImportJobRow {
	return {
		...row,
		status: isImportJobStatus(row.status) ? row.status : "failed",
	};
}

/** Where one job's staged bytes live. */
export function importJobR2Key(mailboxId: string, jobId: string): string {
	return `imports/${mailboxId}/${jobId}.mbox`;
}

// ── mbox framing ───────────────────────────────────────────────────

/** "From " — the bytes an RFC 4155 separator line begins with. */
const FROM_SEPARATOR = [0x46, 0x72, 0x6f, 0x6d, 0x20];

/** ">From " — the bytes the export writes for a stored line beginning "From ". */
const QUOTED_FROM = [0x3e, 0x46, 0x72, 0x6f, 0x6d, 0x20];

const LF = 0x0a;

/** True when `bytes` starts at `from` with `prefix`. */
function hasPrefix(bytes: Uint8Array, from: number, prefix: readonly number[]): boolean {
	if (from + prefix.length > bytes.length) return false;
	for (let index = 0; index < prefix.length; index++) {
		if (bytes[from + index] !== prefix[index]) return false;
	}
	return true;
}

/** Index just past the terminator of the line starting at `from`. */
function lineEnd(bytes: Uint8Array, from: number): number {
	const lf = bytes.indexOf(LF, from);
	return lf < 0 ? bytes.length : lf + 1;
}

/**
 * Whether the object is mbox-framed: its very first line is an RFC 4155
 * separator. A file that does not open with one is treated as a single .eml
 * message and is never split — which is also what keeps a body line that
 * happens to read "From " inside an .eml from being mistaken for framing.
 */
export function isMboxFramed(firstBytes: Uint8Array): boolean {
	return hasPrefix(firstBytes, 0, FROM_SEPARATOR);
}

/** Byte offsets at which a line begins with "From ", in order. */
function fromSeparatorOffsets(bytes: Uint8Array): number[] {
	const offsets: number[] = [];
	if (hasPrefix(bytes, 0, FROM_SEPARATOR)) offsets.push(0);
	for (let at = 0; at < bytes.length - 1; at++) {
		if (bytes[at] === LF && hasPrefix(bytes, at + 1, FROM_SEPARATOR)) {
			offsets.push(at + 1);
		}
	}
	return offsets;
}

/** One read of a staged object, split into complete messages. */
export interface MboxSlice {
	/**
	 * Complete messages, each starting at its own headers — the separator
	 * line and everything before the next one, minus the separator line
	 * itself. A block still carries the record's closing blank line.
	 */
	messages: Uint8Array[];
	/** Absolute offset the job's cursor should advance to. */
	nextCursor: number;
	/** True when this read reached the end of the object. */
	atEnd: boolean;
	/** True when the read stops inside a message that continues past it. */
	partial: boolean;
}

/**
 * Split one read of an mbox-framed object into the complete messages it
 * contains.
 *
 * `bytes` starts at absolute offset `startOffset` (always the start of a
 * separator line, since the cursor only ever advances to one) and is a
 * prefix of an object `fileSize` bytes long. Every separator line found
 * begins a new message; the block between two separators — the first
 * separator's line dropped — is one message. The last block is only taken
 * when this read reached the end of the object: otherwise it may continue
 * past the read and is left for the next one, which is what `partial` says.
 * `maxMessages` bounds how many messages one call returns, so a tick can
 * never store more than its budget.
 */
export function splitMboxSlice(
	bytes: Uint8Array,
	startOffset: number,
	fileSize: number,
	maxMessages = IMPORT_MAX_MESSAGES_PER_TICK,
): MboxSlice {
	const atEnd = startOffset + bytes.length >= fileSize;
	const separators = fromSeparatorOffsets(bytes);
	if (separators.length === 0 || separators[0] !== 0) {
		// Nothing to take: the read is empty, or the cursor is not on a
		// separator (a caller bug — the object's framing is decided once,
		// by isMboxFramed, before any slice is taken).
		return { messages: [], nextCursor: startOffset, atEnd, partial: false };
	}

	const messages: Uint8Array[] = [];
	const take = Math.min(separators.length, maxMessages);
	let nextCursor = startOffset;
	for (let index = 0; index < take; index++) {
		const lastInSlice = index === separators.length - 1;
		if (lastInSlice && !atEnd) break; // May continue past this read.
		const blockStart = lineEnd(bytes, separators[index]!);
		const blockEnd = lastInSlice ? bytes.length : separators[index + 1]!;
		messages.push(bytes.subarray(blockStart, blockEnd));
		nextCursor = startOffset + blockEnd;
	}

	const capped = separators.length > maxMessages;
	const partial = !atEnd && !capped && messages.length < separators.length;
	return { messages, nextCursor, atEnd, partial };
}

/**
 * Invert the export's RFC 4155 quoting: a line the export wrote as ">From "
 * was a stored body line beginning "From " (workers/index.ts,
 * reconstructedMessage). Every other line is copied byte for byte.
 *
 * The inversion cannot be perfect for a body line that already began
 * ">From ": the export writes that verbatim (it quotes only lines starting
 * "From "), so the two are indistinguishable once written — the same
 * ambiguity every mboxrd reader has.
 */
export function unescapeMboxFromLines(bytes: Uint8Array): Uint8Array {
	const pieces: Uint8Array[] = [];
	let copyFrom = 0;
	let lineStart = 0;
	for (let at = 0; at <= bytes.length; at++) {
		if (at !== bytes.length && bytes[at] !== LF) continue;
		if (hasPrefix(bytes, lineStart, QUOTED_FROM)) {
			// Drop the quoting ">" and keep the rest of the line.
			pieces.push(bytes.subarray(copyFrom, lineStart));
			copyFrom = lineStart + 1;
		}
		lineStart = at + 1;
	}
	if (pieces.length === 0) return bytes;
	pieces.push(bytes.subarray(copyFrom));
	let total = 0;
	for (const piece of pieces) total += piece.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const piece of pieces) {
		out.set(piece, offset);
		offset += piece.length;
	}
	return out;
}

// ── Parsing ────────────────────────────────────────────────────────

/** One attachment as parsed, with its bytes ready to be staged in R2. */
export interface ImportedAttachment {
	filename: string;
	mimetype: string;
	content_id: string | null;
	disposition: string | null;
	content: Uint8Array;
}

/** The message fields MailboxDO.createEmail stores for an imported message. */
export interface ImportedEmail {
	subject: string;
	sender: string;
	sender_name: string | null;
	recipient: string;
	cc: string | null;
	reply_to: string | null;
	date: string;
	body: string;
	body_text: string | null;
	in_reply_to: string | null;
	email_references: string | null;
	thread_id: string;
	message_id: string | null;
	raw_headers: string;
	list_unsubscribe: string | null;
	list_unsubscribe_post: string | null;
}

/** One parsed message, ready for MailboxDO to store. */
export interface ImportedMessage {
	email: ImportedEmail;
	attachments: ImportedAttachment[];
}

/** The RFC 5322 Message-ID with angle brackets stripped, or null. */
function extractMessageId(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const match = value.match(/<([^>]+)>/);
	const extracted = match ? match[1]! : (value.trim().split(/\s+/)[0] ?? "");
	return extracted.length > 0 ? extracted : null;
}

/** The address of one parsed mailbox entry, or "". */
function addressOf(value: { address?: string | undefined } | undefined): string {
	return value && typeof value.address === "string" ? value.address : "";
}

/** The addresses of a parsed address list, empty entries dropped. */
function addressesOf(list: readonly { address?: string | undefined }[] | undefined): string[] {
	return (list ?? [])
		.map((entry) => addressOf(entry))
		.filter((address) => address.length > 0);
}

/**
 * Undo the framing newlines an mbox record carries: the export closes the
 * reconstructed message with exactly one "\n" after the stored body, and the
 * record's closing blank line adds a second, so postal-mime hands both back
 * on the parsed body. Removing up to two trailing newlines recovers the
 * stored body byte for byte, which is what makes an export re-import
 * identical. .eml files are never touched — there is no framing to invert.
 */
function stripFramingNewlines(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	let end = value.length;
	for (let removed = 0; removed < 2 && end > 0 && value[end - 1] === "\n"; removed++) {
		end -= 1;
	}
	return value.slice(0, end);
}

/**
 * Parse one message block with the same pipeline inbound mail uses:
 * `encodeBinaryParts` first (a part sent without base64 or quoted-printable
 * loses its CR bytes in postal-mime's pass-through decoder), then
 * `PostalMime.parse`, then `repairBase64Attachment` for every attachment.
 * The reference call sites are the receive path in workers/index.ts.
 *
 * `mbox` inverts the export's record framing (the quoting of body lines
 * beginning "From ", and the two framing newlines); `mailboxId` is the
 * fallback recipient for a message with no usable To header.
 */
export async function parseImportMessage(
	block: Uint8Array,
	options: { mbox: boolean; mailboxId: string },
): Promise<ImportedMessage> {
	const raw = options.mbox ? unescapeMboxFromLines(block) : block;
	const parsed = await new PostalMime().parse(encodeBinaryParts(raw));

	const toRecipients = addressesOf(parsed.to);
	const ccRecipients = addressesOf(parsed.cc);
	const replyToRecipients = addressesOf(parsed.replyTo);

	const inReplyTo = extractMessageId(parsed.inReplyTo);
	const references = (parsed.references ?? "")
		.split(/\s+/)
		.filter(Boolean)
		.map((reference) => extractMessageId(reference) ?? reference);
	const messageId = extractMessageId(parsed.messageId);
	// Threading follows the same chain inbound mail uses (the first
	// reference, then In-Reply-To, then the message itself). Import applies
	// no rules and does no subject-based thread lookup: storage only.
	const threadId = references[0] ?? inReplyTo ?? crypto.randomUUID();
	const unsubscribe = extractUnsubscribeHeaders(parsed.headers);

	const bodyOf = (value: string | undefined): string | undefined =>
		options.mbox ? stripFramingNewlines(value) : value;

	const attachments: ImportedAttachment[] = [];
	for (const attachment of parsed.attachments ?? []) {
		const mimetype = attachment.mimeType || "application/octet-stream";
		const received =
			typeof attachment.content === "string"
				? new TextEncoder().encode(attachment.content)
				: new Uint8Array(attachment.content as ArrayBuffer);
		attachments.push({
			filename: sanitizeAttachmentFilename(attachment.filename || "untitled"),
			mimetype,
			content_id: attachment.contentId || null,
			disposition: attachment.disposition || "attachment",
			content: repairBase64Attachment(received, mimetype),
		});
	}

	return {
		email: {
			subject: parsed.subject || "",
			// The visible sender, lowercased like the inbound path stores it.
			sender: addressOf(parsed.from).toLowerCase(),
			sender_name: parsed.from?.name || null,
			recipient: toRecipients.join(", ") || options.mailboxId,
			cc: ccRecipients.join(", ") || null,
			reply_to: replyToRecipients.join(", ") || null,
			// The message's own Date header is authoritative; a message with
			// none (or an empty one) is stamped with the import time.
			date: (parsed.date ?? "").trim() || new Date().toISOString(),
			body: bodyOf(parsed.html) || bodyOf(parsed.text) || "",
			body_text: bodyOf(parsed.text) ?? null,
			in_reply_to: inReplyTo,
			email_references: references.length > 0 ? JSON.stringify(references) : null,
			thread_id: threadId,
			message_id: messageId,
			raw_headers: JSON.stringify(parsed.headers),
			list_unsubscribe: unsubscribe.listUnsubscribe,
			list_unsubscribe_post: unsubscribe.listUnsubscribePost,
		},
		attachments,
	};
}
