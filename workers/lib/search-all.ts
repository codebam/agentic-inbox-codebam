// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Cross-mailbox search fan-out.
 *
 * Shared by GET /api/v1/search and the agent/MCP `search_all_mailboxes` tool
 * so both merge every mailbox's matches identically: each row comes back
 * annotated with the mailbox it belongs to, merged by date descending.
 */

import type { Env } from "../types";
import { getMailboxStub, listMailboxes } from "./email-helpers";


/** The Durable Object caps one page at 100 rows; fetch top-K in these chunks. */
const SEARCH_CHUNK = 100;


/** Search filters accepted by the Durable Object (snake_case, as in the API). */
export interface SearchAllFilters {
	query?: string | undefined;
	folder?: string | undefined;
	category?: string | undefined;
	from?: string | undefined;
	to?: string | undefined;
	subject?: string | undefined;
	date_start?: string | undefined;
	date_end?: string | undefined;
	is_read?: boolean | undefined;
	is_starred?: boolean | undefined;
	has_attachment?: boolean | undefined;
	page?: number | undefined;
	limit?: number | undefined;
}


/**
 * Fields a per-mailbox search row carries (mirrors MailboxDO.searchEmails).
 * Only the fields the fan-out and the UI rely on are declared; rows may carry
 * more (snippet, folder_name, ...), which the merged type preserves.
 */
export interface MailboxSearchRow {
	id: string;
	subject: string | null;
	sender: string | null;
	recipient: string | null;
	date: string;
	read: boolean;
	starred: boolean;
	thread_id: string | null;
	folder_id: string | null;
	category: string | null;
	envelope_recipient?: string | null;
	cc?: string | null;
	bcc?: string | null;
	in_reply_to?: string | null;
	email_references?: string | null;
	category_confidence?: number | null;
	snippet?: string | null;
	folder_name?: string | null;
}


/** A merged cross-mailbox search result: the row plus its source mailbox. */
export interface SearchAllRow extends MailboxSearchRow {
	mailboxId: string;
}


export interface SearchAllResult {
	emails: SearchAllRow[];
	totalCount: number;
}


type MailboxSearchStub = {
	searchEmails: (
		options: Record<string, unknown>,
	) => Promise<MailboxSearchRow[]>;
	countSearchResults: (options: Record<string, unknown>) => Promise<number>;
};


/**
 * Search every mailbox and merge the matches by date descending.
 *
 * Per-mailbox top-K is sufficient to compute an exact global page of size K
 * when rows are merged by date: the global top-K can only contain rows from
 * each mailbox's own top-K. Counting first (same as /api/v1/all-emails) keeps
 * the global page clamp and the reported total exact.
 */
export async function searchAllMailboxes(
	env: Env,
	params: SearchAllFilters = {},
): Promise<SearchAllResult> {
	const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
	const requestedPage = Math.max(params.page ?? 1, 1);


	const filters = {
		query: params.query ?? "",
		folder: params.folder,
		category: params.category,
		from: params.from,
		to: params.to,
		subject: params.subject,
		date_start: params.date_start,
		date_end: params.date_end,
		is_read: params.is_read,
		is_starred: params.is_starred,
		has_attachment: params.has_attachment,
	};


	const mailboxes = await listMailboxes(env.BUCKET);
	const stubs = mailboxes.map(({ id }) => ({
		mailboxId: id,
		stub: getMailboxStub(env, id) as unknown as MailboxSearchStub,
	}));


	const counts = await Promise.all(
		stubs.map(({ stub }) => stub.countSearchResults(filters)),
	);
	const totalCount = counts.reduce((sum, count) => sum + count, 0);
	if (totalCount === 0) return { emails: [], totalCount: 0 };


	const maxPage = Math.max(1, Math.ceil(totalCount / limit));
	const page = Math.min(requestedPage, maxPage);
	const top = page * limit;


	const perMailbox = await Promise.all(
		stubs.map(async ({ mailboxId, stub }) => {
			const emails: MailboxSearchRow[] = [];
			for (let offset = 0; offset < top; offset += SEARCH_CHUNK) {
				const chunkLimit = Math.min(SEARCH_CHUNK, top - offset);
				const chunkPage = Math.floor(offset / SEARCH_CHUNK) + 1;
				const rows = await stub.searchEmails({
					...filters,
					page: chunkPage,
					limit: chunkLimit,
				});
				emails.push(...rows);
				if (rows.length < chunkLimit) break;
			}
			return { mailboxId, emails };
		}),
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
