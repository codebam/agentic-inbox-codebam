// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { EMPTY_MESSAGE_BODY, ensureMessageBody } from "../shared/compose-body";
import { SendEmailRequestSchema } from "../workers/lib/schemas";

const MAILBOX = "compose-body@example.com";

/** Register the mailbox record the API middleware requires. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(
		`mailboxes/${mailbox}.json`,
		JSON.stringify({ categorization: { enabled: false } }),
	);
}

/** POST the compose send route with exactly the given body. */
async function postEmail(body: Record<string, unknown>) {
	return SELF.fetch(`http://example.com/api/v1/mailboxes/${MAILBOX}/emails`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("ensureMessageBody", () => {
	it("sends a blank composer body as an empty paragraph", () => {
		expect(ensureMessageBody("")).toEqual({
			html: EMPTY_MESSAGE_BODY,
			text: "",
		});
		expect(ensureMessageBody("   \n")).toEqual({
			html: EMPTY_MESSAGE_BODY,
			text: "",
		});
	});

	it("passes a written body through unchanged", () => {
		expect(ensureMessageBody("<p>Hello</p>")).toEqual({
			html: "<p>Hello</p>",
			text: "Hello",
		});
	});

	it("produces a pair the send schema accepts", () => {
		const { html, text } = ensureMessageBody("");
		const parsed = SendEmailRequestSchema.safeParse({
			to: "recipient@example.org",
			from: MAILBOX,
			subject: "No body",
			html,
			text,
		});
		expect(parsed.success).toBe(true);
	});
});

describe("send route body requirement", () => {
	it("accepts the empty-body payload the composer sends", async () => {
		await registerMailbox(MAILBOX);

		const res = await postEmail({
			to: "recipient@example.org",
			from: MAILBOX,
			subject: "No body",
			...ensureMessageBody(""),
		});

		expect(res.status).toBe(202);
	});

	it("names the body when neither html nor text is provided", async () => {
		await registerMailbox(MAILBOX);

		const res = await postEmail({
			to: "recipient@example.org",
			from: MAILBOX,
			subject: "No body",
			html: "",
			text: "",
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("body");
		expect(body.error).toContain("html");
	});
});
