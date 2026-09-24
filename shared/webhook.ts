// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Outbound webhook settings shared by the Worker and the settings UI.
 *
 * A mailbox can point `notifyWebhookUrl` at an https endpoint that receives a
 * JSON POST for every non-spam message that arrives (the notifier itself lives
 * in workers/lib/webhook.ts). `notifyWebhookSecret` is optional and signs the
 * exact request body so the receiver can verify the notification came from
 * this app.
 */


/** Longest accepted webhook URL; keeps oversized garbage out of stored settings. */
export const MAX_WEBHOOK_URL_LENGTH = 2048;


/**
 * Human-readable reason a value cannot be stored as a webhook URL, or null
 * when it is acceptable.
 *
 * Absent and blank values are acceptable — they mean "no webhook" — so this
 * can be run over any settings object, submitted or stored.
 */
export function validateWebhookUrl(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") return "Webhook URL must be a string";
	const trimmed = value.trim();
	if (!trimmed) return null; // Blank clears the webhook.
	if (trimmed.length > MAX_WEBHOOK_URL_LENGTH) {
		return `Webhook URL must be at most ${MAX_WEBHOOK_URL_LENGTH} characters`;
	}
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return "Webhook URL must be a valid absolute URL, for example https://example.com/hooks/inbound";
	}
	if (url.protocol !== "https:") {
		return "Webhook URL must use https:// — notifications are never posted over plain http";
	}
	return null;
}


/** Trimmed webhook URL for storage; absent or blank clears the setting. */
export function normalizeWebhookUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}


/** Trimmed webhook signing secret for storage; absent or blank clears it. */
export function normalizeWebhookSecret(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}
