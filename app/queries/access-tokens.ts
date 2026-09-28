// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { type AccessToken } from "~/services/api";
import { queryKeys } from "./keys";

/**
 * The mailbox's access tokens, newest first. The response carries token
 * metadata only — the plaintext is returned by the create call alone and can
 * never be read back. The call is skipped until a mailbox id is known, and
 * the short staleTime keeps a navigation back to the mailbox from refetching
 * on every mount.
 */
export function useAccessTokens(mailboxId: string | undefined) {
	return useQuery<{ tokens: AccessToken[] }>({
		queryKey: mailboxId
			? queryKeys.accessTokens.list(mailboxId)
			: ["access-tokens", "_disabled"],
		queryFn: () => api.listAccessTokens(mailboxId!),
		enabled: !!mailboxId,
		staleTime: 30_000,
	});
}

/**
 * Mint a token with a fixed scope set. The cached list is invalidated on
 * success, so the card picks the new row up without a second read; the
 * plaintext in the response is the only copy the UI will ever see.
 */
export function useCreateAccessToken() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			input,
		}: {
			mailboxId: string;
			input: { name: string; scopes: string[] };
		}) => api.createAccessToken(mailboxId, input),
		onSuccess: (_created, { mailboxId }) => {
			void qc.invalidateQueries({
				queryKey: queryKeys.accessTokens.list(mailboxId),
			});
		},
	});
}

/**
 * Revoke one token. Revocation is immediate on the server; the cached list
 * is invalidated on success so the row disappears without a reload.
 */
export function useRevokeAccessToken() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			tokenId,
		}: {
			mailboxId: string;
			tokenId: string;
		}) => api.revokeAccessToken(mailboxId, tokenId),
		onSuccess: (_revoked, { mailboxId }) => {
			void qc.invalidateQueries({
				queryKey: queryKeys.accessTokens.list(mailboxId),
			});
		},
	});
}
