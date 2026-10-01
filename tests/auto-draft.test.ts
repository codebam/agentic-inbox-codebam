import {
	createExecutionContext,
	listDurableObjectIds,
	runInDurableObject,
	SELF,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { normalizeAutoDraft, storedExpectsReply } from "../shared/auto-draft";
import { normalizeCategorizationSettings } from "../shared/categories";
import { receiveEmail, type InboundEmailEvent } from "../workers/index";

/** Register the mailbox record the inbound pipeline checks. */
async function registerMailbox(mailbox: string, settings: Record<string, unknown>) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify(settings));
}

/** Delivery settings that keep the pipeline deterministic (no AI calls). */
const PIPELINE_SETTINGS = { categorization: { enabled: false } };

/** The raw message the gate tests deliver: minimal but parseable RFC 822. */
function rawMessage(mailbox: string) {
	return [
		"From: sender@example.org",
		`To: ${mailbox}`,
		"Subject: Hello",
		"",
		"body",
		"",
	].join("\r\n");
}

/** Push one raw message through the real receiveEmail path. */
async function deliver(mailbox: string) {
	await deliverWith(mailbox, env, rawMessage(mailbox));
}

/**
 * deliver() with the env and message under the test's control: the reply
 * gate needs a Workers AI double (the pool cannot run the real binding) and
 * a mailbox whose settings actually reach the classifier.
 */
async function deliverWith(
	mailbox: string,
	pipelineEnv: unknown,
	raw: string,
) {
	const bytes = new TextEncoder().encode(raw);
	const ctx = createExecutionContext();
	const event: InboundEmailEvent = {
		raw: new Response(bytes).body as ReadableStream,
		rawSize: bytes.byteLength,
		to: mailbox,
	};
	await receiveEmail(
		event,
		pipelineEnv as Parameters<typeof receiveEmail>[1],
		ctx,
	);
	// Let the scheduled auto-draft trigger (and the webhook) settle.
	await waitOnExecutionContext(ctx);
}

/** Whether the agent DO for this mailbox was ever instantiated. */
async function agentTouched(mailbox: string) {
	const expected = env.EMAIL_AGENT.idFromName(mailbox).toString();
	const ids = await listDurableObjectIds(env.EMAIL_AGENT);
	return ids.some((id) => id.toString() === expected);
}

describe("normalizeAutoDraft", () => {
	it("only an explicit false disables auto-draft", () => {
		expect(normalizeAutoDraft(false)).toBe(false);
		expect(normalizeAutoDraft(true)).toBe(true);
		expect(normalizeAutoDraft(undefined)).toBe(true);
		expect(normalizeAutoDraft(null)).toBe(true);
		expect(normalizeAutoDraft("false")).toBe(true);
	});
});

describe("mailbox settings route", () => {
	it("normalises autoDraft on PUT", async () => {
		const mailbox = "auto-draft-settings@example.com";
		await registerMailbox(mailbox, {});

		const off = await SELF.fetch(`http://example.com/api/v1/mailboxes/${mailbox}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ settings: { autoDraft: false } }),
		});
		expect(off.status).toBe(200);
		const offBody = (await off.json()) as { settings: { autoDraft: boolean } };
		expect(offBody.settings.autoDraft).toBe(false);

		const junk = await SELF.fetch(`http://example.com/api/v1/mailboxes/${mailbox}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ settings: { autoDraft: "off" } }),
		});
		const junkBody = (await junk.json()) as { settings: { autoDraft: boolean } };
		expect(junkBody.settings.autoDraft).toBe(true);
	});
});

