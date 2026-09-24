// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { AttachmentPayload } from "~/lib/attachments";
import { SNOOZE_FOLDER_ID } from "~/lib/snooze";
import api from "~/services/api";
import type { BulkEmailAction, BulkEmailTarget, Email } from "~/types";
import { queryKeys } from "./keys";

// ---------- Types ----------

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
}

/**
 * True for cached email *list* queries of a mailbox — excludes detail queries
 * (third key element is an email id string) and thread queries.
 */
const isEmailListQuery =
	(mailboxId: string) =>
	(query: { queryKey: readonly unknown[] }) =>
		query.queryKey[0] === "emails" &&
		query.queryKey[1] === mailboxId &&
		typeof query.queryKey[2] === "object" &&
		query.queryKey[2] !== null;

// ---------- Queries ----------

export function useEmails(
	mailboxId: string | undefined,
	params: Record<string, string>,
	options?: { enabled?: boolean; refetchInterval?: number },
) {
	const queryParams = params["folder"]
		? { ...params, threaded: "true" }
		: params;

	return useQuery<EmailListResponse>({
		queryKey: mailboxId
			? queryKeys.emails.list(mailboxId, queryParams)
			: ["emails", "_disabled"],
		queryFn: async () => {
			const data = await api.listEmails(mailboxId!, queryParams);
			if (data && typeof data === "object" && "emails" in data) {
				return {
					emails: data.emails ?? [],
					totalCount: data.totalCount ?? 0,
				};
			}
			const arr = Array.isArray(data) ? data : [];
			return { emails: arr, totalCount: arr.length };
		},
		enabled: !!mailboxId && (options?.enabled ?? true),
		...(options?.refetchInterval !== undefined
			? { refetchInterval: options.refetchInterval }
			: {}),
	});
}

export function useEmail(
	mailboxId: string | undefined,
	emailId: string | undefined,
) {
	return useQuery<Email>({
		queryKey: mailboxId && emailId
			? queryKeys.emails.detail(mailboxId, emailId)
			: ["emails", "_disabled_detail"],
		queryFn: () => api.getEmail(mailboxId!, emailId!),
		enabled: !!mailboxId && !!emailId,
	});
}

export function useThreadReplies(
	mailboxId: string | undefined,
	threadId: string | undefined | null,
) {
	const qc = useQueryClient();

	return useQuery<Email[]>({
		queryKey: mailboxId && threadId
			? queryKeys.emails.thread(mailboxId, threadId)
			: ["emails", "_disabled_thread"],
		queryFn: async ({ signal }) => {
			// Single request returns all thread emails with full bodies +
			// attachments. Eliminates the previous N+1 pattern that fired
			// a separate getEmail call per thread message.
			const emails = await api.getThread(mailboxId!, threadId!, { signal });

			// Populate individual email detail caches so clicking a thread
			// message in the panel doesn't re-fetch.
			for (const email of emails) {
				qc.setQueryData(
					queryKeys.emails.detail(mailboxId!, email.id),
					email,
				);
			}

			return emails;
		},
		enabled: !!mailboxId && !!threadId,
	});
}

/**
 * Snoozed messages for a mailbox — the Snoozed folder's data source. The
 * dedicated endpoint returns the whole list (no pagination).
 */
export function useSnoozedEmails(
	mailboxId: string | undefined,
	options?: { enabled?: boolean },
) {
	return useQuery<EmailListResponse>({
		queryKey: mailboxId
			? queryKeys.emails.snoozed(mailboxId)
			: ["emails", "_disabled_snoozed"],
		queryFn: () => api.listSnoozedEmails(mailboxId!),
		enabled: !!mailboxId && (options?.enabled ?? true),
	});
}

/** Messages whose follow-up reminder is scheduled or has fired. */
export function useReminderEmails(
	mailboxId: string | undefined,
	options?: { enabled?: boolean },
) {
	return useQuery<EmailListResponse>({
		queryKey: mailboxId
			? queryKeys.emails.reminders(mailboxId)
			: ["emails", "_disabled_reminders"],
		queryFn: () => api.listReminderEmails(mailboxId!),
		enabled: !!mailboxId && (options?.enabled ?? true),
	});
}

// ---------- Mutations ----------

/** Invalidate both the email list and folder counts after any email mutation. */
function useInvalidateEmailData() {
	const qc = useQueryClient();
	return (mailboxId: string) => {
		void qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
		void qc.invalidateQueries({
			queryKey: queryKeys.folders.list(mailboxId),
		});
		// Keep the All Accounts aggregate in sync when a mailbox changes.
		void qc.invalidateQueries({ queryKey: ["all-emails"] });
	};
}

