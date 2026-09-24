// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { GlobalCategorizationSettings } from "shared/categories";
import type { AttachmentPayload } from "~/lib/attachments";
import type { GlobalModelSettings } from "shared/models";
import type { GlobalEmailViewSettings } from "shared/email-view";
import type {
	MailRule,
	RuleDraft,
	RulePatch,
	RulePreviewDraft,
	RulePreviewResult,
} from "workers/lib/rules";
import type { WebhookDeliveryResult } from "workers/lib/webhook";
import type { SenderPolicy, SenderPolicyEntry } from "workers/lib/sender-policy";
import type { Template, TemplateInput, TemplatePatch } from "workers/lib/templates";
import type { AgentAction, BulkEmailAction, Contact, Email, Folder, Mailbox, ScheduledSend } from "~/types";

const REQUEST_TIMEOUT_MS = 30_000;

/** Contact suggestions requested per recipient lookup; the server caps it too. */
const CONTACT_SEARCH_LIMIT = 8;

export class ApiError extends Error {
	status: number;
	body: Record<string, unknown>;

	constructor(status: number, body: Record<string, unknown>) {
		super((body["error"] as string) || `Request failed: ${status}`);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

async function request<T>(
	url: string,
	options: RequestInit = {},
): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	// Combine caller signal (e.g. TanStack Query abort) with our timeout signal
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;

	try {
		const res = await fetch(url, {
			...options,
			signal,
			headers: {
				"Content-Type": "application/json",
				...(options.headers as Record<string, string>),
			},
		});

		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new ApiError(res.status, body as Record<string, unknown>);
		}

		if (res.status === 204) return undefined as T;

		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			return res.json();
		}
		return res.blob() as unknown as T;
	} finally {
		clearTimeout(timeout);
	}
}

function get<T>(url: string, opts?: { params?: Record<string, string>; responseType?: string; signal?: AbortSignal | undefined }) {
	const query = opts?.params ? `?${new URLSearchParams(opts.params)}` : "";
	return request<T>(`${url}${query}`, {
		method: "GET",
		...(opts?.signal ? { signal: opts.signal } : {}),
		...(opts?.responseType === "blob" ? { headers: { Accept: "*/*" } } : {}),
	});
}

function post<T>(url: string, body?: unknown, opts?: { signal?: AbortSignal | undefined }) {
	return request<T>(url, {
		method: "POST",
		...(opts?.signal ? { signal: opts.signal } : {}),
		...(body != null ? { body: JSON.stringify(body) } : {}),
	});
}

function put<T>(url: string, body?: unknown) {
	return request<T>(url, {
		method: "PUT",
		...(body != null ? { body: JSON.stringify(body) } : {}),
	});
}

function del<T>(url: string) {
	return request<T>(url, { method: "DELETE" });
}

// ---------- Typed response shapes ----------

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
}

interface AgentActionListResponse {
	actions: AgentAction[];
	totalCount: number;
}

interface ContactListResponse {
	contacts: Contact[];
	totalCount: number;
}

interface ScheduledSendListResponse {
	sends: ScheduledSend[];
	totalCount: number;
}

// ---------- API client ----------

