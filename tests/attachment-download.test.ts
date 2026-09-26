// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";

const MAILBOX = "attachment-download@example.com";
/** A 1x1 transparent PNG — the bytes the preview renders. */
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(
		`mailboxes/${mailbox}.json`,
		JSON.stringify({ categorization: { enabled: false } }),
	);
}

/** The attachment route the preview and the download button both use. */
function attachmentUrl(mailbox: string, emailId: string, attachmentId: string) {
	return `http://example.com/api/v1/mailboxes/${mailbox}/emails/${emailId}/attachments/${attachmentId}`;
}

describe("attachment download route", () => {
	/**
	 * Send one inline image and hand back what the UI has when it renders the
	 * attachment: the sent copy's id and the row the list is built from.
	 */
	async function seedInlineImageSend() {
		await registerMailbox(MAILBOX);
		const send = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${MAILBOX}/emails`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					to: "recipient@example.org",
					from: MAILBOX,
					subject: "Inline image",
					html: "<p>See attached</p>",
					attachments: [
						{
							content: PNG_BASE64,
							filename: "shot.png",
							type: "image/png",
							disposition: "attachment",
						},
					],
				}),
			},
		);
		expect(send.status).toBe(202);

		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(MAILBOX));
		const listed = (await stub.getEmails({ folder: Folders.SENT })) as {
			id: string;
		}[];
		const sent = (await stub.getEmail(listed[0]?.id ?? "")) as {
			id: string;
			attachments: { id: string; filename: string; mimetype: string }[];
		} | null;
		const attachment = sent?.attachments?.[0];
		if (!sent || !attachment) throw new Error("no attachment row");
		return { emailId: sent.id, attachment };
	}

	it("serves the bytes of a sent image at the URL the preview builds", async () => {
		const { emailId, attachment } = await seedInlineImageSend();

		const res = await SELF.fetch(
			attachmentUrl(MAILBOX, emailId, attachment.id),
		);

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("content-disposition")).toContain("shot.png");
		const bytes = new Uint8Array(await res.arrayBuffer());
		// The PNG magic number, so this asserts image bytes and not just a 200.
		expect(Array.from(bytes.slice(0, 8))).toEqual([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);
		expect(bytes.byteLength).toBeGreaterThan(8);
	});

	it("404s for an unknown attachment id", async () => {
		const { emailId } = await seedInlineImageSend();

		const res = await SELF.fetch(
			attachmentUrl(MAILBOX, emailId, "00000000-0000-0000-0000-000000000000"),
		);

		expect(res.status).toBe(404);
	});
});
