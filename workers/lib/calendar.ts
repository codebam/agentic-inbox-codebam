// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Calendar invites (iMIP): the pure ICS half of the feature.
 *
 * An inbound message that carries a `text/calendar` part is parsed here into
 * the bounded metadata one `calendar_invites` row holds, and the operator's
 * answer is built here as an iMIP REPLY (RFC 6047 §3.2). Everything in this
 * module is pure and unit-testable: no clock, no storage, no network — the
 * ingest path (workers/index.ts receiveEmail) and the response route supply
 * the parsed message, the mailbox address and the timestamp.
 *
 * Measured postal-mime shape for a `text/calendar` part (a throwaway probe
 * over multipart/mixed, multipart/alternative, a nested mixed>alternative, a
 * base64 part, a part with no `method` parameter and a single-part message):
 * the part arrives as one `attachments` entry with `mimeType` exactly
 * `"text/calendar"` (parameters stripped), `disposition` from its
 * Content-Disposition (`"attachment"`, `"inline"`, or null when the message
 * set none), `filename` (the parameter's value, else null) and `content` as a
 * **Uint8Array** (decode with TextDecoder — the DSN note's ArrayBuffer is the
 * other possible kind). The content-type parameter `method=REQUEST` IS
 * reachable: postal-mime exposes it as the attachment's own `method` field,
 * and the field is absent when the parameter is. Decoded content carries LF
 * line endings.
 */


/** Bounds on every stored field; the columns are metadata, never message content. */
export const MAX_CALENDAR_SUMMARY_LENGTH = 300;
export const MAX_CALENDAR_LOCATION_LENGTH = 300;
export const MAX_CALENDAR_ADDRESS_LENGTH = 320;
export const MAX_CALENDAR_UID_LENGTH = 320;
export const MAX_CALENDAR_METHOD_LENGTH = 16;
export const MAX_CALENDAR_DATE_LENGTH = 64;

/** The three answers the panel offers; the API accepts nothing else. */
export const CALENDAR_RESPONSES = ["accepted", "declined", "tentative"] as const;
export type CalendarResponse = (typeof CALENDAR_RESPONSES)[number];

/** The iMIP PARTSTAT each answer maps to (RFC 5545 §3.2.12). */
export const PARTSTAT_BY_RESPONSE: Record<CalendarResponse, string> = {
	accepted: "ACCEPTED",
	declined: "DECLINED",
	tentative: "TENTATIVE",
};

/** The subject prefix each answer carries, e.g. "Accepted: Standup". */
const SUBJECT_PREFIX_BY_RESPONSE: Record<CalendarResponse, string> = {
	accepted: "Accepted",
	declined: "Declined",
	tentative: "Tentative",
};

/** PARTSTAT values that mean the attendee has already answered. */
const ANSWERED_PARTSTATS = new Set(["ACCEPTED", "DECLINED", "TENTATIVE"]);


/** True for exactly the three answers the respond route accepts. */
export function isCalendarResponse(value: unknown): value is CalendarResponse {
	return (
		typeof value === "string" &&
		(CALENDAR_RESPONSES as readonly string[]).includes(value)
	);
}


/** The reply's subject: the answer's prefix plus the invitation's summary. */
export function responseSubject(
	response: CalendarResponse,
	summary: string | null,
): string {
	const text = (summary ?? "").trim();
	return `${SUBJECT_PREFIX_BY_RESPONSE[response]}: ${text || "(no subject)"}`;
}


/**
 * The invite metadata one inbound message yields. Every field is bounded by
 * the parser and nullable: an ICS carries any subset of them.
 */
export interface CalendarInviteFields {
	uid: string | null;
	/** REQUEST | REPLY | CANCEL | another uppercased token, or null. */
	method: string | null;
	summary: string | null;
	/** Display form — `Name <address>` when the ICS carried a CN, else the address. */
	organizer: string | null;
	location: string | null;
	/** The raw DATE / DATE-TIME value, plus the ISO instant when it is UTC. */
	start_at: string | null;
	end_at: string | null;
	/** The ATTENDEE that is this mailbox, when the ICS names one. */
	attendee: string | null;
}


/** A stored `calendar_invites` row, as the routes and the UI read it. */
export interface CalendarInviteRow extends CalendarInviteFields {
	id: string;
	email_id: string;
	response: CalendarResponse | null;
	created_at: string;
}


/** One decoded ICS property: its name, its parameters and its raw value. */
interface IcsProperty {
	name: string;
	params: Map<string, string>;
	value: string;
}


/** Collapse whitespace and bound one stored field; null for an empty value. */
function bounded(value: string | null | undefined, max: number): string | null {
	const text = (value ?? "").replace(/\s+/g, " ").trim();
	if (!text) return null;
	return text.length > max ? text.slice(0, max) : text;
}


/** Strip the quotes a parameter value may carry. */
function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1);
	}
	return value;
}


