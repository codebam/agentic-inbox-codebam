// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import api from "~/services/api";
import type { Contact } from "~/types";
import { queryKeys } from "./keys";

export interface ContactListResponse {
	contacts: Contact[];
	totalCount: number;
}

/**
 * Ranked contact lookup behind the composer's recipient autocomplete. The
 * query is the recipient token being typed (the text after the last comma),
 * so the hook stays idle until there is something to search for; callers also
 * pass `enabled: false` while the field is unfocused, so an untouched composer
 * never hits the API.
 *
 * Previous results are kept while the next token loads, which stops the
 * suggestion list flickering as the operator types. A failed lookup resolves
 * to nothing and is not retried: suggestions are advisory.
 */
export function useContactSearch(
	mailboxId: string | undefined,
	query: string,
	options?: { enabled?: boolean },
) {
	const trimmed = query.trim();
	const enabled =
		!!mailboxId && trimmed.length > 0 && (options?.enabled ?? true);

	return useQuery<ContactListResponse>({
		queryKey: enabled
			? queryKeys.contacts.search(mailboxId, trimmed)
			: ["contacts", "_disabled"],
		queryFn: () => api.searchContacts(mailboxId!, trimmed),
		enabled,
		placeholderData: keepPreviousData,
		staleTime: 30_000,
		retry: false,
	});
}