export function useSendEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			email,
		}: { mailboxId: string; email: unknown }) =>
			api.sendEmail(mailboxId, email),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useUpdateEmail() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
			data,
		}: { mailboxId: string; id: string; data: unknown }) =>
			api.updateEmail(mailboxId, id, data),
		onMutate: async ({ mailboxId, id, data }) => {
			// Cancel in-flight list queries so they don't overwrite our optimistic update
			await qc.cancelQueries({
				queryKey: ["emails", mailboxId],
				predicate: isEmailListQuery(mailboxId),
			});

			// Snapshot current email list caches for rollback
			const listQueries = qc.getQueriesData<{ emails: Email[]; totalCount: number }>({
				queryKey: ["emails", mailboxId],
				predicate: isEmailListQuery(mailboxId),
			});

			// Optimistically patch every cached email list that contains this email
			for (const [key, cached] of listQueries) {
				if (!cached?.emails) continue;
				qc.setQueryData(key, {
					...cached,
					emails: cached.emails.map((e) =>
						e.id === id ? { ...e, ...(data as Partial<Email>) } : e,
					),
				});
			}

			// Also patch the detail cache
			const detailKey = queryKeys.emails.detail(mailboxId, id);
			const prevDetail = qc.getQueryData<Email>(detailKey);
			if (prevDetail) {
				qc.setQueryData(detailKey, { ...prevDetail, ...(data as Partial<Email>) });
			}

			return { listQueries, prevDetail, detailKey };
		},
		onError: (_err, _vars, context) => {
			// Roll back optimistic updates on failure
			if (context?.listQueries) {
				for (const [key, cached] of context.listQueries) {
					qc.setQueryData(key, cached);
				}
			}
			if (context?.prevDetail) {
				qc.setQueryData(context.detailKey, context.prevDetail);
			}
		},
		onSettled: (_data, _err, { mailboxId }) => {
			// Always refetch to ensure server truth
			void qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
			void qc.invalidateQueries({
				queryKey: queryKeys.folders.list(mailboxId),
			});
			void qc.invalidateQueries({ queryKey: ["all-emails"] });
		},
	});
}

/**
 * Mirror an optimistic patch into every cached list that shows this email,
 * plus its detail cache, and return the snapshots needed to roll back.
 */
function patchEmailInCaches(
	qc: QueryClient,
	mailboxId: string,
	id: string,
	patch: Partial<Email>,
) {
	const listQueries = qc.getQueriesData<{
		emails: Email[];
		totalCount: number;
	}>({
		queryKey: ["emails", mailboxId],
		predicate: isEmailListQuery(mailboxId),
	});
	for (const [key, cached] of listQueries) {
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

	return { listQueries, detailKey, prevDetail };
}

type EmailPatchSnapshot = ReturnType<typeof patchEmailInCaches>;

/** Roll back a `patchEmailInCaches` snapshot after a failed mutation. */
function restoreEmailCaches(
	qc: QueryClient,
	snapshot: EmailPatchSnapshot | undefined,
) {
	if (!snapshot) return;
	for (const [key, cached] of snapshot.listQueries) {
		qc.setQueryData(key, cached);
	}
	if (snapshot.prevDetail) {
		qc.setQueryData(snapshot.detailKey, snapshot.prevDetail);
	}
}

/**
 * Shared machinery for the snooze and reminder mutations: cancel in-flight
 * list queries, patch the message optimistically, roll back on failure,
 * then refetch server truth (which also refreshes the snoozed and reminder
 * lists, since their keys sit under ["emails", mailboxId]).
 */
function useEmailTimingMutation<
	TVars extends { mailboxId: string; id: string },
>(options: {
	mutationFn: (vars: TVars) => Promise<Email>;
	patch: (vars: TVars) => Partial<Email>;
}) {
	const qc = useQueryClient();
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: options.mutationFn,
		onMutate: async (vars: TVars) => {
			await qc.cancelQueries({
				queryKey: ["emails", vars.mailboxId],
				predicate: isEmailListQuery(vars.mailboxId),
			});
			return patchEmailInCaches(
				qc,
				vars.mailboxId,
				vars.id,
				options.patch(vars),
			);
		},
		onError: (_err, _vars, snapshot) => restoreEmailCaches(qc, snapshot),
		onSettled: (_data, _err, vars) => invalidate(vars.mailboxId),
	});
}

