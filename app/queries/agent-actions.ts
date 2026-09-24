// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { AgentAction } from "~/types";
import { useInvalidateEmailData } from "./emails";
import { queryKeys } from "./keys";

export interface AgentActionListResponse {
	actions: AgentAction[];
	totalCount: number;
}

/**
 * One bounded page of a mailbox's agent/MCP action log, newest first. The
 * endpoint takes a `limit` and reports the total, so the view can say how
 * many older actions exist without paging through them.
 */
export function useAgentActions(mailboxId: string | undefined, limit: number) {
	return useQuery<AgentActionListResponse>({
		queryKey: mailboxId
			? queryKeys.agentActions.list(mailboxId, limit)
			: ["agent-actions", "_disabled"],
		queryFn: () => api.listAgentActions(mailboxId!, limit),
		enabled: !!mailboxId,
	});
}

/**
 * Undo a reversible recorded action. Deliberately not optimistic: the server
 * decides whether the inverse still applies (the message may have moved on
 * since the action was recorded), so the row only flips to "Undone" once the
 * POST confirms it. The log and the message caches are invalidated either
 * way — an undo really does move, star or read a message.
 */
export function useUndoAgentAction() {
	const qc = useQueryClient();
	const invalidateEmails = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			actionId,
		}: {
			mailboxId: string;
			actionId: string;
		}) => api.undoAgentAction(mailboxId, actionId),
		onSettled: (_data, _err, { mailboxId }) => {
			// Prefix match: every cached page of this mailbox's log.
			void qc.invalidateQueries({ queryKey: ["agent-actions", mailboxId] });
			invalidateEmails(mailboxId);
		},
	});
}
