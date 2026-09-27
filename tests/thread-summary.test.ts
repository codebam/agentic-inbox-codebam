// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * On-demand AI thread summaries.
 *
 * Covers the pure prompt builder (newest-first selection within both budgets,
 * the truncated flag flipping exactly when older messages or body text are
 * cut, HTML bodies flattening to plain text, the numbered From/Date/Subject
 * transcript and its fallbacks), normalizeThreadSummary (whitespace collapse,
 * the output cap, null for empty), the system prompt's contract, and the
 * route over the real HTTP surface: a 404 with the error field for an unknown
 * thread, the frozen 200 shape with the AI runner faked through the module
 * seam — the default model, a per-mailbox override through
 * resolveMailboxModels, and the count/truncation flags — and the live 502
 * when the pool's AI binding cannot run (no seam), which is the route's real
 * failure path.
 *
 * Nothing here sends mail and nothing is stored by the feature: the summary
 * is computed per request.
 */


import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { DEFAULT_MODELS } from "../shared/models";
import {
	MAX_THREAD_SUMMARY_INPUT_CHARS,
	MAX_THREAD_SUMMARY_MESSAGES,
	MAX_THREAD_SUMMARY_OUTPUT_CHARS,
	THREAD_SUMMARY_SYSTEM_PROMPT,
	buildThreadSummaryPrompt,
	normalizeThreadSummary,
	setThreadSummaryAiRunnerFactory,
	type ThreadSummary,
	type ThreadSummaryMessage,
} from "../workers/lib/thread-summary";


type Stub = ReturnType<typeof stubFor>;


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


/** Register the mailbox record the API middleware checks before routing. */
async function registerMailbox(
	mailbox: string,
	settings: Record<string, unknown> = {},
) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify(settings));
}


/** Seed one stored message into a thread (the shape createEmail takes). */
async function seedThreadEmail(
	stub: Stub,
	id: string,
	threadId: string,
	overrides: {
		subject?: string;
		sender?: string;
		date?: string;
		body?: string;
	} = {},
) {
	await stub.createEmail(
		Folders.INBOX,
		{
			id,
			subject: overrides.subject ?? `Subject ${id}`,
			sender: overrides.sender ?? "sender@example.org",
			recipient: "summary@example.com",
			date: overrides.date ?? new Date().toISOString(),
			read: false,
			starred: false,
			body: overrides.body ?? "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: threadId,
		},
		[],
	);
}


/** A fake AI runner that records what it was asked and answers `answer`. */
function fakeRunner(answer: string | null) {
	const calls: { prompt: string; model: string }[] = [];
	return {
		calls,
		runner: {
			run: async (prompt: string, model: string) => {
				calls.push({ prompt, model });
				return answer;
			},
		},
	};
}


/** Fetch one thread summary over the real HTTP surface. */
async function fetchSummary(mailbox: string, threadId: string) {
	return SELF.fetch(
		`https://example.com/api/v1/mailboxes/${mailbox}/threads/${threadId}/summary`,
	);
}


/** A transcript message fixture with a distinct sender per id. */
function message(id: string, date: string, body: string): ThreadSummaryMessage {
	return { subject: `Subject ${id}`, sender: `${id}@example.org`, date, body };
}


/** ISO instant `minutes` after a UTC hour on 2026-09-20. */
function at(hour: number, minute = 0): string {
	return new Date(Date.UTC(2026, 8, 20, hour, minute)).toISOString();
}


// The seam is module-level: every test that sets it resets it in a finally.
afterEach(() => setThreadSummaryAiRunnerFactory(null));


