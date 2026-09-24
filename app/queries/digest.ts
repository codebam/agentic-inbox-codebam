// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";
import type { Digest } from "~/types";


/**
 * Query key for one mailbox's digest. Exported so the view's Refresh button
 * can invalidate the same key from a plain click handler.
 */
export function digestQueryKey(mailboxId: string | undefined) {
	return ["digest", mailboxId] as const;
}


/**
 * The mailbox's morning brief for the trailing 24 hours. Read-only: the
 * server builds it on demand from stored mail, so a refetch (or the view's
 * Refresh) asks for a freshly computed digest.
 */
export function useDigest(mailboxId: string | undefined) {
	return useQuery<Digest>({
		queryKey: mailboxId ? digestQueryKey(mailboxId) : ["digest", "_disabled"],
		queryFn: async () => (await api.getDigest(mailboxId!)).digest,
		enabled: !!mailboxId,
	});
}
