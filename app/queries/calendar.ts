// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CalendarInviteRow, CalendarResponse } from "workers/lib/calendar";
import { ApiError } from "~/services/api";


/** The invite one message carries, exactly as the route returns the stored row. */
export type CalendarInvite = CalendarInviteRow;

/** The three answers the respond route accepts; the server's own vocabulary. */
export type { CalendarResponse };


/** What the respond route answers with: the Sent id plus the updated row. */
export interface InviteResponseResult {
	id: string;
	status: string;
	invite: CalendarInvite | null;
}


/**
 * Query key for one message's invite. Declared here rather than in
 * app/queries/keys.ts so the feature's cache lives in one file: the card
 * refetches through this key after a response is recorded.
 */
export function calendarInviteQueryKey(
	mailboxId: string | undefined,
	emailId: string | undefined,
) {
	return ["calendar-invite", mailboxId, emailId] as const;
}


/**
 * The calendar invitation one message carried, or null when it carried none.
 *
 * The request is issued directly here instead of through app/services/api,
 * which carries no invite method; it mirrors that client's handling —
 * relative URL, ApiError on a non-2xx answer.
 */
export function useCalendarInvite(
	mailboxId: string | undefined,
	emailId: string | undefined,
) {
	return useQuery<{ invite: CalendarInvite | null }>({
		queryKey:
			mailboxId && emailId
				? calendarInviteQueryKey(mailboxId, emailId)
				: ["calendar-invite", "_disabled"],
		queryFn: async () => {
			const res = await fetch(
				`/api/v1/mailboxes/${mailboxId!}/emails/${emailId!}/invite`,
			);
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
				throw new ApiError(res.status, body);
			}
			const data: unknown = await res.json();
			// A shape change on the server must not blank the card.
			return { invite: (data as { invite?: CalendarInvite | null }).invite ?? null };
		},
		enabled: !!mailboxId && !!emailId,
		staleTime: 30_000,
	});
}


/**
 * Answer one invitation. Deliberately not optimistic: the server owns the
 * recorded response and the Sent copy, so the card refetches once the route
 * confirms — which is also what makes the card's actions safe to click twice.
 * The route refuses anything but a REQUEST invite, so the error surfaces here.
 */
export function useRespondToInvite() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({
			mailboxId,
			emailId,
			response,
		}: {
			mailboxId: string;
			emailId: string;
			response: CalendarResponse;
		}) => {
			const res = await fetch(
				`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/invite-response`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ response }),
				},
			);
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
				throw new ApiError(res.status, body);
			}
			const data: unknown = await res.json();
			return data as InviteResponseResult;
		},
		onSettled: (_data, _error, { mailboxId, emailId }) => {
			void queryClient.invalidateQueries({
				queryKey: calendarInviteQueryKey(mailboxId, emailId),
			});
		},
	});
}
