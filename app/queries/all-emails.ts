// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";
import type { Email } from "~/types";
import { queryKeys } from "./keys";

interface AllEmailsResponse {
	emails: Email[];
	totalCount: number;
}

/**
 * Aggregated list of emails across every mailbox. `folder` may be omitted
 * to merge every folder; otherwise it is a folder id/name applied to each
 * mailbox (e.g. "inbox", "sent").
 */
export function useAllEmails(params: Record<string, string>, options?: { refetchInterval?: number }) {
	return useQuery<AllEmailsResponse>({
		queryKey: queryKeys.allEmails.list(params),
		queryFn: () => api.listAllEmails(params),
		refetchInterval: options?.refetchInterval,
	});
}