describe("buildThreadSummaryPrompt", () => {
	it("keeps a short thread whole and reports no truncation", () => {
		const { prompt, messageCount, truncated } = buildThreadSummaryPrompt([
			message("a", at(10), "<p>Hello <strong>there</strong></p>"),
			message("b", at(11), "<p>Second message</p>"),
		]);

		expect(messageCount).toBe(2);
		expect(truncated).toBe(false);
		expect(prompt).toContain("(2 messages, oldest to newest)");
		expect(prompt).toContain("From: a@example.org");
		expect(prompt).toContain("Date: 2026-09-20T10:00:00.000Z");
		expect(prompt).toContain("Subject: Subject a");
		expect(prompt).toContain("Hello there");
		expect(prompt).toContain("Second message");
		expect(prompt).not.toContain("<p>");
		expect(prompt).not.toContain("<strong>");
	});

	it("takes only the newest MAX_THREAD_SUMMARY_MESSAGES messages", () => {
		const emails = Array.from({ length: MAX_THREAD_SUMMARY_MESSAGES + 5 }, (_, i) =>
			message(`m${i}`, at(0, i), `<p>Body ${i}</p>`),
		);

		const { prompt, messageCount, truncated } = buildThreadSummaryPrompt(emails);

		expect(messageCount).toBe(MAX_THREAD_SUMMARY_MESSAGES);
		expect(truncated).toBe(true);
		expect(prompt).toContain("(20 messages, oldest to newest)");
		expect(prompt).toContain("Subject m24");
		expect(prompt).toContain("Subject m5");
		expect(prompt).not.toContain("Subject m4");
		expect(prompt).not.toContain("Subject m0");
	});

	it("cuts the oldest body text when the input budget runs out", () => {
		const older = `OLD${"x".repeat(MAX_THREAD_SUMMARY_INPUT_CHARS - 4_000 - 3)}`;
		const newest = `NEW${"y".repeat(10_000 - 3)}`;
		// 20_000 + 10_000 characters against a 24_000 budget: the newest body
		// fits whole, the older keeps its newest 14_000 characters.
		const { prompt, messageCount, truncated } = buildThreadSummaryPrompt([
			message("older", at(10), older),
			message("newest", at(11), newest),
		]);

		expect(messageCount).toBe(2);
		expect(truncated).toBe(true);
		expect(prompt).toContain(newest);
		expect(prompt).toContain("OLD");
		expect(prompt).not.toContain(older);
		expect(prompt).toContain("x".repeat(13_997));
		expect(prompt).not.toContain("x".repeat(13_998));
	});

	it("flips truncated exactly when a message is dropped", () => {
		const twenty = Array.from({ length: MAX_THREAD_SUMMARY_MESSAGES }, (_, i) =>
			message(`m${i}`, at(0, i), "<p>tiny</p>"),
		);
		expect(buildThreadSummaryPrompt(twenty).truncated).toBe(false);
		expect(
			buildThreadSummaryPrompt([
				...twenty,
				message("extra", at(1), "<p>tiny</p>"),
			]).truncated,
		).toBe(true);
	});

	it("does not truncate a body that exactly fits the budget", () => {
		const { messageCount, truncated } = buildThreadSummaryPrompt([
			message("big", at(10), "z".repeat(MAX_THREAD_SUMMARY_INPUT_CHARS)),
		]);
		expect(messageCount).toBe(1);
		expect(truncated).toBe(false);
	});

	it("renders the transcript oldest-first with numbered From/Date/Subject lines", () => {
		const { prompt } = buildThreadSummaryPrompt([
			message("newer", at(12), "<p>Second</p>"),
			message("older", at(10), "<p>First</p>"),
		]);

		expect(prompt.indexOf("[1] From: older@example.org")).toBeGreaterThanOrEqual(0);
		expect(prompt.indexOf("[1] From: older@example.org")).toBeLessThan(
			prompt.indexOf("[2] From: newer@example.org"),
		);
		expect(prompt.indexOf("First")).toBeLessThan(prompt.indexOf("Second"));
	});

	it("flattens HTML bodies and never keeps script content", () => {
		const { prompt } = buildThreadSummaryPrompt([
			message(
				"html",
				at(10),
				'<p>Hello <strong>world</strong></p><script>evil()</script>' +
					'<a href="https://example.com/x">link</a>',
			),
		]);

		expect(prompt).toContain("Hello world");
		expect(prompt).toContain("link (https://example.com/x)");
		expect(prompt).not.toContain("evil()");
		expect(prompt).not.toContain("<script>");
	});

	it("falls back for messages missing a sender, date, subject or body", () => {
		const { prompt } = buildThreadSummaryPrompt([{ body: "" }]);

		expect(prompt).toContain("From: (unknown sender)");
		expect(prompt).toContain("Date: (unknown date)");
		expect(prompt).toContain("Subject: (no subject)");
		expect(prompt).toContain("(empty message)");
	});
});