/** Snooze a message until `until` (ISO 8601, future only). */
export function useSnoozeEmail() {
	return useEmailTimingMutation<{
		mailboxId: string;
		id: string;
		until: string;
	}>({
		mutationFn: ({ mailboxId, id, until }) =>
			api.snoozeEmail(mailboxId, id, until),
		patch: ({ until }) => ({
			snooze_until: until,
			folder_id: SNOOZE_FOLDER_ID,
		}),
	});
}

/** Wake a snoozed message now; it returns to the folder it came from. */
export function useUnsnoozeEmail() {
	return useEmailTimingMutation<{ mailboxId: string; id: string }>({
		mutationFn: ({ mailboxId, id }) => api.unsnoozeEmail(mailboxId, id),
		patch: () => ({ snooze_until: null }),
	});
}

/** Schedule a follow-up reminder at `at` (ISO 8601, future only). */
export function useSetReminder() {
	return useEmailTimingMutation<{
		mailboxId: string;
		id: string;
		at: string;
	}>({
		mutationFn: ({ mailboxId, id, at }) => api.setReminder(mailboxId, id, at),
		// Scheduling a fresh reminder also clears a nudge that already fired.
		patch: ({ at }) => ({ remind_at: at, reminded_at: null }),
	});
}

/** Dismiss a fired reminder or cancel a scheduled one. */
export function useClearReminder() {
	return useEmailTimingMutation<{ mailboxId: string; id: string }>({
		mutationFn: ({ mailboxId, id }) => api.clearReminder(mailboxId, id),
		patch: () => ({ remind_at: null, reminded_at: null }),
	});
}

/**
 * One-click unsubscribe. Deliberately not optimistic: the POST can fail at
 * the sender's endpoint, so the banner owns the pending and error states and
 * `unsubscribed_at` only lands once the server confirms it. The response is
 * the updated row; the affected caches are invalidated either way.
 */
export function useUnsubscribeEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({ mailboxId, id }: { mailboxId: string; id: string }) =>
			api.unsubscribeEmail(mailboxId, id),
		onSettled: (_data, _err, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useMarkThreadRead() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			threadId,
		}: { mailboxId: string; threadId: string }) =>
			api.markThreadRead(mailboxId, threadId),
		onSuccess: (_data, { mailboxId }) => {
			void qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
			void qc.invalidateQueries({
				queryKey: queryKeys.folders.list(mailboxId),
			});
			void qc.invalidateQueries({ queryKey: ["all-emails"] });
		},
	});
}

export function useDeleteEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
			permanent,
		}: { mailboxId: string; id: string; permanent?: boolean }) =>
			api.deleteEmail(mailboxId, id, { permanent }),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}


/** Move a trashed email back to the inbox. */
export function useRestoreEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({ mailboxId, id }: { mailboxId: string; id: string }) =>
			api.restoreEmail(mailboxId, id),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}


/** Permanently delete every message in the Trash folder. */
export function useEmptyTrash() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({ mailboxId }: { mailboxId: string }) =>
			api.emptyTrash(mailboxId),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}


export function useMoveEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
			folderId,
		}: { mailboxId: string; id: string; folderId: string }) =>
			api.moveEmail(mailboxId, id, folderId),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export interface BulkEmailActionVars {
	action: BulkEmailAction;
	targets: BulkEmailTarget[];
	folderId?: string | undefined;
}

/** Group selected rows by their owning mailbox. */
function groupTargetsByMailbox(targets: BulkEmailTarget[]) {
	const byMailbox = new Map<string, BulkEmailTarget[]>();
	for (const target of targets) {
		const list = byMailbox.get(target.mailboxId);
		if (list) list.push(target);
		else byMailbox.set(target.mailboxId, [target]);
	}
	return byMailbox;
}

/**
 * Apply one batch action — mark read/unread, star/unstar, move, trash,
 * restore, or delete — to every selected row. The All Accounts view selects
 * rows from several mailboxes, so the batch is split into one request per
 * mailbox.
 *
 * Read/starred changes are patched optimistically into the list caches;
 * move/trash/restore/delete wait for the server and then invalidate, since
 * rows leave the current folder.
 */
