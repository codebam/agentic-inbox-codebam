// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0




/**
 * App-wide email view settings stored in R2 rather than in an individual
 * mailbox's settings JSON. Any mailbox without its own override uses these;
 * mailboxes fall back to the built-in default (shared/email-view.ts) when
 * nothing is configured here either.
 */




import {
	normalizeGlobalEmailViewSettings,
	type GlobalEmailViewSettings,
} from "../../shared/email-view";




/** Keep this key outside the `mailboxes/` prefix so it isn't a mailbox. */
export const GLOBAL_EMAIL_VIEW_KEY = "config/email-view.json";




export async function getGlobalEmailView(
	bucket: R2Bucket,
): Promise<GlobalEmailViewSettings> {
	const object = await bucket.get(GLOBAL_EMAIL_VIEW_KEY);
	if (!object) return {};




	try {
		return normalizeGlobalEmailViewSettings(await object.json());
	} catch {
		// Corrupt global settings should not break the message view; the
		// built-in default applies.
		return {};
	}
}




export async function putGlobalEmailView(
	bucket: R2Bucket,
	raw: unknown,
): Promise<GlobalEmailViewSettings> {
	const settings = normalizeGlobalEmailViewSettings(raw);
	await bucket.put(GLOBAL_EMAIL_VIEW_KEY, JSON.stringify(settings));
	return settings;
}
