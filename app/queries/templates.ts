// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Template, TemplateInput } from "workers/lib/templates";
import api from "~/services/api";
import { queryKeys } from "./keys";

export interface TemplateListResponse {
	templates: Template[];
}

/**
 * The mailbox's snippets, ordered by name. The composer's template picker
 * reads this when it opens; a mailbox holds at most 200, so the whole list
 * arrives in one response and no paging is involved.
 */
export function useTemplates(
	mailboxId: string | undefined,
	options?: { enabled?: boolean },
) {
	return useQuery<TemplateListResponse>({
		queryKey: mailboxId
			? queryKeys.templates.list(mailboxId)
			: ["templates", "_disabled"],
		queryFn: () => api.listTemplates(mailboxId!),
		enabled: !!mailboxId && (options?.enabled ?? true),
		staleTime: 30_000,
	});
}

/**
 * Store the composer's current body as a new snippet. The cached list is
 * invalidated on success, so the next open shows the template that was just
 * saved instead of the list from before it.
 */
export function useCreateTemplate() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			template,
		}: {
			mailboxId: string;
			template: TemplateInput;
		}) => api.createTemplate(mailboxId, template),
		onSuccess: (_template, { mailboxId }) => {
			void qc.invalidateQueries({ queryKey: queryKeys.templates.list(mailboxId) });
		},
	});
}

/** Remove one snippet; the list refreshes itself after the write. */
export function useDeleteTemplate() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			templateId,
		}: {
			mailboxId: string;
			templateId: string;
		}) => api.deleteTemplate(mailboxId, templateId),
		onSuccess: (_result, { mailboxId }) => {
			void qc.invalidateQueries({ queryKey: queryKeys.templates.list(mailboxId) });
		},
	});
}
