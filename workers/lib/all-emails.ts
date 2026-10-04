// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Cross-mailbox listing fan-out: the All Accounts view's data layer.
 *
 * Shared by GET /api/v1/all-emails and the agent/MCP `list_all_emails`
 * tool so both merge every mailbox's mail identically: counts are summed
 * first so the requested global page clamps exactly, each mailbox's top-K
 * is fetched past the Durable Object's 100-row page limit, and the merged
 * rows come back sorted by date descending, each annotated with the
 * mailbox it belongs to. A `folder` applies that folder to every mailbox
 * (conversation rows, the threaded listing the web's folder tabs render);
 * without one, everything merges (message rows).
 */

import type { MailboxDO } from "../durableObject";
import type { Env } from "../types";
import { getMailboxStub, listMailboxes } from "./email-helpers";


/** The Durable Object caps one page at 100 rows; fetch top-K in these chunks. */
const ALL_EMAILS_CHUNK = 100;


/** One row of a mailbox list page, as returned by the Durable Object. */
type AllEmailsRow = Awaited<ReturnType<MailboxDO["getEmails"]>>[number];

/** Options the two list RPCs accept, derived from the Durable Object. */
type ListEmailsOptions = NonNullable<Parameters<MailboxDO["getEmails"]>[0]>;

/** The list RPCs the cross-mailbox fan-out calls. */
type MailboxListingStub = {
	getEmails: (options: ListEmailsOptions) => Promise<AllEmailsRow[]>;
	getThreadedEmails: (options: ListEmailsOptions) => Promise<AllEmailsRow[]>;
	countEmails: (
		options: NonNullable<Parameters<MailboxDO["countEmails"]>[0]>,
	) => Promise<number>;
	countThreadedEmails: (folder: string) => Promise<number>;
};


/** Parameters the All Accounts listing accepts. */
export interface ListAllEmailsParams {
	/**
	 * Folder id/name applied to every mailbox ("inbox", "sent", ...).
	 * Absent or "all" merges every folder of every mailbox.
	 */
	folder?: string | undefined;
	page?: number | undefined;
	limit?: number | undefined;
}


/** A merged All Accounts page: rows tagged with their source mailbox. */
export interface ListAllEmailsResult {
	emails: (AllEmailsRow & { mailboxId: string })[];
	totalCount: number;
}


/**
 * Fetch the top `top` rows from one mailbox, chunking past the Durable
 * Object's 100-row page limit. Per-mailbox top-K is sufficient to compute
 * an exact global page of size K when the rows are merged by date, because
 * the global top-K can only contain rows from each mailbox's own top-K.
 */
async function getTopMailboxEmails(
	stub: MailboxListingStub,
	folder: string | undefined,
	top: number,
): Promise<AllEmailsRow[]> {
	const emails: AllEmailsRow[] = [];
	for (let offset = 0; offset < top; offset += ALL_EMAILS_CHUNK) {
		const limit = Math.min(ALL_EMAILS_CHUNK, top - offset);
		const page = Math.floor(offset / ALL_EMAILS_CHUNK) + 1;
		const rows = folder
			? await stub.getThreadedEmails({ folder, page, limit })
			: await stub.getEmails({ page, limit });
		emails.push(...rows);
		if (rows.length < limit) break;
	}
	return emails;
}


/**
 * List every mailbox's mail at once, merged by date descending — the All
 * Accounts view. Read-only: it reads every mailbox and writes nothing.
 */
export async function listAllEmails(
	env: Env,
	params: ListAllEmailsParams = {},
): Promise<ListAllEmailsResult> {
	const folder =
		params.folder && params.folder !== "all" ? params.folder : undefined;
	const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
	const requestedPage = Math.max(params.page ?? 1, 1);

	const mailboxes = await listMailboxes(env.BUCKET);
	const stubs = mailboxes.map(({ id }) => ({
		mailboxId: id,
		stub: getMailboxStub(env, id) as unknown as MailboxListingStub,
	}));

	// Count first so we can clamp the requested global page and size each
	// per-mailbox top-K fetch exactly.
	const counts = await Promise.all(
		stubs.map(({ stub }) =>
			folder ? stub.countThreadedEmails(folder) : stub.countEmails({}),
		),
	);
	const totalCount = counts.reduce((sum, count) => sum + count, 0);
	if (totalCount === 0) return { emails: [], totalCount: 0 };

	const maxPage = Math.max(1, Math.ceil(totalCount / limit));
	const page = Math.min(requestedPage, maxPage);
	const top = page * limit;

	const perMailbox = await Promise.all(
		stubs.map(async ({ mailboxId, stub }) => ({
			mailboxId,
			emails: await getTopMailboxEmails(stub, folder, top),
		})),
	);

	const merged = perMailbox
		.flatMap(({ mailboxId, emails }) =>
			emails.map((email) => ({ ...email, mailboxId })),
		)
		.sort((a, b) => {
			const aTime = Date.parse(String(a.date ?? ""));
			const bTime = Date.parse(String(b.date ?? ""));
			return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
		});

	const offset = (page - 1) * limit;
	return { emails: merged.slice(offset, offset + limit), totalCount };
}
