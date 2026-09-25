// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { ApiError } from "~/services/api";


/**
 * The per-mailbox storage footprint, as GET /api/v1/mailboxes/:id/storage
 * returns it under `storage`. Every field is a number: byte counts for the
 * *_bytes fields, row counts for the *_count fields.
 */
export interface StorageUsage {
	database_bytes: number;
	attachment_bytes: number;
	attachment_count: number;
	email_count: number;
	mailbox_json_bytes: number;
}

interface StorageResponse {
	storage: StorageUsage;
}


/**
 * Query key for one mailbox's storage usage.
 */
export function storageQueryKey(mailboxId: string | undefined) {
	return ["storage", mailboxId] as const;
}


/**
 * The mailbox's storage footprint. Read-only: the Durable Object computes it
 * on demand from the mailbox's own SQLite database and the route adds the
 * size of the settings JSON object in R2.
 *
 * The request is issued directly here instead of through app/services/api,
 * which carries no storage method; it mirrors that client's handling —
 * relative URL, ApiError on a non-2xx answer.
 */
export function useStorageUsage(mailboxId: string | undefined) {
	return useQuery<StorageUsage>({
		queryKey: mailboxId ? storageQueryKey(mailboxId) : ["storage", "_disabled"],
		queryFn: async () => {
			const res = await fetch(`/api/v1/mailboxes/${mailboxId!}/storage`);
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
				throw new ApiError(res.status, body);
			}
			const body: unknown = await res.json();
			return (body as StorageResponse).storage;
		},
		enabled: !!mailboxId,
	});
}
