// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Delete a mailbox and everything it owns.
 *
 * Removing only the R2 settings marker left the mailbox's Durable Object
 * SQLite state, its R2 attachment blobs and the agent's chat history behind
 * (upstream #1 / #60). This module removes all four.
 *
 * Ordering is deliberate: the marker goes last, so a failure part-way through
 * leaves the mailbox listed and the delete can simply be repeated. Every step
 * is idempotent — a retry re-wipes empty storage and re-deletes absent blobs.
 *
 * A Durable Object cannot touch R2, so the mailbox DO hands back its
 * attachment rows and the caller deletes the blobs — the same split as the
 * empty-trash route and the retention sweep.
 */


import type { Env } from "../types";
import { getMailboxStub } from "./email-helpers";


/** R2 accepts at most 1000 keys per delete call. */
const KEYS_PER_DELETE = 1000;


export interface MailboxPurgeSummary {
	/** Email rows removed from the mailbox DO. */
	emails: number;
	/** Attachment rows removed; one R2 blob per row. */
	attachments: number;
	/** Blobs deleted from R2 (equals `attachments` unless R2 failed). */
	blobsDeleted: number;
}


/**
 * Purge one mailbox: DO state, attachment blobs, agent history, then the
 * settings marker. Callers must confirm the marker exists first if a 404 for
 * an unknown mailbox is part of their contract.
 */
export async function purgeMailbox(
	env: Env,
	mailboxId: string,
): Promise<MailboxPurgeSummary> {
	const { emails, attachments } = await getMailboxStub(env, mailboxId).purgeAll();

	const keys = attachments.map(
		(att) => `attachments/${att.email_id}/${att.id}/${att.filename}`,
	);
	for (let i = 0; i < keys.length; i += KEYS_PER_DELETE) {
		await env.BUCKET.delete(keys.slice(i, i + KEYS_PER_DELETE));
	}

	// Chat history lives in its own DO keyed by mailbox id. The name is set
	// explicitly because this RPC call bypasses the fetch entry point that
	// normally hydrates it, and destroy() emits an event that reads it.
	// destroy() drops the agent's tables, alarms and storage.
	const agentStub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId));
	await agentStub.setName(mailboxId);
	await agentStub.destroy();

	// Last: without the marker the mailbox is gone from every listing, so it
	// must only disappear once the purge actually succeeded.
	await env.BUCKET.delete(`mailboxes/${mailboxId}.json`);

	return { emails, attachments: attachments.length, blobsDeleted: keys.length };
}
