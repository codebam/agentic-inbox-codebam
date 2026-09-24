// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { useMutation } from "@tanstack/react-query";
import api from "~/services/api";


/**
 * Send a sample notification to a mailbox's outbound webhook.
 *
 * Deliberately cache-free: the settings card runs it on demand and shows the
 * endpoint's status/error inline, so there is nothing to invalidate.
 */
export function useTestWebhook() {
	return useMutation({
		mutationFn: ({
			mailboxId,
			url,
			secret,
		}: {
			mailboxId: string;
			url?: string;
			secret?: string;
		}) => api.testWebhook(mailboxId, { url, secret }),
	});
}
