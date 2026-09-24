// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GlobalModelSettings } from "shared/models";
import api from "~/services/api";
import { queryKeys } from "./keys";


export function useGlobalModels() {
	return useQuery<GlobalModelSettings>({
		queryKey: queryKeys.models.global,
		queryFn: () => api.getGlobalModels(),
	});
}


export function useUpdateGlobalModels() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (settings: GlobalModelSettings) =>
			api.updateGlobalModels(settings),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: queryKeys.models.global });
		},
	});
}