describe("auto-draft gate", () => {
	it("still triggers the agent for new mail by default", async () => {
		const mailbox = "auto-draft-default@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		await deliver(mailbox);
		expect(await agentTouched(mailbox)).toBe(true);
	});

	it("leaves the agent alone when the mailbox turns auto-draft off", async () => {
		const mailbox = "auto-draft-off@example.com";
		await registerMailbox(mailbox, { ...PIPELINE_SETTINGS, autoDraft: false });
		await deliver(mailbox);
		expect(await agentTouched(mailbox)).toBe(false);
	});

	it("schedules no agent fetch when the deployment disables the AI agent", async () => {
		const mailbox = "auto-draft-disabled@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		// The same message deliver() sends, but with ENABLE_AI_AGENT forced
		// off in the env the pipeline reads.
		const raw = [
			"From: sender@example.org",
			`To: ${mailbox}`,
			"Subject: Hello",
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
		const disabledEnv = { ...env, ENABLE_AI_AGENT: "false" };
		await receiveEmail(
			event,
			disabledEnv as unknown as Parameters<typeof receiveEmail>[1],
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(await agentTouched(mailbox)).toBe(false);
	});
});

describe("reply gate settings", () => {
	it("defaults on and clamps the threshold into the safe band", () => {
		expect(normalizeCategorizationSettings(undefined).expectsReply).toEqual({
			enabled: true,
			threshold: 0.5,
		});
		expect(
			normalizeCategorizationSettings({ expectsReply: { enabled: false } })
				.expectsReply,
		).toEqual({ enabled: false, threshold: 0.5 });
		expect(
			normalizeCategorizationSettings({ expectsReply: { threshold: 0.7 } })
				.expectsReply.threshold,
		).toBe(0.7);
		expect(
			normalizeCategorizationSettings({ expectsReply: { threshold: 9 } })
				.expectsReply.threshold,
		).toBe(0.95);
		expect(
			normalizeCategorizationSettings({ expectsReply: { threshold: 0 } })
				.expectsReply.threshold,
		).toBe(0.05);
		expect(
			normalizeCategorizationSettings({ expectsReply: { threshold: "off" } })
				.expectsReply.threshold,
		).toBe(0.5);
	});
});

describe("storedExpectsReply", () => {
	it("reads the verdict from a serialized or parsed audit trail", () => {
		expect(storedExpectsReply(JSON.stringify({ expects_reply: false }))).toBe(
			false,
		);
		expect(storedExpectsReply({ expects_reply: true })).toBe(true);
	});

	it("answers null when there is no verdict to read", () => {
		expect(storedExpectsReply(null)).toBeNull();
		expect(storedExpectsReply(undefined)).toBeNull();
		expect(storedExpectsReply("not json")).toBeNull();
		expect(storedExpectsReply(JSON.stringify({ is_spam: false }))).toBeNull();
		expect(storedExpectsReply({ expects_reply: "no" })).toBeNull();
		expect(storedExpectsReply("[]")).toBeNull();
	});
});

describe("Clef-flash reply gate on the receive path", () => {
	/** A Workers AI double: answers Clef-flash questions, quiets other callers. */
	function fakeClefAi(
		answers: Record<string, unknown>,
		questions: string[][] = [],
		selectors: (string | undefined)[] = [],
	) {
		return {
			run: async (_model: string, params: unknown) => {
				const input = params as { model?: string; questions?: Record<string, unknown> } | null;
				if (input && typeof input === "object" && input.questions) {
					questions.push(Object.keys(input.questions));
					selectors.push(input.model);
					return { model: "@cf/cloudflare/clef-flash", answers };
				}
				// The items extractor asks with `messages`; answer it with an
				// empty extraction so the off-path stays quiet.
				return { response: "[]" };
			},
		};
	}

	/** The newest row's stored classification audit trail. */
	async function storedClassification(mailbox: string) {
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
		return runInDurableObject(stub, async (_instance, state) => {
			const rows = [
				...state.storage.sql.exec(
					"SELECT classification FROM emails ORDER BY rowid DESC LIMIT 1",
				),
			];
			const row = rows[0] as { classification: string | null } | undefined;
			return row?.classification ?? null;
		});
	}

	it("holds the auto-draft trigger back when Clef-flash says no reply is expected", async () => {
		const mailbox = "reply-gate-hold@example.com";
		await registerMailbox(mailbox, { categorization: {} });
		const questions: string[][] = [];
		const selectors: (string | undefined)[] = [];
		await deliverWith(
			mailbox,
			{
				...env,
				AI: fakeClefAi(
					{
						is_spam: { type: "noul", noul: 0.02 },
						expects_reply: { type: "noul", noul: 0.05 },
					},
					questions,
					selectors,
				),
			},
			rawMessage(mailbox),
		);

		expect(questions[0]).toEqual(["is_spam", "expects_reply"]);
		expect(selectors[0]).toBe("clef-flash");
		expect(await agentTouched(mailbox)).toBe(false);
		const stored = await storedClassification(mailbox);
		expect(storedExpectsReply(stored)).toBe(false);
		expect(JSON.parse(String(stored))).toMatchObject({
			is_spam: false,
			expects_reply: false,
		});
	});

	it("keeps drafting when Clef-flash expects a reply", async () => {
		const mailbox = "reply-gate-go@example.com";
		await registerMailbox(mailbox, { categorization: {} });
		await deliverWith(
			mailbox,
			{
				...env,
				AI: fakeClefAi({
					is_spam: { type: "noul", noul: 0.02 },
					expects_reply: { type: "noul", noul: 0.92 },
				}),
			},
			rawMessage(mailbox),
		);

		expect(await agentTouched(mailbox)).toBe(true);
		expect(storedExpectsReply(await storedClassification(mailbox))).toBe(true);
	});

	it("keeps drafting when the classifier could not run (fail-open)", async () => {
		const mailbox = "reply-gate-fail@example.com";
		await registerMailbox(mailbox, { categorization: {} });
		await deliverWith(
			mailbox,
			{
				...env,
				AI: {
					run: async () => {
						throw new Error("model unavailable");
					},
				},
			},
			rawMessage(mailbox),
		);

		expect(await agentTouched(mailbox)).toBe(true);
		expect(await storedClassification(mailbox)).toBeNull();
	});

	it("asks no reply question when the mailbox turns the gate off", async () => {
		const mailbox = "reply-gate-off@example.com";
		await registerMailbox(mailbox, {
			categorization: { expectsReply: { enabled: false } },
		});
		const questions: string[][] = [];
		const selectors: (string | undefined)[] = [];
		await deliverWith(
			mailbox,
			{
				...env,
				AI: fakeClefAi(
					{
						is_spam: { type: "noul", noul: 0.02 },
						expects_reply: { type: "noul", noul: 0.05 },
					},
					questions,
					selectors,
				),
			},
			rawMessage(mailbox),
		);

		expect(questions[0]).toEqual(["is_spam"]);
		expect(selectors[0]).toBe("clef-flash");
		expect(await agentTouched(mailbox)).toBe(true);
		expect(storedExpectsReply(await storedClassification(mailbox))).toBeNull();
	});
});
