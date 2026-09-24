// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Automatic Trash retention sweep.
 *
 * Runs on the daily cron trigger (see `scheduled` in workers/app.ts) and on
 * demand from tests. For every mailbox with retention enabled it asks the
 * mailbox DO to purge messages that entered Trash before the cutoff, then
 * deletes their R2 attachment blobs — a DO cannot touch R2, so the DO returns
 * the attachment rows and the worker removes the objects, exactly like the
 * empty-trash route.
 *
 * Attachment keys use the same layout as the empty-trash route:
 *   attachments/{email_id}/{attachment_id}/{filename}
 */


import type { Env } from "../types";
import { getMailboxStub, listMailboxes } from "./email-helpers";
import { readMailboxSettings } from "./mailbox-settings";
import {
	normalizeTrashRetentionDays,
	trashRetentionCutoffIso,
} from "../../shared/trash-retention";


export interface TrashSweepSummary {
	/** Mailboxes swept (retention enabled); mailboxes with retention off are skipped. */
	mailboxes: number;
	/** Emails permanently deleted across every swept mailbox. */
	purged: number;
	/** R2 attachment blobs deleted for those emails. */
	blobsDeleted: number;
}


/**
 * Delete expired Trash messages for every mailbox that has retention enabled.
 *
 * `opts.now` pins the clock (tests use it to stay deterministic); production
 * callers omit it. A failure in one mailbox is logged and never stops the
 * sweep, so a single bad mailbox cannot block cleanup everywhere else.
 */
export async function sweepTrash(
	env: Env,
	opts: { now?: Date } = {},
): Promise<TrashSweepSummary> {
	const now = opts.now ?? new Date();
	const summary: TrashSweepSummary = { mailboxes: 0, purged: 0, blobsDeleted: 0 };

	const mailboxes = await listMailboxes(env.BUCKET);
	for (const mailbox of mailboxes) {
		try {
			const settings = await readMailboxSettings(env, mailbox.id);
			const retentionDays = normalizeTrashRetentionDays(settings["trashRetentionDays"]);
			if (retentionDays === 0) continue;

			summary.mailboxes++;
			const cutoff = trashRetentionCutoffIso(retentionDays, now);
			const { purged, attachments } = await getMailboxStub(
				env,
				mailbox.id,
			).purgeTrashedBefore(cutoff);
			summary.purged += purged;

			if (attachments.length > 0) {
				await env.BUCKET.delete(
					attachments.map(
						(att) => `attachments/${att.email_id}/${att.id}/${att.filename}`,
					),
				);
				summary.blobsDeleted += attachments.length;
			}
		} catch (e) {
			console.error(
				`Trash retention sweep failed for ${mailbox.id}:`,
				(e as Error).message,
			);
		}
	}

	console.log(
		`Trash retention sweep: ${summary.mailboxes} mailbox(es) swept, ` +
			`${summary.purged} email(s) purged, ${summary.blobsDeleted} blob(s) deleted`,
	);
	return summary;
}
