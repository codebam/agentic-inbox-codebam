// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Deterministic per-mailbox rules engine.
 *
 * This module is pure: no I/O, no Cloudflare bindings, no Durable Object
 * access. It is shared by the Durable Object (CRUD + storage), the inbound
 * pipeline in workers/index.ts, and — for types only — the frontend editor,
 * so the stored shape, the API shape, and the UI shape cannot drift apart.
 *
 * Semantics (kept deliberately small and predictable):
 *   - Rules are evaluated in ascending `priority` order (0 first). Ties fall
 *     back to creation order, then id, so evaluation is always deterministic.
 *   - Match conditions are case-insensitive substring tests over the email's
 *     stored fields; `has_attachment` and `category_equals` are exact tests.
 *   - `match.mode` is "all" (every active condition must hold) or "any" (at
 *     least one active condition must hold). A rule with no active
 *     conditions never matches, so an accidentally empty rule cannot act on
 *     every incoming message.
 *   - Conflicting single-value actions resolve first-write-wins: the first
 *     (lowest priority number) matching rule to set a field owns it, and
 *     later rules may still fill in fields it left unset.
 *   - A matching `discard` action stops evaluation: the message is dropped
 *     and no later rule is consulted.
 */


/** Match modes understood by the engine. */
export const RULE_MATCH_MODES = ["all", "any"] as const;


export type RuleMatchMode = (typeof RULE_MATCH_MODES)[number];


/** Stored/UI bounds. Mirrored by the zod schemas in workers/lib/schemas.ts. */
export const MAX_RULE_NAME_LENGTH = 120;
export const MAX_RULE_CONDITION_LENGTH = 500;
export const MAX_RULE_PRIORITY = 10_000;


/**
 * Thrown when a rule cannot be stored as written (unknown folder, no usable
 * conditions, no actions). Routes translate it into a 400 response.
 */
export class RuleValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuleValidationError";
	}
}


/**
 * True for both locally-thrown and RPC-transported validation errors: DO RPC
 * may rebuild the error, so the class check is backed up by a name check.
 */
export function isRuleValidationError(error: unknown): boolean {
	return (
		error instanceof RuleValidationError ||
		(error instanceof Error && error.name === "RuleValidationError")
	);
}


/** Match conditions. Every field is optional; absent/empty means "inactive". */
export interface RuleConditions {
	/** Case-insensitive substring of the sender address (or display name). */
	from_contains?: string;
	/** Case-insensitive substring of any recipient (to/cc/bcc/envelope). */
	to_contains?: string;
	/** Case-insensitive substring of the subject. */
	subject_contains?: string;
	/** Case-insensitive substring of the body (HTML or text, as stored). */
	body_contains?: string;
	/** Exact test: the message carries at least one attachment. */
	has_attachment?: boolean;
	/** Case-insensitive equality against the email's category id. */
	category_equals?: string;
}


/** The `match` JSON column: condition set plus how to combine it. */
export interface RuleMatchSpec {
	mode: RuleMatchMode;
	conditions: RuleConditions;
}


/** Actions a rule may apply to a matching message. */
export interface RuleActions {
	/** Folder id to file the message in (validated against the folders table). */
	move_to_folder?: string;
	/** Category id to stamp on the message. */
	set_category?: string;
	mark_read?: boolean;
	mark_unread?: boolean;
	star?: boolean;
	unstar?: boolean;
	/** Drop the message entirely: it is never stored. */
	discard?: boolean;
}


/** A stored rule, as returned by the Durable Object and the API. */
export interface MailRule {
	id: string;
	name: string;
	enabled: boolean;
	priority: number;
	match: RuleMatchSpec;
	actions: RuleActions;
	created_at: string;
}


/** Wire shape accepted when creating a rule (id/created_at are server-side). */
export interface RuleDraft {
	name: string;
	enabled?: boolean;
	priority?: number;
	match: RuleMatchSpec;
	actions: RuleActions;
}


/** Wire shape accepted when updating a rule; every field is optional. */
export type RulePatch = Partial<RuleDraft>;


