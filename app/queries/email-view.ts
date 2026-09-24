// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GlobalEmailViewSettings } from "shared/email-view";
import api from "~/services/api";
import { queryKeys } from "./keys";


export function useGlobalEmailView() {
	return useQuery<GlobalEmailViewSettings>({
		queryKey: queryKeys.emailView.global,
		queryFn: () =>
			api.getGlobalEmailView(),
	});
}


export function useUpdateGlobalEmailView() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (settings: GlobalEmailViewSettings) =>
			api.updateGlobalEmailView(settings),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: queryKeys.emailView.global,
			});
		},
	});
}
