// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Scheduled sends: outbound mail queued for a future instant.
 *
 * A scheduled send is one row in a mailbox's `scheduled_sends` table
 * (migration 22). The operator queues it through the HTTP route; the
 * mailbox's own alarm fires it when `send_at` arrives, and the cron sweep
 * (workers/lib/mail-sweep.ts) is the backstop for an alarm that never ran.
 * Sending stays operator-only: neither the agent nor the MCP surface can
 * create or fire one — they can only list and cancel.
 *
 * Guardrails:
 * - `payload` is bounded JSON of the send parameters only. Attachment bytes
 *   are never stored (the route rejects attachments) and every string is
 *   capped here, so one queued send cannot bloat a row.
 * - At fire time the stored parameters re-run the guards the immediate send
 *   path runs (sender validation, the mailbox rate limit, the spam-marked
 *   reply-target check, `verifyDraft`). A send that fails a guard — or the
 *   send itself — is recorded `failed` with its reason in `last_error`; its
 *   payload is never touched, and nothing is silently dropped.
 * - Terminal rows (sent, failed, cancelled) beyond the newest
 *   MAX_SCHEDULED_SENDS are pruned on insert. Pending rows are never pruned.
 */

import { sendEmail, type SendEmailParams } from "../email-sender";
import { buildThreadingHeaders } from "./email-helpers";


/** The statuses a scheduled send row can hold. */
export const SCHEDULED_SEND_STATUSES = [
	"pending",
	"sent",
	"failed",
	"cancelled",
] as const;

export type ScheduledSendStatus = (typeof SCHEDULED_SEND_STATUSES)[number];

/** Most terminal rows kept per mailbox; older rows are pruned on insert. */
export const MAX_SCHEDULED_SENDS = 200;

/** Default page size for the list route and the list tool. */
export const DEFAULT_SCHEDULED_SEND_LIMIT = 50;

/** Hard cap on one stored payload's JSON, in characters. */
export const MAX_SCHEDULED_PAYLOAD_CHARS = 100_000;

/** Hard cap on a stored html/text body, in characters. */
export const MAX_SCHEDULED_BODY_CHARS = 50_000;

/** Hard cap on a stored subject, in characters. */
export const MAX_SCHEDULED_SUBJECT_CHARS = 1_000;

/** Hard cap on the addresses in one stored recipient list (to/cc/bcc). */
export const MAX_SCHEDULED_RECIPIENTS = 50;

/**
 * Error text shared by the Durable Object and the routes for an unknown
 * scheduled send id, so the route can answer 404 without re-reading the row.
 */
export const SCHEDULED_SEND_NOT_FOUND = "Scheduled send not found.";

/**
 * The stored send parameters: the send route's body minus attachments.
 * Attachment bytes are never queued, and nothing else is added — the
 * recipient, sender, subject, bodies and the threading fields the immediate
 * path reads.
 */
export interface ScheduledSendPayload {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	in_reply_to?: string;
	references?: string[];
	thread_id?: string;
}

/** The stored columns of one `scheduled_sends` row, as the table holds them. */
export interface ScheduledSendDbRow {
	id: string;
	draft_id: string | null;
	send_at: string;
	status: string;
	/** Bounded JSON of the send parameters. */
	payload: string;
	attempts: number;
	last_error: string | null;
	created_at: string;
	sent_at: string | null;
}

/** One scheduled send as the Durable Object and the routes return it. */
export interface ScheduledSendRow {
	id: string;
	/** The draft this send was queued from, when the caller recorded one. */
	draft_id: string | null;
	send_at: string;
	status: string;
	/**
	 * The parsed send parameters, or null when the stored JSON cannot be
	 * read back (a fire-time failure, recorded in `last_error`).
	 */
	payload: ScheduledSendPayload | null;
	attempts: number;
	last_error: string | null;
	created_at: string;
	sent_at: string | null;
}

