// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { ScheduledSend } from "~/types";
import { useInvalidateEmailData } from "./emails";
import { queryKeys } from "./keys";

export interface ScheduledSendListResponse {
	sends: ScheduledSend[];
	totalCount: number;
}

/**
 * Invalidate every cached page of a mailbox's send queue. Exported so the
 * composer's undo toast — which outlives the composer — can refresh the
 * Scheduled view from a plain click handler.
 */
export function invalidateScheduledSends(qc: QueryClient, mailboxId: string) {
	void qc.invalidateQueries({ queryKey: ["scheduled-sends", mailboxId] });
}

/**
 * One bounded page of a mailbox's scheduled-send queue, newest first. The
 * endpoint takes a `limit` and reports the total, so the view can say how
 * many older rows exist without paging through them.
 */
export function useScheduledSends(mailboxId: string | undefined, limit: number) {
	return useQuery<ScheduledSendListResponse>({
		queryKey: mailboxId
			? queryKeys.scheduledSends.list(mailboxId, limit)
			: ["scheduled-sends", "_disabled"],
		queryFn: async () => {
			const data = await api.listScheduledSends(mailboxId!, limit);
			// The endpoint reports a total; a bare array is accepted too so a
			// shape change on the server cannot blank the view.
			if (Array.isArray(data)) return { sends: data, totalCount: data.length };
			return { sends: data.sends ?? [], totalCount: data.totalCount ?? 0 };
		},
		enabled: !!mailboxId,
	});
}

/**
 * Queue a message for `sendAt`. Deliberately not optimistic: only the server
 * can create the queue row and the draft that backs it, so the composer
 * shows its "scheduled" toast once the POST confirms it.
 */
export function useScheduleSend() {
	const qc = useQueryClient();
	const invalidateEmails = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			payload,
			sendAt,
		}: {
			mailboxId: string;
			payload: Record<string, unknown>;
			sendAt: string;
		}) => api.scheduleSend(mailboxId, payload, sendAt),
		onSettled: (_data, _err, { mailboxId }) => {
			invalidateScheduledSends(qc, mailboxId);
			// The queue stores the message as a draft, so the Drafts folder
			// may have gained a row.
			invalidateEmails(mailboxId);
		},
	});
}

/**
 * Cancel a queued send. Deliberately not optimistic: the server decides
 * whether the queue already fired it, so the row only changes once the
 * DELETE confirms it. The queue — and the draft it owned — are refetched
 * either way.
 */
export function useCancelScheduledSend() {
	const qc = useQueryClient();
	const invalidateEmails = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({ mailboxId, id }: { mailboxId: string; id: string }) =>
			api.cancelScheduledSend(mailboxId, id),
		onSettled: (_data, _err, { mailboxId }) => {
			invalidateScheduledSends(qc, mailboxId);
			invalidateEmails(mailboxId);
		},
	});
}

/** Re-queue a failed send; the queue row carries the new status. */
export function useRetryScheduledSend() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, id }: { mailboxId: string; id: string }) =>
			api.retryScheduledSend(mailboxId, id),
		onSettled: (_data, _err, { mailboxId }) => {
			invalidateScheduledSends(qc, mailboxId);
		},
	});
}
