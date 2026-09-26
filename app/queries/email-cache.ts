// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { QueryClient } from "@tanstack/react-query";
import type { Email } from "~/types";
import { queryKeys } from "./keys";

/**
 * Cache patching and coalesced invalidation for email data.
 *
 * Both exist for the same reason: opening a message marks it read, so the
 * read/star toggle is the most frequent mutation in the app and its
 * invalidation used to fan out one list, folder and aggregate refetch per
 * action. Patching every cached copy of the row keeps the UI correct without
 * a refetch, and the coalescer bounds whatever refetch is still needed.
 */

/** The list-shaped payload every email list and aggregate caches. */
export interface EmailListCache {
	emails: Email[];
	totalCount: number;
	streamCounts?: { priority: number; other: number };
}

/**
 * True for cached email *list* queries of a mailbox — excludes detail queries
 * (third key element is an email id string) and thread queries.
 */
export const isEmailListQuery =
	(mailboxId: string) =>
	(query: { queryKey: readonly unknown[] }) =>
		query.queryKey[0] === "emails" &&
		query.queryKey[1] === mailboxId &&
		typeof query.queryKey[2] === "object" &&
		query.queryKey[2] !== null;

/**
 * True for cached All Accounts aggregate queries — the merged list the All
 * Accounts view renders, keyed `["all-emails", params]`. It shows the same
 * rows as the mailbox lists, so a patched row has to reach it too.
 */
export const isAllEmailsQuery = (query: { queryKey: readonly unknown[] }) =>
	query.queryKey[0] === "all-emails";

/**
 * Mirror an optimistic patch into every cached view of one email: the
 * mailbox's lists, the All Accounts aggregate and the detail cache. Returns
 * the snapshots needed to roll the patch back.
 *
 * Patching the aggregate is what lets the hot read/star path skip its
 * `["all-emails"]` invalidation — the All Accounts view is then correct
 * without a refetch of its own.
 */
export function patchEmailInCaches(
	qc: QueryClient,
	mailboxId: string,
	id: string,
	patch: Partial<Email>,
) {
	const listQueries = qc.getQueriesData<EmailListCache>({
		queryKey: ["emails", mailboxId],
		predicate: isEmailListQuery(mailboxId),
	});
	const aggregateQueries = qc.getQueriesData<EmailListCache>({
		queryKey: ["all-emails"],
		predicate: isAllEmailsQuery,
	});
	for (const [key, cached] of [...listQueries, ...aggregateQueries]) {
		if (!cached?.emails) continue;
		qc.setQueryData(key, {
			...cached,
			emails: cached.emails.map((email) =>
				email.id === id ? { ...email, ...patch } : email,
			),
		});
	}

	const detailKey = queryKeys.emails.detail(mailboxId, id);
	const prevDetail = qc.getQueryData<Email>(detailKey);
	if (prevDetail) {
		qc.setQueryData(detailKey, { ...prevDetail, ...patch });
	}

	return { listQueries, aggregateQueries, detailKey, prevDetail };
}

export type EmailPatchSnapshot = ReturnType<typeof patchEmailInCaches>;

/** Roll back a `patchEmailInCaches` snapshot after a failed mutation. */
export function restoreEmailCaches(
	qc: QueryClient,
	snapshot: EmailPatchSnapshot | undefined,
) {
	if (!snapshot) return;
	for (const [key, cached] of [
		...snapshot.listQueries,
		...snapshot.aggregateQueries,
	]) {
		qc.setQueryData(key, cached);
	}
	if (snapshot.prevDetail) {
		qc.setQueryData(snapshot.detailKey, snapshot.prevDetail);
	}
}

/**
 * How long a second invalidation of the same key is folded into the one
 * already running. Short enough that a single action still feels instant
 * (the first call invalidates immediately), long enough that a burst of
 * triage — or a scroll through unread messages, each of which marks itself
 * read — turns into one refetch instead of one per message.
 */
export const INVALIDATION_WINDOW_MS = 500;

interface InvalidationWindow {
	startedAt: number;
	/** True once a later call folded into this window. */
	folded: boolean;
}

/** Per-client window state, so a test's client never shares another's. */
const invalidationWindows = new WeakMap<
	QueryClient,
	Map<string, InvalidationWindow>
>();

/**
 * Invalidate a key at most once per window, with a trailing catch-up.
 *
 * The first call in a window invalidates immediately, so the action that
 * caused it sees server truth within one round trip. Calls during the window
 * fold into it; one catch-up invalidation runs when the window closes, so the
 * last action's effects still land. A steady burst therefore costs one
 * refetch per window per key instead of one per action.
 *
 * `refetchType` is left at the react-query default ("active"), so only
 * queries something is currently rendering are refetched.
 */
export function invalidateCoalesced(
	qc: QueryClient,
	queryKey: readonly unknown[],
) {
	const id = JSON.stringify(queryKey);
	let windows = invalidationWindows.get(qc);
	if (!windows) {
		windows = new Map();
		invalidationWindows.set(qc, windows);
	}

	const now = Date.now();
	const running = windows.get(id);
	if (running && now - running.startedAt < INVALIDATION_WINDOW_MS) {
		running.folded = true;
		return;
	}

	// react-query folds an invalidation into a fetch that is already in
	// flight: the invalidation is consumed and no new request is made. When
	// that happens the leading edge changes nothing, so the window owes a
	// catch-up even if nothing else folds into it.
	const fetchingNow = qc
		.getQueryCache()
		.findAll({ queryKey })
		.some((query) => query.state.fetchStatus === "fetching");

	const active: InvalidationWindow = {
		startedAt: now,
		folded: fetchingNow,
	};
	windows.set(id, active);
	void qc.invalidateQueries({ queryKey });

	setTimeout(() => {
		// Only the window that is still current owes a catch-up, and only if
		// something folded into it.
		if (windows.get(id) !== active || !active.folded) return;
		windows.set(id, { startedAt: Date.now(), folded: false });
		void qc.invalidateQueries({ queryKey });
	}, INVALIDATION_WINDOW_MS);
}
