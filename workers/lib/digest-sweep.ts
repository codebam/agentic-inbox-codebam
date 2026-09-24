// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Morning-digest sweep: the second daily cron trigger (DIGEST_CRON).
 *
 * For every mailbox that opted in (`settings.digestEnabled === true`) and has
 * a notification webhook URL configured, it builds the trailing-24-hour
 * digest and POSTs it to that webhook — at most once per UTC day, because the
 * mailbox Durable Object claims the day before anything is built or sent (see
 * MailboxDO.claimDigestDay). A claim that fails (already delivered, or a
 * concurrent run won the race) is a skip, never a duplicate.
 *
 * Mirrors sweepDueMail: one mailbox's failure is logged, never rethrown, and
 * never stops the sweep; a failure after the day was claimed still settles the
 * delivery row so the day's outcome is recorded.
 */


import { normalizeDigestEnabled } from "../../shared/digest";
import { normalizeWebhookUrl } from "../../shared/webhook";
import type { Env } from "../types";
import { deliverDigest, digestWindow } from "./digest";
import { getMailboxStub, listMailboxes } from "./email-helpers";
import { readMailboxSettings } from "./mailbox-settings";


/** Cron expression for the morning-digest trigger (11:00 UTC, see wrangler.jsonc). */
export const DIGEST_CRON = "0 11 * * *";


export interface DigestSweepSummary {
	/** Mailboxes visited. */
	mailboxes: number;
	/** Mailboxes that opted in and have a webhook URL. */
	considered: number;
	/** Digests delivered (the endpoint answered 2xx). */
	delivered: number;
	/** Mailboxes skipped: disabled, no webhook URL, or the day already claimed. */
	skipped: number;
	/** Digests that were attempted but not delivered. */
	failed: number;
}


/**
 * Build and deliver every opted-in mailbox's digest for the UTC day `opts.now`
 * falls on.
 *
 * `opts.now` pins the clock (tests use it to stay deterministic); production
 * callers omit it.
 */
export async function sweepDigests(
	env: Env,
	opts: { now?: Date } = {},
): Promise<DigestSweepSummary> {
	const now = opts.now ?? new Date();
	const day = now.toISOString().slice(0, 10);
	const summary: DigestSweepSummary = {
		mailboxes: 0,
		considered: 0,
		delivered: 0,
		skipped: 0,
		failed: 0,
	};

	const mailboxes = await listMailboxes(env.BUCKET);
	for (const mailbox of mailboxes) {
		let claimed = false;
		try {
			summary.mailboxes++;
			const settings = await readMailboxSettings(env, mailbox.id);
			if (
				!normalizeDigestEnabled(settings["digestEnabled"]) ||
				!normalizeWebhookUrl(settings["notifyWebhookUrl"])
			) {
				// Disabled, or nowhere to deliver to — the digest needs both.
				summary.skipped++;
				continue;
			}
			summary.considered++;

			const stub = getMailboxStub(env, mailbox.id);
			claimed = await stub.claimDigestDay(day);
			if (!claimed) {
				// Another run already claimed (and is delivering) today's digest.
				summary.skipped++;
				continue;
			}

			const digest = await stub.buildDigest(digestWindow(now));
			const result = await deliverDigest(env, mailbox.id, digest, settings);
			await stub.recordDigestDelivery(day, {
				ok: result.ok,
				status: result.status,
				error: result.error,
			});
			if (result.ok) summary.delivered++;
			else summary.failed++;
		} catch (e) {
			console.error(
				`Digest sweep failed for ${mailbox.id}:`,
				(e as Error).message,
			);
			summary.failed++;
			if (claimed) {
				// Settle the claimed day so the row records the failure; today's
				// digest is lost either way and tomorrow's claim is unaffected.
				try {
					await getMailboxStub(env, mailbox.id).recordDigestDelivery(day, {
						ok: false,
						status: null,
						error: (e as Error).message,
					});
				} catch {
					// Best-effort: a broken mailbox must not stop the sweep.
				}
			}
		}
	}

	console.log(
		`Digest sweep: ${summary.mailboxes} mailbox(es) visited, ` +
			`${summary.considered} digest-enabled, ${summary.delivered} delivered, ` +
			`${summary.skipped} skipped, ${summary.failed} failed`,
	);
	return summary;
}
