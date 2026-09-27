// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Semantic (vector) search.
 *
 * The Workers AI binding cannot run in the vitest pool ("Binding AI needs to
 * be run remotely") and no VECTORIZE binding exists yet, so every test here
 * injects a fake through the one seam in workers/lib/semantic.ts and drives
 * the feature end to end against it: ingest, both routes, the shared tool and
 * the not-configured path. The live model and the live index are therefore
 * NOT exercised here — that coverage gap is deliberate and stated in the
 * seam's doc comment; what is covered is every branch the seam is called
 * from, the guarded binding lookup included.
 */

import {
	SELF,
	createExecutionContext,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import {
	normalizeSemanticSearchSettings,
	SEMANTIC_NOT_CONFIGURED,
	SEMANTIC_SEARCH_LIMIT_MAX,
} from "../shared/semantic";
import { createEmailTools } from "../workers/agent/index";
import { defaultMailboxSettings } from "../workers/lib/mailbox";
import {
	buildEmbeddingText,
	clearSemanticSeamForTests,
	MAX_EMBEDDING_SOURCE_CHARS,
	SEMANTIC_EMBEDDING_MODEL,
	setSemanticSeamForTests,
	type SemanticSeam,
	type SemanticVectorInput,
} from "../workers/lib/semantic";
import { toolSemanticSearch } from "../workers/lib/tools";
import { receiveEmail, type InboundEmailEvent } from "../workers/index";


/** Settings that keep the ingest path deterministic (no AI call). */
const PIPELINE_SETTINGS = { categorization: { enabled: false } };

type Stub = ReturnType<typeof stubFor>;


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


/** Register the mailbox record the inbound pipeline checks. */
async function registerMailbox(
	mailbox: string,
	settings: Record<string, unknown> = PIPELINE_SETTINGS,
) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify(settings));
}


/** A fake seam: records every call and answers canned query matches. */
interface FakeSeam extends SemanticSeam {
	embedded: string[];
	upserted: SemanticVectorInput[];
	queries: { mailboxId: string; topK: number; vector: number[] }[];
	setMatches(matches: { id: string; score: number }[]): void;
}


function fakeSeam(matches: { id: string; score: number }[] = []): FakeSeam {
	let canned = [...matches];
	const calls = {
		embedded: [] as string[],
		upserted: [] as SemanticVectorInput[],
		queries: [] as { mailboxId: string; topK: number; vector: number[] }[],
	};
	return {
		embedded: calls.embedded,
		upserted: calls.upserted,
		queries: calls.queries,
		setMatches(next) {
			canned = [...next];
		},
		async embed(text) {
			calls.embedded.push(text);
			// A deterministic pseudo-vector; the fake index never inspects it.
			return [text.length, 0.5, 1];
		},
		async upsert(vector) {
			calls.upserted.push(vector);
		},
		async query(vector, mailboxId, topK) {
			calls.queries.push({ mailboxId, topK, vector });
			return canned.slice(0, topK);
		},
	};
}


/** Push one raw message through the real receiveEmail path. */
async function deliver(mailbox: string, subject = "Hello") {
	const raw = [
		"From: sender@example.org",
		`To: ${mailbox}`,
		`Subject: ${subject}`,
		`Message-ID: <${crypto.randomUUID()}@example.org>`,
		"",
		"body",
		"",
	].join("\r\n");
	const bytes = new TextEncoder().encode(raw);
	const ctx = createExecutionContext();
	const event: InboundEmailEvent = {
		raw: new Response(bytes).body as ReadableStream,
		rawSize: bytes.byteLength,
		to: mailbox,
	};
	await receiveEmail(event, env, ctx);
	// Let the scheduled embedding (and anything else) settle.
	await waitOnExecutionContext(ctx);
}


/** Seed one stored message with an explicit date so batches are ordered. */
async function seedEmail(
	stub: Stub,
	id: string,
	subject: string,
	date = "2026-09-24T09:00:00.000Z",
) {
	await stub.createEmail(
		Folders.INBOX,
		{
			id,
			subject,
			sender: "sender@example.org",
			recipient: "box@example.com",
			date,
			body: `<p>body of ${id}</p>`,
			in_reply_to: null,
			email_references: null,
			thread_id: id,
			message_id: `${id}@example.org`,
		},
		[],
	);
}


