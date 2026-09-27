/**
 * Recover attachments whose sender base64-encoded the body but never said so.
 *
 * Some clients (and some relay paths) put the base64 text of a file into a part
 * whose Content-Transfer-Encoding is missing or says 8bit. The parser then has
 * no decoder to apply and the stored file is the base64 text itself — the row,
 * the size and the content type all look healthy, and the file will not open.
 *
 * The repair is deliberately narrow: a binary media type whose body is nothing
 * but base64 characters *and* whose decoded bytes start with that type's
 * signature. Anything else is left exactly as it arrived, so a genuine text
 * attachment that happens to look like base64 is never rewritten.
 */
import { decodeBase64Bytes } from "./attachments";

type Signature = { offset: number; bytes: number[] };

/** Leading bytes that identify each type, by the type the part declares. */
const SIGNATURES: Record<string, Signature[]> = {
	"image/png": [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
	"image/jpeg": [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
	"image/gif": [{ offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }],
	"image/webp": [
		{ offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
		{ offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
	],
	"image/bmp": [{ offset: 0, bytes: [0x42, 0x4d] }],
	"image/tiff": [
		{ offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00] },
		{ offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a] },
	],
	"application/pdf": [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }],
	"application/zip": [{ offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }],
	"application/gzip": [{ offset: 0, bytes: [0x1f, 0x8b] }],
	"video/mp4": [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }],
};

function isWhitespace(byte: number): boolean {
	return byte === 0x0d || byte === 0x0a || byte === 0x20 || byte === 0x09;
}

function isBase64Char(byte: number): boolean {
	return (
		(byte >= 0x41 && byte <= 0x5a) || // A-Z
		(byte >= 0x61 && byte <= 0x7a) || // a-z
		(byte >= 0x30 && byte <= 0x39) || // 0-9
		byte === 0x2b || // +
		byte === 0x2f || // /
		byte === 0x3d // =
	);
}

/** True when the bytes are nothing but base64 characters and whitespace. */
function isBase64Text(bytes: Uint8Array): boolean {
	if (bytes.length < 64) return false;
	let characters = 0;
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i]!;
		if (isWhitespace(byte)) continue;
		if (!isBase64Char(byte)) return false;
		characters++;
	}
	// A base64 length of 1 mod 4 is impossible; the rest decode after padding.
	return characters > 0 && characters % 4 !== 1;
}

/** The base64 text as a string, whitespace removed and padding restored. */
function base64TextOf(bytes: Uint8Array): string {
	const chunks: string[] = [];
	for (let i = 0; i < bytes.length; i += 8192) {
		chunks.push(String.fromCharCode(...Array.from(bytes.subarray(i, i + 8192))));
	}
	let text = chunks.join("").replace(/\s+/g, "");
	while (text.length % 4 !== 0) text += "=";
	return text;
}

function matchesSignature(bytes: Uint8Array, signatures: Signature[]): boolean {
	return signatures.some((signature) =>
		signature.bytes.every((byte, index) => bytes[signature.offset + index] === byte),
	);
}

/**
 * Decode `bytes` when they are the base64 text of a file whose type they claim
 * to be, and return them unchanged otherwise.
 */
export function repairBase64Attachment(bytes: Uint8Array, mimeType: string): Uint8Array {
	const signatures = SIGNATURES[mimeType.split(";")[0]!.trim().toLowerCase()];
	if (!signatures || !isBase64Text(bytes)) return bytes;

	let decoded: Uint8Array;
	try {
		decoded = decodeBase64Bytes(base64TextOf(bytes));
	} catch {
		return bytes; // Not actually base64; leave the content alone.
	}
	return matchesSignature(decoded, signatures) ? decoded : bytes;
}
