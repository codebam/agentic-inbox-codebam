// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { type AppAccessToken } from "~/services/api";

/**
 * Query key for the app-level token list, shared by the query and the
 * invalidations below. Kept local to this module rather than in
 * ~/queries/keys: the list has no mailbox segment to key on, the way
 * storageQueryKey is local to its module.
 */
export function appTokensQueryKey() {
	return ["app-tokens"] as const;
}

/**
 * Every app-level access token, newest first. The response carries token
 * metadata only — the plaintext is returned by the create call alone and
 * can never be read back. The short staleTime keeps a navigation back to
 * Global Settings from refetching on every mount.
 */
export function useAppTokens() {
	return useQuery<{ tokens: AppAccessToken[] }>({
		queryKey: appTokensQueryKey(),
		queryFn: () => api.listAppTokens(),
		staleTime: 30_000,
	});
}

/**
 * Mint an app-level token with a fixed scope set. The cached list is
 * invalidated on success, so the card picks the new row up without a
 * second read; the plaintext in the response is the only copy the UI will
 * ever see.
 */
export function useCreateAppToken() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: { name: string; scopes: string[] }) =>
			api.createAppToken(input),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: appTokensQueryKey() });
		},
	});
}

/**
 * Revoke one app-level token. Revocation is immediate on the server; the
 * cached list is invalidated on success so the row disappears without a
 * reload.
 */
export function useRevokeAppToken() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (tokenId: string) => api.revokeAppToken(tokenId),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: appTokensQueryKey() });
		},
	});
}