/**
 * The email view a rule matches against. Only the fields the engine needs —
 * callers pass parsed inbound mail, not a stored row.
 */
export interface RuleEmail {
	sender?: string | null;
	recipient?: string | null;
	envelope_recipient?: string | null;
	cc?: string | null;
	bcc?: string | null;
	subject?: string | null;
	body?: string | null;
	category?: string | null;
	has_attachment?: boolean;
}


/** The mutation a rule run asks the caller to apply to the stored row. */
export interface RuleEmailMutation {
	folder?: string;
	category?: string;
	read?: boolean;
	starred?: boolean;
}


export interface RuleRunResult {
	/** A matching rule asked for the message to be dropped. */
	discarded: boolean;
	/** At least one enabled rule matched with actions (classifier is skipped). */
	routed: boolean;
	/** Names of the matching rules, in evaluation order (for logging). */
	appliedRules: string[];
	/** Ids of the matching rules, in evaluation order. */
	appliedRuleIds: string[];
	/** Accumulated email mutation. */
	mutation: RuleEmailMutation;
}


const EMPTY_MUTATION: RuleEmailMutation = {};


/**
 * Result of "no rules were evaluated" — used by callers that must keep
 * delivering mail when rule loading fails, and as a test baseline.
 */
export function emptyRuleRunResult(): RuleRunResult {
	return {
		discarded: false,
		routed: false,
		appliedRules: [],
		appliedRuleIds: [],
		mutation: { ...EMPTY_MUTATION },
	};
}


/** Trim a condition value, dropping empty strings and enforcing the length cap. */
function normalizeConditionValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.slice(0, MAX_RULE_CONDITION_LENGTH);
}


/** Turn arbitrary JSON into a bounded condition set. */
export function normalizeRuleConditions(raw: unknown): RuleConditions {
	const value =
		raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const conditions: RuleConditions = {};

	const from = normalizeConditionValue(value.from_contains);
	if (from) conditions.from_contains = from;
	const to = normalizeConditionValue(value.to_contains);
	if (to) conditions.to_contains = to;
	const subject = normalizeConditionValue(value.subject_contains);
	if (subject) conditions.subject_contains = subject;
	const body = normalizeConditionValue(value.body_contains);
	if (body) conditions.body_contains = body;
	const category = normalizeConditionValue(value.category_equals);
	if (category) conditions.category_equals = category;
	if (typeof value.has_attachment === "boolean") {
		conditions.has_attachment = value.has_attachment;
	}

	return conditions;
}


/** Turn arbitrary JSON into a bounded match spec ("all" is the default mode). */
export function normalizeRuleMatch(raw: unknown): RuleMatchSpec {
	const value =
		raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const mode = RULE_MATCH_MODES.includes(value.mode as RuleMatchMode)
		? (value.mode as RuleMatchMode)
		: "all";
	return { mode, conditions: normalizeRuleConditions(value.conditions) };
}


/** Turn arbitrary JSON into a bounded action set. */
export function normalizeRuleActions(raw: unknown): RuleActions {
	const value =
		raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const actions: RuleActions = {};

	const folder = normalizeConditionValue(value.move_to_folder);
	if (folder) actions.move_to_folder = folder;
	const category = normalizeConditionValue(value.set_category);
	if (category) actions.set_category = category;
	if (typeof value.mark_read === "boolean") actions.mark_read = value.mark_read;
	if (typeof value.mark_unread === "boolean") {
		actions.mark_unread = value.mark_unread;
	}
	if (typeof value.star === "boolean") actions.star = value.star;
	if (typeof value.unstar === "boolean") actions.unstar = value.unstar;
	if (typeof value.discard === "boolean") actions.discard = value.discard;

	return actions;
}


/** True when at least one condition can actually be tested. */
export function hasActiveConditions(conditions: RuleConditions): boolean {
	return Object.keys(conditions).length > 0;
}


/**
 * True when at least one action would change something. Boolean flags only
 * count when set to `true`; a rule that merely sets `mark_read: false` does
 * nothing and is treated as action-less.
 */
