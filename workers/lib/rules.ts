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
 *   - Outbound actions (`forward_to`, `auto_reply_text`) are collected, not
 *     executed: `runRules` stays pure and reports them in `outbound`, and the
 *     inbound pipeline decides whether to send (spam, discard, and the
 *     auto-reply loop guards live in workers/lib/rule-outbound.ts). Forward
 *     targets are de-duplicated case-insensitively, and only the first
 *     matching rule's auto-reply is kept — one auto-reply per message.
 */


/** Match modes understood by the engine. */
export const RULE_MATCH_MODES = ["all", "any"] as const;


export type RuleMatchMode = (typeof RULE_MATCH_MODES)[number];


/** Stored/UI bounds. Mirrored by the zod schemas in workers/lib/schemas.ts. */
export const MAX_RULE_NAME_LENGTH = 120;
export const MAX_RULE_CONDITION_LENGTH = 500;
export const MAX_RULE_PRIORITY = 10_000;
/** Cap for `auto_reply_text`; long enough for a real note, bounded on purpose. */
export const MAX_RULE_AUTO_REPLY_LENGTH = 2000;
/** Cap for a `forward_to` address (RFC 5321 practical maximum). */
export const MAX_RULE_ADDRESS_LENGTH = 320;


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
	if (error instanceof RuleValidationError) return true;
	if (!(error instanceof Error)) return false;
	if (error.name === "RuleValidationError") return true;
	// Durable Object RPC rebuilds thrown errors, so the class identity is lost
	// and the name survives only as the message prefix.
	return error.message.startsWith("RuleValidationError");
}


/**
 * Resolve a rule action's folder reference to a canonical folder id.
 *
 * Accepts a folder id or display name, case-insensitively — the same rule the
 * Durable Object applies when storing the action. Returns null when the folder
 * does not exist, so callers can reject the rule at the edge instead of letting
 * a remote DO error surface as a 500.
 */
export function resolveRuleFolderId(
	folder: string,
	folders: { id: string; name: string }[],
): string | null {
	const needle = folder.trim().toLowerCase();
	if (!needle) return null;
	for (const option of folders) {
		if (
			option.id.toLowerCase() === needle ||
			option.name.toLowerCase() === needle
		) {
			return option.id;
		}
	}
	return null;
}


/** Match conditions. Every field is optional; absent/empty means "inactive". */
export interface RuleConditions {
	/** Case-insensitive substring of the sender address (or display name). */
	from_contains?: string | undefined;
	/** Case-insensitive substring of any recipient (to/cc/bcc/envelope). */
	to_contains?: string | undefined;
	/** Case-insensitive substring of the subject. */
	subject_contains?: string | undefined;
	/** Case-insensitive substring of the body (HTML or text, as stored). */
	body_contains?: string | undefined;
	/** Exact test: the message carries at least one attachment. */
	has_attachment?: boolean | undefined;
	/** Case-insensitive equality against the email's category id. */
	category_equals?: string | undefined;
}


/** The `match` JSON column: condition set plus how to combine it. */
export interface RuleMatchSpec {
	mode: RuleMatchMode;
	conditions: RuleConditions;
}


/** Actions a rule may apply to a matching message. */
export interface RuleActions {
	/** Folder id to file the message in (validated against the folders table). */
	move_to_folder?: string | undefined;
	/** Category id to stamp on the message. */
	set_category?: string | undefined;
	mark_read?: boolean | undefined;
	mark_unread?: boolean | undefined;
	star?: boolean | undefined;
	unstar?: boolean | undefined;
	/** Drop the message entirely: it is never stored. */
	discard?: boolean | undefined;
	/**
	 * Forward the message to this single address. Outbound: the inbound
	 * pipeline sends it after the message is stored, never for spam or for a
	 * discarded message. Operator-only — the agent/MCP tool paths strip it.
	 */
	forward_to?: string | undefined;
	/**
	 * Auto-reply body sent to the original sender. Outbound, and subject to
	 * the loop guards in workers/lib/rule-outbound.ts (Auto-Submitted /
	 * List-Id / bulk precedence headers, self-sent mail, and one auto-reply
	 * per sender per day). Operator-only — the agent/MCP tool paths strip it.
	 */
	auto_reply_text?: string | undefined;
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
	/** Times the rule acted on an inbound message (absent = never fired). */
	fired_count?: number;
	/** ISO timestamp of the last firing, or null when it never fired. */
	last_fired_at?: string | null;
}


