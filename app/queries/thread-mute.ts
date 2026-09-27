// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";

/**
 * Whether one thread is muted: new mail in a muted thread raises no push and
 * no webhook notification, because both fan-outs check the mute before they
 * send. The key is built inline here (rather than in ./keys) so the whole
 * feature lives in this file; the mutations below invalidate exactly it.
 *
 * The mute is keyed by the thread id alone, so a thread can be muted before
 * its first message arrives. The message toolbar treats "not answered yet"
 * as unmuted and only ever toggles from an explicit click.
 */
export function useThreadMuted(
	mailboxId: string | undefined,
	threadId: string | null | undefined,
) {
	return useQuery<{ muted: boolean }>({
		queryKey:
			mailboxId && threadId
				? ["thread-mute", mailboxId, threadId]
				: ["thread-mute", "_disabled"],
		queryFn: () => api.getThreadMute(mailboxId!, threadId!),
		enabled: !!mailboxId && !!threadId,
		staleTime: 30_000,
	});
}

/**
 * Mute one thread. Deliberately not optimistic: the toggle's visual follows
 * the server, and the invalidation on success is what refetches the new
 * state. Answers the same `{ muted }` object the route does.
 */
export function useMuteThread() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, threadId }: { mailboxId: string; threadId: string }) =>
			api.muteThread(mailboxId, threadId),
		onSuccess: (_state, { mailboxId, threadId }) => {
			void qc.invalidateQueries({ queryKey: ["thread-mute", mailboxId, threadId] });
		},
	});
}

/** Unmute one thread; the same non-optimistic contract as useMuteThread. */
export function useUnmuteThread() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, threadId }: { mailboxId: string; threadId: string }) =>
			api.unmuteThread(mailboxId, threadId),
		onSuccess: (_state, { mailboxId, threadId }) => {
			void qc.invalidateQueries({ queryKey: ["thread-mute", mailboxId, threadId] });
		},
	});
}
