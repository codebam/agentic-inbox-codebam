/**
 * Preserve binary attachments that arrive without a base64 or quoted-printable
 * transfer encoding.
 *
 * postal-mime decodes base64 and quoted-printable exactly, but a part carrying
 * no `Content-Transfer-Encoding` (or 7bit/8bit/binary) goes through its
 * pass-through decoder, which re-emits every body line with a bare LF. Every CR
 * in such a part is therefore dropped, and a binary attachment stored that way
 * is corrupt: a PNG loses each 0x0D byte and no longer decodes.
 *
 * Rewriting those parts to base64 before parsing keeps the bytes intact and
 * leaves the parser in charge of everything else — headers, filenames, encoded
 * words, nested messages.
 */
const CR = 0x0d;
const LF = 0x0a;
const DASH = 0x2d;

/** Latin-1 decode: lossless for header blocks, which are ASCII by RFC 5322. */
function latin1(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]!);
	return out;
}

/** Encode a string as bytes, one byte per character (Latin-1). */
function bytesOf(text: string): Uint8Array {
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
	return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const part of parts) total += part.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
	if (bytes.length < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (bytes[i] !== prefix[i]) return false;
	}
	return true;
}

/** Index just past the terminator of the line that starts at `from`. */
function lineEnd(bytes: Uint8Array, from: number): number {
	const lf = bytes.indexOf(LF, from);
	return lf < 0 ? bytes.length : lf + 1;
}

/** The line's bytes without its terminator. */
function lineBytes(bytes: Uint8Array, from: number): Uint8Array {
	let stop = lineEnd(bytes, from);
	if (stop > from && bytes[stop - 1] === LF) stop--;
	if (stop > from && bytes[stop - 1] === CR) stop--;
	return bytes.subarray(from, stop);
}

/** Index just past the blank line that ends the header block, or -1. */
function headerBlockEnd(bytes: Uint8Array): number {
	let at = 0;
	while (at < bytes.length) {
		if (lineBytes(bytes, at).length === 0) return lineEnd(bytes, at);
		at = lineEnd(bytes, at);
	}
	return -1;
}

/** One header value, with folded continuation lines unfolded. */
function headerValue(headerText: string, name: string): string {
	const unfolded = headerText.replace(/\r?\n[ \t]+/g, " ");
	const match = new RegExp(`^${name}\\s*:\\s*([^\\r\\n]*)`, "im").exec(unfolded);
	return match?.[1]?.trim() ?? "";
}

function boundaryOf(contentType: string): string | null {
	const match = /boundary\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(contentType);
	return match?.[1] ?? match?.[2] ?? null;
}

function typeOf(contentType: string): string {
	return contentType.split(";")[0]!.trim().toLowerCase();
}

/** True for a part whose body is not text and so must survive byte-for-byte. */
function isBinaryType(contentType: string): boolean {
	const type = typeOf(contentType);
	if (!type) return false; // No Content-Type: text/plain by RFC 2045.
	return !type.startsWith("text/") && !type.startsWith("multipart/") && !type.startsWith("message/");
}

/** True when the body reaches the parser with no decoder of its own. */
function isPassThrough(cte: string): boolean {
	const value = cte.trim().toLowerCase();
	return value === "" || value === "7bit" || value === "8bit" || value === "binary";
}

/** base64 with CRLF every 76 characters, as RFC 2045 requires. */
function base64Lines(bytes: Uint8Array): Uint8Array {
	const toBase64 = (bytes as unknown as { toBase64?: () => string }).toBase64;
	const buffer = (
		globalThis as unknown as {
			Buffer?: { from(value: Uint8Array): { toString(encoding: string): string } };
		}
	).Buffer;
	let encoded: string;
	if (typeof toBase64 === "function") {
		encoded = toBase64.call(bytes);
	} else if (buffer) {
		encoded = buffer.from(bytes).toString("base64");
	} else {
		throw new Error("No native base64 encoder is available in this runtime");
	}
	const lines: string[] = [];
	for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76));
	return bytesOf(`${lines.join("\r\n")}\r\n`);
}