/** Wire shape accepted when creating a rule (id/created_at are server-side). */
export interface RuleDraft {
	name: string;
	enabled?: boolean | undefined;
	priority?: number | undefined;
	match: RuleMatchSpec;
	actions: RuleActions;
}


/**
 * Wire shape accepted when updating a rule; every field is optional and may be
 * explicitly `undefined` (the partial schemas emit every key).
 */
export type RulePatch = {
	[K in keyof RuleDraft]?: RuleDraft[K] | undefined;
};




/** Dry-run bounds: how many recent messages a preview scans and returns. */
export const RULE_PREVIEW_SCAN_LIMIT = 2000;
export const RULE_PREVIEW_MAX_MATCHES = 200;




/** One matching message in a preview result. */
export interface RulePreviewMatch {
	id: string;
	subject: string;
	sender: string;
	date: string;
	folder_id: string;
}




/**
 * Dry-run result for a rule draft: how many stored messages it matches, plus
 * the first `limit` summaries. `total` counts matches among the `scanned`
 * most recent messages; a preview never writes anything.
 */
export interface RulePreviewResult {
	total: number;
	scanned: number;
	scan_limit: number;
	limit: number;
	matches: RulePreviewMatch[];
}




/**
 * Wire shape accepted by the preview endpoint: only the conditions matter, so
 * `name` is optional and `actions` are ignored (they are validated for folder
 * targets by the route, never executed).
 */
export interface RulePreviewDraft {
	name?: string | undefined;
	match: RuleMatchSpec;
}


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
	/** Outbound work (forward / auto-reply) the caller may perform. */
	outbound: RuleOutboundAction[];
}




/**
 * One outbound action a matching rule asked for. `runRules` only reports it;
 * the inbound pipeline performs the send after its spam and loop guards.
 */
export interface RuleOutboundAction {
	kind: "forward" | "auto_reply";
	rule_id: string;
	rule_name: string;
	/** Recipient address (forward only). */
	to?: string;
	/** Auto-reply body (auto_reply only). */
	text?: string;
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
		outbound: [],
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

	const from = normalizeConditionValue(value["from_contains"]);
	if (from) conditions.from_contains = from;
	const to = normalizeConditionValue(value["to_contains"]);
	if (to) conditions.to_contains = to;
	const subject = normalizeConditionValue(value["subject_contains"]);
	if (subject) conditions.subject_contains = subject;
	const body = normalizeConditionValue(value["body_contains"]);
	if (body) conditions.body_contains = body;
	const category = normalizeConditionValue(value["category_equals"]);
	if (category) conditions.category_equals = category;
	if (typeof value["has_attachment"] === "boolean") {
		conditions.has_attachment = value["has_attachment"];
	}

	return conditions;
}


/** Turn arbitrary JSON into a bounded match spec ("all" is the default mode). */
export function normalizeRuleMatch(raw: unknown): RuleMatchSpec {
	const value =
		raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const mode = RULE_MATCH_MODES.includes(value["mode"] as RuleMatchMode)
		? (value["mode"] as RuleMatchMode)
		: "all";
	return { mode, conditions: normalizeRuleConditions(value["conditions"]) };
}


/**
 * Trim auto-reply text, dropping empty strings and enforcing the length cap.
 * Unlike condition values this keeps internal newlines — it is message body
 * text, not a needle.
 */
function normalizeAutoReplyText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.slice(0, MAX_RULE_AUTO_REPLY_LENGTH);
}




