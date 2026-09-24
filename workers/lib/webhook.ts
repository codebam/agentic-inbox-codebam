// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Outbound webhook notifications for new mail.
 *
 * When a mailbox sets `notifyWebhookUrl` (see shared/webhook.ts for the
 * validation rules), every message that lands in the mailbox triggers one
 * JSON POST to that URL with an `X-Agentic-Inbox-Signature: sha256=<hmac>`
 * header when a secret is configured.
 *
 * Delivery is best-effort by design, mirroring inbound rule/classification
 * handling:
 *   - Notification only. This module never sends mail and never touches the
 *     send path — it is a plain outbound HTTP POST to a URL the user set.
 *   - Failures never affect mail delivery. A missing or invalid URL, a
 *     timeout, a DNS error and a non-2xx answer are all logged and reported
 *     in the result; `notifyNewEmail` never rejects, so callers can hand it
 *     straight to `ctx.waitUntil` after storing the message.
 *   - Non-spam arrivals only. AI-classified spam, mail a rule filed in Spam
 *     and mail stamped with the spam category are skipped, matching the
 *     auto-draft rules: a spam endpoint would otherwise be told about every
 *     piece of junk the mailbox receives.
 */


import {
	normalizeWebhookSecret,
	normalizeWebhookUrl,
	validateWebhookUrl,
} from "../../shared/webhook";
import type { Env } from "../types";
import { stripHtmlToText } from "./email-helpers";
import { readMailboxSettings } from "./mailbox-settings";


/** Hard cap on how long one notification may take before we give up. */
export const WEBHOOK_TIMEOUT_MS = 5_000;


/** Longest plain-text preview carried in the payload. */
export const WEBHOOK_SNIPPET_MAX_LENGTH = 200;


/** One arrival, as stored by the mailbox Durable Object. */
export interface WebhookEmail {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	/** Receive time (ISO 8601), the same convention the stored row uses. */
	date: string;
	folder: string;
	category?: string | null;
	/** Full body; the payload carries a truncated plain-text preview of it. */
	body?: string | null;
}


/** Exact JSON body POSTed to the webhook URL. */
export interface WebhookPayload {
	mailbox: string;
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	date: string;
	folder: string;
	category: string | null;
	snippet: string;
}


export interface WebhookDeliveryResult {
	/** True when the endpoint answered 2xx. */
	ok: boolean;
	/** Upstream HTTP status, or null when the request never got a response. */
	status: number | null;
	/** Human-readable failure reason, or null on success. */
	error: string | null;
	/** True when nothing was sent (no URL configured, or the stored URL is unusable). */
	skipped?: boolean;
}


/**
 * Collapse a message body into a short single-line plain-text preview.
 * Truncation appends an ellipsis so receivers can tell a cut snippet apart
 * from a short message.
 */
export function emailSnippet(
	body: string | null | undefined,
	maxLength: number = WEBHOOK_SNIPPET_MAX_LENGTH,
): string {
	const text = stripHtmlToText(body ?? "");
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength).trimEnd()}…`;
}


/** Build the notification body for one arrival. */
export function buildWebhookPayload(
	mailboxId: string,
	email: WebhookEmail,
): WebhookPayload {
	return {
		mailbox: mailboxId,
		id: email.id,
		subject: email.subject,
		sender: email.sender,
		recipient: email.recipient,
		date: email.date,
		folder: email.folder,
		category: email.category ?? null,
		snippet: emailSnippet(email.body),
	};
}


/**
 * `sha256=<hex hmac>` over the exact request body bytes. Receivers recompute
 * the HMAC with the shared secret over the raw body to verify the sender.
 */
export async function signWebhookBody(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(body),
	);
	const hex = [...new Uint8Array(signature)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `sha256=${hex}`;
}


/**
 * POST request for one notification. The body is sent verbatim so the
 * signature always matches the bytes the receiver sees.
 */
export function buildWebhookRequest(
	url: string,
	body: string,
	signature: string | null,
): Request {
	return new Request(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(signature ? { "X-Agentic-Inbox-Signature": signature } : {}),
		},
		body,
		signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
	});
}


/**
 * Notify a mailbox's webhook about one newly stored message.
 *
 * Never throws: every failure is logged and returned in the result, so a
 * broken endpoint can never affect mail delivery. `settings` is the mailbox
 * settings JSON when the caller already has it; otherwise it is read from R2.
 */
export async function notifyNewEmail(
	env: Env,
	mailboxId: string,
	email: WebhookEmail,
	settings?: Record<string, unknown>,
): Promise<WebhookDeliveryResult> {
	try {
		const mailboxSettings = settings ?? (await readMailboxSettings(env, mailboxId));

		const url = normalizeWebhookUrl(mailboxSettings["notifyWebhookUrl"]);
		if (!url) return { ok: false, status: null, error: null, skipped: true };

		// Settings are validated on write, but a hand-edited R2 object (or a
		// stale client) can still hold an unusable URL — never fetch it.
		const urlError = validateWebhookUrl(url);
		if (urlError) {
			console.error(`Webhook for ${mailboxId} skipped: ${urlError}`);
			return { ok: false, status: null, error: urlError, skipped: true };
		}

		const secret = normalizeWebhookSecret(mailboxSettings["notifyWebhookSecret"]);
		const body = JSON.stringify(buildWebhookPayload(mailboxId, email));
		const signature = secret ? await signWebhookBody(secret, body) : null;

		const response = await fetch(buildWebhookRequest(url, body, signature));
		// The receiver's response body is irrelevant; release it unread.
		await response.body?.cancel().catch(() => {});

		if (!response.ok) {
			const error = `Webhook responded ${response.status}`;
			console.error(`Webhook for ${mailboxId} failed: ${error}`);
			return { ok: false, status: response.status, error };
		}
		return { ok: true, status: response.status, error: null };
	} catch (error) {
		const message = (error as Error).message || "Webhook request failed";
		console.error(`Webhook for ${mailboxId} failed: ${message}`);
		return { ok: false, status: null, error: message };
	}
}
