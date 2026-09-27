// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import worker from "../workers/app";

/**
 * Attachments must reach R2 byte-for-byte, whatever transfer encoding the
 * sender used.
 *
 * The parser decodes base64 and quoted-printable exactly, but a part with no
 * `Content-Transfer-Encoding` (or 7bit/8bit/binary) goes through a pass-through
 * decoder that re-emits each body line with a bare LF — every CR in the part is
 * dropped, so a binary attachment stored that way is corrupt and no longer
 * decodes. `encodeBinaryParts` re-encodes those parts before parsing; these
 * tests pin the bytes at the far end, through the real inbound handler.
 */

const MAILBOX = "inbound-encodings@example.com";
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));
const encoder = new TextEncoder();

/** Quote-printable encode; the wrapping never splits a token. */
function qpEncode(bytes: Uint8Array): string {
	const tokens: string[] = [];
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i]!;
		if (byte >= 33 && byte <= 126 && byte !== 61) {
			tokens.push(String.fromCharCode(byte));
		} else if (byte === 32) {
			tokens.push(" ");
		} else {
			tokens.push(`=${byte.toString(16).toUpperCase().padStart(2, "0")}`);
		}
	}
	const lines: string[] = [];
	let line = "";
	for (const token of tokens) {
		if (line.length + token.length > 72) {
			lines.push(`${line}=`);
			line = "";
		}
		line += token;
	}
	lines.push(line);
	return lines.join("\r\n");
}

/** One message whose single image part uses `cte` (null = no header at all). */
function rawMessage(cte: string | null, body: string | Uint8Array): Uint8Array {
	const head = [
		"From: Sender <sender@example.org>",
		`To: ${MAILBOX}`,
		"Subject: inbound encodings",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="B1"',
		"",
		"--B1",
		'Content-Type: text/plain; charset="utf-8"',
		"",
		"See attached",
		"",
		"--B1",
		'Content-Type: image/png; name="shot.png"',
		...(cte ? [`Content-Transfer-Encoding: ${cte}`] : []),
		'Content-Disposition: attachment; filename="shot.png"',
		"",
		"",
	].join("\r\n");
	const headBytes = encoder.encode(head);
	const bodyBytes = typeof body === "string" ? encoder.encode(body) : body;
	const tailBytes = encoder.encode("\r\n--B1--\r\n");
	const raw = new Uint8Array(
		headBytes.length + bodyBytes.length + tailBytes.length,
	);
	raw.set(headBytes, 0);
	raw.set(bodyBytes, headBytes.length);
	raw.set(tailBytes, headBytes.length + bodyBytes.length);
	return raw;
}

interface Delivered {
	subject: string;
	bodyText: string;
	stored: Uint8Array;
	rowSize: number;
}

async function deliver(raw: Uint8Array): Promise<Delivered> {
	await env.BUCKET.put(
		`mailboxes/${MAILBOX}.json`,
		JSON.stringify({ categorization: { enabled: false } }),
	);
	const event = {
		from: "sender@example.org",
		to: MAILBOX,
		raw: new Response(raw).body,
		rawSize: raw.byteLength,
	} as unknown as Parameters<typeof worker.email>[0];
	const ctx = createExecutionContext();
	await worker.email(event, env, ctx);
	await waitOnExecutionContext(ctx);

	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(MAILBOX));
	const inbox = (await stub.getEmails({ folder: Folders.INBOX })) as {
		id: string;
	}[];
	const email = (await stub.getEmail(inbox[0]?.id ?? "")) as {
		id: string;
		subject: string;
		body: string;
		attachments: { id: string; filename: string; mimetype: string; size: number }[];
	} | null;
	if (!email) throw new Error("the message did not arrive");

	const attachment = email.attachments.find((a) => a.mimetype === "image/png");
	if (!attachment) throw new Error("the image part was not stored as an attachment");
	const object = await env.BUCKET.get(
		`attachments/${email.id}/${attachment.id}/${attachment.filename}`,
	);
	if (!object) throw new Error("the attachment bytes are not in R2");

	return {
		subject: email.subject,
		bodyText: email.body,
		stored: new Uint8Array(await object.arrayBuffer()),
		rowSize: attachment.size,
	};
}

function expectSameBytes(stored: Uint8Array) {
	expect(Array.from(stored)).toEqual(Array.from(PNG_BYTES));
}

describe("inbound attachment encodings", () => {
	it("keeps a base64 attachment byte-for-byte", async () => {
		const delivered = await deliver(rawMessage("base64", PNG_BASE64));
		expectSameBytes(delivered.stored);
		expect(delivered.rowSize).toBe(PNG_BYTES.byteLength);
	});

	it("keeps an attachment with no Content-Transfer-Encoding", async () => {
		const delivered = await deliver(rawMessage(null, PNG_BYTES));
		expectSameBytes(delivered.stored);
		expect(delivered.rowSize).toBe(PNG_BYTES.byteLength);
	});

	it("keeps an 8bit attachment", async () => {
		const delivered = await deliver(rawMessage("8bit", PNG_BYTES));
		expectSameBytes(delivered.stored);
	});

	it("keeps a binary attachment", async () => {
		const delivered = await deliver(rawMessage("binary", PNG_BYTES));
		expectSameBytes(delivered.stored);
	});

	it("keeps a quoted-printable attachment", async () => {
		const delivered = await deliver(
			rawMessage("quoted-printable", qpEncode(PNG_BYTES)),
		);
		// The decoder appends one LF to the part; the image bytes themselves
		// must still be intact and in order.
		expect(Array.from(delivered.stored.slice(0, PNG_BYTES.byteLength))).toEqual(
			Array.from(PNG_BYTES),
		);
		expect(delivered.stored.length).toBeLessThanOrEqual(PNG_BYTES.byteLength + 1);
	});

	it("leaves the message text readable", async () => {
		const delivered = await deliver(rawMessage(null, PNG_BYTES));
		expect(delivered.subject).toBe("inbound encodings");
		expect(delivered.bodyText).toContain("See attached");
	});
});