/**
 * Unfold an ICS body into logical lines (RFC 5545 §3.1): a line starting with
 * a space or a tab continues the previous one. Measured postal-mime output
 * uses LF endings; CRLF is handled too.
 */
export function unfoldIcsLines(text: string): string[] {
	const lines: string[] = [];
	let current: string | null = null;
	for (const raw of text.split(/\r?\n/)) {
		if (current !== null && /^[ \t]/.test(raw)) {
			current += raw.slice(1);
			continue;
		}
		if (current !== null) lines.push(current);
		current = raw;
	}
	if (current !== null) lines.push(current);
	return lines;
}


/** Split a property head on the semicolons that are not inside a quoted value. */
function splitIcsSegments(head: string): string[] {
	const segments: string[] = [];
	let current = "";
	let inQuotes = false;
	for (const char of head) {
		if (char === '"') inQuotes = !inQuotes;
		if (char === ";" && !inQuotes) {
			segments.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	segments.push(current);
	return segments;
}


/**
 * Split one logical line into its property. The name and the parameter keys
 * are uppercased; the value stays verbatim (the colon inside a quoted
 * parameter value is not a separator).
 */
function parseIcsLine(line: string): IcsProperty | null {
	let colon = -1;
	let inQuotes = false;
	for (let i = 0; i < line.length; i += 1) {
		const char = line[i];
		if (char === '"') inQuotes = !inQuotes;
		else if (char === ":" && !inQuotes) {
			colon = i;
			break;
		}
	}
	if (colon <= 0) return null;

	const segments = splitIcsSegments(line.slice(0, colon));
	const name = (segments.shift() ?? "").trim().toUpperCase();
	if (!name) return null;

	const params = new Map<string, string>();
	for (const segment of segments) {
		const equals = segment.indexOf("=");
		if (equals <= 0) continue;
		const key = segment.slice(0, equals).trim().toUpperCase();
		if (key) params.set(key, unquote(segment.slice(equals + 1).trim()));
	}
	return { name, params, value: line.slice(colon + 1) };
}


/**
 * Unescape an ICS TEXT value (RFC 5545 §3.3.11): `\\` is a literal backslash,
 * `\,` a comma and `\;` a semicolon (both of which separate values in a list
 * otherwise), `\n` / `\N` a line break. Any other escape keeps its backslash,
 * because the spec defines no meaning for it.
 */
export function unescapeIcsText(value: string): string {
	let out = "";
	for (let i = 0; i < value.length; i += 1) {
		const char = value[i] ?? "";
		if (char !== "\\") {
			out += char;
			continue;
		}
		const next = value[i + 1];
		if (next === undefined) break;
		i += 1;
		out +=
			next === "n" || next === "N"
				? "\n"
				: next === "\\" || next === "," || next === ";"
					? next
					: `\\${next}`;
	}
	return out;
}


/** Escape a free-text value for an ICS TEXT property (the inverse of unescape). */
export function escapeIcsText(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/;/g, "\\;")
		.replace(/,/g, "\\,")
		.replace(/\r?\n/g, "\\n");
}


/**
 * The deliverable address inside a stored organizer/attendee value: the
 * `mailto:` target, or whatever sits inside `<...>`. Null when the value
 * names no address at all — a bare CN, or a URI that is not mailto.
 */
export function calendarAddress(value: string | null | undefined): string | null {
	const text = (value ?? "").trim();
	if (!text) return null;
	const angled = /<([^<>]+)>/.exec(text);
	const candidate = (angled?.[1] ?? text).trim();
	const withoutScheme = /^mailto:/i.test(candidate) ? candidate.slice(7) : candidate;
	const address = withoutScheme.trim().toLowerCase();
	return /^[^\s@]+@[^\s@]+$/.test(address) ? address : null;
}


/**
 * Normalize one DTSTART/DTEND value. The raw ICS value is kept — a DATE
 * (`20260925`) or a DATE-TIME (`20260925T140000`, `20260925T140000Z`) — and a
 * UTC form also carries the ISO instant the UI can format, so the stored
 * string reads `20260925T140000Z (2026-09-25T14:00:00.000Z)`. A floating
 * local time keeps the raw value only (its zone is unknowable here), and an
 * unrecognized value is kept as-is (bounded) rather than guessed at.
 */
export function normalizeIcsDate(value: string | null | undefined): string | null {
	const raw = (value ?? "").trim();
	if (!raw) return null;
	const utc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw);
	if (utc) {
		const iso = `${utc[1]}-${utc[2]}-${utc[3]}T${utc[4]}:${utc[5]}:${utc[6]}.000Z`;
		if (Number.isFinite(Date.parse(iso))) {
			return `${raw} (${new Date(iso).toISOString()})`;
		}
	}
	return bounded(raw, MAX_CALENDAR_DATE_LENGTH);
}


