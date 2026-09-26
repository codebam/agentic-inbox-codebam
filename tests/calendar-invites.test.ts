// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Calendar invites (iMIP).
 *
 * The real inbound path is driven end to end: a raw multipart/mixed message
 * carrying a text/calendar part goes through receiveEmail, the invite lands in
 * the mailbox's calendar_invites row, and the two routes read it and record an
 * answer on it. The iMIP reply's delivery itself cannot be exercised in the
 * pool — wrangler.test.jsonc carries no send_email binding, so the deferred
 * send only logs — which is the same gap every other send route's coverage
 * has; what the reply contains is pinned by the pure-builder tests below.
 *
 * The measured postal-mime shape these fixtures build on: the text/calendar
 * part arrives as one attachment with `mimeType: "text/calendar"` (parameters
 * stripped), the content-type `method` parameter exposed as `attachment.method`
 * (absent when the part carries none) and the body as a Uint8Array.
 */

import { createExecutionContext, SELF, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { receiveEmail, type InboundEmailEvent } from "../workers/index";
import {
	buildImipReply,
	extractCalendarInvite,
	normalizeIcsDate,
	parseIcsEvent,
	responseSubject,
	unescapeIcsText,
} from "../workers/lib/calendar";


/** Settings that keep the ingest path deterministic (no AI call). */
const MAILBOX_SETTINGS = { categorization: { enabled: false } };

type Stub = ReturnType<typeof stubFor>;

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

/** Register the mailbox record the inbound pipeline checks. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify(MAILBOX_SETTINGS));
}


/** An invitation addressed to `mailbox`, as a calendar client sends it. */
function icsRequest(mailbox: string, method = "REQUEST"): string {
	return [
		"BEGIN:VCALENDAR",
		"PRODID:-//Example//EN",
		"VERSION:2.0",
		`METHOD:${method}`,
		"BEGIN:VEVENT",
		"UID:standup-123@example.org",
		"DTSTAMP:20260924T090000Z",
		"DTSTART:20260925T140000Z",
		"DTEND:20260925T143000Z",
		"SUMMARY:Standup\\, daily",
		"LOCATION:Room 1\\; floor 2",
		"ORGANIZER;CN=Organizer:mailto:organizer@example.org",
		`ATTENDEE;CN=Box;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${mailbox}`,
		"STATUS:CONFIRMED",
		"END:VEVENT",
		"END:VCALENDAR",
		"",
	].join("\r\n");
}


/** One raw multipart/mixed message with a text/plain part and an ICS part. */
function calendarMessage(
	to: string,
	ics: string,
	contentType = "text/calendar; charset=utf-8; method=REQUEST",
): string {
	return [
		"From: Organizer <organizer@example.org>",
		`To: ${to}`,
		"Subject: Invitation: Standup",
		`Message-ID: <${crypto.randomUUID()}@example.org>`,
		'Content-Type: multipart/mixed; boundary="CAL-BOUND"',
		"",
		"--CAL-BOUND",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"See the attached invitation.",
		"--CAL-BOUND",
		`Content-Type: ${contentType}`,
		'Content-Disposition: attachment; filename="invite.ics"',
		"",
		...ics.split("\r\n"),
		"--CAL-BOUND--",
		"",
	].join("\r\n");
}


/** A plain message: no calendar part anywhere. */
function plainMessage(to: string): string {
	return [
		"From: sender@example.org",
		`To: ${to}`,
		"Subject: Hello",
		`Message-ID: <${crypto.randomUUID()}@example.org>`,

		"body",
		"",
	].join("\r\n");
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


interface InviteResponseBody {
	invite: {
		id: string;
		email_id: string;
		uid: string | null;
		method: string | null;
		summary: string | null;
		organizer: string | null;
		location: string | null;
		start_at: string | null;
		end_at: string | null;
		attendee: string | null;
		response: string | null;
	} | null;
}

interface RespondResponseBody extends InviteResponseBody {
	id: string;
	status: string;
}


/** The id of the one message now sitting in the mailbox's Inbox. */
async function inboxEmailId(stub: Stub): Promise<string> {
	const inbox = (await stub.getEmails({ folder: Folders.INBOX })) as { id: string }[];
	expect(inbox).toHaveLength(1);
	return inbox[0]!.id;
}


async function getInvite(mailbox: string, emailId: string) {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/emails/${emailId}/invite`,
	);
	return { status: res.status, body: (await res.json()) as InviteResponseBody };
}


async function respondToInvite(mailbox: string, emailId: string, body: unknown) {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/emails/${emailId}/invite-response`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	return { status: res.status, body: (await res.json()) as RespondResponseBody };
}


describe("workers/lib/calendar.ts", () => {
	it("reads the invite out of the calendar part, content-type method first", () => {
		const attachments = [
			{ mimeType: "text/plain", content: "hello" },
			{
				mimeType: "text/calendar",
				method: "CANCEL",
				content: new TextEncoder().encode(icsRequest("box@example.com")),
			},
		];
		const invite = extractCalendarInvite(attachments, "box@example.com");
		// The parameter is the sender's declared intent for the part, so it
		// outranks the ICS body's own METHOD line.
		expect(invite?.method).toBe("CANCEL");
		expect(invite?.uid).toBe("standup-123@example.org");
		expect(invite?.summary).toBe("Standup, daily");
		expect(invite?.location).toBe("Room 1; floor 2");
		expect(invite?.organizer).toBe("Organizer <organizer@example.org>");
		expect(invite?.attendee).toBe("Box <box@example.com>");
		expect(invite?.start_at).toBe("20260925T140000Z (2026-09-25T14:00:00.000Z)");
		expect(invite?.end_at).toBe("20260925T143000Z (2026-09-25T14:30:00.000Z)");
	});

	it("returns null for a message with no calendar part", () => {
		expect(extractCalendarInvite([{ mimeType: "text/plain", content: "hi" }])).toBeNull();
		expect(extractCalendarInvite([])).toBeNull();
		// A calendar part with no VEVENT at all is not an invite either.
		expect(
			extractCalendarInvite([
				{ mimeType: "text/calendar", content: "BEGIN:VCALENDAR\nEND:VCALENDAR\n" },
			]),
		).toBeNull();
	});

	it("infers the method from the VEVENT when the ICS carries no METHOD line", () => {
		const body = (lines: string[]) =>
			[
				"BEGIN:VCALENDAR",
				"VERSION:2.0",
				"BEGIN:VEVENT",
				"UID:u-1@example.org",
				"DTSTART:20260925T140000Z",
				...lines,
				"END:VEVENT",
				"END:VCALENDAR",
			].join("\r\n");

		expect(parseIcsEvent(body([]))?.method).toBe("REQUEST");
		expect(
			parseIcsEvent(body(["ATTENDEE;PARTSTAT=ACCEPTED:mailto:box@example.com"]))?.method,
		).toBe("REPLY");
		// NEEDS-ACTION is the unanswered default of every fresh invitation.
		expect(
			parseIcsEvent(body(["ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:box@example.com"]))?.method,
		).toBe("REQUEST");
		expect(parseIcsEvent(body(["STATUS:CANCELLED"]))?.method).toBe("CANCEL");
	});

	it("unfolds folded lines and unescapes text values", () => {
		const text = [
			"BEGIN:VCALENDAR",
			"BEGIN:VEVENT",
			"UID:u-2@example.org",
			"SUMMARY:Standup\\, daily and a very long ",
			" summary that was folded",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		expect(parseIcsEvent(text)?.summary).toBe(
			"Standup, daily and a very long summary that was folded",
		);
		expect(unescapeIcsText("a\\, b\\; c\\\\ d\\n e")).toBe("a, b; c\\ d\n e");
	});

	it("keeps the raw ICS date value and adds the instant only for a UTC form", () => {
		expect(normalizeIcsDate("20260925T140000Z")).toBe(
			"20260925T140000Z (2026-09-25T14:00:00.000Z)",
		);
		expect(normalizeIcsDate("20260925")).toBe("20260925");
		// A floating local time names no zone, so no instant is invented.
		expect(normalizeIcsDate("20260925T140000")).toBe("20260925T140000");
		expect(normalizeIcsDate("")).toBeNull();
	});

	it("builds the iMIP REPLY body and the answer's subject", () => {
		const ics = buildImipReply({
			uid: "standup-123@example.org",
			summary: "Standup, daily",
			organizer: "Organizer <organizer@example.org>",
			attendee: "box@example.com",
			response: "accepted",
			dtstamp: "2026-09-24T09:30:00.000Z",
		});
		expect(ics).toContain("METHOD:REPLY");
		expect(ics).toContain("UID:standup-123@example.org");
		expect(ics).toContain("DTSTAMP:20260924T093000Z");
		expect(ics).toContain("ORGANIZER:mailto:organizer@example.org");
		expect(ics).toContain("ATTENDEE;PARTSTAT=ACCEPTED:mailto:box@example.com");
		// The summary is escaped on the way out, exactly as it arrived.
		expect(ics).toContain("SUMMARY:Standup\\, daily");
		expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);

		expect(
			buildImipReply({
				uid: "u",
				summary: "Standup",
				organizer: "organizer@example.org",
				attendee: "box@example.com",
				response: "declined",
				dtstamp: "2026-09-24T09:30:00.000Z",
			}),
		).toContain("ATTENDEE;PARTSTAT=DECLINED:mailto:box@example.com");

		expect(responseSubject("accepted", "Standup, daily")).toBe("Accepted: Standup, daily");
		expect(responseSubject("tentative", "  ")).toBe("Tentative: (no subject)");
	});
});


describe("calendar invite ingest", () => {
	it("stores the invite of an iMIP part and serves it over the route", async () => {
		const mailbox = "calendar-request@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		await deliver(mailbox, calendarMessage(mailbox, icsRequest(mailbox)));

		// The message itself is ordinary stored mail either way.
		const emailId = await inboxEmailId(stub);
		expect(await stub.getEmail(emailId)).toBeTruthy();

		const { status, body } = await getInvite(mailbox, emailId);
		expect(status).toBe(200);
		expect(body.invite?.email_id).toBe(emailId);
		expect(body.invite?.uid).toBe("standup-123@example.org");
		expect(body.invite?.method).toBe("REQUEST");
		expect(body.invite?.summary).toBe("Standup, daily");
		expect(body.invite?.organizer).toBe("Organizer <organizer@example.org>");
		expect(body.invite?.location).toBe("Room 1; floor 2");
		expect(body.invite?.start_at).toBe("20260925T140000Z (2026-09-25T14:00:00.000Z)");
		expect(body.invite?.end_at).toBe("20260925T143000Z (2026-09-25T14:30:00.000Z)");
		expect(body.invite?.attendee).toBe(`Box <${mailbox}>`);
		// Nothing has been answered yet.
		expect(body.invite?.response).toBeNull();
	});

	it("answers null for a message with no calendar part", async () => {
		const mailbox = "calendar-plain@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		await deliver(mailbox, plainMessage(mailbox));

		const emailId = await inboxEmailId(stub);
		const { status, body } = await getInvite(mailbox, emailId);
		expect(status).toBe(200);
		expect(body.invite).toBeNull();

		// An unknown message answers null too: the panel only needs the invite.
		const missing = await getInvite(mailbox, "no-such-email");
		expect(missing.status).toBe(200);
		expect(missing.body.invite).toBeNull();
	});
});


describe("POST /api/v1/mailboxes/:mailboxId/emails/:emailId/invite-response", () => {
	it("records an acceptance and leaves the Sent copy", async () => {
		const mailbox = "calendar-accept@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		await deliver(mailbox, calendarMessage(mailbox, icsRequest(mailbox)));
		const emailId = await inboxEmailId(stub);

		const { status, body } = await respondToInvite(mailbox, emailId, {
			response: "accepted",
		});
		expect(status).toBe(202);
		expect(body.status).toBe("sent");
		expect(body.invite?.response).toBe("accepted");

		// The route's own id is the Sent copy's id, so the panel and the
		// mailbox agree on which message went out. The delivery itself has no
		// binding in the pool: the deferred send only logs.
		const sent = (await stub.getEmails({ folder: Folders.SENT })) as {
			id: string;
			subject: string;
			sender: string;
			recipient: string;
		}[];
		expect(sent).toHaveLength(1);
		expect(sent[0]?.id).toBe(body.id);
		expect(sent[0]?.subject).toBe("Accepted: Standup, daily");
		expect(sent[0]?.sender).toBe(mailbox);
		expect(sent[0]?.recipient).toBe("organizer@example.org");

		// The recorded answer is what the GET route reports next.
		const stored = await getInvite(mailbox, emailId);
		expect(stored.body.invite?.response).toBe("accepted");
	});

	it("refuses an invite that is not a REQUEST", async () => {
		const mailbox = "calendar-reply@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		await deliver(
			mailbox,
			calendarMessage(
				mailbox,
				icsRequest(mailbox, "REPLY"),
				"text/calendar; method=REPLY",
			),
		);
		const emailId = await inboxEmailId(stub);
		// The invite is still recorded — ingest is method-agnostic.
		expect((await getInvite(mailbox, emailId)).body.invite?.method).toBe("REPLY");

		const { status, body } = await respondToInvite(mailbox, emailId, {
			response: "accepted",
		});
		expect(status).toBe(400);
		expect(body.invite).toBeUndefined();
		expect(await stub.getEmails({ folder: Folders.SENT })).toHaveLength(0);
	});

	it("refuses a response for a message with no invite, and an unknown answer", async () => {
		const mailbox = "calendar-no-invite@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		await deliver(mailbox, plainMessage(mailbox));
		const emailId = await inboxEmailId(stub);

		expect((await respondToInvite(mailbox, emailId, { response: "accepted" })).status).toBe(400);
		expect((await respondToInvite(mailbox, emailId, { response: "maybe" })).status).toBe(400);
		expect((await respondToInvite(mailbox, emailId, {})).status).toBe(400);
		expect(await stub.getEmails({ folder: Folders.SENT })).toHaveLength(0);
	});

	it("answers 404 for an unknown email", async () => {
		const mailbox = "calendar-missing@example.com";
		await registerMailbox(mailbox);

		const { status } = await respondToInvite(mailbox, "no-such-email", {
			response: "accepted",
		});
		expect(status).toBe(404);
	});
});