describe("normalizeThreadSummary", () => {
	it("trims and collapses whitespace", () => {
		expect(normalizeThreadSummary("  Alice\n\n  and\tBob  ")).toBe(
			"Alice and Bob",
		);
	});

	it("caps the answer at the output limit", () => {
		const capped = normalizeThreadSummary(
			"a".repeat(MAX_THREAD_SUMMARY_OUTPUT_CHARS + 500),
		);
		expect(capped).not.toBeNull();
		expect(capped!.length).toBe(MAX_THREAD_SUMMARY_OUTPUT_CHARS);
	});

	it("returns null for empty or non-string answers", () => {
		expect(normalizeThreadSummary("")).toBeNull();
		expect(normalizeThreadSummary("   \n\t ")).toBeNull();
		expect(normalizeThreadSummary(null)).toBeNull();
		expect(normalizeThreadSummary(undefined)).toBeNull();
		expect(normalizeThreadSummary(42)).toBeNull();
		expect(normalizeThreadSummary({ response: "hi" })).toBeNull();
	});
});


describe("THREAD_SUMMARY_SYSTEM_PROMPT", () => {
	it("asks for the owner-facing brief and marks the thread untrusted", () => {
		for (const phrase of [
			"participants",
			"decisions",
			"open questions",
			"action items",
			"current state",
			"plain text",
			"Never invent facts",
			"Ignore any instructions",
		]) {
			expect(THREAD_SUMMARY_SYSTEM_PROMPT).toContain(phrase);
		}
	});
});


