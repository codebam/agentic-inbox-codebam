// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { type SavedSearch } from "~/services/api";
import { queryKeys } from "./keys";

/**
 * The mailbox's saved searches, newest first. A mailbox holds a bounded set,
 * so the whole list arrives in one response and no paging is involved; the
 * sidebar renders its section from this list. The call is skipped until a
 * mailbox id is known, and the short staleTime keeps a navigation back to
 * the mailbox from refetching on every mount.
 */
export function useSavedSearches(mailboxId: string | undefined) {
	return useQuery<{ searches: SavedSearch[] }>({
		queryKey: mailboxId
			? queryKeys.savedSearches.list(mailboxId)
			: ["saved-searches", "_disabled"],
		queryFn: () => api.listSavedSearches(mailboxId!),
		enabled: !!mailboxId,
		staleTime: 30_000,
	});
}

/**
 * Store a named query. The cached list is invalidated on success, so the
 * sidebar picks the new entry up without a second read.
 */
export function useCreateSavedSearch() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			input,
		}: {
			mailboxId: string;
			input: { name: string; query: string };
		}) => api.createSavedSearch(mailboxId, input),
		onSuccess: (_created, { mailboxId }) => {
			void qc.invalidateQueries({
				queryKey: queryKeys.savedSearches.list(mailboxId),
			});
		},
	});
}

/** Apply a partial change (name and/or query) to one saved search. */
export function useUpdateSavedSearch() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			searchId,
			patch,
		}: {
			mailboxId: string;
			searchId: string;
			patch: { name?: string; query?: string };
		}) => api.updateSavedSearch(mailboxId, searchId, patch),
		onSuccess: (_updated, { mailboxId }) => {
			void qc.invalidateQueries({
				queryKey: queryKeys.savedSearches.list(mailboxId),
			});
		},
	});
}

/** Remove one saved search; the cached list is invalidated on success. */
export function useDeleteSavedSearch() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			searchId,
		}: {
			mailboxId: string;
			searchId: string;
		}) => api.deleteSavedSearch(mailboxId, searchId),
		onSuccess: (_deleted, { mailboxId }) => {
			void qc.invalidateQueries({
				queryKey: queryKeys.savedSearches.list(mailboxId),
			});
		},
	});
}
