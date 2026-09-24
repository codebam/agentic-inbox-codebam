// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Task / deadline extraction from inbound mail.
 *
 * One AI call per non-spam message (workers/index.ts schedules it off the
 * receive path with ctx.waitUntil) turns a message into at most five concrete
 * items; the mailbox's Durable Object stores them and the Tasks page, the
 * message panel and the read-only list_items tool read them back.
 *
 * Everything here is best-effort by design: a message whose extraction fails
 * is still delivered, nothing throws, and a mailbox with the switch off pays
 * neither the AI call nor a DO read.
 *
 * The stored row columns are frozen (workers/db/schema.ts mirrors them):
 * id, email_id, thread_id, kind (task | deadline), title, details, due_at,
 * status (open | done | dismissed), created_at, updated_at.
 */


import { DEFAULT_MODELS } from "../../shared/models";
import {
	isItemDueFilter,
	isItemKind,
	isItemStatus,
	normalizeItemsSettings,
	type ItemDueFilter,
	type ItemKind,
	type ItemStatus,
} from "../../shared/items";
import { readMailboxSettings, resolveMailboxModels } from "./mailbox-settings";
import { stripHtmlToText } from "./email-helpers";
import type { Env } from "../types";


// ── Frozen row + request shapes ────────────────────────────────────

/** One stored item, as MailboxDO returns it and the routes expose it. */
export interface ExtractedItem {
	id: string;
	email_id: string;
	thread_id: string | null;
	kind: ItemKind;
	title: string;
	details: string | null;
	/** ISO 8601 UTC instant the message states, or null when it states none. */
	due_at: string | null;
	status: ItemStatus;
	created_at: string;
	updated_at: string;
}

/** The parsed content of one item, before the Durable Object stamps ids. */
export interface ExtractedItemInput {
	kind: ItemKind;
	title: string;
	details: string | null;
	due_at: string | null;
}

/** Filters for MailboxDO.listItems (every field optional). */
export interface ItemListFilters {
	status?: ItemStatus | undefined;
	due?: ItemDueFilter | undefined;
	limit?: number | undefined;
	page?: number | undefined;
}

/** One page of items plus the total matching the filters. */
export interface ItemListPage {
	items: ExtractedItem[];
	totalCount: number;
}

/** Items one message may contribute; also the parse cap. */
export const MAX_EXTRACTED_ITEMS_PER_EMAIL = 5;

/** Longest stored title, in characters. */
export const MAX_ITEM_TITLE_LENGTH = 200;

/** Longest stored details, in characters. */
export const MAX_ITEM_DETAILS_LENGTH = 1000;

/** Plain-text characters of sender + subject + body sent to the model. */
export const MAX_ITEM_INPUT_CHARS = 6000;

/** How far from now a stated due date may sit before it is dropped (~2 years). */
export const ITEM_DUE_HORIZON_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/** Rows per page when the caller does not ask for a size. */
export const ITEM_LIST_LIMIT_DEFAULT = 50;

/**
 * Hard cap on one page. The Tasks page groups by due bucket rather than
 * paging through a long history, so a bigger page would not be shown.
 */
export const ITEM_LIST_LIMIT_MAX = 50;

/** Closed rows a mailbox may hold before the DO prunes the oldest. */
export const MAX_EXTRACTED_ITEMS = 2000;

/** Re-exported so callers can narrow wire values without another import. */
export { isItemDueFilter, isItemKind, isItemStatus };
export type { ItemDueFilter, ItemKind, ItemStatus };


// ── Parsing ────────────────────────────────────────────────────────

/**
 * The one system prompt the extractor sends. It asks for JSON only, a hard
 * cap of five items, and forbids invented dates — a wrong deadline is worse
 * than a missing one, because the UI offers a reminder on every due date.
 */
const EXTRACTOR_PROMPT = `You extract concrete tasks and deadlines from one email.

Return ONLY a JSON object of the form:
{"items":[{"kind":"task|deadline","title":"...","details":"...","due_at":"ISO 8601 or null"}]}

Rules:
- At most 5 items, most important first.
- Extract only actions the message asks for or deadlines it states or clearly implies. Return {"items":[]} when there is nothing to do and nothing is due.
- Never invent a deadline: due_at is null unless the message names or implies a date.
- kind is "deadline" when the message states or implies when something is due, otherwise "task".
- title is a short imperative summary. details carries the supporting context (who, what, reference numbers).
- due_at is an ISO 8601 timestamp when the message says when something is due, otherwise null. Never guess a time of day the message does not state.`;

/**
 * Unwrap the JSON object from whatever the model wrapped it in: a markdown
 * code fence, a one-line preamble, or both. Anything else is returned as-is
 * so JSON.parse can reject it.
 */
