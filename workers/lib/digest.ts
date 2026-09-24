// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Morning digest: the trailing-24-hour brief for one mailbox, plus the POST
 * that delivers it to the mailbox's notification webhook.
 *
 * The digest is computed on demand by the mailbox Durable Object
 * (`MailboxDO.buildDigest`) and served read-only from
 * `/api/v1/mailboxes/:mailboxId/digest`. Once a day the digest cron (see
 * workers/lib/digest-sweep.ts) builds one for every mailbox that opted in
 * and delivers it here through the same signing helpers the new-mail
 * notifier uses (workers/lib/webhook.ts) — never through a fetch of its
 * own, so the outbound-webhook rules stay in one place.
 *
 * The wire shape is frozen: the UI, the webhook payload and the cron sweep
 * all read these field names, so they are a contract rather than a
 * convenience. Caps bound every list the digest carries.
 *
 * Delivery is best-effort by design, mirroring notifyNewEmail: a missing or
 * invalid URL, a timeout, a DNS error and a non-2xx answer are all logged
 * and reported in the result; `deliverDigest` never rejects, so a broken
 * endpoint can never stop the sweep.
 */


import {
	normalizeWebhookSecret,
	normalizeWebhookUrl,
	validateWebhookUrl,
} from "../../shared/webhook";
import type { Env } from "../types";
import { readMailboxSettings } from "./mailbox-settings";
import {
	buildWebhookRequest,
	signWebhookBody,
	type WebhookDeliveryResult,
} from "./webhook";


/** Cap on `recent`: the newest non-spam arrivals carried in the digest. */
export const DIGEST_RECENT_LIMIT = 10;

/** Cap on the `needs_reply` list, newest first. */
export const DIGEST_NEEDS_REPLY_LIMIT = 10;

/** Cap on `by_category` rows, largest count first. */
export const DIGEST_CATEGORY_LIMIT = 20;

/** Cap on `reminders`: the most recently fired follow-ups. */
export const DIGEST_REMINDER_LIMIT = 10;

/** Cap on `items.due`: the soonest-due open tasks and deadlines. */
export const DIGEST_ITEM_LIMIT = 10;

/**
 * Delivery rows kept per mailbox (newest UTC day first). The table is
 * append-only bookkeeping for the cron sweep, never message content.
 */
export const MAX_DIGEST_DELIVERIES = 90;


/**
 * One message referenced by the digest: enough to render a row or link back
 * to it. `folder` is the folder's display name; `category` is the stored
 * category id, or null when the message was never categorized.
 */
export interface DigestEmailRef {
	id: string;
	subject: string;
	sender: string;
	date: string;
	folder: string;
	category: string | null;
}


/** One follow-up reminder that already fired, as the reminders list shows it. */
export interface DigestReminderRef {
	id: string;
	subject: string;
	sender: string;
	/** ISO 8601 instant the follow-up fired (`emails.reminded_at`). */
	fired_at: string;
}


/** Arrival counts over the digest window. */
export interface DigestCounts {
	received: number;
	unread: number;
	starred: number;
	spam: number;
	needs_reply: number;
}


/** One `by_category` row: a category id and how many arrivals carry it. */
export interface DigestCategoryCount {
	category: string;
	count: number;
}


/**
 * One open task or deadline from the items extractor, as the digest's
 * `items.due` list carries it. `email_id` names the message the item came
 * from, so a receiver can link back to it.
 */
export interface DigestItemRef {
	id: string;
	title: string;
	/** ISO 8601 UTC instant the item is due. */
	due_at: string;
	email_id: string;
}


/** The open work the items extractor has stored for this mailbox. */
export interface DigestItems {
	/** Every open item, dated or not. */
	open: number;
	/** Open items already past due (due date before today, UTC). */
	overdue: number;
	/** Open items due on the digest's UTC day. */
	due_today: number;
	/** Soonest due first, at most DIGEST_ITEM_LIMIT; undated items excluded. */
	due: DigestItemRef[];
}


/**
 * FROZEN WIRE SHAPE. The API route, the webhook payload, the digest UI and
 * the cron sweep all read these field names — change them only with every
 * consumer.
 */
export interface Digest {
	mailbox: string;
	generated_at: string;
	window: { from: string; to: string };
	counts: DigestCounts;
	by_category: DigestCategoryCount[];
	needs_reply: DigestEmailRef[];
	recent: DigestEmailRef[];
	reminders: DigestReminderRef[];
	items: DigestItems;
}


/** Exact JSON body POSTed to the notification webhook for a digest. */
export interface DigestPayload extends Digest {
	type: "digest";
}


/** Outcome of one digest delivery attempt, stored per UTC day. */
export interface DigestDeliveryResult {
	ok: boolean;
	status: number | null;
	error: string | null;
}


/**
 * The digest window: the trailing 24 hours ending at `now`, as ISO 8601
 * instants. The stored `date` column carries receive time in the same
 * format, so the bounds compare as plain strings.
 */
export function digestWindow(now: Date): { from: string; to: string } {
	return {
		from: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
		to: now.toISOString(),
	};
}


/**
 * POST one digest to a mailbox's notification webhook.
 *
 * Never throws: every failure is logged and returned in the result, so a
 * broken endpoint can never affect the sweep (or anything else). `settings`
 * is the mailbox settings JSON when the caller already has it; otherwise it
 * is read from R2. The URL is validated before fetching even though it was
 * checked on write — a hand-edited R2 object must never become a fetch.
 */
export async function deliverDigest(
	env: Env,
	mailboxId: string,
	digest: Digest,
	settings?: Record<string, unknown>,
): Promise<WebhookDeliveryResult> {
	try {
		const mailboxSettings = settings ?? (await readMailboxSettings(env, mailboxId));

		const url = normalizeWebhookUrl(mailboxSettings["notifyWebhookUrl"]);
		if (!url) return { ok: false, status: null, error: null, skipped: true };

		const urlError = validateWebhookUrl(url);
		if (urlError) {
			console.error(`Digest for ${mailboxId} skipped: ${urlError}`);
			return { ok: false, status: null, error: urlError, skipped: true };
		}

		const secret = normalizeWebhookSecret(mailboxSettings["notifyWebhookSecret"]);
		const body = JSON.stringify(buildDigestPayload(mailboxId, digest));
		const signature = secret ? await signWebhookBody(secret, body) : null;

		const response = await fetch(buildWebhookRequest(url, body, signature));
		// The receiver's response body is irrelevant; release it unread.
		await response.body?.cancel().catch(() => {});

		if (!response.ok) {
			const error = `Webhook responded ${response.status}`;
			console.error(`Digest for ${mailboxId} failed: ${error}`);
			return { ok: false, status: response.status, error };
		}
		return { ok: true, status: response.status, error: null };
	} catch (error) {
		const message = (error as Error).message || "Digest request failed";
		console.error(`Digest for ${mailboxId} failed: ${message}`);
		return { ok: false, status: null, error: message };
	}
}


/**
 * The digest as the webhook receives it: the frozen fields plus a `type`
 * discriminator so a receiver can tell a digest apart from a new-mail
 * notification. `mailbox` names the mailbox that owns the digest, matching
 * the caller's target rather than whatever the DO recorded.
 */
export function buildDigestPayload(
	mailboxId: string,
	digest: Digest,
): DigestPayload {
	return {
		type: "digest",
		mailbox: mailboxId,
		generated_at: digest.generated_at,
		window: digest.window,
		counts: digest.counts,
		by_category: digest.by_category,
		needs_reply: digest.needs_reply,
		recent: digest.recent,
		reminders: digest.reminders,
		items: digest.items,
	};
}