/** The input MailboxDO.scheduleSend stores. */
export interface ScheduleSendInput {
	/** ISO instant the send becomes due. */
	sendAt: string;
	/** Bounded JSON of the send parameters (serializeScheduledSendPayload). */
	payload: string;
	/** Optional provenance: the draft this send was queued from. */
	draft_id?: string | null;
}

/** The answer of cancelScheduledSend / retryScheduledSend. */
export type ScheduledSendActionResult =
	| { ok: true; send: ScheduledSendRow }
	| { ok: false; error: string };


/** A caller-facing rejection for one over-limit field. */
function overLimit(label: string, limit: number): { error: string } {
	return {
		error: `${label} is longer than ${limit} characters — shorten it before scheduling.`,
	};
}

/** How many addresses a stored recipient field holds (1 for a bare string). */
function recipientCount(value: string | string[]): number {
	return Array.isArray(value) ? value.length : 1;
}

/**
 * Bound and serialize the send parameters for storage.
 *
 * Every string is capped and every recipient list is limited; an over-limit
 * input is rejected with a caller-facing error rather than silently
 * truncated, because a truncated queued message would be sent wrong later.
 * Returns the JSON string to store, or `{ error }` when the input cannot be
 * queued at all.
 */
export function serializeScheduledSendPayload(
	input: ScheduledSendPayload,
): { payload: string } | { error: string } {
	if (input.subject.length > MAX_SCHEDULED_SUBJECT_CHARS) {
		return overLimit("The subject", MAX_SCHEDULED_SUBJECT_CHARS);
	}
	if (typeof input.html === "string" && input.html.length > MAX_SCHEDULED_BODY_CHARS) {
		return overLimit("The HTML body", MAX_SCHEDULED_BODY_CHARS);
	}
	if (typeof input.text === "string" && input.text.length > MAX_SCHEDULED_BODY_CHARS) {
		return overLimit("The text body", MAX_SCHEDULED_BODY_CHARS);
	}
	for (const [label, value] of [
		["The recipient list", input.to],
		["The cc list", input.cc],
		["The bcc list", input.bcc],
	] as const) {
		if (value !== undefined && recipientCount(value) > MAX_SCHEDULED_RECIPIENTS) {
			return overLimit(label, MAX_SCHEDULED_RECIPIENTS);
		}
	}

	// Only the known fields are stored, and only when present: an absent
	// optional field must stay absent (exactOptionalPropertyTypes), and a
	// hand-built payload cannot smuggle anything else into the row.
	const payload: ScheduledSendPayload = {
		to: input.to,
		from: input.from,
		subject: input.subject,
	};
	if (input.html !== undefined) payload.html = input.html;
	if (input.text !== undefined) payload.text = input.text;
	if (input.cc !== undefined) payload.cc = input.cc;
	if (input.bcc !== undefined) payload.bcc = input.bcc;
	if (input.in_reply_to) payload.in_reply_to = input.in_reply_to;
	if (input.references && input.references.length > 0) {
		payload.references = input.references;
	}
	if (input.thread_id) payload.thread_id = input.thread_id;

	const json = JSON.stringify(payload);
	if (json.length > MAX_SCHEDULED_PAYLOAD_CHARS) {
		return overLimit("The stored send", MAX_SCHEDULED_PAYLOAD_CHARS);
	}
	return { payload: json };
}

/** A stored recipient field: a non-empty string, or a non-empty string list. */
function readRecipients(value: unknown): string | string[] | null {
	if (typeof value === "string") return value ? value : null;
	if (Array.isArray(value) && value.length > 0) {
		return value.every((entry): entry is string => typeof entry === "string")
			? value
			: null;
	}
	return null;
}

/** A stored sender: a non-empty address, or an { email, name } object. */
function readSender(value: unknown): string | { email: string; name: string } | null {
	if (typeof value === "string") return value ? value : null;
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		const email = record["email"];
		const name = record["name"];
		if (typeof email === "string" && email && typeof name === "string") {
			return { email, name };
		}
	}
	return null;
}

