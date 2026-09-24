// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Read-side helpers for a mailbox's stored settings JSON (R2):
 * effective AI model ids and the outbound signature.
 *
 * Kept next to `global-models.ts` so every worker-side caller (API routes,
 * agent, MCP tools) resolves model ids and signatures the same way.
 */


import {
	normalizeSignatureSettings,
	type SignatureSettings,
} from "../../shared/signature";
import {
	resolveModelConfig,
	type EffectiveModelConfig,
} from "../../shared/models";
import type { Env } from "../types";
import { getGlobalModels } from "./global-models";


/**
 * Read a mailbox's raw settings JSON. Never throws: a missing or corrupt file
 * resolves to `{}` so callers fall back to defaults.
 */
export async function readMailboxSettings(
	env: Env,
	mailboxId: string,
): Promise<Record<string, unknown>> {
	try {
		const object = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
		if (!object) return {};
		const parsed = await object.json();
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}


/**
 * Effective AI model ids for a mailbox: mailbox overrides win over the
 * app-wide settings, which win over the built-in defaults.
 */
export async function resolveMailboxModels(
	env: Env,
	mailboxId: string,
	settings?: Record<string, unknown>,
): Promise<EffectiveModelConfig> {
	const mailboxSettings = settings ?? (await readMailboxSettings(env, mailboxId));
	return resolveModelConfig(mailboxSettings, await getGlobalModels(env.BUCKET));
}


/**
 * Normalized signature settings for a mailbox, or undefined when none are
 * configured. Disabled signatures are returned as-is (the caller renders
 * nothing) so the UI can still show the saved configuration.
 */
export async function loadMailboxSignature(
	env: Env,
	mailboxId: string,
	settings?: Record<string, unknown>,
): Promise<SignatureSettings | undefined> {
	const mailboxSettings = settings ?? (await readMailboxSettings(env, mailboxId));
	return normalizeSignatureSettings(mailboxSettings.signature);
}