/** The embedding bookkeeping rows, straight out of the Durable Object. */
async function embeddingRows(stub: Stub) {
	return runInDurableObject(stub, async (_instance, state) => {
		return [...state.storage.sql.exec(
			`SELECT email_id, model, content_hash, created_at FROM message_embeddings ORDER BY email_id`,
		)] as unknown as {
			email_id: string;
			model: string;
			content_hash: string;
			created_at: string;
		}[];
	});
}


/** POST one semantic route and answer the parsed body with its status. */
async function postJson(mailbox: string, path: string, body?: unknown) {
	const res = await SELF.fetch(`http://example.com/api/v1/mailboxes/${mailbox}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}


beforeEach(() => {
	// Every test starts unconfigured; tests that need the seam set their fake.
	clearSemanticSeamForTests();
});


describe("normalizeSemanticSearchSettings", () => {
	it("defaults to off and only an explicit true turns it on", () => {
		expect(normalizeSemanticSearchSettings(undefined).enabled).toBe(false);
		expect(normalizeSemanticSearchSettings(null).enabled).toBe(false);
		expect(normalizeSemanticSearchSettings({}).enabled).toBe(false);
		expect(normalizeSemanticSearchSettings({ enabled: "true" }).enabled).toBe(false);
		expect(normalizeSemanticSearchSettings({ enabled: false }).enabled).toBe(false);
		expect(normalizeSemanticSearchSettings({ enabled: true }).enabled).toBe(true);
	});

	it("is off in the default mailbox settings", () => {
		expect(defaultMailboxSettings("box@example.com").semanticSearch).toEqual({
			enabled: false,
		});
	});
});


describe("buildEmbeddingText", () => {
	it("leads with sender and subject and clips the body", () => {
		const text = buildEmbeddingText({
			subject: "Quarterly report",
			sender: "sender@example.org",
			body: `<p>${"x".repeat(MAX_EMBEDDING_SOURCE_CHARS * 2)}</p>`,
		});
		expect(text.startsWith("From: sender@example.org\nSubject: Quarterly report")).toBe(true);
		expect(text.length).toBe(MAX_EMBEDDING_SOURCE_CHARS);
	});

	it("answers an empty string for a message with nothing to embed", () => {
		expect(buildEmbeddingText({})).toBe("");
	});
});


describe("mailbox settings route", () => {
	it("round-trips semanticSearch through PUT and GET", async () => {
		const mailbox = "semantic-settings@example.com";
		await registerMailbox(mailbox, {});

		const on = await SELF.fetch(`http://example.com/api/v1/mailboxes/${mailbox}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ settings: { semanticSearch: { enabled: true } } }),
		});
		expect(on.status).toBe(200);
		const onBody = (await on.json()) as {
			settings: { semanticSearch: { enabled: boolean } };
		};
		expect(onBody.settings.semanticSearch.enabled).toBe(true);

		const get = await SELF.fetch(`http://example.com/api/v1/mailboxes/${mailbox}`);
		expect(get.status).toBe(200);
		const getBody = (await get.json()) as {
			settings: { semanticSearch: { enabled: boolean } };
		};
		expect(getBody.settings.semanticSearch.enabled).toBe(true);

		// Junk normalizes to off rather than being stored as-is.
		const junk = await SELF.fetch(`http://example.com/api/v1/mailboxes/${mailbox}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ settings: { semanticSearch: { enabled: "yes" } } }),
		});
		const junkBody = (await junk.json()) as {
			settings: { semanticSearch: { enabled: boolean } };
		};
		expect(junkBody.settings.semanticSearch.enabled).toBe(false);
	});
});


describe("semantic ingest", () => {
	it("embeds and indexes a new message when the mailbox opted in", async () => {
		const mailbox = "semantic-ingest-on@example.com";
		await registerMailbox(mailbox, {
			...PIPELINE_SETTINGS,
			semanticSearch: { enabled: true },
		});
		const seam = fakeSeam();
		setSemanticSeamForTests(seam);
		const stub = stubFor(mailbox);

		await deliver(mailbox, "Project update");

		// The message was embedded from its subject and sender…
		expect(seam.embedded).toHaveLength(1);
		expect(seam.embedded[0]).toContain("Subject: Project update");
		expect(seam.embedded[0]).toContain("sender@example.org");

		// …indexed with this mailbox in the metadata…
		const inbox = (await stub.getEmails({ folder: Folders.INBOX })) as unknown as {
			id: string;
		}[];
		expect(inbox).toHaveLength(1);
		expect(seam.upserted).toHaveLength(1);
		expect(seam.upserted[0]?.id).toBe(inbox[0]!.id);
		expect(seam.upserted[0]?.mailboxId).toBe(mailbox);

		// …and recorded, model id and content hash included.
		expect(await stub.countEmbeddings()).toEqual({ embedded: 1, total: 1 });
		const rows = await embeddingRows(stub);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.email_id).toBe(inbox[0]!.id);
		expect(rows[0]!.model).toBe(SEMANTIC_EMBEDDING_MODEL);
		expect(rows[0]!.content_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(rows[0]!.created_at).toEqual(expect.any(String));
	});

	it("does nothing when the mailbox has not opted in", async () => {
		const mailbox = "semantic-ingest-off@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const seam = fakeSeam();
		setSemanticSeamForTests(seam);
		const stub = stubFor(mailbox);

		await deliver(mailbox, "Project update");

		// The mail still lands; no embedding call is made and nothing is
		// recorded.
		expect(seam.embedded).toHaveLength(0);
		expect(seam.upserted).toHaveLength(0);
		expect(await stub.countEmbeddings()).toEqual({ embedded: 0, total: 1 });
	});

	it("does nothing when the deployment is not configured", async () => {
		const mailbox = "semantic-ingest-unconfigured@example.com";
		await registerMailbox(mailbox, {
			...PIPELINE_SETTINGS,
			semanticSearch: { enabled: true },
		});
		const stub = stubFor(mailbox);

		// No fake injected and no bindings in the pool: ingest must still
		// complete and record nothing.
		await deliver(mailbox, "Project update");

		expect(await stub.countEmbeddings()).toEqual({ embedded: 0, total: 1 });
		expect(await embeddingRows(stub)).toHaveLength(0);
	});
});


describe("POST /semantic-search", () => {
	it("answers ranked results from the index, in index order", async () => {
		const mailbox = "semantic-search@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const stub = stubFor(mailbox);
		await seedEmail(stub, "semantic-1", "Subject semantic-1");
		await seedEmail(stub, "semantic-2", "Subject semantic-2");
		const seam = fakeSeam([
			{ id: "semantic-2", score: 0.91 },
			// A hit whose message no longer exists is skipped, not answered.
			{ id: "semantic-deleted", score: 0.8 },
			{ id: "semantic-1", score: 0.42 },
		]);
		setSemanticSeamForTests(seam);

		const { status, body } = await postJson(mailbox, "/semantic-search", {
			query: "quarterly report",
		});

		expect(status).toBe(200);
		const results = body["results"] as {
			id: string;
			subject: string;
			sender: string;
			date: string;
			snippet: string;
			score: number;
			read: boolean;
		}[];
		expect(results.map((row) => row.id)).toEqual(["semantic-2", "semantic-1"]);
		expect(results[0]!.score).toBe(0.91);
		expect(results[0]!.subject).toBe("Subject semantic-2");
		expect(results[0]!.sender).toBe("sender@example.org");
		expect(results[0]!.date).toEqual(expect.any(String));
		expect(results[0]!.snippet).toContain("body of semantic-2");
		expect(results[0]!.read).toBe(false);

		// The query text was embedded, and the index was asked for this
		// mailbox only, bounded to the route's cap.
		expect(seam.embedded).toEqual(["quarterly report"]);
		expect(seam.queries).toHaveLength(1);
		expect(seam.queries[0]!.mailboxId).toBe(mailbox);
		expect(seam.queries[0]!.topK).toBe(SEMANTIC_SEARCH_LIMIT_MAX);
	});

	it("400s without a query", async () => {
		const mailbox = "semantic-search-noquery@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		setSemanticSeamForTests(fakeSeam());

		expect((await postJson(mailbox, "/semantic-search", {})).status).toBe(400);
		expect(
			(await postJson(mailbox, "/semantic-search", { query: "   " })).status,
		).toBe(400);
		expect(
			(await postJson(mailbox, "/semantic-search", { query: "x", limit: 500 })).status,
		).toBe(400);
	});

	it("503s with the not-configured message when the bindings are absent", async () => {
		const mailbox = "semantic-search-unconfigured@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);

		const { status, body } = await postJson(mailbox, "/semantic-search", {
			query: "anything",
		});

		expect(status).toBe(503);
		expect(body["error"]).toBe(SEMANTIC_NOT_CONFIGURED);
	});
});


describe("POST /semantic/reindex", () => {
	it("processes one bounded batch and reports the remainder", async () => {
		const mailbox = "semantic-reindex@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const stub = stubFor(mailbox);
		// 25 messages, oldest first, so the newest 20 are ids 06..25.
		for (let i = 1; i <= 25; i += 1) {
			const id = `reindex-${String(i).padStart(2, "0")}`;
			await seedEmail(stub, id, `Subject ${id}`, `2026-09-${String(i).padStart(2, "0")}T09:00:00.000Z`);
		}
		const seam = fakeSeam();
		setSemanticSeamForTests(seam);

		const first = await postJson(mailbox, "/semantic/reindex");
		expect(first.status).toBe(200);
		expect(first.body).toEqual({
			processed: 20,
			remaining: 5,
			embedded: 20,
			total: 25,
		});
		const newestTwenty = Array.from({ length: 20 }, (_v, i) => `reindex-${String(25 - i).padStart(2, "0")}`);
		expect(seam.upserted.map((vector) => vector.id)).toEqual(newestTwenty);
		expect(seam.upserted.every((vector) => vector.mailboxId === mailbox)).toBe(true);

		// A caller loops until nothing remains; a finished index answers 0/0.
		const second = await postJson(mailbox, "/semantic/reindex");
		expect(second.body).toEqual({
			processed: 5,
			remaining: 0,
			embedded: 25,
			total: 25,
		});
		const third = await postJson(mailbox, "/semantic/reindex");
		expect(third.body).toEqual({
			processed: 0,
			remaining: 0,
			embedded: 25,
			total: 25,
		});
	});

	it("503s with the not-configured message when the bindings are absent", async () => {
		const mailbox = "semantic-reindex-unconfigured@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);

		const { status, body } = await postJson(mailbox, "/semantic/reindex");

		expect(status).toBe(503);
		expect(body["error"]).toBe(SEMANTIC_NOT_CONFIGURED);
	});
});


describe("semantic_search tool", () => {
	it("is offered to a per-mailbox agent chat", () => {
		const tools = createEmailTools(env, "semantic-tool@example.com");
		expect(tools["semantic_search"]).toBeDefined();
		// The pinned MCP and agent lists live in tests/tool-parity.test.ts;
		// this tool is read-only there and on the MCP surface alike.
	});

	it("answers the not-configured result instead of throwing", async () => {
		await expect(
			toolSemanticSearch(env, "semantic-tool-unconfigured@example.com", {
				query: "anything",
			}),
		).resolves.toEqual({ error: SEMANTIC_NOT_CONFIGURED, status: 503 });
	});

	it("answers ranked results from the fake index", async () => {
		const mailbox = "semantic-tool@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "tool-1", "Subject tool-1");
		const seam = fakeSeam([{ id: "tool-1", score: 0.77 }]);
		setSemanticSeamForTests(seam);

		const answer = await toolSemanticSearch(env, mailbox, { query: "anything", limit: 5 });

		expect(answer).toEqual({
			results: [
				{
					id: "tool-1",
					subject: "Subject tool-1",
					sender: "sender@example.org",
					recipient: "box@example.com",
					date: "2026-09-24T09:00:00.000Z",
					read: false,
					starred: false,
					folder_id: Folders.INBOX,
					snippet: "body of tool-1",
					score: 0.77,
				},
			],
		});
		expect(seam.queries[0]?.topK).toBe(5);
	});
});