/** Uppercase and bound a METHOD token; null when it is not a bare token. */
export function normalizeCalendarMethod(
	value: string | null | undefined,
): string | null {
	const text = (value ?? "").trim().toUpperCase();
	if (!/^[A-Z]+$/.test(text)) return null;
	return text.slice(0, MAX_CALENDAR_METHOD_LENGTH);
}


/** `Name <address>` when the property carried a CN, else the address itself. */
function displayForm(property: IcsProperty): string | null {
	const address = calendarAddress(property.value);
	const name = bounded(property.params.get("CN"), MAX_CALENDAR_ADDRESS_LENGTH);
	if (name && address) {
		return bounded(`${name} <${address}>`, MAX_CALENDAR_ADDRESS_LENGTH);
	}
	return address ?? name ?? bounded(property.value, MAX_CALENDAR_ADDRESS_LENGTH);
}


/**
 * The invite one ICS body carries: the first VEVENT's fields, or null when
 * the body names no VEVENT at all. `mailboxId` picks which ATTENDEE is
 * "ours" (the one the reply answers as); without it the first ATTENDEE is.
 *
 * METHOD comes from the ICS's own `METHOD:` line when present, and is
 * otherwise inferred from the VEVENT: our attendee carrying an answered
 * PARTSTAT (ACCEPTED / DECLINED / TENTATIVE — NEEDS-ACTION is the unanswered
 * default of every fresh invitation, so it is not an answer) means the
 * message is an answer, `STATUS:CANCELLED` a cancellation, and anything else
 * an invitation.
 */
export function parseIcsEvent(
	text: string,
	mailboxId?: string | null,
): CalendarInviteFields | null {
	const properties: IcsProperty[] = [];
	let inEvent = false;
	let closed = false;
	for (const line of unfoldIcsLines(text)) {
		const property = parseIcsLine(line);
		if (!property) continue;
		const value = property.value.trim().toUpperCase();
		if (property.name === "BEGIN" && value === "VEVENT") {
			inEvent = true;
			continue;
		}
		if (property.name === "END" && value === "VEVENT") {
			inEvent = false;
			closed = true;
			break;
		}
		if (inEvent) properties.push(property);
	}
	if (!closed || properties.length === 0) return null;

	const first = (name: string) =>
		properties.find((property) => property.name === name) ?? null;
	const textField = (name: string, max: number) => {
		const property = first(name);
		return property ? bounded(unescapeIcsText(property.value), max) : null;
	};

	const mailbox = (mailboxId ?? "").trim().toLowerCase();
	const attendees = properties.filter((property) => property.name === "ATTENDEE");
	const ours = mailbox
		? (attendees.find((attendee) => calendarAddress(attendee.value) === mailbox) ?? null)
		: null;
	const attendee = ours ?? attendees[0] ?? null;
	const partstat = (attendee?.params.get("PARTSTAT") ?? "").trim().toUpperCase();
	const status = (first("STATUS")?.value ?? "").trim().toUpperCase();

	return {
		uid: bounded(first("UID")?.value, MAX_CALENDAR_UID_LENGTH),
		method:
			normalizeCalendarMethod(first("METHOD")?.value) ??
			(ANSWERED_PARTSTATS.has(partstat)
				? "REPLY"
				: status === "CANCELLED"
					? "CANCEL"
					: "REQUEST"),
		summary: textField("SUMMARY", MAX_CALENDAR_SUMMARY_LENGTH),
		organizer: first("ORGANIZER") ? displayForm(first("ORGANIZER")!) : null,
		location: textField("LOCATION", MAX_CALENDAR_LOCATION_LENGTH),
		start_at: normalizeIcsDate(first("DTSTART")?.value),
		end_at: normalizeIcsDate(first("DTEND")?.value),
		attendee: attendee ? displayForm(attendee) : null,
	};
}


