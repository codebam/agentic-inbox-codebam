// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


/** Register the mailbox record the API middleware checks before routing. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
}


/** Seed one stored message with the fields the export reconstructs from. */
async function seedEmail(
	mailbox: string,
	email: {
		id: string;
		subject: string;
		body: string;
		sender?: string;
		date?: string;
		message_id?: string | null;
		cc?: string | null;
	},
) {
	await stubFor(mailbox).createEmail(
		Folders.INBOX,
		{
			id: email.id,
			subject: email.subject,
			sender: email.sender ?? "sender@example.org",
			recipient: mailbox,
			date: email.date ?? new Date().toISOString(),
			body: email.body,
			cc: email.cc ?? null,
			message_id: email.message_id ?? null,
			in_reply_to: null,
			email_references: null,
			thread_id: email.id,
		},
		[],
	);
}


function exportUrl(mailbox: string) {
	return `http://example.com/api/v1/mailboxes/${mailbox}/export`;
}


function emlUrl(mailbox: string, emailId: string) {
	return `http://example.com/api/v1/mailboxes/${mailbox}/emails/${emailId}/eml`;
}


/** The mbox separator lines; an escaped body line begins ">From ", not "From ". */
function separatorLines(mbox: string) {
	return mbox.split("\n").filter((line) => line.startsWith("From "));
}


describe("mbox export", () => {
	it("frames two stored messages with From separators, headers and blank lines", async () => {
		const mailbox = "mbox-export@example.com";
		await registerMailbox(mailbox);
		await seedEmail(mailbox, {
			id: "mbox-1",
			subject: "First message",
			sender: "alice@example.org",
			date: "2026-09-01T10:00:00.000Z",
			body: "Hello from the first message.",
			message_id: "first@example.org",
		});
		await seedEmail(mailbox, {
			id: "mbox-2",
			subject: "Second message",
			sender: "bob@example.org",
			date: "2026-09-02T11:30:00.000Z",
			body: "Second body.",
		});

		const res = await SELF.fetch(exportUrl(mailbox));

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/mbox");
		const disposition = res.headers.get("content-disposition") ?? "";
		expect(disposition).toContain("attachment");
		expect(disposition).toContain(".mbox");

		const mbox = await res.text();
		// One separator per message, oldest first.
		const separators = separatorLines(mbox);
		expect(separators).toHaveLength(2);
		expect(separators[0]).toContain("alice@example.org");
		expect(separators[1]).toContain("bob@example.org");

		// Both subjects, and the Message-ID only where the row stores one.
		expect(mbox).toContain("Subject: First message");
		expect(mbox).toContain("Subject: Second message");
		expect(mbox).toContain("Message-ID: first@example.org");
		expect(mbox.match(/^Message-ID: /gm) ?? []).toHaveLength(1);

		// A blank line separates headers from body, each record is closed by
		// a blank line, and the next separator follows immediately. The
		// first record's stored Message-ID is its last header line.
		expect(mbox).toContain(
			"Subject: First message\nMessage-ID: first@example.org\n\nHello from the first message.",
		);
		expect(mbox).toContain("Hello from the first message.\n\nFrom bob@example.org");
		expect(mbox).toContain("Subject: Second message\n\nSecond body.");
		expect(mbox.endsWith("Second body.\n\n")).toBe(true);
	});

	it("quotes a body line that begins with From and a space", async () => {
		const mailbox = "mbox-escape@example.com";
		await registerMailbox(mailbox);
		await seedEmail(mailbox, {
			id: "escape-1",
			subject: "Escaped body",
			body: "Line one\nFrom here on this line is quoted\nLast line",
		});

		const res = await SELF.fetch(exportUrl(mailbox));

		expect(res.status).toBe(200);
		const mbox = await res.text();

		expect(mbox).toContain("Line one\n>From here on this line is quoted\nLast line");
		// The only unquoted From line is the record's own separator.
		expect(separatorLines(mbox)).toHaveLength(1);
		expect(mbox).not.toContain("\nFrom here on this line is quoted");
	});

	it("answers 200 with an empty body for a mailbox with no messages", async () => {
		const mailbox = "mbox-empty@example.com";
		await registerMailbox(mailbox);

		const res = await SELF.fetch(exportUrl(mailbox));

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/mbox");
		expect(await res.text()).toBe("");
	});

	it("pages through more messages than one export page holds", async () => {
		const mailbox = "mbox-paged@example.com";
		await registerMailbox(mailbox);
		// 205 messages is just over the route's 200-message page, so the
		// stream has to ask the Durable Object for a second page.
		const ids = Array.from({ length: 205 }, (_, index) => `paged-${index}`);
		await Promise.all(
			ids.map((id, index) =>
				seedEmail(mailbox, {
					id,
					subject: `Paged subject ${index}`,
					body: `Paged body ${index}.`,
					date: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
				}),
			),
		);

		const res = await SELF.fetch(exportUrl(mailbox));

		expect(res.status).toBe(200);
		const mbox = await res.text();
		expect(separatorLines(mbox)).toHaveLength(205);
		expect(mbox).toContain("Subject: Paged subject 0");
		expect(mbox).toContain("Subject: Paged subject 204");
	});

	it("never includes a message from another mailbox", async () => {
		const mine = "mbox-mine@example.com";
		const other = "mbox-other@example.com";
		await registerMailbox(mine);
		await registerMailbox(other);
		await seedEmail(mine, {
			id: "mine-1",
			subject: "Mine only",
			body: "Mine body.",
		});
		await seedEmail(other, {
			id: "other-1",
			subject: "Other mailbox message",
			body: "Other body.",
		});

		const res = await SELF.fetch(exportUrl(mine));

		expect(res.status).toBe(200);
		const mbox = await res.text();
		expect(mbox).toContain("Subject: Mine only");
		expect(mbox).not.toContain("Other mailbox message");
		expect(separatorLines(mbox)).toHaveLength(1);
	});
});


describe("EML download", () => {
	it("returns the stored message as message/rfc822", async () => {
		const mailbox = "eml-download@example.com";
		await registerMailbox(mailbox);
		await seedEmail(mailbox, {
			id: "eml-1",
			subject: "Eml subject",
			body: "Eml body text",
			message_id: "eml@example.org",
		});

		const res = await SELF.fetch(emlUrl(mailbox, "eml-1"));

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("message/rfc822");
		const disposition = res.headers.get("content-disposition") ?? "";
		expect(disposition).toContain("attachment");
		expect(disposition).toContain(".eml");

		const eml = await res.text();
		expect(eml).toContain("Subject: Eml subject");
		expect(eml).toContain("Eml body text");
		expect(eml).toContain("Message-ID: eml@example.org");
	});

	it("404s for an unknown email id", async () => {
		const mailbox = "eml-missing@example.com";
		await registerMailbox(mailbox);

		const res = await SELF.fetch(
			emlUrl(mailbox, "00000000-0000-0000-0000-000000000000"),
		);

		expect(res.status).toBe(404);
	});
});
