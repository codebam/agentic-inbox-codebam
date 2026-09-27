// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { type Label } from "~/services/api";
import { queryKeys } from "./keys";

/**
 * The mailbox's labels. A mailbox holds a bounded set, so the whole list
 * arrives in one response and no paging is involved. The picker and the
 * search filter read this. Until the labels routes exist on this branch they
 * answer 404, which surfaces as `isError` — an empty list stays a normal
 * empty state and the callers render the error themselves.
 */
export function useLabels(
	mailboxId: string | undefined,
	options?: { enabled?: boolean },
) {
	return useQuery<{ labels: Label[] }>({
		queryKey: mailboxId
			? queryKeys.labels.list(mailboxId)
			: ["labels", "_disabled"],
		queryFn: () => api.listLabels(mailboxId!),
		enabled: !!mailboxId && (options?.enabled ?? true),
		staleTime: 30_000,
	});
}

/**
 * Create a label (name required, color optional). The cached list is
 * invalidated on success, so the next open shows the new label.
 */
export function useCreateLabel() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			label,
		}: {
			mailboxId: string;
			label: { name: string; color?: string };
		}) => api.createLabel(mailboxId, label),
		onSuccess: (_created, { mailboxId }) => {
			void qc.invalidateQueries({ queryKey: queryKeys.labels.list(mailboxId) });
		},
	});
}

/**
 * Attach one label to a message. The route answers the message's full label
 * set; the message panel stores that answer, so the chips and the picker
 * both show it without a refetch.
 */
export function useAttachLabel() {
	return useMutation({
		mutationFn: ({
			mailboxId,
			emailId,
			labelId,
		}: {
			mailboxId: string;
			emailId: string;
			labelId: string;
		}) => api.addLabelToEmail(mailboxId, emailId, labelId),
	});
}

/** Detach one label from a message; answers the message's labels too. */
export function useDetachLabel() {
	return useMutation({
		mutationFn: ({
			mailboxId,
			emailId,
			labelId,
		}: {
			mailboxId: string;
			emailId: string;
			labelId: string;
		}) => api.removeLabelFromEmail(mailboxId, emailId, labelId),
	});
}
