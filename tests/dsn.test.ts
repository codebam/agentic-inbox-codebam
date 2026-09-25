// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Bounce/DSN handling (RFC 3464 delivery status notifications).
 *
 * The real inbound path is driven end to end: a raw multipart/report message
 * goes through receiveEmail, the outcome is recorded on the matching Sent
 * copy, and the DSN itself still lands in the destination folder as ordinary
 * mail. The measured postal-mime shape these fixtures build on: header keys
 * are lowercased, and the `message/delivery-status`, `message/rfc822` and
 * `text/rfc822-headers` parts all surface as attachments with a null
 * filename, a null disposition and an ArrayBuffer body.
 */

import {
	createExecutionContext,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { receiveEmail, type InboundEmailEvent } from "../workers/index";


/** Settings that keep the ingest path deterministic (no AI call). */
const MAILBOX_SETTINGS = { categorization: { enabled: false } };


type Stub = ReturnType<typeof stubFor>;


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


/** The emails columns this feature owns. */
interface DeliveryRow {
	id: string;
	message_id: string | null;
	delivery_status: string | null;
	delivery_detail: string | null;
	delivery_updated_at: string | null;
}


/** Register the mailbox record the inbound pipeline checks. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify(MAILBOX_SETTINGS));
}


/** Seed one stored message, optionally in Sent with an RFC 5322 Message-ID. */
async function seedEmail(
	stub: Stub,
	id: string,
	folder: string,
	messageId: string | null,
	date = "2026-09-24T09:00:00.000Z",
) {
	await stub.createEmail(
		folder,
		{
			id,
			subject: `Subject ${id}`,
			sender: folder === Folders.SENT ? "box@example.com" : "sender@example.org",
			recipient: folder === Folders.SENT ? "missing@example.net" : "box@example.com",
			date,
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: id,
			message_id: messageId,
		},
		[],
	);
}


/** Push one raw message through the real receiveEmail path. */
async function deliver(mailbox: string, raw: string) {
	const bytes = new TextEncoder().encode(raw);
	const ctx = createExecutionContext();
	const event: InboundEmailEvent = {
		raw: new Response(bytes).body as ReadableStream,
		rawSize: bytes.byteLength,
		to: mailbox,
	};
	await receiveEmail(event, env, ctx);
	await waitOnExecutionContext(ctx);
}


interface ReportFields {
	action: string;
	status: string;
	diagnostic?: string;
}

interface ReportOptions {
	/** The Message-ID the embedded original-message part carries. */
	originalMessageId?: string;
	/** Which part carries the original: an embedded message, its headers, or none. */
	part?: "rfc822" | "rfc822-headers" | "none";
	/** Headers on the report itself, for the In-Reply-To / References fallbacks. */
	inReplyTo?: string;
	references?: string;
}

/** A raw multipart/report DSN, shaped like the mail a reporting MTA returns. */
function dsnMessage(
	to: string,
	fields: ReportFields,
	options: ReportOptions = {},
): string {
	const lines = [
		"From: Mail Delivery System <MAILER-DAEMON@example.org>",
		`To: ${to}`,
		"Subject: Undelivered Mail Returned to Sender",
		`Message-ID: <${crypto.randomUUID()}@example.org>`,
		...(options.inReplyTo ? [`In-Reply-To: <${options.inReplyTo}>`] : []),
		...(options.references ? [`References: ${options.references}`] : []),
		'Content-Type: multipart/report; report-type=delivery-status; boundary="DSN-BOUND"',
		"",
		"--DSN-BOUND",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Delivery has failed for the following recipient(s).",
		"--DSN-BOUND",
		"Content-Type: message/delivery-status",
		"",
		"Reporting-MTA: dns; mx.example.org",
		"Arrival-Date: Tue, 23 Sep 2026 03:00:00 +0000",
		"",
		"Final-Recipient: rfc822; missing@example.net",
		`Action: ${fields.action}`,
		`Status: ${fields.status}`,
		...(fields.diagnostic ? [`Diagnostic-Code: ${fields.diagnostic}`] : []),
	];
	const part = options.part ?? "rfc822";
	if (part !== "none") {
		lines.push(
			"--DSN-BOUND",
			`Content-Type: ${part === "rfc822" ? "message/rfc822" : "text/rfc822-headers"}`,
			"",
			"From: box@example.com",
			"To: missing@example.net",
			"Subject: Original",
			`Message-ID: <${options.originalMessageId ?? ""}>`,
			"Date: Tue, 23 Sep 2026 02:00:00 +0000",
			...(part === "rfc822" ? ["", "original body"] : []),
		);
	}
	lines.push("--DSN-BOUND--", "");
	return lines.join("\r\n");
}


/** A plain message: no report, no delivery-status part. */
function plainMessage(to: string): string {
	return [
		"From: sender@example.org",
		`To: ${to}`,
		"Subject: Hello",
		`Message-ID: <${crypto.randomUUID()}@example.org>`,
		"",
		"body",
		"",
	].join("\r\n");
}


/** The rows currently in a mailbox's Inbox. */
async function inboxRows(stub: Stub) {
	return (await stub.getEmails({ folder: Folders.INBOX })) as unknown as DeliveryRow[];
}


describe("DSN ingest", () => {
	it("records a failed delivery on the matching Sent copy and still stores the DSN", async () => {
		const mailbox = "dsn-failed@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, "sent-failed", Folders.SENT, "bounced@example.com");

		await deliver(
			mailbox,
			dsnMessage(
				mailbox,
				{
					action: "failed",
					status: "5.1.1",
					diagnostic: "smtp; 550 5.1.1 Mailbox unavailable",
				},
				{ originalMessageId: "bounced@example.com" },
			),
		);

		const sent = (await stub.getEmail("sent-failed")) as DeliveryRow | null;
		expect(sent?.delivery_status).toBe("failed");
		expect(sent?.delivery_detail).toBe("550 5.1.1 Mailbox unavailable");
		expect(sent?.delivery_detail).toContain("5.1.1");
		expect(sent?.delivery_updated_at).toEqual(expect.any(String));

		// The report itself is ordinary stored mail: it is never dropped, and
		// it carries no delivery fields of its own.
		const inbox = await inboxRows(stub);
		expect(inbox).toHaveLength(1);
		const report = (await stub.getEmail(inbox[0]!.id)) as DeliveryRow | null;
		expect(report?.delivery_status).toBeNull();
	});

	it("records a delayed delivery", async () => {
		const mailbox = "dsn-delayed@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, "sent-delayed", Folders.SENT, "slow@example.com");

		await deliver(
			mailbox,
			dsnMessage(
				mailbox,
				{ action: "delayed", status: "4.2.2", diagnostic: "smtp; 451 4.2.2 Mailbox full" },
				{ originalMessageId: "slow@example.com" },
			),
		);

		const sent = (await stub.getEmail("sent-delayed")) as DeliveryRow | null;
		expect(sent?.delivery_status).toBe("delayed");
		expect(sent?.delivery_detail).toBe("451 4.2.2 Mailbox full");
	});

	it("records delivered for a relayed report", async () => {
		const mailbox = "dsn-relayed@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, "sent-relayed", Folders.SENT, "relayed@example.com");

		await deliver(
			mailbox,
			dsnMessage(
				mailbox,
				{ action: "relayed", status: "2.0.0" },
				{ originalMessageId: "relayed@example.com" },
			),
		);

		const sent = (await stub.getEmail("sent-relayed")) as DeliveryRow | null;
		expect(sent?.delivery_status).toBe("delivered");
	});

	it("reads the original id out of a text/rfc822-headers part", async () => {
		const mailbox = "dsn-rfc822-headers@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, "sent-headers", Folders.SENT, "headers@example.com");

		await deliver(
			mailbox,
			dsnMessage(
				mailbox,
				{ action: "failed", status: "5.1.1", diagnostic: "smtp; 550 5.1.1 gone" },
				{ part: "rfc822-headers", originalMessageId: "headers@example.com" },
			),
		);

		expect(((await stub.getEmail("sent-headers")) as DeliveryRow | null)?.delivery_status)
			.toBe("failed");
	});

	it("falls back to the report's In-Reply-To, then its first References entry", async () => {
		const mailbox = "dsn-fallback@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, "sent-inreplyto", Folders.SENT, "via-inreplyto@example.com");
		await seedEmail(stub, "sent-references", Folders.SENT, "via-references@example.com");

		await deliver(
			mailbox,
			dsnMessage(
				mailbox,
				{ action: "failed", status: "5.1.1" },
				{ part: "none", inReplyTo: "via-inreplyto@example.com" },
			),
		);
		await deliver(
			mailbox,
			dsnMessage(
				mailbox,
				{ action: "delayed", status: "4.4.1" },
				{ part: "none", references: "<via-references@example.com> <later@example.com>" },
			),
		);

		expect(((await stub.getEmail("sent-inreplyto")) as DeliveryRow | null)?.delivery_status)
			.toBe("failed");
		expect(((await stub.getEmail("sent-references")) as DeliveryRow | null)?.delivery_status)
			.toBe("delayed");
	});

	it("leaves Sent rows untouched when the report matches nothing", async () => {
		const mailbox = "dsn-unmatched@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, "sent-unmatched", Folders.SENT, "kept@example.com");

		await deliver(
			mailbox,
			dsnMessage(
				mailbox,
				{ action: "failed", status: "5.1.1", diagnostic: "smtp; 550 5.1.1 no such user" },
				{ originalMessageId: "nobody@example.com" },
			),
		);

		const sent = (await stub.getEmail("sent-unmatched")) as DeliveryRow | null;
		expect(sent?.delivery_status).toBeNull();
		expect(sent?.delivery_detail).toBeNull();
		expect(sent?.delivery_updated_at).toBeNull();
		// A report that matches nothing is still stored, not silently dropped.
		expect(await inboxRows(stub)).toHaveLength(1);
	});

	it("records nothing for a message that is not a delivery report", async () => {
		const mailbox = "dsn-plain@example.com";
		await registerMailbox(mailbox);

		await deliver(mailbox, plainMessage(mailbox));

		const stub = stubFor(mailbox);
		const inbox = await inboxRows(stub);
		expect(inbox).toHaveLength(1);
		const stored = (await stub.getEmail(inbox[0]!.id)) as DeliveryRow | null;
		expect(stored?.delivery_status).toBeNull();
		expect(stored?.delivery_detail).toBeNull();
		expect(stored?.delivery_updated_at).toBeNull();
	});

	it("does not re-apply a redelivered DSN", async () => {
		const mailbox = "dsn-redelivered@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, "sent-redelivered", Folders.SENT, "once@example.com");
		const raw = dsnMessage(
			mailbox,
			{ action: "failed", status: "5.1.1", diagnostic: "smtp; 550 5.1.1 gone" },
			{ originalMessageId: "once@example.com" },
		);

		await deliver(mailbox, raw);
		expect(((await stub.getEmail("sent-redelivered")) as DeliveryRow | null)?.delivery_status)
			.toBe("failed");

		// A later state, then the very same DSN again: the duplicate early
		// return must leave the row alone and store no second copy.
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE emails SET delivery_status = 'delivered', delivery_detail = 'kept' WHERE id = 'sent-redelivered'",
			);
		});
		await deliver(mailbox, raw);

		const sent = (await stub.getEmail("sent-redelivered")) as DeliveryRow | null;
		expect(sent?.delivery_status).toBe("delivered");
		expect(sent?.delivery_detail).toBe("kept");
		expect(await inboxRows(stub)).toHaveLength(1);
	});
});


