// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * On-demand AI rewrite of a compose draft (upstream #55, the core feature).
 *
 * The reader picks a quick action (polish / formalize / friendly / shorten)
 * or types a custom instruction; the mailbox's configured rewrite model
 * rewrites the body and the result replaces the draft. This is a deliberate
 * user action on text they are composing — not the inbound auto-draft path —
 * so it runs the mailbox's resolved model and returns only the rewritten body.
 *
 * Uses the same Workers AI runner shape as the thread summarizer: a resolved
 * model id, a system + user message, and `extractModelText` to read the answer
 * off either response shape. A factory seam lets tests inject a fake runner.
 */

import { stripHtmlToText, textToHtml } from "./email-helpers";
import { resolveMailboxModels } from "./mailbox-settings";
import { extractModelText, reasoningEffortParam } from "./model-output";
import type { Env } from "../types";

export type RewriteAction = "polish" | "formalize" | "friendly" | "shorten" | "custom";

export const REWRITE_ACTIONS: readonly RewriteAction[] = [
	"polish",
	"formalize",
	"friendly",
	"shorten",
	"custom",
];

export function isRewriteAction(value: unknown): value is RewriteAction {
	return typeof value === "string" && (REWRITE_ACTIONS as readonly string[]).includes(value);
}

const ACTION_PROMPTS: Record<Exclude<RewriteAction, "custom">, string> = {
	polish:
		"Improve the writing quality of this email. Fix grammar, improve clarity, and make it more professional while keeping the same meaning and tone.",
	formalize:
		"Rewrite this email in a more formal, professional tone. Keep the same meaning but use more formal language.",
	friendly:
		"Rewrite this email in a warmer, more friendly and conversational tone. Keep the same meaning but sound more approachable.",
	shorten:
		"Make this email shorter and more concise. Remove unnecessary words and keep only the essential information.",
};

const SYSTEM_PROMPT =
	'You are an email writing assistant. You rewrite email drafts according to instructions. Return ONLY the rewritten email body — no greetings like "Here\'s the rewrite", no explanations, no markdown formatting. Output plain text only.';

/** One rewrite call: the model plus the two prompts, returning the answer text. */
export interface RewriteAiRunner {
	run: (model: string, systemPrompt: string, userPrompt: string) => Promise<string | null>;
}

let rewriteAiRunnerFactoryOverride: (() => RewriteAiRunner) | null = null;

/** Test seam: replace the runner (pass null to restore the real one). */
export function setRewriteAiRunnerFactory(factory: (() => RewriteAiRunner) | null): void {
	rewriteAiRunnerFactoryOverride = factory;
}

export function createRewriteAiRunner(env: Env): RewriteAiRunner {
	return {
		run: async (model, systemPrompt, userPrompt) => {
			const response = await env.AI.run(model, {
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userPrompt },
				],
				max_tokens: 4096,
				temperature: 0.7,
				...reasoningEffortParam(model, "low"),
			});
			return extractModelText(response) || null;
		},
	};
}

function resolveRewriteAiRunner(env: Env): RewriteAiRunner {
	return rewriteAiRunnerFactoryOverride?.() ?? createRewriteAiRunner(env);
}

/**
 * Rewrite a compose body with the mailbox's configured rewrite model. Returns
 * the rewritten body as HTML. Throws when the action is unknown, a custom
 * instruction is missing, or the model returns nothing usable — the route
 * turns that into an error response rather than silently clearing the draft.
 */
export async function rewriteEmailBody(
	env: Env,
	mailboxId: string,
	body: string,
	action: RewriteAction,
	customInstruction?: string,
): Promise<string> {
	if (!isRewriteAction(action)) {
		throw new Error(`Unknown rewrite action: ${String(action)}`);
	}
	const instruction = customInstruction?.trim();
	if (action === "custom" && !instruction) {
		throw new Error("A custom rewrite needs an instruction.");
	}

	const models = await resolveMailboxModels(env, mailboxId);
	const plainText = stripHtmlToText(body);
	const userPrompt =
		action === "custom"
			? `${instruction}\n\nEmail to rewrite:\n${plainText}`
			: `${ACTION_PROMPTS[action]}\n\nEmail to rewrite:\n${plainText}`;

	const runner = resolveRewriteAiRunner(env);
	const text = await runner.run(models.rewrite, SYSTEM_PROMPT, userPrompt);
	if (!text || !text.trim()) {
		throw new Error("The rewrite model returned no usable text.");
	}
	return textToHtml(text.trim());
}
