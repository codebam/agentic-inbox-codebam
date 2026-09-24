// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Centralised query key factories for cache invalidation. */
export const queryKeys = {
	mailboxes: {
		all: ["mailboxes"] as const,
		detail: (id: string) => ["mailboxes", id] as const,
	},
	emails: {
		list: (mailboxId: string, params: Record<string, string>) =>
			["emails", mailboxId, params] as const,
		detail: (mailboxId: string, emailId: string) =>
			["emails", mailboxId, emailId] as const,
		thread: (mailboxId: string, threadId: string) =>
			["emails", mailboxId, "thread", threadId] as const,
		/** Snoozed messages (dedicated list endpoint, no pagination). */
		snoozed: (mailboxId: string) =>
			["emails", mailboxId, "snoozed"] as const,
		/** Messages with a scheduled or fired follow-up reminder. */
		reminders: (mailboxId: string) =>
			["emails", mailboxId, "reminders"] as const,
	},
	agentActions: {
		/** One bounded page of the agent/MCP action log, newest first. */
		list: (mailboxId: string, limit: number) =>
			["agent-actions", mailboxId, limit] as const,
	},
	folders: {
		list: (mailboxId: string) => ["folders", mailboxId] as const,
	},
	rules: {
		list: (mailboxId: string) => ["rules", mailboxId] as const,
	},
	senderPolicy: {
		list: (mailboxId: string) => ["sender-policy", mailboxId] as const,
	},
	allEmails: {
		list: (params: Record<string, string>) =>
			["all-emails", params] as const,
	},
	search: {
		results: (mailboxId: string, query: string, page: number) =>
			["search", mailboxId, query, page] as const,
		all: (query: string, page: number) =>
			["search", "all-mailboxes", query, page] as const,
	},
	config: ["config"] as const,
	categorization: {
		global: ["global-categorization"] as const,
	},
	models: {
		global: ["global-models"] as const,
	},
	emailView: {
		global: ["global-email-view"] as const,
	},
};