describe("MailboxDO.applyDeliveryReport", () => {
	it("is a silent no-op without an original id", async () => {
		const stub = stubFor("dsn-no-id@example.com");
		await seedEmail(stub, "sent-no-id", Folders.SENT, "kept@example.com");

		expect(
			await stub.applyDeliveryReport({
				originalMessageId: null,
				status: "failed",
				detail: "550 5.1.1 no such user",
			}),
		).toBe(false);

		expect(((await stub.getEmail("sent-no-id")) as DeliveryRow | null)?.delivery_status)
			.toBeNull();
	});

	it("only matches Sent copies", async () => {
		const stub = stubFor("dsn-sent-only@example.com");
		await seedEmail(stub, "inbox-copy", Folders.INBOX, "inbox-only@example.com");

		expect(
			await stub.applyDeliveryReport({
				originalMessageId: "inbox-only@example.com",
				status: "failed",
				detail: "550 5.1.1 no such user",
			}),
		).toBe(false);

		expect(((await stub.getEmail("inbox-copy")) as DeliveryRow | null)?.delivery_status)
			.toBeNull();
	});

	it("updates the newest matching Sent row", async () => {
		const stub = stubFor("dsn-newest@example.com");
		await seedEmail(stub, "sent-new", Folders.SENT, "shared@example.com");
		// A second Sent copy with the same message_id, older than the first:
		// createEmail refuses the duplicate, so it goes in through SQL.
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, read, starred, message_id)
				 VALUES ('sent-old', (SELECT id FROM folders WHERE name = 'sent' OR id = 'sent' LIMIT 1),
					'Older copy', 'box@example.com', 'missing@example.net', '2026-01-01T00:00:00.000Z', 1, 0, 'shared@example.com')`,
			);
		});

		expect(
			await stub.applyDeliveryReport({
				originalMessageId: "shared@example.com",
				status: "delivered",
				detail: null,
			}),
		).toBe(true);

		expect(((await stub.getEmail("sent-new")) as DeliveryRow | null)?.delivery_status)
			.toBe("delivered");
		expect(((await stub.getEmail("sent-old")) as DeliveryRow | null)?.delivery_status)
			.toBeNull();
	});
});