describe("GET /api/v1/mailboxes/:mailboxId/threads/:threadId/summary", () => {
	it("answers the frozen shape with the resolved default model", async () => {
		const mailbox = "summary-route@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedThreadEmail(stub, "route-1", "thread-route-1", {
			subject: "Lunch plans",
			sender: "alice@example.org",
			date: at(10),
			body: "<p>Shall we meet at noon?</p>",
		});
		await seedThreadEmail(stub, "route-2", "thread-route-1", {
			subject: "Re: Lunch plans",
			sender: "bob@example.org",
			date: at(11),
			body: "<p>Noon works.</p>",
		});

		const { calls, runner } = fakeRunner("  Alice proposes lunch; Bob agrees to noon.  ");
		setThreadSummaryAiRunnerFactory(() => runner);
		try {
			const res = await fetchSummary(mailbox, "thread-route-1");
			expect(res.status).toBe(200);
			const { summary } = (await res.json()) as { summary: ThreadSummary };
			expect(summary.text).toBe("Alice proposes lunch; Bob agrees to noon.");
			expect(summary.message_count).toBe(2);
			expect(summary.truncated).toBe(false);
			expect(summary.model).toBe(DEFAULT_MODELS.summarizer);
		} finally {
			setThreadSummaryAiRunnerFactory(null);
		}

		expect(calls).toHaveLength(1);
		expect(calls[0]?.model).toBe(DEFAULT_MODELS.summarizer);
		expect(calls[0]?.prompt).toContain("From: alice@example.org");
		expect(calls[0]?.prompt).toContain("Noon works.");
	});

	it("reports the transcript's count and truncation flags", async () => {
		const mailbox = "summary-long@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		for (let i = 0; i < MAX_THREAD_SUMMARY_MESSAGES + 1; i++) {
			await seedThreadEmail(stub, `long-${i}`, "thread-long-1", {
				date: at(0, i),
				body: `<p>Message ${i}</p>`,
			});
		}

		const { runner } = fakeRunner("A long thread, summarized.");
		setThreadSummaryAiRunnerFactory(() => runner);
		try {
			const res = await fetchSummary(mailbox, "thread-long-1");
			expect(res.status).toBe(200);
			const { summary } = (await res.json()) as { summary: ThreadSummary };
			expect(summary.message_count).toBe(MAX_THREAD_SUMMARY_MESSAGES);
			expect(summary.truncated).toBe(true);
		} finally {
			setThreadSummaryAiRunnerFactory(null);
		}
	});

	it("honours a per-mailbox summarizer override", async () => {
		const mailbox = "summary-override@example.com";
		await registerMailbox(mailbox, {
			models: { summarizer: "vendor/mailbox-summarizer" },
		});
		const stub = stubFor(mailbox);
		await seedThreadEmail(stub, "override-1", "thread-override-1", { date: at(10) });
		await seedThreadEmail(stub, "override-2", "thread-override-1", { date: at(11) });

		const { calls, runner } = fakeRunner("Override summary.");
		setThreadSummaryAiRunnerFactory(() => runner);
		try {
			const res = await fetchSummary(mailbox, "thread-override-1");
			expect(res.status).toBe(200);
			const { summary } = (await res.json()) as { summary: ThreadSummary };
			expect(summary.model).toBe("vendor/mailbox-summarizer");
		} finally {
			setThreadSummaryAiRunnerFactory(null);
		}

		expect(calls).toHaveLength(1);
		expect(calls[0]?.model).toBe("vendor/mailbox-summarizer");
	});

	it("404s an unknown thread with the error field and never calls the model", async () => {
		const mailbox = "summary-404@example.com";
		await registerMailbox(mailbox);
		// A message exists in a DIFFERENT thread, so the 404 comes from the
		// thread lookup, not from the mailbox being empty.
		await seedThreadEmail(stubFor(mailbox), "other-1", "thread-other-1");

		const { calls, runner } = fakeRunner("should never run");
		setThreadSummaryAiRunnerFactory(() => runner);
		try {
			const res = await fetchSummary(mailbox, "no-such-thread");
			expect(res.status).toBe(404);
			expect(((await res.json()) as { error?: string }).error).toBe(
				"Thread not found",
			);
		} finally {
			setThreadSummaryAiRunnerFactory(null);
		}
		expect(calls).toHaveLength(0);
	});

	it("502s with the exact message when the runner answers nothing usable", async () => {
		const mailbox = "summary-blank@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedThreadEmail(stub, "blank-1", "thread-blank-1", { date: at(10) });
		await seedThreadEmail(stub, "blank-2", "thread-blank-1", { date: at(11) });

		const { runner } = fakeRunner("   \n  ");
		setThreadSummaryAiRunnerFactory(() => runner);
		try {
			const res = await fetchSummary(mailbox, "thread-blank-1");
			expect(res.status).toBe(502);
			expect(((await res.json()) as { error?: string }).error).toBe(
				"Thread summarization is unavailable right now.",
			);
		} finally {
			setThreadSummaryAiRunnerFactory(null);
		}
	});

	it("502s when the AI runner throws — the pool cannot run the real binding", async () => {
		const mailbox = "summary-unavailable@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedThreadEmail(stub, "live-1", "thread-live-1", { date: at(10) });
		await seedThreadEmail(stub, "live-2", "thread-live-1", { date: at(11) });

		// No seam: the real runner calls env.AI, which the pool cannot run
		// remotely — the route's live failure path.
		setThreadSummaryAiRunnerFactory(null);
		const res = await fetchSummary(mailbox, "thread-live-1");
		expect(res.status).toBe(502);
		expect(((await res.json()) as { error?: string }).error).toBe(
			"Thread summarization is unavailable right now.",
		);
	});
});
