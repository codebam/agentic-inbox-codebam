// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GlobalCategorizationSettings } from "shared/categories";
import api from "~/services/api";
import { queryKeys } from "./keys";

export function useGlobalCategorization() {
	return useQuery<GlobalCategorizationSettings>({
		queryKey: queryKeys.categorization.global,
		queryFn: () =>
			api.getGlobalCategorization() as Promise<GlobalCategorizationSettings>,
	});
}

export function useUpdateGlobalCategorization() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (settings: GlobalCategorizationSettings) =>
			api.updateGlobalCategorization(settings),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.categorization.global,
			});
		},
	});
}
