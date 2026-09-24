// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	MailRule,
	RuleDraft,
	RulePatch,
	RulePreviewDraft,
} from "workers/lib/rules";
import api from "~/services/api";
import { queryKeys } from "./keys";


export function useRules(mailboxId: string | undefined) {
	return useQuery<MailRule[]>({
		queryKey: mailboxId
			? queryKeys.rules.list(mailboxId)
			: ["rules", "_disabled"],
		queryFn: () => api.listRules(mailboxId!) as Promise<MailRule[]>,
		enabled: !!mailboxId,
	});
}


export function useCreateRule() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			rule,
		}: {
			mailboxId: string;
			rule: RuleDraft;
		}) => api.createRule(mailboxId, rule),
		onSuccess: (_rule, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.rules.list(mailboxId) });
		},
	});
}


export function useUpdateRule() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			ruleId,
			patch,
		}: {
			mailboxId: string;
			ruleId: string;
			patch: RulePatch;
		}) => api.updateRule(mailboxId, ruleId, patch),
		onSuccess: (rule, { mailboxId }) => {
			// The response is the stored rule, so patch it into the cached list
			// before the refetch lands (keeps the enable toggle from flickering
			// back to its old value).
			qc.setQueryData<MailRule[]>(
				queryKeys.rules.list(mailboxId),
				(current) =>
					current?.map((item) => (item.id === rule.id ? rule : item)),
			);
			qc.invalidateQueries({ queryKey: queryKeys.rules.list(mailboxId) });
		},
	});
}


export function useDeleteRule() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			ruleId,
		}: {
			mailboxId: string;
			ruleId: string;
		}) => api.deleteRule(mailboxId, ruleId),
		onSuccess: (_result, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.rules.list(mailboxId) });
		},
	});
}


export function useReorderRules() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, ids }: { mailboxId: string; ids: string[] }) =>
			api.reorderRules(mailboxId, ids),
		onSuccess: (rules, { mailboxId }) => {
			// The endpoint returns the new evaluation order, so seed the cache
			// with it and let the invalidation reconcile.
			if (rules) {
				qc.setQueryData(queryKeys.rules.list(mailboxId), rules);
			}
			qc.invalidateQueries({ queryKey: queryKeys.rules.list(mailboxId) });
		},
	});
}




/**
 * Dry-run a rule draft: the server matches stored mail with the same engine
 * the live pipeline uses and returns the matches. Nothing is written, nothing
 * is sent.
 */
export function usePreviewRule() {
	return useMutation({
		mutationFn: ({
			mailboxId,
			draft,
		}: {
			mailboxId: string;
			draft: RulePreviewDraft;
		}) => api.previewRule(mailboxId, draft),
	});
}
