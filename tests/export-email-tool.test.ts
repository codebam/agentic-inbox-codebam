/**
 * export_email tool tests: one stored message rebuilt as an RFC 5322 (EML)
 * block, under the `eml` key — the same text the message/rfc822 download
 * route serves, from the same stored fields.
 */

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { toolExportEmail } from "../workers/lib/tools";

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
		cc?: string | null;
		message_id?: string | null;
	},
) {
	await stubFor(mailbox).createEmail(
		Folders.INBOX,
		{
			id: email.id,
			subject: email.subject,
			sender: email.sender ?? "sender@example.org",
			recipient: mailbox,
			date: new Date().toISOString(),
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

describe("export_email tool", () => {
	it("returns the reconstructed EML with headers and body", async () => {
		const mailbox = "export-tool@example.com";
		await seedEmail(mailbox, {
			id: "export-1",
			subject: "Export subject",
			sender: "alice@example.org",
			body: "Export body text",
			cc: "carol@example.org",
			message_id: "export@example.org",
		});

		const answer = await toolExportEmail(env, mailbox, { emailId: "export-1" });

		expect(Object.keys(answer)).toEqual(["eml"]);
		const eml = (answer as { eml: string }).eml;
		expect(eml).toContain("From: alice@example.org");
		expect(eml).toContain(`To: ${mailbox}`);
		expect(eml).toContain("Cc: carol@example.org");
		expect(eml).toContain("Date: ");
		expect(eml).toContain("Subject: Export subject");
		expect(eml).toContain("Message-ID: export@example.org");
		// Headers end at a blank line; the body is the last thing, newline-closed.
		expect(eml).toContain("\n\nExport body text");
		expect(eml.endsWith("Export body text\n")).toBe(true);
	});

	it("answers exactly the bytes of the EML download route", async () => {
		const mailbox = "export-tool-parity@example.com";
		await registerMailbox(mailbox);
		await seedEmail(mailbox, {
			id: "export-2",
			subject: "Parity subject",
			body: "Parity body.",
		});

		const answer = await toolExportEmail(env, mailbox, { emailId: "export-2" });
		const res = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/emails/export-2/eml`,
		);

		expect(res.status).toBe(200);
		expect((answer as { eml: string }).eml).toBe(await res.text());
	});

	it("quotes a body line that begins with From and a space", async () => {
		const mailbox = "export-tool-escape@example.com";
		await seedEmail(mailbox, {
			id: "export-3",
			subject: "Escaped body",
			body: "Line one\nFrom here on this line is quoted\nLast line",
		});

		const eml = (
			(await toolExportEmail(env, mailbox, { emailId: "export-3" })) as {
				eml: string;
			}
		).eml;

		expect(eml).toContain(">From here on this line is quoted");
		expect(eml).not.toContain("\nFrom here on this line is quoted");
	});

	it("errors for an unknown email id", async () => {
		const mailbox = "export-tool-missing@example.com";
		expect(
			await toolExportEmail(env, mailbox, { emailId: "missing-1" }),
		).toEqual({ error: "Email not found" });
	});
});
