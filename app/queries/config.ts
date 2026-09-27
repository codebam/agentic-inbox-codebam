// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";
import { queryKeys } from "./keys";

/**
 * The deployment config, including whether the AI agent and the MCP server
 * are enabled. Shares `queryKeys.config` with the home route's inline query,
 * and keeps its `staleTime: Infinity` — config only changes on redeploy.
 */
export function useConfig() {
	return useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity, // config rarely changes
	});
}
