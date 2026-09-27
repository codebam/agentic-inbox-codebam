// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-mailbox labels (mailbox-wide tags).
 *
 * A label is an operator- or agent-applied tag: a name (unique per mailbox,
 * case-insensitively) and an optional color. Labels attach to messages
 * through the email_labels join table (migration 34_add_labels), many per
 * message and many messages per label; unlike the AI-assigned `category`
 * column, a label is only ever set by an explicit user or agent action.
 *
 * This module is pure — no I/O, no bindings, no Durable Object access — so
 * it is shared by the Durable Object (storage CRUD), the routes in
 * workers/index.ts (validation) and — for types only — the frontend, the
 * same way workers/lib/templates.ts is shared.
 *
 * Guardrails:
 * - Every stored value is bounded. A name is 1..MAX_LABEL_NAME_LENGTH
 *   characters after trimming, a color at most MAX_LABEL_COLOR_LENGTH, and
 *   one mailbox holds at most MAX_LABELS labels (enforced by
 *   MailboxDO.createLabel). Out-of-bounds values are REJECTED, never
 *   silently clipped.
 * - Names are unique per mailbox, case-insensitively: "Receipts" and
 *   "receipts" cannot coexist.
 * - Labels never send mail and never delete it; removing a label only
 *   drops its assignments.
 */

/** Longest label name stored (and accepted), after trimming. */
export const MAX_LABEL_NAME_LENGTH = 50;

/** Longest label color stored (and accepted); the UI decides the format. */
export const MAX_LABEL_COLOR_LENGTH = 32;

/** Most labels one mailbox can hold; createLabel refuses beyond it. */
export const MAX_LABELS = 100;

/** One stored label row. */
export interface Label {
	id: string;
	/** Trimmed, 1..MAX_LABEL_NAME_LENGTH characters; unique per mailbox, case-insensitively. */
	name: string;
	/** Trimmed color token (e.g. "#f59e0b"), or null when the label sets none. */
	color: string | null;
	created_at: string;
}

/**
 * A new label as the API accepts it, before normalization. Fields are typed
 * `unknown` on purpose: the normalizers below are the validators, so a route
 * can hand over a parsed JSON body without pre-checking its shape.
 */
export interface LabelInput {
	name?: unknown;
	color?: unknown;
}

/**
 * A partial change to one stored label. Omitted fields keep their stored
 * value; an explicit `null` (or a blank string) color clears it.
 */
export interface LabelPatch {
	name?: unknown;
	color?: unknown;
}

/**
 * Thrown when a label write cannot be stored as written (missing or
 * oversized name, duplicate name, oversized color, mailbox at its cap).
 * Routes translate it into a 400 response.
 */
export class LabelValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LabelValidationError";
	}
}

/**
 * True for both locally-thrown and RPC-transported validation errors: DO RPC
 * may rebuild the error, so the class check is backed up by a name check.
 */
export function isLabelValidationError(error: unknown): boolean {
	if (error instanceof LabelValidationError) return true;
	if (!(error instanceof Error)) return false;
	if (error.name === "LabelValidationError") return true;
	// Durable Object RPC rebuilds thrown errors, so the class identity is lost
	// and the name survives only as the message prefix.
	return error.message.startsWith("LabelValidationError");
}

/** Canonical stored name: trimmed, required, bounded. */
export function normalizeLabelName(value: unknown): string {
	const name = typeof value === "string" ? value.trim() : "";
	if (!name) {
		throw new LabelValidationError("A label name is required");
	}
	if (name.length > MAX_LABEL_NAME_LENGTH) {
		throw new LabelValidationError(
			`A label name can be at most ${MAX_LABEL_NAME_LENGTH} characters`,
		);
	}
	return name;
}

/**
 * Canonical stored color: trimmed and bounded, or null when absent or
 * blank. The format is the client's choice (the UI renders the token
 * straight into CSS); only the length is bounded here.
 */
export function normalizeLabelColor(value: unknown): string | null {
	if (value == null) return null;
	if (typeof value !== "string") {
		throw new LabelValidationError("A label color must be a string");
	}
	const color = value.trim();
	if (!color) return null;
	if (color.length > MAX_LABEL_COLOR_LENGTH) {
		throw new LabelValidationError(
			`A label color can be at most ${MAX_LABEL_COLOR_LENGTH} characters`,
		);
	}
	return color;
}