/** The postal-mime attachment fields the calendar scan reads. */
export interface CalendarPart {
	mimeType: string;
	/** The content-type `method` parameter; postal-mime exposes it (measured). */
	method?: string | undefined;
	content: ArrayBuffer | Uint8Array | string;
}


/** Decode a part body — measured as a Uint8Array for a calendar part. */
export function decodeCalendarPart(content: ArrayBuffer | Uint8Array | string): string {
	if (typeof content === "string") return content;
	return new TextDecoder().decode(content);
}


/** The first `text/calendar` part of a parsed message, or null. */
export function findCalendarPart(
	attachments: readonly CalendarPart[],
): CalendarPart | null {
	return (
		attachments.find((attachment) =>
			attachment.mimeType.trim().toLowerCase().startsWith("text/calendar"),
		) ?? null
	);
}


/**
 * The invite one parsed message carries, or null when it has no calendar part
 * (or the part names no VEVENT). The content-type `method` parameter wins
 * over the ICS's own METHOD line: it is the sender's declared intent for the
 * whole part, while the METHOD line is body content.
 */
export function extractCalendarInvite(
	attachments: readonly CalendarPart[],
	mailboxId?: string | null,
): CalendarInviteFields | null {
	const part = findCalendarPart(attachments);
	if (!part) return null;
	const invite = parseIcsEvent(decodeCalendarPart(part.content), mailboxId);
	if (!invite) return null;
	const method = normalizeCalendarMethod(part.method);
	return method ? { ...invite, method } : invite;
}


/** Everything the iMIP reply needs; all of it pure input, no clock read. */
export interface ImipReplyInput {
	/** The invitation's UID; the caller generates one when the invite has none. */
	uid: string;
	summary: string | null;
	/** The stored organizer value; the mailto address is extracted from it. */
	organizer: string;
	/** The mailbox address answering. */
	attendee: string;
	response: CalendarResponse;
	/** DTSTAMP as an ISO 8601 instant — the caller's clock, never this module's. */
	dtstamp: string;
}


/** An ICS UTC timestamp (`YYYYMMDDTHHMMSSZ`) for an ISO instant, or null. */
export function toIcsUtcStamp(iso: string): string | null {
	const parsed = Date.parse(iso);
	if (!Number.isFinite(parsed)) return null;
	return new Date(parsed)
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
}


/** Fold one ICS line at 75 characters, continuation lines carrying a leading space. */
function foldIcsLine(line: string): string {
	if (line.length <= 75) return line;
	const parts = [line.slice(0, 75)];
	for (let i = 75; i < line.length; i += 74) parts.push(` ${line.slice(i, i + 74)}`);
	return parts.join("\r\n");
}


/**
 * The iMIP REPLY body for one answer (RFC 6047 §3.2): a text/calendar body
 * with `METHOD:REPLY` and one VEVENT naming the UID, DTSTAMP, ORGANIZER, the
 * answering ATTENDEE with its PARTSTAT and the SUMMARY. CRLF line endings,
 * folded at 75 characters, so a mail client reads it without a parser.
 */
export function buildImipReply(input: ImipReplyInput): string {
	const dtstamp = toIcsUtcStamp(input.dtstamp);
	if (!dtstamp) {
		throw new Error(`buildImipReply: dtstamp is not a valid instant: ${input.dtstamp}`);
	}
	const organizer = calendarAddress(input.organizer) ?? input.organizer.trim().toLowerCase();
	const attendee = calendarAddress(input.attendee) ?? input.attendee.trim().toLowerCase();
	const lines = [
		"BEGIN:VCALENDAR",
		"PRODID:-//agentic-inbox//iMIP reply//EN",
		"VERSION:2.0",
		"METHOD:REPLY",
		"BEGIN:VEVENT",
		`UID:${escapeIcsText(input.uid)}`,
		`DTSTAMP:${dtstamp}`,
		`ORGANIZER:mailto:${organizer}`,
		`ATTENDEE;PARTSTAT=${PARTSTAT_BY_RESPONSE[input.response]}:mailto:${attendee}`,
		`SUMMARY:${escapeIcsText(input.summary ?? "")}`,
		"END:VEVENT",
		"END:VCALENDAR",
		"",
	];
	return lines.map(foldIcsLine).join("\r\n");
}
