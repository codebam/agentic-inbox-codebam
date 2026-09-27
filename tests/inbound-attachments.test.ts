// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	SELF,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import worker from "../workers/app";

const MAILBOX = "inbound-attachments@example.com";
/** A 1x1 transparent PNG. */
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A plain message with one image attachment, as postal-mime will parse it. */
function rawMessage() {
	return [
		"From: Sender <sender@example.org>",
		`To: ${MAILBOX}`,
		"Subject: Received with image",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="BOUNDARY-1"',
		"",
		"--BOUNDARY-1",
		'Content-Type: text/plain; charset="utf-8"',
		"",
		"See attached",
		"",
		"--BOUNDARY-1",
		'Content-Type: image/png; name="shot.png"',
		"Content-Transfer-Encoding: base64",
		'Content-Disposition: attachment; filename="shot.png"',
		"",
		PNG_BASE64,
		"--BOUNDARY-1--",
		"",
	].join("\r\n");
}

interface ReceivedAttachment {
	id: string;
	filename: string;
	mimetype: string;
	disposition: string;
	content_id: string | null;
}

/**
 * Deliver one message through the worker's inbound handler and hand back what
 * the UI has when it renders the attachment: the stored message and its rows.
 */
async function deliverImageMessage() {
	await env.BUCKET.put(
		`mailboxes/${MAILBOX}.json`,
		JSON.stringify({ categorization: { enabled: false } }),
	);

	const raw = rawMessage();
	const event = {
		from: "sender@example.org",
		to: MAILBOX,
		raw: new Response(raw).body,
		rawSize: raw.length,
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
		attachments: ReceivedAttachment[];
	} | null;
	if (!email) throw new Error("message not delivered");
	return email;
}

describe("received attachments", () => {
	it("stores an inbound image on the message and serves its bytes", async () => {
		const email = await deliverImageMessage();

		expect(email.subject).toBe("Received with image");
		const attachment = email.attachments[0];
		expect(attachment).toBeDefined();
		if (!attachment) return;
		expect(attachment.filename).toBe("shot.png");
		expect(attachment.mimetype).toBe("image/png");
		expect(attachment.disposition).toBe("attachment");

		const res = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${MAILBOX}/emails/${email.id}/attachments/${attachment.id}`,
		);

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect(Array.from(bytes.slice(0, 8))).toEqual([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);
	});
});