/**
 * Parse a stored payload back into send parameters. Tolerant by design:
 * anything that is not a JSON object with a usable recipient, sender and
 * subject is null, and only the known fields are read back, so a
 * hand-edited row cannot smuggle extra keys into a send.
 */
export function parseScheduledSendPayload(
	json: string,
): ScheduledSendPayload | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const record = parsed as Record<string, unknown>;

	const to = readRecipients(record["to"]);
	const from = readSender(record["from"]);
	const subject = record["subject"];
	if (to === null || from === null || typeof subject !== "string") return null;

	const payload: ScheduledSendPayload = { to, from, subject };
	const html = record["html"];
	if (typeof html === "string") payload.html = html;
	const text = record["text"];
	if (typeof text === "string") payload.text = text;
	const cc = readRecipients(record["cc"]);
	if (cc !== null) payload.cc = cc;
	const bcc = readRecipients(record["bcc"]);
	if (bcc !== null) payload.bcc = bcc;
	const inReplyTo = record["in_reply_to"];
	if (typeof inReplyTo === "string" && inReplyTo) payload.in_reply_to = inReplyTo;
	const references = record["references"];
	if (Array.isArray(references)) {
		payload.references = references.filter(
			(entry): entry is string => typeof entry === "string",
		);
	}
	const threadId = record["thread_id"];
	if (typeof threadId === "string" && threadId) payload.thread_id = threadId;
	return payload;
}

/**
 * Rebuild the binding parameters of a queued send: the stored parameters
 * plus the threading headers the immediate path builds for a reply
 * (`buildThreadingHeaders`), so the message threads exactly like one sent
 * right away.
 */
export function buildScheduledSendParams(
	payload: ScheduledSendPayload,
): SendEmailParams {
	return {
		to: payload.to,
		from: payload.from,
		subject: payload.subject,
		...(payload.html !== undefined ? { html: payload.html } : {}),
		...(payload.text !== undefined ? { text: payload.text } : {}),
		...(payload.cc !== undefined ? { cc: payload.cc } : {}),
		...(payload.bcc !== undefined ? { bcc: payload.bcc } : {}),
		...(payload.in_reply_to
			? { headers: buildThreadingHeaders(payload.in_reply_to, payload.references ?? []) }
			: {}),
	};
}

/** One stored row as the API shape, with `payload` parsed. */
export function scheduledSendRow(row: ScheduledSendDbRow): ScheduledSendRow {
	return {
		id: row.id,
		draft_id: row.draft_id,
		send_at: row.send_at,
		status: row.status,
		payload: parseScheduledSendPayload(row.payload),
		attempts: row.attempts,
		last_error: row.last_error,
		created_at: row.created_at,
		sent_at: row.sent_at,
	};
}


// ── Sender seam ────────────────────────────────────────────────────

/** Anything that can deliver one queued message. Tests inject a fake. */
export interface ScheduledSendSender {
	send(params: SendEmailParams): Promise<{ messageId: string }>;
}

type ScheduledSendEnv = { EMAIL?: SendEmail };

let senderFactoryOverride: (() => ScheduledSendSender | null) | null = null;

/**
 * Test seam: replace the sender the fire path uses. Passing null restores
 * the real Cloudflare Email Service binding path.
 */
export function setScheduledSendSenderFactory(
	factory: (() => ScheduledSendSender | null) | null,
): void {
	senderFactoryOverride = factory;
}

/** The real sender, or null when this deployment has no EMAIL binding. */
export function createScheduledSendSender(
	env: ScheduledSendEnv,
): ScheduledSendSender | null {
	const binding = env.EMAIL;
	if (!binding) return null;
	return { send: (params: SendEmailParams) => sendEmail(binding, params) };
}

/** The sender the fire path should use (honours the test override). */
export function resolveScheduledSendSender(
	env: ScheduledSendEnv,
): ScheduledSendSender | null {
	if (senderFactoryOverride) return senderFactoryOverride();
	return createScheduledSendSender(env);
}
