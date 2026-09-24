// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mail-flow contacts: the addresses this mailbox has exchanged mail with.
 *
 * A contact row is metadata only — address, display name, sent/received
 * counts and timestamps — never message bodies, subjects or attachment
 * bytes. The store is fed by the ingest choke point itself: MailboxDO's
 * createEmail records a sent delta for every addressee of a message stored
 * in the Sent folder, and a received delta for the sender of a message
 * stored anywhere else (the From display name is captured when the message
 * carries one).
 *
 * Guardrails:
 * - Every stored value is bounded. MailboxDO.recordContacts prunes each
 *   mailbox back to its newest MAX_CONTACTS rows on every write, the search
 *   page is capped at MAX_CONTACT_SEARCH_LIMIT, and a display name is
 *   clipped to MAX_CONTACT_NAME_LENGTH.
 * - Addresses are normalized (trimmed + lowercased) before they are stored
 *   or compared, so `Alice@Example.com ` and `alice@example.com` are one
 *   contact.
 * - Nothing here sends mail or changes message state: recording contacts is
 *   a side effect of storing a message, never a message action.
 */

import { Folders } from "../../shared/folders";
import { normalizeEmailAddress } from "../../shared/mailboxes";

/** Most contacts kept per mailbox; older rows are pruned on write. */
export const MAX_CONTACTS = 5000;

/** Default page size for a contact search (the route and both tools). */
export const DEFAULT_CONTACT_SEARCH_LIMIT = 10;

/** Hard cap on a contact search page, however large a limit is asked for. */
export const MAX_CONTACT_SEARCH_LIMIT = 50;

/** Longest display name stored on a contact row. */
export const MAX_CONTACT_NAME_LENGTH = 200;

/**
 * One address's increment to apply to the contacts table. `sent` and
 * `received` are added to the stored counters; `name` refreshes the stored
 * display name only when it arrives non-empty.
 */
export interface ContactDelta {
	/** The address this delta belongs to; matched lowercased. */
	email: string;
	/** Display name captured from the message headers, when present. */
	name?: string | null;
	/** Increment added to `sent_count`. Defaults to 0. */
	sent?: number;
	/** Increment added to `received_count`. Defaults to 0. */
	received?: number;
}

/** One stored contact row. */
export interface ContactRow {
	id: string;
	/** The address, lowercased (the table's upsert target). */
	email: string;
	name: string | null;
	sent_count: number;
	received_count: number;
	first_seen_at: string;
	last_seen_at: string;
}

/**
 * The stored-message fields the contact deltas read. Structural on purpose:
 * the Durable Object passes its own EmailData.
 */
export interface ContactEmailFields {
	sender?: string | null;
	recipient?: string | null;
	cc?: string | null;
	bcc?: string | null;
	/** Display name from the sender's From header, when the message carried one. */
	sender_name?: string | null;
}

/** Normalize one address for storage, or null when it is not usable. */
export function normalizeContactAddress(value: unknown): string | null {
	return normalizeEmailAddress(value);
}

/** Trim a display name to its bounded stored form; null when there is none. */
export function normalizeContactName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const name = value.trim();
	if (!name) return null;
	return name.length > MAX_CONTACT_NAME_LENGTH
		? name.slice(0, MAX_CONTACT_NAME_LENGTH)
		: name;
}

/** Split a stored comma-joined address list into normalized addresses. */
function addressesIn(list: string | null | undefined): string[] {
	if (!list) return [];
	const addresses: string[] = [];
	for (const part of list.split(",")) {
		const address = normalizeContactAddress(part);
		if (address) addresses.push(address);
	}
	return addresses;
}

/**
 * Sent-side deltas: every address in `recipient`, `cc` and `bcc`, counted
 * once each even when an address appears twice (a message is one send to
 * one address).
 */
export function sentContactDeltas(email: ContactEmailFields): ContactDelta[] {
	const seen = new Set<string>();
	const deltas: ContactDelta[] = [];
	for (const address of [
		...addressesIn(email.recipient),
		...addressesIn(email.cc),
		...addressesIn(email.bcc),
	]) {
		if (seen.has(address)) continue;
		seen.add(address);
		deltas.push({ email: address, sent: 1 });
	}
	return deltas;
}

/** Received-side delta: the sender, with the From display name when present. */
export function receivedContactDelta(email: ContactEmailFields): ContactDelta[] {
	const address = normalizeContactAddress(email.sender);
	if (!address) return [];
	return [{ email: address, name: email.sender_name ?? null, received: 1 }];
}

/**
 * The contact deltas one stored message feeds, decided by the folder it was
 * stored in: a Sent copy counts its addressees as sent, every other folder
 * counts its sender as received. Both sides are never fed by one message.
 */
export function contactDeltasForEmail(
	folderId: string,
	email: ContactEmailFields,
): ContactDelta[] {
	return folderId === Folders.SENT
		? sentContactDeltas(email)
		: receivedContactDelta(email);
}