export function useBulkEmailAction() {
	const qc = useQueryClient();

	return useMutation({
		mutationFn: async ({ action, targets, folderId }: BulkEmailActionVars) => {
			const byMailbox = groupTargetsByMailbox(targets);

			// Return the per-mailbox responses so callers can report what the
			// server actually did (trashed / purged / restored counts).
			return Promise.all(
				[...byMailbox].map(([mailboxId, mailboxTargets]) => {
					// Expand read/unread to whole conversations so threaded rows
					// don't keep showing an unread badge.
					const threadIds =
						action === "mark_read" || action === "mark_unread"
							? [
									...new Set(
										mailboxTargets
											.filter(
												(target) =>
													(target.threadCount ?? 1) > 1 && target.threadId,
											)
											.map((target) => target.threadId as string),
									),
								]
							: [];

					return api.bulkEmailAction(mailboxId, {
						action,
						ids: mailboxTargets.map((target) => target.id),
						...(threadIds.length > 0 ? { threadIds } : {}),
						...(action === "move" ? { folderId } : {}),
					});
				}),
			);
		},
		onMutate: async ({ action, targets }) => {
			const snapshots: Array<[readonly unknown[], { emails: Email[]; totalCount: number }]> = [];

			if (
				action === "move" ||
				action === "trash" ||
				action === "restore" ||
				action === "delete"
			) {
				return { snapshots };
			}

			const patch: Partial<Email> =
				action === "mark_read"
					? { read: true }
					: action === "mark_unread"
						? { read: false }
						: action === "star"
							? { starred: true }
							: { starred: false };

			const byMailbox = groupTargetsByMailbox(targets);
			const idsByMailbox = new Map<string, Set<string>>();
			for (const [mailboxId, mailboxTargets] of byMailbox) {
				idsByMailbox.set(mailboxId, new Set(mailboxTargets.map((target) => target.id)));
			}

			// Cancel in-flight list queries so they don't overwrite the patch.
			for (const mailboxId of byMailbox.keys()) {
				await qc.cancelQueries({
					queryKey: ["emails", mailboxId],
					predicate: isEmailListQuery(mailboxId),
				});
			}
			await qc.cancelQueries({ queryKey: ["all-emails"] });

			for (const [mailboxId, ids] of idsByMailbox) {
				const listQueries = qc.getQueriesData<{ emails: Email[]; totalCount: number }>({
					queryKey: ["emails", mailboxId],
					predicate: isEmailListQuery(mailboxId),
				});
				for (const [key, cached] of listQueries) {
					if (!cached?.emails) continue;
					snapshots.push([key, cached]);
					qc.setQueryData(key, {
						...cached,
						emails: cached.emails.map((email) =>
							ids.has(email.id) ? { ...email, ...patch } : email,
						),
					});
				}
			}

			const allQueries = qc.getQueriesData<{ emails: Email[]; totalCount: number }>({
				queryKey: ["all-emails"],
			});
			for (const [key, cached] of allQueries) {
				if (!cached?.emails) continue;
				snapshots.push([key, cached]);
				qc.setQueryData(key, {
					...cached,
					emails: cached.emails.map((email) =>
						email.mailboxId &&
						idsByMailbox.get(email.mailboxId)?.has(email.id)
							? { ...email, ...patch }
							: email,
					),
				});
			}

			return { snapshots };
		},
		onError: (_err, _vars, context) => {
			for (const [key, cached] of context?.snapshots ?? []) {
				qc.setQueryData(key, cached);
			}
		},
		onSettled: (_data, _err, { targets }) => {
			for (const mailboxId of new Set(targets.map((target) => target.mailboxId))) {
				void qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
				void qc.invalidateQueries({
					queryKey: queryKeys.folders.list(mailboxId),
				});
			}
			void qc.invalidateQueries({ queryKey: ["all-emails"] });
		},
	});
}

export function useSaveDraft() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			draft,
		}: {
			mailboxId: string;
			draft: {
				to?: string | undefined;
				cc?: string | undefined;
				bcc?: string | undefined;
				subject?: string | undefined;
				body: string;
				/** Pending composer files, base64 — persisted with the draft. */
				attachments?: AttachmentPayload[] | undefined;
				in_reply_to?: string | undefined;
				thread_id?: string | undefined;
				draft_id?: string | undefined;
			};
		}) => api.saveDraft(mailboxId, draft),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useReplyToEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			emailId,
			email,
		}: { mailboxId: string; emailId: string; email: unknown }) =>
			api.replyToEmail(mailboxId, emailId, email),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useForwardEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			emailId,
			email,
		}: { mailboxId: string; emailId: string; email: unknown }) =>
			api.forwardEmail(mailboxId, emailId, email),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}