/** The header block with its transfer encoding replaced by base64. */
function withBase64Encoding(headers: Uint8Array): Uint8Array {
	const text = latin1(headers).replace(/\r\n/g, "\n");
	const entries: string[] = [];
	for (const line of text.split("\n")) {
		if (line === "") continue; // The blank line is re-added below.
		if (/^[ \t]/.test(line) && entries.length > 0) {
			entries[entries.length - 1] += ` ${line.trim()}`;
			continue;
		}
		entries.push(line);
	}
	const kept = entries.filter((entry) => !/^content-transfer-encoding\s*:/i.test(entry));
	kept.push("Content-Transfer-Encoding: base64");
	return bytesOf(`${kept.join("\r\n")}\r\n\r\n`);
}

/** Rewrite one MIME entity: its headers, then its body. */
function rewriteEntity(bytes: Uint8Array): Uint8Array {
	const headerEnd = headerBlockEnd(bytes);
	if (headerEnd < 0) return bytes;
	const headerText = latin1(bytes.subarray(0, headerEnd));
	const contentType = headerValue(headerText, "content-type");
	const cte = headerValue(headerText, "content-transfer-encoding");

	const boundary = boundaryOf(contentType);
	if (boundary) {
		return concat(
			bytes.subarray(0, headerEnd),
			rewriteParts(bytes.subarray(headerEnd), boundary),
		);
	}

	if (isBinaryType(contentType) && isPassThrough(cte)) {
		return concat(
			withBase64Encoding(bytes.subarray(0, headerEnd)),
			base64Lines(bytes.subarray(headerEnd)),
		);
	}

	if (typeOf(contentType).startsWith("message/") && isPassThrough(cte)) {
		// An inline forwarded message: the message it carries has parts too.
		return concat(
			bytes.subarray(0, headerEnd),
			rewriteEntity(bytes.subarray(headerEnd)),
		);
	}

	return bytes;
}

/** Rewrite each part of a multipart body, copying the framing verbatim. */
function rewriteParts(body: Uint8Array, boundary: string): Uint8Array {
	const delimiter = bytesOf(`--${boundary}`);
	const pieces: Uint8Array[] = [];
	let copyFrom = 0;
	let partStart = -1;
	let at = 0;

	while (at < body.length) {
		const line = lineBytes(body, at);
		if (!startsWith(line, delimiter)) {
			at = lineEnd(body, at);
			continue;
		}

		if (partStart >= 0) {
			// The CRLF before a delimiter belongs to the delimiter (RFC 2046),
			// so the part's bytes stop short of it — but it still has to be
			// copied, or the delimiter ends up glued to the part's content.
			let contentEnd = at;
			if (contentEnd > partStart && body[contentEnd - 1] === LF) contentEnd--;
			if (contentEnd > partStart && body[contentEnd - 1] === CR) contentEnd--;
			pieces.push(body.subarray(copyFrom, partStart));
			pieces.push(rewriteEntity(body.subarray(partStart, contentEnd)));
			copyFrom = contentEnd;
		}

		const closing = line[delimiter.length] === DASH && line[delimiter.length + 1] === DASH;
		const next = lineEnd(body, at);
		at = next;
		if (closing) break; // The epilogue is copied verbatim.
		partStart = next;
	}

	pieces.push(body.subarray(copyFrom));
	return concat(...pieces);
}

/**
 * Rewrite every part of `raw` that would otherwise lose its CR bytes, so the
 * parser decodes it exactly. Returns the input unchanged when there is nothing
 * to rewrite, and never throws: a rewrite failure must not lose a message.
 */
export function encodeBinaryParts(raw: Uint8Array): Uint8Array {
	try {
		return rewriteEntity(raw);
	} catch {
		return raw;
	}
}
