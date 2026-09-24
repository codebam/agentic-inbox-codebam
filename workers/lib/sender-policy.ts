// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Per-mailbox sender allow/block policy.
 *
 * This module is pure: no I/O, no bindings, no Durable Object access. It is
 * shared by the Durable Object (storage CRUD), the inbound pipeline in
 * workers/index.ts (the ingest decision), and — for types only — the frontend,
 * so the stored shape and the API/UI shape cannot drift apart.
 *
 * Ingest decision (evaluated before the Jev classifier runs):
 *   - `block` → the message is filed straight into Spam, classification is
 *     skipped entirely, and no auto-draft is requested. The message is still
 *     STORED — blocked mail is never silently dropped.
 *   - `allow` → the message is treated as not-spam: the spam question is
 *     dropped from the classifier call, but category classification still
 *     runs and auto-drafting is unchanged.
 *   - `none`  → today's behaviour (the classifier decides).
 *
 * Addresses are stored and compared trimmed + lowercased, so
 * `Alice@Example.com ` and `alice@example.com` are the same entry.
 */

import { Folders } from "../../shared/folders";


/** Policy values accepted by the API and stored in the `sender_policy` table. */
export const SENDER_POLICIES = ["allow", "block"] as const;


export type SenderPolicy = (typeof SENDER_POLICIES)[number];


/** One stored sender-policy row. */
export interface SenderPolicyEntry {
	/** Trimmed + lowercased sender address (the table's primary key). */
	address: string;
	policy: SenderPolicy;
	created_at: string;
}


/**
 * Thrown when a sender-policy write cannot be stored as written (empty
 * address, unknown policy). Routes translate it into a 400 response.
 */
export class SenderPolicyValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SenderPolicyValidationError";
	}
}


/**
 * True for both locally-thrown and RPC-transported validation errors: DO RPC
 * may rebuild the error, so the class check is backed up by a name check.
 */
export function isSenderPolicyValidationError(error: unknown): boolean {
	if (error instanceof SenderPolicyValidationError) return true;
	if (!(error instanceof Error)) return false;
	if (error.name === "SenderPolicyValidationError") return true;
	// Durable Object RPC rebuilds thrown errors, so the class identity is lost
	// and the name survives only as the message prefix.
	return error.message.startsWith("SenderPolicyValidationError");
}


/** Type guard for the policy enum. */
export function isSenderPolicy(value: unknown): value is SenderPolicy {
	return (
		typeof value === "string" &&
		(SENDER_POLICIES as readonly string[]).includes(value)
	);
}


/** Canonical form of a sender address: trimmed and lowercased. */
export function normalizeSenderAddress(address: unknown): string {
	return typeof address === "string" ? address.trim().toLowerCase() : "";
}


/** The three ingest outcomes. */
export const SENDER_POLICY_VERDICTS = ["block", "allow", "none"] as const;


export type SenderPolicyVerdictKind = (typeof SENDER_POLICY_VERDICTS)[number];


/** Everything the inbound pipeline needs to know about one message's policy. */
export interface SenderPolicyDecision {
	verdict: SenderPolicyVerdictKind;
	/**
	 * Folder the message must be filed in, or null for normal routing.
	 * `block` always wins over classifier and rule routing.
	 */
	folder: string | null;
	/** False when the Jev classifier must not run at all (block). */
	classify: boolean;
	/** True when the spam question must be dropped for this message. */
	forceNotSpam: boolean;
	/** False when the auto-draft trigger must be skipped (block). */
	autoDraft: boolean;
}


/**
 * The ingest decision for one message, derived purely from the stored policy.
 *
 * Unknown or absent values fall back to `none` (today's behaviour), so a
 * corrupt row can never drop a message or bypass classification unexpectedly.
 */
export function senderPolicyVerdict(policy: unknown): SenderPolicyDecision {
	if (policy === "block") {
		return {
			verdict: "block",
			folder: Folders.SPAM,
			classify: false,
			forceNotSpam: true,
			autoDraft: false,
		};
	}
	if (policy === "allow") {
		return {
			verdict: "allow",
			folder: null,
			classify: true,
			forceNotSpam: true,
			autoDraft: true,
		};
	}
	return {
		verdict: "none",
		folder: null,
		classify: true,
		forceNotSpam: false,
		autoDraft: true,
	};
}


/**
 * Copy of the categorization settings with the Jev spam question turned off.
 *
 * Used for `allow` senders (and harmless for `block`, which skips the
 * classifier anyway): categories are still classified, but the message can
 * never come back as spam.
 */
export function withoutSpamQuestion<T extends { spam: { enabled: boolean } }>(
	settings: T,
): T {
	return { ...settings, spam: { ...settings.spam, enabled: false } };
}
