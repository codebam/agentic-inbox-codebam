// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ItemStatus } from "shared/items";
import api from "~/services/api";
import type { ExtractedItem } from "~/types";
import { queryKeys } from "./keys";

export interface ItemListResponse {
	items: ExtractedItem[];
	totalCount: number;
}

/** The endpoint's own query values, all optional. */
export interface ItemFilters {
	/** One lifecycle state, or omitted for every state. */
	status?: ItemStatus | undefined;
	/** One due bucket (overdue | today | upcoming | none), or omitted. */
	due?: string | undefined;
	/** Rows per page; the server caps it at 50. */
	limit?: number | undefined;
}

/**
 * One filtered page of the mailbox's extracted tasks and deadlines, newest
 * first. The filters are the endpoint's own query values, so the Tasks page
 * groups by asking for one due bucket at a time and the server — not the
 * browser — decides what "today" means.
 */
export function useItems(
	mailboxId: string | undefined,
	filters: ItemFilters = {},
	options?: { enabled?: boolean },
) {
	const params: Record<string, string> = {};
	if (filters.status) params["status"] = filters.status;
	if (filters.due) params["due"] = filters.due;
	if (filters.limit != null) params["limit"] = String(filters.limit);
	return useQuery<ItemListResponse>({
		queryKey: mailboxId
			? queryKeys.items.list(mailboxId, params)
			: ["items", "_disabled"],
		queryFn: async () => {
			const data = await api.listItems(mailboxId!, params);
			// A shape change on the server must not blank the view.
			return { items: data.items ?? [], totalCount: data.totalCount ?? 0 };
		},
		enabled: !!mailboxId && (options?.enabled ?? true),
		staleTime: 30_000,
	});
}

/**
 * The items one message contributed — the message panel's card. Kept on the
 * same "items" key prefix as the lists, so closing an item in the panel also
 * refreshes the Tasks page.
 */
export function useEmailItems(
	mailboxId: string | undefined,
	emailId: string | undefined,
) {
	return useQuery<{ items: ExtractedItem[] }>({
		queryKey:
			mailboxId && emailId
				? queryKeys.items.email(mailboxId, emailId)
				: ["items", "_disabled_email"],
		queryFn: async () => {
			const data = await api.listEmailItems(mailboxId!, emailId!);
			return { items: data.items ?? [] };
		},
		enabled: !!mailboxId && !!emailId,
		staleTime: 30_000,
	});
}

/**
 * The instant a "Remind" click schedules for an item: the item's own due
 * date, or the next minute when that date has already passed. The reminder
 * endpoint accepts future timestamps only (workers/index.ts), and reminding
 * at a past instant would read as "nothing happened". Called from click
 * handlers, never during render.
 */
export function itemReminderInstant(dueAt: string): string {
	const parsed = Date.parse(dueAt);
	if (!Number.isFinite(parsed)) return new Date(Date.now() + 60_000).toISOString();
	return new Date(Math.max(parsed, Date.now() + 60_000)).toISOString();
}

/**
 * Close, reopen or dismiss one item. Deliberately not optimistic: the server
 * owns the row's status and updated_at, so the views refetch once the PUT
 * confirms it. Invalidating the whole "items" prefix refreshes the Tasks
 * page's buckets and the message panel's card together.
 */
export function useUpdateItemStatus() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			itemId,
			status,
		}: {
			mailboxId: string;
			itemId: string;
			status: ItemStatus;
		}) => api.updateItem(mailboxId, itemId, status),
		onSettled: (_data, _err, { mailboxId }) => {
			void qc.invalidateQueries({ queryKey: ["items", mailboxId] });
		},
	});
}
