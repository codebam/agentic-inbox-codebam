// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Helpers for reading Workers AI responses.
 *
 * The binding returns two shapes depending on the model:
 *
 * - native text generation: `{ response: "..." }` (for example
 *   `@cf/meta/llama-4-scout-17b-16e-instruct`);
 * - OpenAI-compatible chat completions: `{ choices: [{ message: {
 *   content, reasoning_content } }] }` (for example
 *   `@cf/deepseek-ai/deepseek-v4.1-flash-1017`).
 *
 * Every model id is configurable per mailbox, so callers must not assume one
 * shape. `extractModelText` returns the answer text from either.
 */


/**
 * Read the assistant's answer text out of a Workers AI response.
 *
 * Only the final answer is returned: `reasoning_content` is the model's
 * trace, never the answer, so it is skipped. Returns "" when there is no
 * usable text.
 */
export function extractModelText(response: unknown): string {
	if (!response || typeof response !== "object") return "";
	const record = response as { response?: unknown; choices?: unknown };

	// Native Workers AI text generation.
	if (typeof record.response === "string") return record.response;

	// OpenAI-compatible chat completions.
	if (Array.isArray(record.choices)) {
		for (const choice of record.choices) {
			const content = (choice as { message?: { content?: unknown } } | null)
				?.message?.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				const text = content
					.map((part) => {
						if (typeof part === "string") return part;
						if (part && typeof part === "object") {
							const candidate = (part as { text?: unknown }).text;
							if (typeof candidate === "string") return candidate;
						}
						return "";
					})
					.join("");
				if (text) return text;
			}
		}
	}

	return "";
}


/** Levels the Workers AI request schema accepts for `reasoning_effort`. */
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "max";


/**
 * Models that accept `reasoning_effort`, with the levels each documents.
 *
 * Only models the app defaults to are listed: a mailbox can point any job at
 * any model, and sending a field a model does not accept risks a rejected
 * request, so anything absent gets no field and uses the model's own default.
 */
const REASONING_EFFORT_LEVELS: Record<string, readonly ReasoningEffort[]> = {
	"@cf/deepseek-ai/deepseek-v4.1-flash-1017": ["none", "low", "high", "max"],
};


/**
 * The `reasoning_effort` request field for a model, or an empty object when
 * that model does not document the level.
 *
 * Pipeline calls use this to keep short, strict outputs (item extraction)
 * free of reasoning tokens and to lower the effort for thread summaries.
 */
export function reasoningEffortParam(
	model: string,
	effort: ReasoningEffort,
): { reasoning_effort?: ReasoningEffort } {
	const levels = REASONING_EFFORT_LEVELS[model.trim()];
	return levels?.includes(effort) ? { reasoning_effort: effort } : {};
}