const api = {
	// Config
	getConfig: () =>
		get<{
			domains: string[];
			emailAddresses: string[];
			catchAllMailbox?: string | null;
			catchAllMailboxes?: string[];
		}>("/api/v1/config"),

	// Global categorization (applies to every mailbox that opts in)
	getGlobalCategorization: () =>
		get<GlobalCategorizationSettings>("/api/v1/categorization"),
	updateGlobalCategorization: (settings: GlobalCategorizationSettings) =>
		put<GlobalCategorizationSettings>("/api/v1/categorization", settings),

	// Global AI model overrides (apply to every mailbox without its own)
	getGlobalModels: () => get<GlobalModelSettings>("/api/v1/models"),
	updateGlobalModels: (settings: GlobalModelSettings) =>
		put<GlobalModelSettings>("/api/v1/models", settings),

	// Global default email view (applies to every mailbox without its own)
	getGlobalEmailView: () => get<GlobalEmailViewSettings>("/api/v1/email-view"),
	updateGlobalEmailView: (settings: GlobalEmailViewSettings) =>
		put<GlobalEmailViewSettings>("/api/v1/email-view", settings),

	// Mailboxes
	listMailboxes: () => get<Mailbox[]>("/api/v1/mailboxes"),
	createMailbox: (email: string, name: string, settings?: unknown) =>
		post<Mailbox>("/api/v1/mailboxes", { email, name, settings }),
	getMailbox: (mailboxId: string) =>
		get<Mailbox>(`/api/v1/mailboxes/${mailboxId}`),
	updateMailbox: (mailboxId: string, settings: unknown) =>
		put<Mailbox>(`/api/v1/mailboxes/${mailboxId}`, { settings }),
	deleteMailbox: (mailboxId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}`),

	// Outbound webhook notifications (notification only — never sends mail)
	/** Send a sample payload to the mailbox webhook and report the upstream result. */
	testWebhook: (mailboxId: string, body: { url?: string | undefined; secret?: string | undefined }) =>
		post<WebhookDeliveryResult>(`/api/v1/mailboxes/${mailboxId}/webhook/test`, body),

	// Emails
	listEmails: (mailboxId: string, params: Record<string, string>, opts?: { signal?: AbortSignal }) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/emails`, { params, signal: opts?.signal }),
	listAllEmails: (params: Record<string, string>, opts?: { signal?: AbortSignal }) =>
		get<EmailListResponse>(`/api/v1/all-emails`, { params, signal: opts?.signal }),
	sendEmail: (mailboxId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails`, email),
	getEmail: (mailboxId: string, id: string, opts?: { signal?: AbortSignal }) =>
		get<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, { signal: opts?.signal }),
	updateEmail: (mailboxId: string, id: string, data: unknown) =>
		put<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, data),
	/**
	 * Delete an email. A plain delete moves the message to Trash; an email
	 * already in Trash — or `permanent: true` — is deleted for good.
	 */
	deleteEmail: (mailboxId: string, id: string, opts?: { permanent?: boolean | undefined }) =>
		del<{ status: string; trashed: number; purged: number }>(
			`/api/v1/mailboxes/${mailboxId}/emails/${id}${opts?.permanent ? "?permanent=true" : ""}`,
		),
	restoreEmail: (mailboxId: string, id: string) =>
		post<{ restored: number }>(`/api/v1/mailboxes/${mailboxId}/emails/${id}/restore`),
	moveEmail: (mailboxId: string, id: string, folderId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}/move`, { folderId }),
	bulkEmailAction: (
		mailboxId: string,
		body: {
			action: BulkEmailAction;
			ids: string[];
			threadIds?: string[] | undefined;
			folderId?: string | undefined;
		},
	) =>
		post<{ updated?: number; trashed?: number; purged?: number; restored?: number }>(
			`/api/v1/mailboxes/${mailboxId}/emails/bulk`,
			body,
		),
	/** Permanently delete every message in the Trash folder. */
	emptyTrash: (mailboxId: string) =>
		post<{ purged: number }>(`/api/v1/mailboxes/${mailboxId}/trash/empty`),

	// Snooze and follow-up reminders. The Durable Object owns the
	// semantics: a snoozed message waits in the "snoozed" folder and returns
	// to the folder it came from; a fired reminder stays active until the
	// user dismisses it. Both mutators return the updated row.
	/** Park a message until `until` (ISO 8601, must be in the future). */
	snoozeEmail: (mailboxId: string, id: string, until: string) =>
		post<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}/snooze`, { until }),
	/** Wake a snoozed message immediately. */
	unsnoozeEmail: (mailboxId: string, id: string) =>
		del<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}/snooze`),
	/** Schedule a follow-up reminder for `at` (ISO 8601, future only). */
	setReminder: (mailboxId: string, id: string, at: string) =>
		post<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}/reminder`, { at }),
	/** Clear the reminder — used for both "change" and "dismiss". */
	clearReminder: (mailboxId: string, id: string) =>
		del<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}/reminder`),
	/**
	 * One-click unsubscribe (RFC 8058). The server posts to the sender's
	 * endpoint and returns the updated row; the UI only ever calls this from
	 * an explicit user click.
	 */
	unsubscribeEmail: (mailboxId: string, id: string) =>
		post<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}/unsubscribe`),
	/** Every snoozed message for the mailbox, with its wake time. */
	listSnoozedEmails: (mailboxId: string) =>
		get<EmailListResponse>(`/api/v1/mailboxes/${mailboxId}/snoozed`),
	/** Messages whose follow-up reminder is scheduled or has fired. */
	listReminderEmails: (mailboxId: string) =>
		get<EmailListResponse>(`/api/v1/mailboxes/${mailboxId}/reminders`),

	// Scheduled sends — the composer queues messages here and the server's
	// queue fires each one at `sendAt`. A queued send carries no attachments.
	/** Queue `payload` (the same shape `sendEmail` takes) for `sendAt` (ISO 8601, future only). */
	scheduleSend: (mailboxId: string, payload: Record<string, unknown>, sendAt: string) =>
		post<ScheduledSend>(`/api/v1/mailboxes/${mailboxId}/scheduled-sends`, {
			...payload,
			send_at: sendAt,
		}),
	/** Queued and past sends for the mailbox, newest first (bounded page). */
	listScheduledSends: (mailboxId: string, limit?: number) =>
		get<ScheduledSendListResponse | ScheduledSend[]>(
			`/api/v1/mailboxes/${mailboxId}/scheduled-sends`,
			limit != null ? { params: { limit: String(limit) } } : undefined,
		),
	/** Cancel a queued send before the queue fires it. */
	cancelScheduledSend: (mailboxId: string, id: string) =>
		del<{ send: ScheduledSend }>(
			`/api/v1/mailboxes/${mailboxId}/scheduled-sends/${id}`,
		),
	/** Re-queue a failed send. */
	retryScheduledSend: (mailboxId: string, id: string) =>
		post<{ send: ScheduledSend }>(
			`/api/v1/mailboxes/${mailboxId}/scheduled-sends/${id}/retry`,
		),

	// Agent/MCP action audit log. Metadata only — never message bodies.
	/** Recent agent/MCP actions for the mailbox, newest first (bounded page). */
	listAgentActions: (mailboxId: string, limit?: number) =>
		get<AgentActionListResponse>(
			`/api/v1/mailboxes/${mailboxId}/agent-actions`,
			limit != null ? { params: { limit: String(limit) } } : undefined,
		),
	/** Undo a reversible recorded action; returns the updated action and message. */
	undoAgentAction: (mailboxId: string, actionId: string) =>
		post<{ action: AgentAction; email: Email }>(
			`/api/v1/mailboxes/${mailboxId}/agent-actions/${actionId}/undo`,
		),
	// Contacts — the address book aggregated from a mailbox's mail history.
	/** Ranked contact lookup for recipient autocomplete; `limit` bounds the page. */
	searchContacts: (mailboxId: string, query: string, limit = CONTACT_SEARCH_LIMIT) =>
		get<ContactListResponse>(`/api/v1/mailboxes/${mailboxId}/contacts`, {
			params: { q: query, limit: String(limit) },
		}),
	// Templates — the operator's reusable snippets. The composer inserts a
	// template's body into a draft; nothing here sends mail.
	/** Every snippet for the mailbox, ordered by name (case-insensitive). */
	listTemplates: (mailboxId: string) =>
		get<{ templates: Template[] }>(`/api/v1/mailboxes/${mailboxId}/templates`),
	/** Store a snippet; `subject` is optional. */
	createTemplate: (mailboxId: string, template: TemplateInput) =>
		post<Template>(`/api/v1/mailboxes/${mailboxId}/templates`, template),
	/** Partial update: name, subject and/or body (an explicit null clears the subject). */
	updateTemplate: (mailboxId: string, templateId: string, patch: TemplatePatch) =>
		put<Template>(`/api/v1/mailboxes/${mailboxId}/templates/${templateId}`, patch),
	/** Remove one snippet. */
	deleteTemplate: (mailboxId: string, templateId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/templates/${templateId}`),
	getThread: (mailboxId: string, threadId: string, opts?: { signal?: AbortSignal }) =>
		get<Email[]>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}`, { signal: opts?.signal }),
	markThreadRead: (mailboxId: string, threadId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}/read`),
	getAttachment: (mailboxId: string, emailId: string, attachmentId: string) =>
		get<Blob>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/attachments/${attachmentId}`, { responseType: "blob" }),
	// The composer prefills the signature client-side, so it never sends
	// applySignature — the server would append the signature a second time.
	saveDraft: (
		mailboxId: string,
		draft: {
			to?: string | undefined;
			cc?: string | undefined;
			bcc?: string | undefined;
			subject?: string | undefined;
			body: string;
			attachments?: AttachmentPayload[] | undefined;
			in_reply_to?: string | undefined;
			thread_id?: string | undefined;
			draft_id?: string | undefined;
		},
	) => post<{ id: string; draft_id?: string }>(`/api/v1/mailboxes/${mailboxId}/drafts`, draft),
	replyToEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/reply`, email),
	forwardEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/forward`, email),

	// Folders
	listFolders: (mailboxId: string) =>
		get<Folder[]>(`/api/v1/mailboxes/${mailboxId}/folders`),
	createFolder: (mailboxId: string, name: string) =>
		post<Folder>(`/api/v1/mailboxes/${mailboxId}/folders`, { name }),
	updateFolder: (mailboxId: string, id: string, name: string) =>
		put<Folder>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`, { name }),
	deleteFolder: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`),


	// Rules (deterministic per-mailbox filters, evaluated on arrival)
	listRules: (mailboxId: string) =>
		get<MailRule[]>(`/api/v1/mailboxes/${mailboxId}/rules`),
	createRule: (mailboxId: string, rule: RuleDraft) =>
		post<MailRule>(`/api/v1/mailboxes/${mailboxId}/rules`, rule),
	updateRule: (mailboxId: string, ruleId: string, patch: RulePatch) =>
		put<MailRule>(`/api/v1/mailboxes/${mailboxId}/rules/${ruleId}`, patch),
	deleteRule: (mailboxId: string, ruleId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/rules/${ruleId}`),
	reorderRules: (mailboxId: string, ids: string[]) =>
		post<MailRule[]>(`/api/v1/mailboxes/${mailboxId}/rules/reorder`, { ids }),
	/** Dry-run a draft against stored mail: matches only, never writes. */
	previewRule: (mailboxId: string, draft: RulePreviewDraft) =>
		post<RulePreviewResult>(
			`/api/v1/mailboxes/${mailboxId}/rules/preview`,
			draft,
		),




	// Sender policy (per-mailbox allow/block list, applied before the classifier)
	listSenderPolicy: (mailboxId: string) =>
		get<SenderPolicyEntry[]>(`/api/v1/mailboxes/${mailboxId}/sender-policy`),
	setSenderPolicy: (mailboxId: string, address: string, policy: SenderPolicy) =>
		put<SenderPolicyEntry>(`/api/v1/mailboxes/${mailboxId}/sender-policy`, { address, policy }),
	removeSenderPolicy: (mailboxId: string, address: string) =>
		del<void>(
			`/api/v1/mailboxes/${mailboxId}/sender-policy?address=${encodeURIComponent(address)}`,
		),
	/** One-click message-panel feedback: allow ("Not spam") or block a sender. */
	senderPolicyFeedback: (mailboxId: string, emailId: string, action: SenderPolicy) =>
		post<SenderPolicyEntry>(`/api/v1/mailboxes/${mailboxId}/sender-policy/feedback`, {
			emailId,
			action,
		}),

	// Search
	searchEmails: (mailboxId: string, params: Record<string, string>) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/search`, { params }),
	/** Aggregated search across every mailbox; rows carry their mailboxId. */
	searchAllMailboxes: (params: Record<string, string>, opts?: { signal?: AbortSignal }) =>
		get<EmailListResponse>(`/api/v1/search`, { params, signal: opts?.signal }),
};

export default api;
