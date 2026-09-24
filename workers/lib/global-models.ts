// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * App-wide AI model settings stored in R2 rather than in an individual
 * mailbox's settings JSON. Any mailbox without its own override uses these;
 * mailboxes fall back to the built-in defaults (shared/models.ts) when
 * nothing is configured here either.
 */


import {
	normalizeGlobalModelSettings,
	type GlobalModelSettings,
} from "../../shared/models";


/** Keep this key outside the `mailboxes/` prefix so it isn't a mailbox. */
export const GLOBAL_MODELS_KEY = "config/models.json";


export async function getGlobalModels(
	bucket: R2Bucket,
): Promise<GlobalModelSettings> {
	const object = await bucket.get(GLOBAL_MODELS_KEY);
	if (!object) return { models: {} };


	try {
		return normalizeGlobalModelSettings(await object.json());
	} catch {
		// Corrupt global settings should not break AI calls; defaults apply.
		return { models: {} };
	}
}


export async function putGlobalModels(
	bucket: R2Bucket,
	raw: unknown,
): Promise<GlobalModelSettings> {
	const settings = normalizeGlobalModelSettings(raw);
	await bucket.put(GLOBAL_MODELS_KEY, JSON.stringify(settings));
	return settings;
}
