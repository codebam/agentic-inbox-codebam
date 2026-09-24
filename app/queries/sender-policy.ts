// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SenderPolicy, SenderPolicyEntry } from "workers/lib/sender-policy";
import api from "~/services/api";
import { queryKeys } from "./keys";


/** Every allow/block entry for one mailbox (settings card). */
export function useSenderPolicy(mailboxId: string | undefined) {
	return useQuery<SenderPolicyEntry[]>({
		queryKey: mailboxId
			? queryKeys.senderPolicy.list(mailboxId)
			: ["sender-policy", "_disabled"],
		queryFn: () =>
			api.listSenderPolicy(mailboxId!),
		enabled: !!mailboxId,
	});
}


/** Upsert one entry (the message panel uses the feedback mutation instead). */
export function useSetSenderPolicy() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			address,
			policy,
		}: {
			mailboxId: string;
			address: string;
			policy: SenderPolicy;
		}) => api.setSenderPolicy(mailboxId, address, policy),
		onSuccess: (_entry, { mailboxId }) => {
			void qc.invalidateQueries({ queryKey: queryKeys.senderPolicy.list(mailboxId) });
		},
	});
}


/** Remove one entry from the settings card. */
export function useRemoveSenderPolicy() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			address,
		}: {
			mailboxId: string;
			address: string;
		}) => api.removeSenderPolicy(mailboxId, address),
		onSuccess: (_result, { mailboxId }) => {
			void qc.invalidateQueries({ queryKey: queryKeys.senderPolicy.list(mailboxId) });
		},
	});
}


/**
 * One-click 'Not spam' / 'Block sender' feedback. The server records the
 * sender's policy and re-files the message, so the email caches are
 * invalidated alongside the policy list.
 */
export function useSenderPolicyFeedback() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			emailId,
			action,
		}: {
			mailboxId: string;
			emailId: string;
			action: SenderPolicy;
		}) => api.senderPolicyFeedback(mailboxId, emailId, action),
		onSuccess: (_entry, { mailboxId }) => {
			void qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
			void qc.invalidateQueries({ queryKey: queryKeys.folders.list(mailboxId) });
			void qc.invalidateQueries({ queryKey: ["all-emails"] });
			void qc.invalidateQueries({ queryKey: queryKeys.senderPolicy.list(mailboxId) });
		},
	});
}