export function hasActiveActions(actions: RuleActions): boolean {
	return (
		Boolean(actions.move_to_folder) ||
		Boolean(actions.set_category) ||
		actions.mark_read === true ||
		actions.mark_unread === true ||
		actions.star === true ||
		actions.unstar === true ||
		actions.discard === true
	);
}


/** Case-insensitive substring test; an empty needle never matches. */
function contains(haystack: string | null | undefined, needle: string): boolean {
	if (!needle) return false;
	if (typeof haystack !== "string") return false;
	return haystack.toLowerCase().includes(needle.toLowerCase());
}


/**
 * Evaluate one rule's conditions against an email.
 *
 * Disabled rules never match (the runner filters them out as well, so the
 * predicate is safe to use on its own).
 */
export function matchRule(rule: MailRule, email: RuleEmail): boolean {
	if (!rule.enabled) return false;

	const { mode, conditions } = rule.match ?? { mode: "all", conditions: {} };
	if (!hasActiveConditions(conditions)) return false;

	const tests: boolean[] = [];

	if (conditions.from_contains) {
		tests.push(contains(email.sender, conditions.from_contains));
	}
	if (conditions.to_contains) {
		tests.push(
			contains(email.recipient, conditions.to_contains) ||
				contains(email.envelope_recipient, conditions.to_contains) ||
				contains(email.cc, conditions.to_contains) ||
				contains(email.bcc, conditions.to_contains),
		);
	}
	if (conditions.subject_contains) {
		tests.push(contains(email.subject, conditions.subject_contains));
	}
	if (conditions.body_contains) {
		tests.push(contains(email.body, conditions.body_contains));
	}
	if (conditions.has_attachment !== undefined) {
		tests.push(Boolean(email.has_attachment) === conditions.has_attachment);
	}
	if (conditions.category_equals) {
		tests.push(
			typeof email.category === "string" &&
				email.category.trim().toLowerCase() ===
					conditions.category_equals.toLowerCase(),
		);
	}

	if (tests.length === 0) return false;
	return mode === "any" ? tests.some(Boolean) : tests.every(Boolean);
}


/**
 * Apply every enabled rule that matches, in priority order, and return the
 * accumulated mutation plus the names of the rules that fired.
 *
 * Evaluation stops at the first matching `discard` action: the message is
 * dropped, so nothing later in the list could matter.
 */
export function runRules(
	rules: readonly MailRule[],
	email: RuleEmail,
): RuleRunResult {
	const ordered = rules
		.filter((rule) => rule.enabled)
		.sort(
			(a, b) =>
				a.priority - b.priority ||
				a.created_at.localeCompare(b.created_at) ||
				a.id.localeCompare(b.id),
		);

	const mutation: RuleEmailMutation = { ...EMPTY_MUTATION };
	const appliedRules: string[] = [];
	const appliedRuleIds: string[] = [];
	let discarded = false;

	for (const rule of ordered) {
		if (!matchRule(rule, email)) continue;

		appliedRules.push(rule.name);
		appliedRuleIds.push(rule.id);

		const actions = rule.actions ?? {};

		// First write wins: the lowest priority number that sets a field owns it.
		if (actions.move_to_folder && mutation.folder === undefined) {
			mutation.folder = actions.move_to_folder;
		}
		if (actions.set_category && mutation.category === undefined) {
			mutation.category = actions.set_category;
		}
		if (typeof actions.mark_read === "boolean" && mutation.read === undefined) {
			mutation.read = actions.mark_read;
		}
		if (
			typeof actions.mark_unread === "boolean" &&
			mutation.read === undefined
		) {
			mutation.read = !actions.mark_unread;
		}
		if (typeof actions.star === "boolean" && mutation.starred === undefined) {
			mutation.starred = actions.star;
		}
		if (
			typeof actions.unstar === "boolean" &&
			mutation.starred === undefined
		) {
			mutation.starred = !actions.unstar;
		}

		if (actions.discard === true) {
			discarded = true;
			break;
		}
	}

	return {
		discarded,
		routed: !discarded && appliedRules.length > 0,
		appliedRules,
		appliedRuleIds,
		mutation,
	};
}
