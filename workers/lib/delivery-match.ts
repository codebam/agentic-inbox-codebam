// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Delivery-report matching support for MailboxDO.applyDeliveryReport, plus
 * the send-id capture every send path runs.
 *
 * A bounce names the original message by Message-ID, but the platform sets
 * that header itself: the id `sendEmail` returns is the only wire-side id
 * this mailbox ever sees. Every send path therefore stores it on the Sent
 * copy (captureSendMessageId, migration 32), and the matcher tries the
 * locally generated `message_id` first, then the binding-returned
 * `send_message_id`. When neither id matches, the bounded fallback below
 * compares normalized subject + recipient over a short date window and
 * matches only when exactly one Sent copy remains: ambiguity is a no-op,
 * never a guess. The whole step is best-effort — the DSN itself is stored as
 * ordinary mail whatever the match does.
 */


/** How far before a report's arrival a Sent copy may be dated and still be considered by the fallback. */
export const DELIVERY_MATCH_WINDOW_DAYS = 7;

/** Slack after the report's arrival, so a copy dated slightly ahead of it (clock skew) is not lost. */
export const DELIVERY_MATCH_WINDOW_SKEW_MS = 60 * 60 * 1000;


/**
 * The bounded `[from, to]` ISO window the fallback considers, anchored on the
 * instant the report is applied. The lower bound keeps the fallback to
 * recent sends; the upper bound is a small skew allowance only.
 */
export function deliveryMatchWindow(receivedAt: Date): { from: string; to: string } {
	const anchor = receivedAt.getTime();
	return {
		from: new Date(
			anchor - DELIVERY_MATCH_WINDOW_DAYS * 24 * 60 * 60 * 1000,
		).toISOString(),
		to: new Date(anchor + DELIVERY_MATCH_WINDOW_SKEW_MS).toISOString(),
	};
}


/**
 * The fallback's subject comparison: trim, collapse whitespace, casefold.
 * Deliberately conservative — the embedded part carries the subject as it
 * was sent, so no reply/forward prefixes are stripped and the comparison
 * cannot drift onto a different message.
 */
export function normalizeDeliverySubject(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}


/**
 * The address part of a report or stored address field. A Final-Recipient is
 * `address-type; address` (RFC 3464) and a stored Sent recipient is a
 * lowercased address (or comma-joined list), so only the addresses compare.
 */
export function normalizeDeliveryAddress(value: string | null | undefined): string {
	const raw = (value ?? "").trim();
	if (!raw) return "";
	return raw
		.slice(raw.lastIndexOf(";") + 1)
		.trim()
		.replace(/^</, "")
		.replace(/>$/, "")
		.toLowerCase();
}


/** True when the report's recipient is the stored one, or one entry of a stored list. */
function recipientMatches(stored: string | null, address: string): boolean {
	const normalized = normalizeDeliveryAddress(stored);
	if (!normalized) return false;
	if (normalized === address) return true;
	return normalized.split(",").some((entry) => entry.trim() === address);
}


/** One Sent row the fallback may match, as the DO's read helper returns it. */
export interface DeliveryMatchCandidate {
	id: string;
	subject: string | null;
	recipient: string | null;
}


export interface DeliveryFallbackCriteria {
	/** The original message's Subject, read from the report's embedded part. */
	subject: string | null;
	/** The report's Final-Recipient. */
	recipient: string | null;
}


/**
 * The single Sent copy a report's subject + recipient identify, or null.
 *
 * Null when either side of the comparison is missing, when nothing matches,
 * and — the point of the bounded fallback — when more than one candidate
 * remains: an ambiguous report is a no-op rather than a guess, because
 * recording the outcome on the wrong message is worse than recording none.
 */
export function pickDeliveryFallbackCandidate(
	candidates: readonly DeliveryMatchCandidate[],
	criteria: DeliveryFallbackCriteria,
): DeliveryMatchCandidate | null {
	const subject = normalizeDeliverySubject(criteria.subject);
	const recipient = normalizeDeliveryAddress(criteria.recipient);
	if (!subject || !recipient) return null;

	const matches = candidates.filter(
		(candidate) =>
			normalizeDeliverySubject(candidate.subject) === subject &&
			recipientMatches(candidate.recipient, recipient),
	);
	return matches.length === 1 ? matches[0]! : null;
}


/**
 * Anything that can record a send id on a stored message: MailboxDO's
 * setSendMessageId. Optional so a caller that cannot store mail (a test
 * fake, a stub without the method) is a safe no-op.
 */
export interface SendMessageIdStore {
	setSendMessageId?:
		| ((
				emailId: string,
				sendMessageId: string,
		  ) => boolean | Promise<boolean>)
		| undefined;
}


/**
 * Store the id the email binding returned on the Sent copy of a send.
 *
 * Best-effort by contract: the message has already gone out, so every
 * failure here — no id returned, a Sent copy that is gone, a storage error —
 * is reported as `false` (and logged, except for the silent no-ops), never
 * thrown. A storage failure must never flip a successful send to failed.
 */
export async function captureSendMessageId(
	store: SendMessageIdStore | null | undefined,
	emailId: string,
	result: { messageId?: string | null } | null | undefined,
): Promise<boolean> {
	const sendMessageId =
		typeof result?.messageId === "string" ? result.messageId.trim() : "";
	if (!sendMessageId) return false;
	if (!store || typeof store.setSendMessageId !== "function") return false;
	try {
		return (await store.setSendMessageId(emailId, sendMessageId)) === true;
	} catch (e) {
		console.error(
			`Storing the send id for ${emailId} failed:`,
			(e as Error).message,
		);
		return false;
	}
}
