// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Semantic (vector) search over a mailbox's stored mail.
 *
 * One seam owns the two binding calls the feature makes — embed text through
 * the Workers AI binding, and upsert/query vectors through the Vectorize
 * index — so tests can pass fakes: the vitest pool cannot run Workers AI
 * ("Binding AI needs to be run remotely") and has no Vectorize binding, and
 * no live call may run there.
 *
 * The bindings are resolved through a guarded optional lookup. `VECTORIZE` is
 * deliberately NOT declared in wrangler.jsonc yet (a declared binding for a
 * nonexistent index fails `wrangler deploy`), so every entry point answers
 * SEMANTIC_NOT_CONFIGURED and does nothing else when either binding is
 * absent.
 *
 * Bookkeeping lives in the mailbox's Durable Object (migration
 * 31_add_message_embeddings): one row per embedded message with the model id
 * and a content hash, so a reindex can list what is missing and count
 * progress without touching the index. Ingest embeds best-effort off the
 * receive path (receiveEmail); the reindex route embeds one bounded batch
 * per call so a caller can loop until nothing remains — the same idempotent
 * shape as the retroactive rule apply.
 *
 * Everything here is read-only with respect to mail: no message body is
 * rewritten, nothing is sent, and the only writes are the embedding
 * bookkeeping row and the index itself.
 */


import {
	normalizeSemanticSearchSettings,
	SEMANTIC_NOT_CONFIGURED,
	SEMANTIC_REINDEX_BATCH_MAX,
	SEMANTIC_SEARCH_LIMIT_MAX,
} from "../../shared/semantic";
import type { MailboxDO } from "../durableObject";
import type { Env } from "../types";
import { getMailboxStub, stripHtmlToText } from "./email-helpers";
import { readMailboxSettings } from "./mailbox-settings";


/**
 * The embedding model. The Vectorize index must be created for this model's
 * 768 dimensions. The id is stored with every bookkeeping row so a future
 * re-embed can tell which rows were made with an older model.
 */
export const SEMANTIC_EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

/** Plain-text characters of one message (or query) sent to the model. */
export const MAX_EMBEDDING_SOURCE_CHARS = 6000;

/** Characters of the message body kept as a search result snippet. */
export const SEMANTIC_SNIPPET_CHARS = 300;


// ── The seam ───────────────────────────────────────────────────────

/** One vector handed to the index: a message id, its values, its mailbox. */
export interface SemanticVectorInput {
	id: string;
	values: number[];
	mailboxId: string;
}

/** One ranked hit from the vector index. */
export interface SemanticIndexMatch {
	id: string;
	score: number;
}

/**
 * The two binding calls behind one interface.
 *
 * `embed` turns text into a vector; `upsert` stores one message's vector
 * (metadata carries the mailbox so a query can be restricted to it); `query`
 * answers the closest vectors in that mailbox, best score first.
 */
export interface SemanticSeam {
	embed(text: string): Promise<number[]>;
	upsert(vector: SemanticVectorInput): Promise<void>;
	query(vector: number[], mailboxId: string, topK: number): Promise<SemanticIndexMatch[]>;
}

/**
 * The guarded optional lookup for the two bindings. `AI` exists in every
 * deployment; `VECTORIZE` does not exist yet, so it is read through an
 * optional cast rather than a required binding — absent means the feature is
 * off, never an error.
 */
export function resolveSemanticBindings(
	env: Env,
): { ai: Ai; index: VectorizeIndex } | null {
	const optional = env as unknown as { AI?: Ai; VECTORIZE?: VectorizeIndex };
	const ai = optional.AI;
	const index = optional.VECTORIZE;
	if (!ai || !index) return null;
	return { ai, index };
}

/** The Workers AI + Vectorize implementation of the seam. */
function workersAiSeam(bindings: { ai: Ai; index: VectorizeIndex }): SemanticSeam {
	return {
		async embed(text) {
			const response = (await bindings.ai.run(SEMANTIC_EMBEDDING_MODEL, {
				text: [text],
			})) as { data?: number[][] };
			const vector = response.data?.[0];
			if (!vector || vector.length === 0) {
				throw new Error("The embedding model returned no vector");
			}
			return vector;
		},
		async upsert(vector) {
			await bindings.index.upsert([
				{
					id: vector.id,
					values: vector.values,
					metadata: { mailboxId: vector.mailboxId },
				},
			]);
		},
		async query(values, mailboxId, topK) {
			const result = await bindings.index.query(values, {
				topK,
				returnMetadata: "none",
				filter: { mailboxId: { $eq: mailboxId } },
			});
			return result.matches.map((match) => ({
				id: match.id,
				score: match.score,
			}));
		},
	};
}


// ── Test injection ─────────────────────────────────────────────────

