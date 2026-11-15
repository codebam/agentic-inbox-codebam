// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * On-demand AI compose rewrite (upstream #55, the core feature).
 *
 * Covers rewriteEmailBody through the runner seam (quick actions and custom
 * instructions, the resolved rewrite model incl. a per-mailbox override, and
 * the refusal paths: unknown action, missing custom instruction, empty model
 * answer), and the route over the real HTTP surface: the 200 {body} shape,
 * 400 for a missing body or unknown action, 404 for an unknown mailbox, and
 * 502 when the rewrite fails. Nothing here sends mail.
 */

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MODELS } from "../shared/models";
import { textToHtml } from "../workers/lib/email-helpers";
import {
	isRewriteAction,
	rewriteEmailBody,
	setRewriteAiRunnerFactory,
	type RewriteAiRunner,
} from "../workers/lib/ai-rewrite";
import type { Env } from "../workers/types";

const appEnv = env as unknown as Env;

async function registerMailbox(mailbox: string, settings: Record<string, unknown> = {}) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify(settings));
}

/** A runner that records its inputs and returns a fixed answer. */
function fakeRunner(answer: string | null) {
	const calls: { model: string; system: string; user: string }[] = [];
	const runner: RewriteAiRunner = {
		run: async (model, system, user) => {
			calls.push({ model, system, user });
			return answer;
		},
	};
	return { runner, calls };
}

function rewriteRoute(mailbox: string, payload: unknown): Promise<Response> {
	return SELF.fetch(`https://example.com/api/v1/mailboxes/${mailbox}/ai/rewrite`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
}

afterEach(() => setRewriteAiRunnerFactory(null));

describe("isRewriteAction", () => {
	it("accepts the five actions and rejects anything else", () => {
		for (const action of ["polish", "formalize", "friendly", "shorten", "custom"]) {
			expect(isRewriteAction(action)).toBe(true);
		}
		for (const bad of ["", "expand", "POLISH", 42, null, undefined]) {
			expect(isRewriteAction(bad)).toBe(false);
		}
	});
});

describe("rewriteEmailBody", () => {
	it("rewrites with the default rewrite model and returns HTML", async () => {
		const mailbox = "rewrite-default@example.com";
		await registerMailbox(mailbox);
		const { runner, calls } = fakeRunner("A cleaner draft.");
		setRewriteAiRunnerFactory(() => runner);
		const result = await rewriteEmailBody(appEnv, mailbox, "<p>hey there</p>", "polish");
		expect(result).toBe(textToHtml("A cleaner draft."));
		expect(calls[0]!.model).toBe(DEFAULT_MODELS.rewrite);
		expect(calls[0]!.user).toContain("hey there");
	});

	it("honours a per-mailbox rewrite model override", async () => {
		const mailbox = "rewrite-override@example.com";
		await registerMailbox(mailbox, { models: { rewrite: "vendor/custom-rewrite" } });
		const { runner, calls } = fakeRunner("Done.");
		setRewriteAiRunnerFactory(() => runner);
		await rewriteEmailBody(appEnv, mailbox, "<p>text</p>", "shorten");
		expect(calls[0]!.model).toBe("vendor/custom-rewrite");
	});

	it("passes a custom instruction through to the prompt", async () => {
		const mailbox = "rewrite-custom@example.com";
		await registerMailbox(mailbox);
		const { runner, calls } = fakeRunner("Translated.");
		setRewriteAiRunnerFactory(() => runner);
		await rewriteEmailBody(appEnv, mailbox, "<p>hello</p>", "custom", "Translate to French");
		expect(calls[0]!.user).toContain("Translate to French");
		expect(calls[0]!.user).toContain("hello");
	});

	it("refuses an unknown action", async () => {
		const mailbox = "rewrite-badaction@example.com";
		await registerMailbox(mailbox);
		await expect(
			rewriteEmailBody(appEnv, mailbox, "<p>x</p>", "expand" as never),
		).rejects.toThrow(/Unknown rewrite action/);
	});

	it("refuses a custom rewrite with no instruction", async () => {
		const mailbox = "rewrite-noinstr@example.com";
		await registerMailbox(mailbox);
		await expect(rewriteEmailBody(appEnv, mailbox, "<p>x</p>", "custom", "  ")).rejects.toThrow(
			/instruction/,
		);
	});

	it("refuses when the model returns nothing usable", async () => {
		const mailbox = "rewrite-empty@example.com";
		await registerMailbox(mailbox);
		const { runner } = fakeRunner("   ");
		setRewriteAiRunnerFactory(() => runner);
		await expect(rewriteEmailBody(appEnv, mailbox, "<p>x</p>", "polish")).rejects.toThrow(
			/no usable text/,
		);
	});
});

describe("POST /api/v1/mailboxes/:mailboxId/ai/rewrite", () => {
	it("returns the rewritten body", async () => {
		const mailbox = "rewrite-route@example.com";
		await registerMailbox(mailbox);
		const { runner } = fakeRunner("Rewritten body.");
		setRewriteAiRunnerFactory(() => runner);
		const res = await rewriteRoute(mailbox, { body: "<p>draft</p>", action: "polish" });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { body: string }).body).toBe(textToHtml("Rewritten body."));
	});

	it("rejects a missing body", async () => {
		const mailbox = "rewrite-nobody@example.com";
		await registerMailbox(mailbox);
		const res = await rewriteRoute(mailbox, { action: "polish" });
		expect(res.status).toBe(400);
	});

	it("rejects an unknown action", async () => {
		const mailbox = "rewrite-badroute@example.com";
		await registerMailbox(mailbox);
		const res = await rewriteRoute(mailbox, { body: "<p>x</p>", action: "expand" });
		expect(res.status).toBe(400);
	});

	it("answers 404 for an unknown mailbox", async () => {
		const res = await rewriteRoute("no-such-mailbox@example.com", {
			body: "<p>x</p>",
			action: "polish",
		});
		expect(res.status).toBe(404);
	});

	it("answers 502 when the rewrite fails", async () => {
		const mailbox = "rewrite-fail@example.com";
		await registerMailbox(mailbox);
		const runner: RewriteAiRunner = {
			run: async () => {
				throw new Error("model exploded");
			},
		};
		setRewriteAiRunnerFactory(() => runner);
		const res = await rewriteRoute(mailbox, { body: "<p>x</p>", action: "polish" });
		expect(res.status).toBe(502);
		expect(((await res.json()) as { error: string }).error).toContain("model exploded");
	});
});