/** Turn arbitrary JSON into a bounded action set. */
export function normalizeRuleActions(raw: unknown): RuleActions {
	const value =
		raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const actions: RuleActions = {};

	const folder = normalizeConditionValue(value["move_to_folder"]);
	if (folder) actions.move_to_folder = folder;
	const category = normalizeConditionValue(value["set_category"]);
	if (category) actions.set_category = category;
	if (typeof value["mark_read"] === "boolean") actions.mark_read = value["mark_read"];
	if (typeof value["mark_unread"] === "boolean") {
		actions.mark_unread = value["mark_unread"];
	}
	if (typeof value["star"] === "boolean") actions.star = value["star"];
	if (typeof value["unstar"] === "boolean") actions.unstar = value["unstar"];
	if (typeof value["discard"] === "boolean") actions.discard = value["discard"];
	const forwardTo = normalizeConditionValue(value["forward_to"]);
	if (forwardTo) {
		actions.forward_to = forwardTo.slice(0, MAX_RULE_ADDRESS_LENGTH);
	}
	const autoReply = normalizeAutoReplyText(value["auto_reply_text"]);
	if (autoReply) actions.auto_reply_text = autoReply;


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
		actions.discard === true ||
		Boolean(actions.forward_to) ||
		Boolean(actions.auto_reply_text)
	);
}




/**
 * True when the action set would send mail from this mailbox (`forward_to`,
 * `auto_reply_text`). The inbound pipeline owns execution; agent/MCP tooling
 * must never store or enable such a rule.
 */
export function hasOutboundActions(actions: RuleActions): boolean {
	return Boolean(actions.forward_to) || Boolean(actions.auto_reply_text);
}




/**
 * Copy of the action set with the outbound actions removed. The agent/MCP
 * tool paths run every inbound draft through this so a rule they create can
 * only ever shape mail, never send it.
 */
export function stripOutboundActions(actions: RuleActions): RuleActions {
	const { forward_to: _forwardTo, auto_reply_text: _autoReplyText, ...rest } =
		actions;
	return rest;
}




/**
 * Reject outbound actions outright (agent/MCP tooling). Throws
 * RuleValidationError so the caller can surface a refusal the model can read.
 */
export function forbidOutboundActions(actions: RuleActions): void {
	if (actions.forward_to) {
		throw new RuleValidationError(
			"forward_to is operator-only: rules created through the agent or MCP tools cannot send mail",
		);
	}
	if (actions.auto_reply_text) {
		throw new RuleValidationError(
			"auto_reply_text is operator-only: rules created through the agent or MCP tools cannot send mail",
		);
	}
}




/**
 * Loose single-address test, applied before any outbound send and when a
 * stored rule is validated. Deliberately strict: one bare address, no display
 * name, no list, no whitespace.
 */
export function isRuleEmailAddress(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > MAX_RULE_ADDRESS_LENGTH) return false;
	return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(trimmed);
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
	const outbound: RuleOutboundAction[] = [];
	const forwardTargets = new Set<string>();
	let autoReplyTaken = false;

	for (const rule of ordered) {
		if (!matchRule(rule, email)) continue;

		appliedRules.push(rule.name);
		appliedRuleIds.push(rule.id);

		const actions = rule.actions ?? {};

		// Outbound actions are reported, never executed here: the inbound
		// pipeline sends them after its own spam/discard/loop guards. Forward
		// targets are de-duplicated case-insensitively; only the first
		// matching rule's auto-reply is kept.
		if (actions.forward_to && isRuleEmailAddress(actions.forward_to)) {
			const target = actions.forward_to.trim();
			const key = target.toLowerCase();
			if (!forwardTargets.has(key)) {
				forwardTargets.add(key);
				outbound.push({
					kind: "forward",
					rule_id: rule.id,
					rule_name: rule.name,
					to: target,
				});
			}
		}
		if (actions.auto_reply_text && !autoReplyTaken) {
			autoReplyTaken = true;
			outbound.push({
				kind: "auto_reply",
				rule_id: rule.id,
				rule_name: rule.name,
				text: actions.auto_reply_text,
			});
		}

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
		outbound,
	};
}