/**
 * Set by tests only. The pool cannot run Workers AI and has no Vectorize
 * binding, so a fake seam is the only way to exercise the feature end to end
 * there; production code never touches this.
 */
let injectedSeam: SemanticSeam | undefined;

/** Use this seam for the rest of the isolate, instead of the bindings. */
export function setSemanticSeamForTests(seam: SemanticSeam): void {
	injectedSeam = seam;
}

/** Drop the injected seam so the guarded binding lookup applies again. */
export function clearSemanticSeamForTests(): void {
	injectedSeam = undefined;
}

/** The seam every entry point uses: the injected fake, or the bindings. */
export function resolveSemanticSeam(env: Env): SemanticSeam | null {
	if (injectedSeam) return injectedSeam;
	const bindings = resolveSemanticBindings(env);
	return bindings ? workersAiSeam(bindings) : null;
}

/** Whether the feature has a working seam (bindings present, or a test fake). */
export function isSemanticConfigured(env: Env): boolean {
	return resolveSemanticSeam(env) !== null;
}


// ── Content ────────────────────────────────────────────────────────

/**
 * The text one message contributes to its embedding: sender, subject and the
 * plain-text body, clipped to MAX_EMBEDDING_SOURCE_CHARS. Sender and subject
 * go first because they are short and often carry the topic, and the body is
 * what the clip mostly trims.
 */
