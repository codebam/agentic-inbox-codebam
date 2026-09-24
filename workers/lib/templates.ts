// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-mailbox message templates (snippets).
 *
 * A template is operator-authored content: a name, an optional subject and a
 * body the composer inserts into a draft (and that a future parameterized
 * send could be built from). This module is pure — no I/O, no bindings, no
 * Durable Object access — so it is shared by the Durable Object (storage
 * CRUD), the routes in workers/index.ts (validation) and — for types only —
 * the frontend, the same way workers/lib/sender-policy.ts is shared.
 *
 * Guardrails:
 * - Every stored value is bounded. A name is 1..MAX_TEMPLATE_NAME_LENGTH
 *   characters, a subject at most MAX_TEMPLATE_SUBJECT_LENGTH, a body
 *   1..MAX_TEMPLATE_BODY_LENGTH, and one mailbox holds at most
 *   MAX_TEMPLATES rows (enforced by MailboxDO.createTemplate).
 * - Out-of-bounds values are REJECTED, never silently clipped: a truncated
 *   body would read as a template that lost its ending, with nothing on
 *   screen to say so.
 * - Templates never send mail. The agent/MCP surfaces get one read-only
 *   tool (list_templates) and no write path: only the operator authors,
 *   edits or deletes a template.
 */

/** Longest template name stored (and accepted). */
export const MAX_TEMPLATE_NAME_LENGTH = 120;

/** Longest template subject stored (and accepted). */
export const MAX_TEMPLATE_SUBJECT_LENGTH = 500;

/** Longest template body stored (and accepted), in characters of HTML. */
export const MAX_TEMPLATE_BODY_LENGTH = 100_000;

/** Most templates one mailbox can hold; createTemplate refuses beyond it. */
export const MAX_TEMPLATES = 200;

/** One stored template row. */
export interface Template {
	id: string;
	/** Trimmed, 1..MAX_TEMPLATE_NAME_LENGTH characters. */
	name: string;
	/** Trimmed subject line, or null when the template sets none. */
	subject: string | null;
	/** HTML body; never empty, bounded to MAX_TEMPLATE_BODY_LENGTH. */
	body: string;
	created_at: string;
	updated_at: string;
}

/**
 * A new template as the API accepts it, before normalization. `subject` is
 * optional and may be explicitly `undefined` (the wire schemas emit every
 * key); it is stored as null when omitted or blank.
 */
export interface TemplateInput {
	name: string;
	subject?: string | null | undefined;
	body: string;
}

/**
 * A partial change to one stored template. Omitted fields keep their stored
 * value; an explicit `null` (or blank string) subject clears it. Every field
 * may be explicitly `undefined` — the partial schema emits every key.
 */
export interface TemplatePatch {
	name?: string | undefined;
	subject?: string | null | undefined;
	body?: string | undefined;
}

/**
 * Thrown when a template write cannot be stored as written (missing name,
 * blank or oversized body, oversized subject, mailbox at its cap). Routes
 * translate it into a 400 response.
 */
export class TemplateValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TemplateValidationError";
	}
}

/**
 * True for both locally-thrown and RPC-transported validation errors: DO RPC
 * may rebuild the error, so the class check is backed up by a name check.
 */
export function isTemplateValidationError(error: unknown): boolean {
	if (error instanceof TemplateValidationError) return true;
	if (!(error instanceof Error)) return false;
	if (error.name === "TemplateValidationError") return true;
	// Durable Object RPC rebuilds thrown errors, so the class identity is lost
	// and the name survives only as the message prefix.
	return error.message.startsWith("TemplateValidationError");
}

/** Canonical stored name: trimmed, required, bounded. */
export function normalizeTemplateName(value: unknown): string {
	const name = typeof value === "string" ? value.trim() : "";
	if (!name) {
		throw new TemplateValidationError("A template name is required");
	}
	if (name.length > MAX_TEMPLATE_NAME_LENGTH) {
		throw new TemplateValidationError(
			`A template name can be at most ${MAX_TEMPLATE_NAME_LENGTH} characters`,
		);
	}
	return name;
}

/**
 * Canonical stored subject: trimmed and bounded, or null when absent or
 * blank. A template may legitimately carry only a body, so no subject is
 * not an error.
 */
export function normalizeTemplateSubject(value: unknown): string | null {
	if (value == null) return null;
	if (typeof value !== "string") {
		throw new TemplateValidationError("A template subject must be a string");
	}
	const subject = value.trim();
	if (!subject) return null;
	if (subject.length > MAX_TEMPLATE_SUBJECT_LENGTH) {
		throw new TemplateValidationError(
			`A template subject can be at most ${MAX_TEMPLATE_SUBJECT_LENGTH} characters`,
		);
	}
	return subject;
}

/** Canonical stored body: trimmed, required, bounded. */
export function normalizeTemplateBody(value: unknown): string {
	const body = typeof value === "string" ? value.trim() : "";
	if (!body) {
		throw new TemplateValidationError("A template body is required");
	}
	if (body.length > MAX_TEMPLATE_BODY_LENGTH) {
		throw new TemplateValidationError(
			`A template body can be at most ${MAX_TEMPLATE_BODY_LENGTH} characters`,
		);
	}
	return body;
}
