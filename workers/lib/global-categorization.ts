// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * App-wide categorization settings (currently global categories) stored in
 * R2 rather than in an individual mailbox's settings JSON. Any mailbox with
 * `categorization.useGlobalCategories` enabled merges this list into its own
 * inbound classification categories.
 */

import {
	normalizeGlobalCategorizationSettings,
	type GlobalCategorizationSettings,
} from "../../shared/categories";

/** Keep this key outside the `mailboxes/` prefix so it isn't a mailbox. */
export const GLOBAL_CATEGORIZATION_KEY = "config/categorization.json";

export async function getGlobalCategorization(
	bucket: R2Bucket,
): Promise<GlobalCategorizationSettings> {
	const object = await bucket.get(GLOBAL_CATEGORIZATION_KEY);
	if (!object) return { categories: [] };

	try {
		return normalizeGlobalCategorizationSettings(await object.json());
	} catch {
		// Corrupt global settings should not break inbound email delivery.
		return { categories: [] };
	}
}

export async function putGlobalCategorization(
	bucket: R2Bucket,
	raw: unknown,
): Promise<GlobalCategorizationSettings> {
	const settings = normalizeGlobalCategorizationSettings(raw);
	await bucket.put(GLOBAL_CATEGORIZATION_KEY, JSON.stringify(settings));
	return settings;
}