function unwrapJson(raw: string): string {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return "";
	const fenced = trimmed.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)```\s*$/);
	const inner = (fenced?.[1] ?? trimmed).trim();
	const start = inner.indexOf("{");
	const end = inner.lastIndexOf("}");
	if (start >= 0 && end > start) return inner.slice(start, end + 1);
	return inner;
}

/**
 * A stated due date, normalized to an ISO 8601 UTC string, or null when it
 * cannot be trusted: not a string, not parseable, or further than
 * ITEM_DUE_HORIZON_MS from now in either direction. Dates in the past are
 * kept — they are what "overdue" means — but a date years off is drift or a
 * hallucination, so it is dropped rather than shown as a deadline.
 */
function normalizeDueAt(value: unknown, now: number): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const parsed = Date.parse(trimmed);
	if (!Number.isFinite(parsed)) return null;
	if (Math.abs(parsed - now) > ITEM_DUE_HORIZON_MS) return null;
	return new Date(parsed).toISOString();
}

/** Trimmed, bounded text, or null when the value carries nothing. */
function clampText(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.slice(0, max);
}

/**
 * Turn the model's raw answer into storable items. Fully defensive — this
 * parses an untrusted model into rows, so it never throws and drops every
 * entry it cannot use: a wrong shape, a missing title, or a due date the
 * horizon rejects. Returns [] for anything it cannot read as
 * `{ items: [...] }`, and at most MAX_EXTRACTED_ITEMS_PER_EMAIL items.
 */
export function parseExtractedItems(raw: string): ExtractedItemInput[] {
	try {
		const unwrapped = unwrapJson(raw);
		if (!unwrapped) return [];
		const parsed: unknown = JSON.parse(unwrapped);
		if (!parsed || typeof parsed !== "object") return [];
		const entries = (parsed as { items?: unknown }).items;
		if (!Array.isArray(entries)) return [];

		const now = Date.now();
		const items: ExtractedItemInput[] = [];
		for (const entry of entries) {
			if (items.length >= MAX_EXTRACTED_ITEMS_PER_EMAIL) break;
			if (!entry || typeof entry !== "object") continue;
			const record = entry as Record<string, unknown>;
			const title = clampText(record["title"], MAX_ITEM_TITLE_LENGTH);
			if (!title) continue;
			items.push({
				kind: isItemKind(record["kind"]) ? record["kind"] : "task",
				title,
				details: clampText(record["details"], MAX_ITEM_DETAILS_LENGTH),
				due_at: normalizeDueAt(record["due_at"], now),
			});
		}
		return items;
	} catch {
		return [];
	}
}


// ── Extraction ─────────────────────────────────────────────────────

/**
 * The user message: who sent it, the subject and the plain-text body, clipped
 * to MAX_ITEM_INPUT_CHARS. Sender and subject go first (they are short, and
 * "Re: invoice due Friday" often carries the whole deadline) and the body is
 * what the clip mostly trims.
 */
function buildExtractorInput(input: {
	subject: string;
	sender: string;
	body: string;
}): string {
	const sender = (input.sender ?? "").trim();
	const subject = (input.subject ?? "").trim();
	const body = stripHtmlToText(input.body ?? "").trim();
	const header = [
		sender ? `From: ${sender}` : "",
		subject ? `Subject: ${subject}` : "",
	]
		.filter(Boolean)
		.join("\n");
	if (!header && !body) return "";
	const content = header && body ? `${header}\n\n${body}` : header || body;
	return content.slice(0, MAX_ITEM_INPUT_CHARS);
}

/**
 * Ask the model for this message's tasks and deadlines. Modelled on
 * isPromptInjection (workers/lib/ai.ts): one system prompt, temperature 0,
 * a small token budget, and a failure that logs and answers [] instead of
 * propagating — extraction must never affect delivery.
 */
export async function extractItems(
	ai: Ai,
	input: { subject: string; sender: string; body: string },
	model: string = DEFAULT_MODELS.extractor,
): Promise<ExtractedItemInput[]> {
	const content = buildExtractorInput(input);
	if (!content) return [];

	try {
		const response = (await ai.run(
			model,
			{
				messages: [
					{ role: "system", content: EXTRACTOR_PROMPT },
					{ role: "user", content },
				],
				max_tokens: 512,
				temperature: 0,
			},
		)) as { response?: string };

		return parseExtractedItems(response?.response ?? "");
	} catch (e) {
		console.error("Item extraction failed, skipping items:", (e as Error).message);
		return [];
	}
}


// ── Off the receive path ───────────────────────────────────────────

/**
 * Extract this message's items and store them, off the receive path.
 *
 * Best-effort wrapper: it never throws, and it returns the number of items
 * stored (0 when it skipped or found nothing) purely so tests and logs can
 * tell the cases apart. Skips, in order:
 *   - the mailbox's `items.enabled` switch is off (settings.mailbox only —
 *     the switch is per mailbox, never inherited);
 *   - the message already has items (a redelivery or retry must not double
 *     the list), checked through the Durable Object;
 *   - the extraction found nothing.
 *
 * `settings` lets the caller pass the mailbox settings it already read on
 * the receive path; without them this reads the settings JSON itself.
 */
export async function insertExtractedItems(
	env: Env,
	mailboxId: string,
	input: {
		emailId: string;
		threadId?: string | null;
		subject: string;
		sender: string;
		body: string;
	},
	settings?: Record<string, unknown>,
): Promise<number> {
	try {
		const mailboxSettings = settings ?? (await readMailboxSettings(env, mailboxId));
		if (!normalizeItemsSettings(mailboxSettings["items"]).enabled) return 0;

		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
		const existing = await stub.listItemsForEmail(input.emailId);
		if (existing.length > 0) return 0;

		const models = await resolveMailboxModels(env, mailboxId, mailboxSettings);
		const items = await extractItems(
			env.AI,
			{
				subject: input.subject,
				sender: input.sender,
				body: input.body,
			},
			models.extractor,
		);
		if (items.length === 0) return 0;

		const stored = await stub.insertItems(
			input.emailId,
			input.threadId ?? null,
			items,
		);
		return stored.length;
	} catch (e) {
		console.error(
			"Item extraction failed, skipping items:",
			(e as Error).message,
		);
		return 0;
	}
}
