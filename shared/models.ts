// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * AI model configuration shared by the Worker, Durable Object, Agent/MCP
 * tools and the settings UI.
 *
 * Every model id has a built-in default. App-wide settings (Global Settings)
 * can override the defaults and a mailbox can override both. Blank or
 * whitespace-only values mean "use the inherited/default model", so clearing
 * a field in the UI is always safe.
 */


/** Built-in defaults: the model ids the app shipped with. */
export const DEFAULT_MODELS = {
	/** Chat model used by the built-in email agent. */
	agent: "@cf/qwen/qwen3.8-27b",
	/** Model that proofreads drafts (verifyDraft). */
	draftVerify: "@cf/meta/llama-4-scout-17b-16e-instruct",
	/** Model that scans inbound mail for prompt injection. */
	promptInjection: "@cf/meta/llama-3.1-8b-instruct-fast",
	/** Model that classifies inbound mail (spam + categories). */
	classifier: "typesafe/jev",
} as const;


export type ModelConfigKey = keyof typeof DEFAULT_MODELS;


/** Stable iteration order for the UI and validation. */
export const MODEL_CONFIG_KEYS: readonly ModelConfigKey[] = [
	"agent",
	"draftVerify",
	"promptInjection",
	"classifier",
];


/** Human-readable labels, used by the settings UI and error messages. */
export const MODEL_CONFIG_LABELS: Record<ModelConfigKey, string> = {
	agent: "Agent chat model",
	draftVerify: "Draft verifier model",
	promptInjection: "Prompt-injection scanner model",
	classifier: "Email classifier model",
};


/** Longest accepted model id; keeps garbage out of stored settings. */
export const MAX_MODEL_ID_LENGTH = 120;


/** Per-mailbox (or per-app) model overrides. Every field is optional. */
export interface ModelConfig {
	agent?: string;
	draftVerify?: string;
	promptInjection?: string;
	classifier?: string;
}


/** Model ids after inheritance has been resolved; never blank. */
export type EffectiveModelConfig = Record<ModelConfigKey, string>;


/** App-wide model settings stored in R2 (`config/models.json`). */
export interface GlobalModelSettings {
	models: ModelConfig;
}


/** Trim a candidate model id; blank or oversized values count as unset. */
function pickModelId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > MAX_MODEL_ID_LENGTH) return undefined;
	return trimmed;
}


/**
 * Read a model config from either `{ models: {...} }` (settings payloads) or
 * a bare `{ agent, draftVerify, ... }` object.
 */
function readModelConfig(raw: unknown): ModelConfig {
	if (!raw || typeof raw !== "object") return {};
	const value = raw as { models?: unknown };
	const source =
		value.models && typeof value.models === "object" ? value.models : value;
	return normalizeModelConfig(source);
}


/**
 * Turn arbitrary model settings JSON into a clean shape: strings only,
 * trimmed, blanks and oversized values dropped.
 */
export function normalizeModelConfig(raw: unknown): ModelConfig {
	if (!raw || typeof raw !== "object") return {};
	const source = raw as Record<string, unknown>;
	const normalized: ModelConfig = {};
	for (const key of MODEL_CONFIG_KEYS) {
		const value = pickModelId(source[key]);
		if (value) normalized[key] = value;
	}
	return normalized;
}


/** Normalize the app-wide model settings payload. */
export function normalizeGlobalModelSettings(
	raw: unknown,
): GlobalModelSettings {
	return { models: readModelConfig(raw) };
}


/**
 * Resolve the effective model ids: mailbox override, then app-wide override,
 * then the built-in default. Blank/whitespace values are ignored at every
 * level.
 */
export function resolveModelConfig(
	mailboxSettings?: unknown,
	globalSettings?: unknown,
): EffectiveModelConfig {
	const mailbox = readModelConfig(mailboxSettings);
	const global = readModelConfig(globalSettings);
	const effective = {} as EffectiveModelConfig;
	for (const key of MODEL_CONFIG_KEYS) {
		effective[key] = mailbox[key] ?? global[key] ?? DEFAULT_MODELS[key];
	}
	return effective;
}


/**
 * Validate a model id for the settings UI and API.
 * @returns an error message, or null when the value looks usable.
 */
export function validateModelId(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) {
		return "Enter a model ID, or leave the field empty to use the default.";
	}
	if (trimmed.length > MAX_MODEL_ID_LENGTH) {
		return `Model IDs are limited to ${MAX_MODEL_ID_LENGTH} characters.`;
	}
	if (/\s/.test(trimmed)) {
		return "Model IDs cannot contain spaces.";
	}
	if (!/^[A-Za-z0-9@][A-Za-z0-9._:@/-]*$/.test(trimmed)) {
		return "Model IDs may only contain letters, numbers and . _ : @ / -";
	}
	if (!trimmed.includes("/")) {
		return 'Model IDs look like "provider/model" (for example @cf/meta/llama-3.1-8b-instruct-fast or typesafe/jev).';
	}
	return null;
}


/**
 * Validate every non-empty model id in a settings payload.
 *
 * Raw string values are validated before normalization drops oversized or
 * malformed ids, so the settings UI and the API surface the same errors.
 * @returns a map of field -> error message (empty when everything is valid).
 */
export function modelConfigErrors(
	raw: unknown,
): Partial<Record<ModelConfigKey, string>> {
	if (!raw || typeof raw !== "object") return {};
	const value = raw as { models?: unknown };
	const source =
		value.models && typeof value.models === "object" ? value.models : value;
	const errors: Partial<Record<ModelConfigKey, string>> = {};
	for (const key of MODEL_CONFIG_KEYS) {
		const candidate = (source as Record<string, unknown>)[key];
		if (typeof candidate !== "string" || !candidate.trim()) continue;
		const error = validateModelId(candidate);
		if (error) errors[key] = error;
	}
	return errors;
}
