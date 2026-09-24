// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Snooze + reminder wake sweep.
 *
 * Every mailbox DO arms its own alarm for the next due snooze or reminder
 * (see MailboxDO.alarm), but an alarm is not a guarantee: it can be missed
 * while a DO is throttled or evicted mid-flight, and a mailbox whose state
 * changed while the alarm was down has no other path back to the surface.
 * This sweep runs on the cron trigger (see `scheduled` in workers/app.ts) and
 * asks every mailbox to drain whatever is due, so a missed alarm delays a
 * wake until the next run instead of stranding the message.
 *
 * It mirrors sweepTrash: one failing mailbox is logged and never stops the
 * sweep. There is no per-mailbox setting to consult — a snooze or reminder is
 * always due once its time passes — so every mailbox is visited.
 */


import type { Env } from "../types";
import { getMailboxStub, listMailboxes } from "./email-helpers";


export interface SnoozeSweepSummary {
	/** Mailboxes visited. */
	mailboxes: number;
	/** Snoozed messages returned to the folder they came from. */
	woken: number;
	/** Follow-up reminders that fired. */
	fired: number;
}


/**
 * Drain due snoozes and reminders for every mailbox.
 *
 * `opts.now` pins the clock (tests use it to stay deterministic); production
 * callers omit it.
 */
export async function sweepDueSnoozes(
	env: Env,
	opts: { now?: Date } = {},
): Promise<SnoozeSweepSummary> {
	const now = (opts.now ?? new Date()).toISOString();
	const summary: SnoozeSweepSummary = { mailboxes: 0, woken: 0, fired: 0 };

	const mailboxes = await listMailboxes(env.BUCKET);
	for (const mailbox of mailboxes) {
		try {
			const stub = getMailboxStub(env, mailbox.id);
			summary.mailboxes++;
			summary.woken += await stub.wakeDueSnoozes(now);
			summary.fired += await stub.fireDueReminders(now);
		} catch (e) {
			console.error(
				`Snooze sweep failed for ${mailbox.id}:`,
				(e as Error).message,
			);
		}
	}

	console.log(
		`Snooze sweep: ${summary.mailboxes} mailbox(es) swept, ` +
			`${summary.woken} snooze(s) woken, ${summary.fired} reminder(s) fired`,
	);
	return summary;
}