export function buildEmbeddingText(input: {
	subject?: string | null;
	sender?: string | null;
	body?: string | null;
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
	return content.slice(0, MAX_EMBEDDING_SOURCE_CHARS);
}

/** Stable content hash (SHA-256, hex) recorded with every embedding row. */
export async function hashEmbeddingContent(content: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(content),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}


// ── Ingest (off the receive path) ──────────────────────────────────

/** What one message contributes to the index. */
export interface SemanticMessageInput {
	emailId: string;
	subject?: string | null;
	sender?: string | null;
	body?: string | null;
}

/**
 * Embed one stored message, index its vector and record the bookkeeping row.
 *
 * Best-effort by design, like insertExtractedItems: it never throws and
 * answers false on every skip or failure, so the receive path can schedule it
 * without risking delivery. Skips, in order:
 *   - the mailbox's `semanticSearch.enabled` switch is off (per mailbox,
 *     never inherited — the feature is opt-in because it spends AI calls);
 *   - the deployment has no AI/Vectorize bindings (not configured);
 *   - the message has no embeddable content;
 *   - the message no longer exists (the bookkeeping row answers false).
 *
 * `settings` lets the caller pass the mailbox settings it already read on the
 * receive path; without them this reads the settings JSON itself.
 */
export async function embedAndIndexMessage(
	env: Env,
	mailboxId: string,
	input: SemanticMessageInput,
	settings?: Record<string, unknown>,
): Promise<boolean> {
	try {
		const mailboxSettings = settings ?? (await readMailboxSettings(env, mailboxId));
		if (!normalizeSemanticSearchSettings(mailboxSettings["semanticSearch"]).enabled) {
			return false;
		}

		const seam = resolveSemanticSeam(env);
		if (!seam) return false;

		const content = buildEmbeddingText(input);
		if (!content) return false;

		const values = await seam.embed(content);
		await seam.upsert({ id: input.emailId, values, mailboxId });

		const stub = getMailboxStub(env, mailboxId);
		return await stub.markMessageEmbedded(
			input.emailId,
			SEMANTIC_EMBEDDING_MODEL,
			await hashEmbeddingContent(content),
		);
	} catch (e) {
		console.error(
			"Semantic embedding failed, skipping this message:",
			(e as Error).message,
		);
		return false;
	}
}


// ── Search ─────────────────────────────────────────────────────────

/** One ranked result, in the row shape the mailbox list UI already renders. */
export interface SemanticSearchHit {
	id: string;
	subject: string | null;
	sender: string | null;
	recipient: string | null;
	date: string | null;
	read: boolean;
	starred: boolean;
	folder_id: string | null;
	/** Plain-text excerpt of the message body, clipped. */
	snippet: string;
	/** The vector index's similarity score (higher is closer). */
	score: number;
}

/**
 * Answer of the semantic search entry points. The not-configured case is a
 * value, never a thrown error; a real embedding/index failure still throws
 * (the route answers 500, the tool reports the error), because that is a
 * server fault the caller should see.
 */
export type SemanticSearchAnswer =
	| { results: SemanticSearchHit[] }
	| { error: string; status: 400 | 503 };

/**
 * Semantic search over one mailbox: embed the query text, ask the index for
 * the closest messages restricted to that mailbox, and resolve every hit
 * into the same row shape the keyword search returns (plus its score).
 *
 * Results are bounded to SEMANTIC_SEARCH_LIMIT_MAX and ranked by the index,
 * best first. A hit whose message was deleted since it was indexed is
 * skipped rather than answered with stale data. Read-only: no message is
 * written, nothing is sent.
 */
export async function semanticSearch(
	env: Env,
	mailboxId: string,
	query: string,
	limit: number = SEMANTIC_SEARCH_LIMIT_MAX,
): Promise<SemanticSearchAnswer> {
	const text = query.trim();
	if (!text) return { error: "A query is required.", status: 400 };

	const seam = resolveSemanticSeam(env);
	if (!seam) return { error: SEMANTIC_NOT_CONFIGURED, status: 503 };

	const boundedLimit = Number.isFinite(limit)
		? Math.min(Math.max(Math.trunc(limit), 1), SEMANTIC_SEARCH_LIMIT_MAX)
		: SEMANTIC_SEARCH_LIMIT_MAX;

	const vector = await seam.embed(text.slice(0, MAX_EMBEDDING_SOURCE_CHARS));
	const matches = await seam.query(vector, mailboxId, boundedLimit);

	const stub = getMailboxStub(env, mailboxId);
	const results: SemanticSearchHit[] = [];
	for (const match of matches) {
		const email = await stub.getEmail(match.id);
		if (!email) continue;
		results.push({
			id: email.id,
			subject: email.subject ?? null,
			sender: email.sender ?? null,
			recipient: email.recipient ?? null,
			date: email.date ?? null,
			read: email.read,
			starred: email.starred,
			folder_id: email.folder_id ?? null,
			snippet: stripHtmlToText(email.body ?? "").trim().slice(0, SEMANTIC_SNIPPET_CHARS),
			score: match.score,
		});
	}
	return { results };
}


// ── Reindex (one bounded batch per call) ───────────────────────────

/** What one reindex batch reports: what it handled and what is left. */
export interface SemanticReindexProgress {
	/** Messages this batch dealt with (embedded, or recorded as unembeddable). */
	processed: number;
	/** Messages still without an embedding row after this batch. */
	remaining: number;
	/** Messages with an embedding row now. */
	embedded: number;
	/** Stored messages in the mailbox. */
	total: number;
}

/** Answer of the reindex entry point; the not-configured case is a value. */
export type SemanticReindexAnswer =
	| SemanticReindexProgress
	| { error: string; status: 503 };

/** One row of the DO's unembedded list. */
type UnembeddedMessageRow = Awaited<
	ReturnType<MailboxDO["listUnembeddedMessages"]>
>[number];

/**
 * Embed ONE bounded batch of the mailbox's newest unembedded messages and
 * answer with how many it processed and how many remain, so a caller can
 * loop until nothing is left — the same idempotent shape as the retroactive
 * rule apply (each pass shrinks the work; a repeated call after it finishes
 * answers processed 0).
 *
 * Unlike ingest this ignores the `semanticSearch` switch: it is an explicit
 * operator action ("build the index"), not a per-message spend, and it is the
 * only way to index mail stored before the switch was turned on. A message
 * with nothing embeddable is recorded with an empty content hash instead of
 * being re-listed forever.
 */
export async function semanticReindex(
	env: Env,
	mailboxId: string,
	limit: number = SEMANTIC_REINDEX_BATCH_MAX,
): Promise<SemanticReindexAnswer> {
	const seam = resolveSemanticSeam(env);
	if (!seam) return { error: SEMANTIC_NOT_CONFIGURED, status: 503 };

	const boundedLimit = Number.isFinite(limit)
		? Math.min(Math.max(Math.trunc(limit), 1), SEMANTIC_REINDEX_BATCH_MAX)
		: SEMANTIC_REINDEX_BATCH_MAX;

	const stub = getMailboxStub(env, mailboxId);
	const rows = (await stub.listUnembeddedMessages(
		boundedLimit,
	)) as UnembeddedMessageRow[];

	let processed = 0;
	for (const row of rows) {
		const content = buildEmbeddingText({
			subject: row.subject,
			sender: row.sender,
			// The text/plain alternative is the better embedding source when
			// the sender included one; the HTML body is the fallback.
			body: row.body_text?.trim() ? row.body_text : row.body,
		});
		if (!content) {
			await stub.markMessageEmbedded(row.id, SEMANTIC_EMBEDDING_MODEL, "");
			processed += 1;
			continue;
		}
		const values = await seam.embed(content);
		await seam.upsert({ id: row.id, values, mailboxId });
		await stub.markMessageEmbedded(
			row.id,
			SEMANTIC_EMBEDDING_MODEL,
			await hashEmbeddingContent(content),
		);
		processed += 1;
	}

	const counts = await stub.countEmbeddings();
	return {
		processed,
		remaining: Math.max(counts.total - counts.embedded, 0),
		embedded: counts.embedded,
		total: counts.total,
	};
}
