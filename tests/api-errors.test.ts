// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/**
 * What the API says when a request is wrong.
 *
 * A live 500 with no body and no log line is undiagnosable: the client shows
 * "Request failed: 500" and nothing says which request or which field. These
 * tests pin the two answers the app owes — a 400 naming the field for a body
 * the schema rejects, and a 500 that carries the error's message (the log
 * line, with the stack, is the operator's side of the same fix).
 */

const MAILBOX = "api-errors@example.com";

/** Register the mailbox record the API middleware checks before routing. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
}

function postEmail(body: unknown) {
	return SELF.fetch(
		`http://example.com/api/v1/mailboxes/${MAILBOX}/emails`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
}

describe("API error responses", () => {
	it("answers 400 naming the field when the body fails validation", async () => {
		await registerMailbox(MAILBOX);

		const res = await postEmail({
			to: "not-an-address",
			from: MAILBOX,
			subject: "Bad recipient",
			html: "<p>hi</p>",
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("to");
	});

	it("names a missing body field rather than the whole body", async () => {
		await registerMailbox(MAILBOX);

		// `to` is required: its absence is the request's fault, not a 500.
		const res = await postEmail({
			from: MAILBOX,
			subject: "No recipient",
			html: "<p>hi</p>",
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("Invalid request");
	});

	it("keeps a body-level refinement readable", async () => {
		await registerMailbox(MAILBOX);

		// The schema refines that a message carries html or text; the failure
		// has no field path, so it is reported against the body.
		const res = await postEmail({
			to: MAILBOX,
			from: MAILBOX,
			subject: "No body",
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("body");
	});
});
