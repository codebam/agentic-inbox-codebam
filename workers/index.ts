// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { sendEmail } from "./email-sender";
import { storeAttachments, type StoredAttachment } from "./lib/attachments";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
	listMailboxes,
} from "./lib/email-helpers";
import {
	SendEmailRequestSchema,
	BulkEmailActionSchema,
	CreateRuleSchema,
	DraftBodySchema,
	PreviewRuleSchema,
	ReorderRulesSchema,
	SenderPolicyAddressSchema,
	SenderPolicyFeedbackSchema,
	SetSenderPolicySchema,
	UpdateRuleSchema,
} from "./lib/schemas";
import { isSpamMarkedEmail } from "../shared/spam";
import { applySignatureToBody } from "../shared/signature";
import { modelConfigErrors, normalizeModelConfig } from "../shared/models";
import { emailViewSettingError, normalizeEmailViewMode } from "../shared/email-view";
import { normalizeTrashRetentionDays } from "../shared/trash-retention";
import { normalizeImageAllowlist } from "../shared/remote-images";
import { normalizeAutoDraft } from "../shared/auto-draft";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import { parseSearchQuery } from "../shared/search-query";
import {
	searchAllMailboxes,
	type MailboxSearchRow,
	type SearchAllFilters,
} from "./lib/search-all";
import {
	mergeCategorizationCategories,
	normalizeCategorizationSettings,
	SPAM_CATEGORY_ID,
} from "../shared/categories";
import {
	CATCH_ALL_LOCAL_PARTS,
	emailDomain,
	hasConfiguredAddresses,
	isCatchAllAddress,
	isMailboxCreationAllowed,
	normalizeEmailAddress,
	normalizeEmailAddressList,
	parseDomains,
	resolveCatchAllMailboxes,
} from "../shared/mailboxes";
import {
	getGlobalCategorization,
	putGlobalCategorization,
} from "./lib/global-categorization";
import { getGlobalModels, putGlobalModels } from "./lib/global-models";
import { getGlobalEmailView, putGlobalEmailView } from "./lib/global-email-view";
import {
	loadMailboxSignature,
	readMailboxSettings,
	resolveMailboxModels,
} from "./lib/mailbox-settings";
import { purgeMailbox } from "./lib/mailbox-purge";
import {
	normalizeWebhookSecret,
	normalizeWebhookUrl,
	validateWebhookUrl,
} from "../shared/webhook";
import { notifyNewEmail } from "./lib/webhook";
import {
	classifyIncomingEmail,
	serializeClassification,
} from "./lib/categorize";
import {
	emptyRuleRunResult,
	isRuleValidationError,
	resolveRuleFolderId,
	runRules,
} from "./lib/rules";
import {
	isSenderPolicyValidationError,
	senderPolicyVerdict,
	withoutSpamQuestion,
	type SenderPolicy,
} from "./lib/sender-policy";
import { handleInboundRuleOutbound } from "./lib/rule-outbound";
import type { Env } from "./types";
import {
	defaultMailboxSettings,
	requireMailbox,
	type MailboxContext,
} from "./lib/mailbox";
import type { MailboxDO } from "./durableObject";

type AppContext = Context<MailboxContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(), // unvalidated — agentSystemPrompt goes straight to AI
});

// -- Helpers --------------------------------------------------------

function slugify(text: string) { // can return "" for non-alphanumeric input
	return text.toString().toLowerCase()
		.replace(/\s+/g, "-").replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function intQuery(c: AppContext, key: string): number | undefined {
	const v = c.req.query(key);
	if (!v) return undefined;
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(c: AppContext, key: string): boolean | undefined {
	const v = c.req.query(key);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}


/** First zod issue as a human-readable 400 message (path + reason). */
function ruleErrorMessage(error: z.ZodError): string {
	const issue = error.issues[0];
	if (!issue) return "Invalid rule";
	const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
	return `Invalid rule — ${path}${issue.message}`;
}


/** Same shape of 400 message for the sender-policy routes. */
function senderPolicyErrorMessage(error: z.ZodError): string {
	const issue = error.issues[0];
	if (!issue) return "Invalid sender policy";
	const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
	return `Invalid sender policy — ${path}${issue.message}`;
}

// -- App & middleware -----------------------------------------------

const app = new Hono<MailboxContext>();
app.use("/api/*", cors({
	origin: (origin) => {
		// Same-origin requests have no Origin header — allow them.
		if (!origin) return origin;
		// In development, allow localhost for Vite dev server.
		try {
			const url = new URL(origin);
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
		} catch { /* invalid origin */ }
		// Block all other cross-origin requests. The app is served from the
		// same origin as the API, so legitimate browser requests never send
		// an Origin header. Returning undefined omits Access-Control-Allow-Origin.
		return undefined;
	},
}));
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", (c) => {
	const domains = parseDomains(c.env.DOMAINS);
	const emailAddresses = normalizeEmailAddressList(c.env.EMAIL_ADDRESSES);
	const catchAllMailboxes = [
		...new Set(resolveCatchAllMailboxes(c.env).values()),
	];
	return c.json({
		domains,
		emailAddresses,
		catchAllMailbox: normalizeEmailAddress(c.env.CATCH_ALL_MAILBOX),
		catchAllMailboxes,
	});
});

// -- Global categorization ------------------------------------------

app.get("/api/v1/categorization", async (c) => {
	return c.json(await getGlobalCategorization(c.env.BUCKET));
});

app.put("/api/v1/categorization", async (c) => {
	const body = await c.req.json<unknown>().catch(() => null);
	if (!body || typeof body !== "object") {
		return c.json({ error: "Invalid categorization settings" }, 400);
	}
	return c.json(await putGlobalCategorization(c.env.BUCKET, body));
});

// -- Global AI models -----------------------------------------------

app.get("/api/v1/models", async (c) => {
	return c.json(await getGlobalModels(c.env.BUCKET));
});

app.put("/api/v1/models", async (c) => {
	const body = await c.req.json<unknown>().catch(() => null);
	if (!body || typeof body !== "object") {
		return c.json({ error: "Invalid model settings" }, 400);
	}
	const errors = modelConfigErrors(body);
	if (Object.keys(errors).length > 0) {
		return c.json({ error: "Invalid model ID", details: errors }, 400);
	}
	return c.json(await putGlobalModels(c.env.BUCKET, body));
});

// -- Global email view ----------------------------------------------

app.get("/api/v1/email-view", async (c) => {
	return c.json(await getGlobalEmailView(c.env.BUCKET));
});

app.put("/api/v1/email-view", async (c) => {
	const body = await c.req.json<unknown>().catch(() => null);
	if (!body || typeof body !== "object") {
		return c.json({ error: "Invalid email view settings" }, 400);
	}
	const error = emailViewSettingError(body);
	if (error) return c.json({ error }, 400);
	return c.json(await putGlobalEmailView(c.env.BUCKET, body));
});

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c) => {
	const allMailboxes = await listMailboxes(c.env.BUCKET);
	return c.json(allMailboxes.map((m) => ({ ...m, name: m.id })));
});

app.post("/api/v1/mailboxes", async (c) => {
	const { name, settings, email: rawEmail } = CreateMailboxBody.parse(await c.req.json());
	const email = rawEmail.toLowerCase();
	const catchAllMailboxes = [
		...new Set(resolveCatchAllMailboxes(c.env).values()),
	];
	if (!isMailboxCreationAllowed(email, c.env.EMAIL_ADDRESSES, catchAllMailboxes)) {
		return c.json(
			{ error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES or a catch-all mailbox" },
			403,
		);
	}
	const key = `mailboxes/${email}.json`;
	if (await c.env.BUCKET.head(key)) return c.json({ error: "Mailbox already exists" }, 409);
	const finalSettings = {
		...defaultMailboxSettings(name),
		...settings,
		categorization: normalizeCategorizationSettings(settings?.["categorization"]),
		imageAllowlist: normalizeImageAllowlist(settings?.["imageAllowlist"]),
		autoDraft: normalizeAutoDraft(settings?.["autoDraft"]),
	};
	await c.env.BUCKET.put(key, JSON.stringify(finalSettings));
	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(email));
	await stub.getFolders();
	return c.json({ id: email, email, name, settings: finalSettings }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId");
	const obj = await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return c.json({ error: "Not found" }, 404);
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings: await obj.json() });
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId");
	const { settings } = await c.req.json<{ settings?: Record<string, unknown> }>();
	if (!settings || typeof settings !== "object") {
		return c.json({ error: "settings must be an object" }, 400);
	}
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	// An unusable webhook URL is rejected outright: notification settings are
	// only stored once the endpoint is known to be deliverable (absolute https).
	const webhookUrlError = validateWebhookUrl(settings["notifyWebhookUrl"]);
	if (webhookUrlError) return c.json({ error: webhookUrlError }, 400);
	// Normalize server-side so an edited stale client cannot store malformed
	// categorization, model or Trash retention settings that would break
	// inbound classification, AI calls or the retention sweep.
	const normalizedSettings = {
		...settings,
		categorization: normalizeCategorizationSettings(settings["categorization"]),
		models: normalizeModelConfig(settings["models"]),
		defaultEmailView: normalizeEmailViewMode(settings["defaultEmailView"]) ?? null,
		// Missing or unusable values fall back to the 30-day default; 0 keeps
		// trashed mail until someone empties Trash by hand.
		trashRetentionDays: normalizeTrashRetentionDays(settings["trashRetentionDays"]),
		notifyWebhookUrl: normalizeWebhookUrl(settings["notifyWebhookUrl"]),
		notifyWebhookSecret: normalizeWebhookSecret(settings["notifyWebhookSecret"]),
		imageAllowlist: normalizeImageAllowlist(settings["imageAllowlist"]),
		autoDraft: normalizeAutoDraft(settings["autoDraft"]),
	};
	await c.env.BUCKET.put(key, JSON.stringify(normalizedSettings));
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings: normalizedSettings });
});

app.delete("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId");
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	// Purges the DO's SQLite state, its R2 attachment blobs and the agent's
	// chat history; the settings marker goes last so a failure part-way
	// leaves the mailbox listed and the delete can be retried.
	const summary = await purgeMailbox(c.env, mailboxId);
	console.log(
		`Mailbox ${mailboxId} purged: ${summary.emails} email(s), ${summary.attachments} attachment(s), ${summary.blobsDeleted} blob(s)`,
	);
	return c.body(null, 204);
});


// -- Outbound webhook (notification only) ----------------------------


/**
 * Send a sample notification to a mailbox webhook so the settings UI can
 * verify an endpoint. The caller may pass the URL/secret currently typed in
 * the form; when omitted, the stored settings are used.
 *
 * Notification only — this route never sends mail. A failed delivery is
 * reported in the body (upstream status + error) rather than thrown, so the
 * UI can show exactly what the endpoint said.
 */
app.post("/api/v1/mailboxes/:mailboxId/webhook/test", async (c) => {
	const mailboxId = c.req.param("mailboxId");
	const body = (await c.req.json().catch(() => ({}))) as { url?: unknown; secret?: unknown };
	const settings = await readMailboxSettings(c.env, mailboxId);

	const url = normalizeWebhookUrl(body.url !== undefined ? body.url : settings["notifyWebhookUrl"]);
	if (!url) return c.json({ error: "No webhook URL configured" }, 400);
	const urlError = validateWebhookUrl(url);
	if (urlError) return c.json({ error: urlError }, 400);

	const secret = body.secret !== undefined
		? normalizeWebhookSecret(body.secret)
		: normalizeWebhookSecret(settings["notifyWebhookSecret"]);

	const result = await notifyNewEmail(c.env, mailboxId, {
		id: `webhook-test-${crypto.randomUUID()}`,
		subject: "Agentic Inbox webhook test",
		sender: "webhook-test@example.com",
		recipient: mailboxId,
		date: new Date().toISOString(),
		folder: Folders.INBOX,
		category: null,
		body: "This is a sample notification sent from the Agentic Inbox settings page.",
	}, { ...settings, notifyWebhookUrl: url, notifyWebhookSecret: secret });
	return c.json({ ok: result.ok, status: result.status, error: result.error });
});


// -- All Accounts (aggregated across mailboxes) ---------------------

const ALL_EMAILS_CHUNK = 100;

// -- Durable Object RPC shapes --------------------------------------
//
// The Mailbox DO's option types are not exported, and instantiating several of
// its calls straight off DurableObjectStub<MailboxDO> is excessively deep
// (TS2589 — getThreadedEmails infers its return type from getEmails). These
// types declare the RPC surface the routes actually use, the same way
// lib/search-all.ts does, deriving every shape from the Durable Object itself
// so none of them can drift.


/** One row of a mailbox list page, as returned by the Durable Object. */
type MailboxEmailRow = Awaited<ReturnType<MailboxDO["getEmails"]>>[number];

/** Options MailboxDO.getEmails accepts, derived from the Durable Object. */
type GetEmailsOptions = NonNullable<Parameters<MailboxDO["getEmails"]>[0]>;

/** Options MailboxDO.countEmails accepts, derived from the Durable Object. */
type CountEmailsOptions = NonNullable<Parameters<MailboxDO["countEmails"]>[0]>;

/** Columns MailboxDO.getEmails can order by. */
type SortColumn = NonNullable<GetEmailsOptions["sortColumn"]>;

/** The list RPCs the email routes call. */
type MailboxEmailsStub = {
	getEmails: (options: GetEmailsOptions) => Promise<MailboxEmailRow[]>;
	countEmails: (options: CountEmailsOptions) => Promise<number>;
	getThreadedEmails: (options: GetEmailsOptions) => Promise<MailboxEmailRow[]>;
	countThreadedEmails: (folder: string, category?: string) => Promise<number>;
};

/** One email of a thread: the row MailboxDO.getEmail returns. */
type MailboxThreadEmailRow = NonNullable<Awaited<ReturnType<MailboxDO["getEmail"]>>>;

/** The thread RPC the thread route and the draft spam check call. */
type MailboxThreadStub = {
	getThreadEmails: (threadId: string) => Promise<MailboxThreadEmailRow[]>;
};

/** The search RPCs the search route calls; the DO requires a query string. */
type MailboxSearchStub = {
	searchEmails: (options: SearchAllFilters & { query: string }) => Promise<MailboxSearchRow[]>;
	countSearchResults: (options: SearchAllFilters & { query: string }) => Promise<number>;
};

/**
 * The snooze/reminder RPCs the routes call. The mutators answer with the
 * updated email (the shape getEmail returns) or null for an unknown id; the
 * lists answer with rows in the same shape as a folder listing.
 */
type MailboxSnoozeStub = {
	setSnooze: (id: string, until: string) => Promise<MailboxThreadEmailRow | null>;
	clearSnooze: (id: string) => Promise<MailboxThreadEmailRow | null>;
	setReminder: (id: string, at: string) => Promise<MailboxThreadEmailRow | null>;
	clearReminder: (id: string) => Promise<MailboxThreadEmailRow | null>;
	getSnoozed: () => Promise<MailboxEmailRow[]>;
	getReminders: () => Promise<MailboxEmailRow[]>;
};


/**
 * Fetch the top `top` rows from one mailbox, chunking past the Durable
 * Object's 100-row page limit. Per-mailbox top-K is sufficient to compute
 * an exact global page of size K when the rows are merged by date, because
 * the global top-K can only contain rows from each mailbox's own top-K.
 */
async function getTopMailboxEmails(
	stub: DurableObjectStub<MailboxDO>,
	folder: string | undefined,
	top: number,
): Promise<MailboxEmailRow[]> {
	const mailbox = stub as unknown as MailboxEmailsStub;
	const emails: MailboxEmailRow[] = [];
	for (let offset = 0; offset < top; offset += ALL_EMAILS_CHUNK) {
		const limit = Math.min(ALL_EMAILS_CHUNK, top - offset);
		const page = Math.floor(offset / ALL_EMAILS_CHUNK) + 1;
		const rows = folder
			? await mailbox.getThreadedEmails({ folder, page, limit })
			: await mailbox.getEmails({ page, limit });
		emails.push(...rows);
		if (rows.length < limit) break;
	}
	return emails;
}

app.get("/api/v1/all-emails", async (c) => {
	const folderParam = c.req.query("folder");
	const folder = folderParam && folderParam !== "all" ? folderParam : undefined;
	const limit = Math.min(Math.max(intQuery(c, "limit") ?? 25, 1), 100);
	const requestedPage = Math.max(intQuery(c, "page") ?? 1, 1);

	const mailboxes = await listMailboxes(c.env.BUCKET);
	const stubs = mailboxes.map(({ id }) => ({
		id,
		stub: c.env.MAILBOX.get(c.env.MAILBOX.idFromName(id)),
	}));

	// Count first so we can clamp the requested global page and size each
	// per-mailbox top-K fetch exactly.
	const counts = await Promise.all(
		stubs.map(({ stub }) =>
			folder
				? stub.countThreadedEmails(folder)
				: stub.countEmails({}),
		),
	);
	const totalCount = counts.reduce((sum, count) => sum + count, 0);
	if (totalCount === 0) return c.json({ emails: [], totalCount: 0 });

	const maxPage = Math.max(1, Math.ceil(totalCount / limit));
	const page = Math.min(requestedPage, maxPage);
	const top = page * limit;

	const perMailbox = await Promise.all(
		stubs.map(async ({ id, stub }) => ({
			mailboxId: id,
			emails: await getTopMailboxEmails(stub, folder, top),
		})),
	);

	const merged = perMailbox
		.flatMap(({ mailboxId, emails }) =>
			emails.map((email) => ({ ...email, mailboxId })),
		)
		.sort((a, b) => {
			const aTime = Date.parse(String(a.date ?? ""));
			const bTime = Date.parse(String(b.date ?? ""));
			return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
		});

	const offset = (page - 1) * limit;
	return c.json({
		emails: merged.slice(offset, offset + limit),
		totalCount,
	});
});

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const category = c.req.query("category") || undefined;
	const threaded = boolQuery(c, "threaded");
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	// Defaulted rather than passed through as undefined so the option is always
	// defined (exactOptionalPropertyTypes); the DO validates the name against its
	// own allowlist and falls back to "date".
	const sortColumn = (c.req.query("sortColumn") ?? "date") as SortColumn;
	const sortDirection = c.req.query("sortDirection") as "ASC" | "DESC" | undefined;
	const stub = c.var.mailboxStub as unknown as MailboxEmailsStub;

	if (threaded && folder) {
		const emails = await stub.getThreadedEmails({ folder, category, page, limit });
		const totalCount = await stub.countThreadedEmails(folder, category);
		return c.json({ emails, totalCount });
	}
	const emails = await stub.getEmails({ folder, thread_id, category, page, limit, sortColumn, sortDirection });
	if (folder) {
		const totalCount = await stub.countEmails({ folder, thread_id, category });
		return c.json({ emails, totalCount });
	}
	return c.json(emails);
});

app.post("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments, in_reply_to, references, thread_id } = body;

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const stub = c.var.mailboxStub;
	const rateLimitError = await stub.checkSendRateLimit();
	if (rateLimitError) return c.json({ error: rateLimitError }, 429);
	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await stub.createEmail(Folders.SENT, {
		id: messageId, subject, sender: fromEmail, recipient: toStr,
		cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
		bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
		date: new Date().toISOString(), body: html || text || "",
		in_reply_to: in_reply_to || null, email_references: references ? JSON.stringify(references) : null,
		thread_id: thread_id || in_reply_to || messageId, message_id: outgoingMessageId,
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
			{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
			...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
			...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
			{ key: "subject", value: subject }, { key: "date", value: new Date().toISOString() },
			{ key: "message-id", value: `<${outgoingMessageId}>` },
		]),
	}, attachmentData);

	c.executionCtx.waitUntil(
		sendEmail(c.env.EMAIL, {
			to, cc, bcc, from, subject, html, text,
			attachments: attachments?.map((att) => ({ content: att.content, filename: att.filename, type: att.type, disposition: att.disposition || "attachment", contentId: att.contentId })),
			...(in_reply_to ? { headers: buildThreadingHeaders(in_reply_to, references || []) } : {}),
		}).catch((e) => console.error("Deferred email delivery failed:", (e as Error).message)),
	);
	return c.json({ id: messageId, status: "sent" }, 202);
});

app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { to, cc, bcc, subject, body, attachments, in_reply_to, thread_id, draft_id, applySignature } = DraftBodySchema.parse(await c.req.json());
	const stub = c.var.mailboxStub;
	// Thread lookups go through their structural shape: the real RPC type is
	// excessively deep to instantiate (see the Durable Object RPC shapes above).
	const threadStub = stub as unknown as MailboxThreadStub;

	// Draft replies to spam are refused at the same layer as the agent and MCP
	// tools, so a human saving from the composer cannot create one either.
	const currentDraft = draft_id
		? ((await stub.getEmail(draft_id)) as {
				folder_id?: string | null;
				in_reply_to?: string | null;
				thread_id?: string | null;
			} | null)
		: null;
	if (draft_id && (!currentDraft || currentDraft.folder_id !== Folders.DRAFT)) {
		return c.json({ error: "Draft not found" }, 404);
	}

	// Use the incoming target, or inherit it when updating an existing draft,
	// so omitting in_reply_to cannot bypass the spam check.
	const replyTarget = in_reply_to || currentDraft?.in_reply_to || null;
	const threadTarget = thread_id || currentDraft?.thread_id || null;

	if (replyTarget) {
		const original = (await stub.getEmail(replyTarget)) as {
			folder_id?: string | null;
			category?: string | null;
			classification?: string | null;
		} | null;
		if (!original) {
			return c.json({ error: "Original email not found" }, 404);
		}
		if (isSpamMarkedEmail(original)) {
			return c.json(
				{
					error:
						"Cannot save a draft reply to an email marked as spam. Move the original out of Spam or remove the spam category first.",
				},
				409,
			);
		}
	} else if (threadTarget) {
		const threadEmails = await threadStub.getThreadEmails(threadTarget);
		if (threadEmails.some((email) => isSpamMarkedEmail(email))) {
			return c.json(
				{
					error:
						"Cannot save a draft reply to a spam-marked thread. Move the original out of Spam or remove the spam category first.",
				},
				409,
			);
		}
	}

	if (draft_id && currentDraft) {
		// Delete after validation; clean up R2 attachments just like the
		// regular email-delete route.
		const attachments = await stub.deleteEmail(draft_id);
		if (attachments && attachments.length > 0) {
			await c.env.BUCKET.delete(
				attachments.map(
					(att) => `attachments/${draft_id}/${att.id}/${att.filename}`,
				),
			);
		}
	}
	const messageId = crypto.randomUUID();
	const now = new Date().toISOString();
	// Programmatic callers (agent/MCP integrations) can ask for the mailbox
	// signature server-side. The browser composer prefills the signature
	// client-side and never sets applySignature, so a draft is never signed
	// twice and sending a saved draft never appends another one.
	const storedBody = applySignature
		? applySignatureToBody(body, await loadMailboxSignature(c.env, mailboxId))
		: body;
	// Persist the composer's files with the draft so re-opening and sending it
	// keeps the attachments (the previous draft's copies are deleted above).
	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);
	await stub.createEmail(Folders.DRAFT, {
		id: messageId, subject: subject || "", sender: mailboxId.toLowerCase(),
		recipient: (to || "").toLowerCase(), cc: cc?.toLowerCase() || null, bcc: bcc?.toLowerCase() || null,
		date: now, body: storedBody, in_reply_to: replyTarget || null, email_references: null,
		thread_id: threadTarget || replyTarget || messageId,
	}, attachmentData);
	return c.json({ id: messageId, draft_id: messageId, status: "draft", subject: subject || "", recipient: to || "", date: now, signatureApplied: storedBody !== body }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const email = await c.var.mailboxStub.getEmail(c.req.param("id")!);
	if (!email) return c.json({ error: "Email not found" }, 404);
	return new Response(JSON.stringify(email), {
		headers: { "Content-Type": "application/json" },
	});
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const { read, starred } = await c.req.json<{ read?: boolean; starred?: boolean }>();
	const email = await c.var.mailboxStub.updateEmail(c.req.param("id")!, { read, starred });
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

/**
 * Delete an email.
 *
 * Trash semantics: a plain DELETE moves the message to the Trash folder;
 * deleting a message that already sits in Trash removes it permanently
 * (row + R2 blobs). `?permanent=true` forces permanent deletion from any
 * folder.
 */
app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const id = c.req.param("id")!;
	const stub = c.var.mailboxStub;

	if (!boolQuery(c, "permanent")) {
		const { trashed } = await stub.trashEmails([id]);
		if (trashed.length > 0) return c.json({ status: "trashed", trashed: 1, purged: 0 });
	}

	const attachments = await stub.deleteEmail(id);
	if (attachments === null) return c.json({ error: "Not found" }, 404);
	if (attachments.length > 0) await c.env.BUCKET.delete(attachments.map((att) => `attachments/${id}/${att.id}/${att.filename}`));
	return c.json({ status: "deleted", trashed: 0, purged: 1 });
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const { folderId } = await c.req.json<{ folderId: string }>();
	const success = await c.var.mailboxStub.moveEmail(c.req.param("id")!, folderId);
	return success ? c.json({ status: "moved" }) : c.json({ error: "Folder not found" }, 400);
});


/** Move a trashed email back to the inbox. */
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/restore", async (c: AppContext) => {
	const restored = (await c.var.mailboxStub.restoreEmails([
		c.req.param("id")!,
	])) as string[];
	return c.json({ restored: restored.length });
});

// -- Snooze & reminders ---------------------------------------------

/** The snooze/reminder RPCs are not part of the default stub shape (see the aliases above). */
function snoozeStub(c: AppContext): MailboxSnoozeStub {
	return c.var.mailboxStub as unknown as MailboxSnoozeStub;
}

/**
 * Parse a caller-supplied due time into the canonical UTC instant stored on
 * the row. Both snooze and reminder times must be valid ISO 8601 AND in the
 * future: a time in the past would be due immediately, which reads as "the
 * request did nothing", so it is rejected instead. Null marks unusable input.
 */
function futureTimestamp(value: unknown): string | null {
	if (typeof value !== "string" || !value.trim()) return null;
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed) || parsed <= Date.now()) return null;
	return new Date(parsed).toISOString();
}

/** Snooze a message until `until`; it moves to Snoozed and comes back by itself. */
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/snooze", async (c: AppContext) => {
	const body = await c.req
		.json<{ until?: unknown }>()
		.catch(() => null);
	const until = futureTimestamp(body?.until);
	if (!until) {
		return c.json({ error: "`until` must be a future ISO 8601 timestamp" }, 400);
	}
	const email = await snoozeStub(c).setSnooze(c.req.param("id")!, until);
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

/** Wake a snoozed message now, back to the folder it came from. */
app.delete("/api/v1/mailboxes/:mailboxId/emails/:id/snooze", async (c: AppContext) => {
	const email = await snoozeStub(c).clearSnooze(c.req.param("id")!);
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reminder", async (c: AppContext) => {
	const body = await c.req
		.json<{ at?: unknown }>()
		.catch(() => null);
	const at = futureTimestamp(body?.at);
	if (!at) {
		return c.json({ error: "`at` must be a future ISO 8601 timestamp" }, 400);
	}
	const email = await snoozeStub(c).setReminder(c.req.param("id")!, at);
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id/reminder", async (c: AppContext) => {
	const email = await snoozeStub(c).clearReminder(c.req.param("id")!);
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

/** Messages currently asleep in the Snoozed folder, earliest wake first. */
app.get("/api/v1/mailboxes/:mailboxId/snoozed", async (c: AppContext) => {
	const emails = await snoozeStub(c).getSnoozed();
	return c.json({ emails, totalCount: emails.length });
});

/** Follow-ups that already fired and are waiting for an answer. */
app.get("/api/v1/mailboxes/:mailboxId/reminders", async (c: AppContext) => {
	const emails = await snoozeStub(c).getReminders();
	return c.json({ emails, totalCount: emails.length });
});

// -- Bulk actions (list-view multi-select) --------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/bulk", async (c: AppContext) => {
	const parsed = BulkEmailActionSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) {
		return c.json({ error: "Invalid bulk action request" }, 400);
	}
	const { action, ids, threadIds, folderId } = parsed.data;
	const stub = c.var.mailboxStub;

	switch (action) {
		case "mark_read":
		case "mark_unread": {
			await stub.bulkUpdateEmails(ids, { read: action === "mark_read" }, threadIds ?? []);
			return c.json({ updated: ids.length });
		}
		case "star":
		case "unstar": {
			await stub.bulkUpdateEmails(ids, { starred: action === "star" });
			return c.json({ updated: ids.length });
		}
		case "move": {
			const moved = await stub.bulkMoveEmails(ids, folderId!);
			return moved
				? c.json({ updated: ids.length })
				: c.json({ error: "Folder not found" }, 400);
		}
		// Trash semantics, per action:
		//   trash   — always move to the Trash folder
		//   restore — move Trash messages back to the inbox
		//   delete  — trash-aware: messages already in Trash are purged for
		//             good, everything else moves to Trash. Only the purge
		//             path touches R2.
		case "trash": {
			const { trashed } = await stub.trashEmails(ids);
			return c.json({ trashed: trashed.length, purged: 0, restored: 0 });
		}
		case "restore": {
			const restored = await stub.restoreEmails(ids);
			return c.json({ trashed: 0, purged: 0, restored: restored.length });
		}
		case "delete": {
			const { trashed, alreadyInTrash } = await stub.trashEmails(ids);
			if (alreadyInTrash.length > 0) {
				const attachments = await stub.bulkDeleteEmails(alreadyInTrash);
				if (attachments.length > 0) {
					await c.env.BUCKET.delete(
						attachments.map(
							(att) => `attachments/${att.email_id}/${att.id}/${att.filename}`,
						),
					);
				}
			}
			return c.json({ trashed: trashed.length, purged: alreadyInTrash.length, restored: 0 });
		}
	}
});


// -- Trash ----------------------------------------------------------

/**
 * Permanently delete every message in the Trash folder, including its R2
 * attachment blobs. Exposed as an explicit endpoint so emptying Trash is
 * always a deliberate action, never a side effect of a plain delete.
 */
app.post("/api/v1/mailboxes/:mailboxId/trash/empty", async (c: AppContext) => {
	const { purged, attachments } = await c.var.mailboxStub.emptyTrash();
	if (attachments.length > 0) {
		await c.env.BUCKET.delete(
			attachments.map(
				(att) => `attachments/${att.email_id}/${att.id}/${att.filename}`,
			),
		);
	}
	return c.json({ purged });
});


// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	const stub = c.var.mailboxStub as unknown as MailboxThreadStub;
	return c.json(await stub.getThreadEmails(c.req.param("threadId")!));
});

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c: AppContext) => {
	await c.var.mailboxStub.markThreadRead(c.req.param("threadId")!);
	return c.json({ status: "marked_read" });
});

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => c.json(await c.var.mailboxStub.getFolders()));

app.post("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => {
	const { name } = await c.req.json<{ name: string }>();
	const slug = slugify(name);
	if (!slug) return c.json({ error: "Folder name must contain alphanumeric characters" }, 400);
	const f = await c.var.mailboxStub.createFolder(slug, name);
	return f ? c.json(f, 201) : c.json({ error: "Folder with this name already exists" }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const { name } = await c.req.json<{ name: string }>();
	const f = await c.var.mailboxStub.updateFolder(c.req.param("id")!, name);
	return f ? c.json(f) : c.json({ error: "Folder not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteFolder(c.req.param("id")!);
	return ok ? c.body(null, 204) : c.json({ error: "Folder not found or cannot be deleted" }, 400);
});


// -- Rules (deterministic per-mailbox filters) ----------------------


/**
 * Validate a rule's move_to_folder target so the API answers 400 for an unknown
 * folder. The Durable Object still enforces this, but its throw is rebuilt by
 * RPC and would otherwise surface as a 500.
 */
async function unknownRuleFolder(
	mailboxStub: MailboxContext["Variables"]["mailboxStub"],
	actions: { move_to_folder?: string | undefined } | undefined,
): Promise<string | null> {
	const folder = actions?.move_to_folder;
	if (!folder) return null;
	const folders = (await mailboxStub.getFolders()) as {
		id: string;
		name: string;
	}[];
	if (resolveRuleFolderId(folder, folders)) return null;
	return `Unknown folder: ${folder}`;
}




app.get("/api/v1/mailboxes/:mailboxId/rules", async (c: AppContext) => {
	return c.json(await c.var.mailboxStub.listRules());
});


app.post("/api/v1/mailboxes/:mailboxId/rules", async (c: AppContext) => {
	const parsed = CreateRuleSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: ruleErrorMessage(parsed.error) }, 400);
	const folderError = await unknownRuleFolder(c.var.mailboxStub, parsed.data.actions);
	if (folderError) return c.json({ error: folderError }, 400);
	try {
		return c.json(await c.var.mailboxStub.createRule(parsed.data), 201);
	} catch (e) {
		if (isRuleValidationError(e)) return c.json({ error: (e as Error).message }, 400);
		throw e;
	}
});


app.put("/api/v1/mailboxes/:mailboxId/rules/:ruleId", async (c: AppContext) => {
	const parsed = UpdateRuleSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: ruleErrorMessage(parsed.error) }, 400);
	const folderError = await unknownRuleFolder(c.var.mailboxStub, parsed.data.actions);
	if (folderError) return c.json({ error: folderError }, 400);
	try {
		const rule = await c.var.mailboxStub.updateRule(c.req.param("ruleId")!, parsed.data);
		return rule ? c.json(rule) : c.json({ error: "Rule not found" }, 404);
	} catch (e) {
		if (isRuleValidationError(e)) return c.json({ error: (e as Error).message }, 400);
		throw e;
	}
});


app.delete("/api/v1/mailboxes/:mailboxId/rules/:ruleId", async (c: AppContext) => {
	const deleted = await c.var.mailboxStub.deleteRule(c.req.param("ruleId")!);
	return deleted ? c.body(null, 204) : c.json({ error: "Rule not found" }, 404);
});


app.post("/api/v1/mailboxes/:mailboxId/rules/reorder", async (c: AppContext) => {
	const parsed = ReorderRulesSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: ruleErrorMessage(parsed.error) }, 400);
	return c.json(await c.var.mailboxStub.reorderRules(parsed.data.ids));
});


// -- Sender policy (per-mailbox allow/block list) -------------------


/** Every allow/block entry for this mailbox, oldest first. */
app.get("/api/v1/mailboxes/:mailboxId/sender-policy", async (c: AppContext) => {
	return c.json(await c.var.mailboxStub.listSenderPolicy());
});


/**
 * Upsert one entry. The stored policy overrides the AI classifier on arrival:
 * `block` files mail straight into Spam (still stored — never dropped — and
 * never auto-drafted), `allow` skips spam classification for that sender but
 * still lets categories be classified.
 */
app.put("/api/v1/mailboxes/:mailboxId/sender-policy", async (c: AppContext) => {
	const parsed = SetSenderPolicySchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: senderPolicyErrorMessage(parsed.error) }, 400);
	try {
		return c.json(
			await c.var.mailboxStub.setSenderPolicy(parsed.data.address, parsed.data.policy),
		);
	} catch (e) {
		if (isSenderPolicyValidationError(e)) return c.json({ error: (e as Error).message }, 400);
		throw e;
	}
});


/**
 * Dry-run a rule draft: matched message summaries, no writes, no sends. Same
 * folder validation as create, so an invalid move target is a 400 here too
 * instead of a surprise when the rule is saved.
 */
app.post("/api/v1/mailboxes/:mailboxId/rules/preview", async (c: AppContext) => {
	const parsed = PreviewRuleSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: ruleErrorMessage(parsed.error) }, 400);
	const folderError = await unknownRuleFolder(c.var.mailboxStub, parsed.data.actions);
	if (folderError) return c.json({ error: folderError }, 400);
	try {
		return c.json(await c.var.mailboxStub.previewRule(parsed.data));
	} catch (e) {
		if (isRuleValidationError(e)) return c.json({ error: (e as Error).message }, 400);
		throw e;
	}
});


/** Remove one entry by ?address=...; 404 when there is nothing to remove. */
app.delete("/api/v1/mailboxes/:mailboxId/sender-policy", async (c: AppContext) => {
	const parsed = SenderPolicyAddressSchema.safeParse(c.req.query("address"));
	if (!parsed.success) return c.json({ error: senderPolicyErrorMessage(parsed.error) }, 400);
	const removed = await c.var.mailboxStub.removeSenderPolicy(parsed.data);
	return removed ? c.body(null, 204) : c.json({ error: "Sender policy entry not found" }, 404);
});


/**
 * One-click message-panel feedback:
 *   - `allow` ("Not spam") records an allow entry, moves the message back to
 *     the Inbox, and clears its spam category/classification.
 *   - `block` ("Block sender") records a block entry and moves the message to
 *     Spam (it is still stored there — never deleted).
 */
app.post("/api/v1/mailboxes/:mailboxId/sender-policy/feedback", async (c: AppContext) => {
	const parsed = SenderPolicyFeedbackSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: senderPolicyErrorMessage(parsed.error) }, 400);
	try {
		const entry = await c.var.mailboxStub.applySenderPolicyFeedback(
			parsed.data.emailId,
			parsed.data.action,
		);
		return entry ? c.json(entry) : c.json({ error: "Email not found" }, 404);
	} catch (e) {
		if (isSenderPolicyValidationError(e)) return c.json({ error: (e as Error).message }, 400);
		throw e;
	}
});
// -- Search ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/search", async (c: AppContext) => {
	const searchOpts: SearchAllFilters & { query: string } = {
		query: c.req.query("query") || "", folder: c.req.query("folder"), category: c.req.query("category"),
		from: c.req.query("from"),
		to: c.req.query("to"), subject: c.req.query("subject"), date_start: c.req.query("date_start"),
		date_end: c.req.query("date_end"), is_read: boolQuery(c, "is_read"),
		is_starred: boolQuery(c, "is_starred"), has_attachment: boolQuery(c, "has_attachment"),
	};
	const stub = c.var.mailboxStub as unknown as MailboxSearchStub;
	const emails = await stub.searchEmails({ ...searchOpts, page: intQuery(c, "page"), limit: intQuery(c, "limit") });
	const totalCount = await stub.countSearchResults(searchOpts);
	return c.json({ emails, totalCount });
});


/**
 * Aggregated search across every mailbox.
 *
 * `q` is a raw Gmail-style query (e.g. `from:bob is:unread has:attachment`),
 * parsed server-side by the shared search-query parser so clients can pass a
 * query string straight through. Explicit operator params override the values
 * parsed out of `q`. Rows are merged by date descending and tagged with the
 * mailboxId they belong to.
 */
app.get("/api/v1/search", async (c) => {
	const parsed = parseSearchQuery(c.req.query("q") ?? c.req.query("query") ?? "");
	const folderParam = c.req.query("folder");
	const result = await searchAllMailboxes(c.env, {
		query: parsed.query,
		folder: folderParam && folderParam !== "all" ? folderParam : parsed.folder,
		category: c.req.query("category"),
		from: c.req.query("from") ?? parsed.from,
		to: c.req.query("to") ?? parsed.to,
		subject: c.req.query("subject") ?? parsed.subject,
		date_start: c.req.query("date_start") ?? parsed.date_start,
		date_end: c.req.query("date_end") ?? parsed.date_end,
		is_read: boolQuery(c, "is_read") ?? parsed.is_read,
		is_starred: boolQuery(c, "is_starred") ?? parsed.is_starred,
		has_attachment: boolQuery(c, "has_attachment") ?? parsed.has_attachment,
		page: intQuery(c, "page"),
		limit: intQuery(c, "limit"),
	});
	return c.json(result);
});

// -- Attachments ----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const attachment = await c.var.mailboxStub.getAttachment(attachmentId);
	if (!attachment) return c.json({ error: "Attachment not found" }, 404);
	const obj = await c.env.BUCKET.get(`attachments/${emailId}/${attachmentId}/${attachment.filename}`);
	if (!obj) return c.json({ error: "Attachment file not found" }, 404);
	const headers = new Headers();
	headers.set("Content-Type", attachment.mimetype);
	// Control characters are exactly what has to go from a header value.
	// eslint-disable-next-line no-control-regex -- deliberate: strip control characters
	const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
	headers.set("Content-Disposition", `attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
	return new Response(obj.body, { headers });
});

// -- Receive inbound email ------------------------------------------

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

async function streamToArrayBuffer(
	stream: ReadableStream<Uint8Array>,
	streamSize: number,
): Promise<Uint8Array> {
	if (streamSize > MAX_EMAIL_SIZE) throw new Error(`Email too large: ${streamSize} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`);
	if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);
	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytesRead + value.length > streamSize) {
			// Best effort: the read is being abandoned, so the cancel is not awaited.
			void reader.cancel();
			throw new Error(`Stream exceeds declared size`);
		}
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
}

export interface InboundEmailEvent {
	readonly raw: ReadableStream<Uint8Array>;
	readonly rawSize: number;
	/** SMTP envelope recipient supplied by Cloudflare Email Routing. */
	readonly to?: string;
}

async function receiveEmail(event: InboundEmailEvent, env: Env, ctx: ExecutionContext) {
	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);

	const parsedToRecipients = (parsedEmail.to || [])
		.map((recipient) => normalizeEmailAddress(recipient.address))
		.filter((address): address is string => address !== null);
	const ccRecipients = (parsedEmail.cc || [])
		.map((recipient) => normalizeEmailAddress(recipient.address))
		.filter((address): address is string => address !== null);
	const bccRecipients = (parsedEmail.bcc || [])
		.map((recipient) => normalizeEmailAddress(recipient.address))
		.filter((address): address is string => address !== null);
	const replyToRecipients = (parsedEmail.replyTo || [])
		.map((recipient) => normalizeEmailAddress(recipient.address))
		.filter((address): address is string => address !== null);

	const envelopeRecipient = normalizeEmailAddress(event.to);
	// The SMTP envelope recipient is the routing source of truth. Fall back to
	// the visible To headers only for local/test invocations that do not supply
	// one (and for Bcc-only messages without a usable envelope recipient).
	const routingRecipients = envelopeRecipient
		? [envelopeRecipient]
		: parsedToRecipients;
	if (routingRecipients.length === 0) {
		throw new Error("received email with no valid recipient address");
	}

	// Visible headers are stored as-is; routing follows the SMTP envelope first,
	// then the visible To headers as a fallback for older/local invocations.
	const allRecipients = parsedToRecipients.length > 0 ? parsedToRecipients : routingRecipients;
	const allowedAddresses = new Set(normalizeEmailAddressList(env.EMAIL_ADDRESSES));
	const hasAllowList = hasConfiguredAddresses(env.EMAIL_ADDRESSES);
	const catchAllMailboxes = resolveCatchAllMailboxes(env);

	let mailboxId: string | undefined;
	let mailboxIsCatchAll = false;

	const directCandidates = hasAllowList
		? routingRecipients.filter((address) => allowedAddresses.has(address))
		: routingRecipients;

	for (const candidate of directCandidates) {
		if (await env.BUCKET.head(`mailboxes/${candidate}.json`)) {
			mailboxId = candidate;
			break;
		}
	}

	// No dedicated mailbox: hand the message to the catch-all mailbox for the
	// recipient's domain. Hand-made aliases (catchall@, catch_all@) are honoured
	// before falling back to the canonical catch-all@ address.
	if (!mailboxId) {
		for (const candidate of routingRecipients) {
			const domain = emailDomain(candidate);
			if (!domain) continue;
			const target = catchAllMailboxes.get(domain);
			if (!target) continue;

			// Only conventional catch-all names are resolved to hand-made
			// aliases; an explicit CATCH_ALL_MAILBOXES target is used verbatim.
			const targetAddresses = isCatchAllAddress(target)
				? [
						...new Set([
							target,
							...CATCH_ALL_LOCAL_PARTS.map((localPart) => `${localPart}@${domain}`),
						]),
					]
				: [target];
			for (const address of targetAddresses) {
				if (await env.BUCKET.head(`mailboxes/${address}.json`)) {
					mailboxId = address;
					break;
				}
			}
			if (!mailboxId) mailboxId = target;
			mailboxIsCatchAll = true;
			break;
		}
	}

	if (!mailboxId) {
		console.log(
			hasAllowList
				? "Ignoring email: no recipient matches EMAIL_ADDRESSES or a catch-all mailbox."
				: `Ignoring email for ${routingRecipients.join(", ")}: mailbox does not exist and no catch-all is configured.`,
		);
		return;
	}

	const mailboxKey = `mailboxes/${mailboxId}.json`;
	const mailboxObject = await env.BUCKET.get(mailboxKey);
	let mailboxSettings: Record<string, unknown>;
	if (mailboxObject) {
		mailboxSettings = (await mailboxObject.json().catch(() => ({}))) as Record<string, unknown>;
	} else if (mailboxIsCatchAll) {
		const localPart = mailboxId.split("@")[0] || mailboxId;
		mailboxSettings = defaultMailboxSettings(
			isCatchAllAddress(mailboxId) ? "Catch-all" : localPart,
		);
		await env.BUCKET.put(mailboxKey, JSON.stringify(mailboxSettings));
		console.log(`Catch-all mailbox created: ${mailboxId}`);
	} else {
		console.log(`Ignoring email for ${mailboxId}: mailbox does not exist`);
		return;
	}
	const categorization = normalizeCategorizationSettings(mailboxSettings["categorization"]);

	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));


	// ── Deterministic rules run BEFORE the AI classifier ────────────
	// Precedence, in order:
	//   1. A rule with `discard` drops the message outright: it is never
	//      stored and no attachment bytes reach R2 (this block runs before
	//      the attachment upload below).
	//   2. Any other matched rule shapes the stored row (folder, category,
	//      read, starred) and is authoritative — the Jev classifier is
	//      skipped for messages a rule already routed, so AI never overrides
	//      user-authored automation.
	//   3. Only messages no rule matched reach the classifier.
	// Rule loading/evaluation failures never block delivery: they are logged
	// and the message is delivered unruled.
	let ruleResult = emptyRuleRunResult();
	try {
		ruleResult = runRules(await stub.listRules(), {
			sender: (parsedEmail.from?.address || "").toLowerCase(),
			recipient: allRecipients.join(", "),
			envelope_recipient: envelopeRecipient ?? routingRecipients[0] ?? null,
			cc: ccRecipients.join(", ") || null,
			bcc: bccRecipients.join(", ") || null,
			subject: parsedEmail.subject || "",
			body: parsedEmail.html || parsedEmail.text || "",
			has_attachment: (parsedEmail.attachments?.length ?? 0) > 0,
			// Inbound mail carries no category until classification runs, so
			// category_equals cannot match on arrival.
			category: null,
		});
	} catch (e) {
		console.error("Rule evaluation failed; delivering without rules:", (e as Error).message);
	}


	// Firing statistics: every rule that acted on this message is counted,
	// including a discard rule — the message is dropped, but the rule fired.
	// Best-effort: a stats failure must never block delivery.
	if (ruleResult.appliedRuleIds.length > 0) {
		try {
			await stub.recordRuleFirings(ruleResult.appliedRuleIds);
		} catch (e) {
			console.error("Rule stats update failed:", (e as Error).message);
		}
	}

	if (ruleResult.discarded) {
		console.log(`Inbound email discarded by rule(s) for ${mailboxId}: ${ruleResult.appliedRules.join(", ")}`);
		return;
	}
	if (ruleResult.appliedRules.length > 0) {
		console.log(`Inbound rules applied for ${mailboxId}: ${ruleResult.appliedRules.join(", ")}`);
	}


	const messageId = crypto.randomUUID();
	const attachmentData: StoredAttachment[] = [];
	if (parsedEmail.attachments) {
		for (const att of parsedEmail.attachments) {
			const attId = crypto.randomUUID();
			// Control characters and path separators are exactly what has to go.
			// eslint-disable-next-line no-control-regex -- deliberate: strip control characters
			const filename = (att.filename || "untitled").replace(/[/\\:*?"<>|\x00-\x1f]/g, "_");
			await env.BUCKET.put(`attachments/${messageId}/${attId}/${filename}`, att.content);
			attachmentData.push({ id: attId, email_id: messageId, filename, mimetype: att.mimeType,
				size: typeof att.content === "string" ? att.content.length : att.content.byteLength,
				content_id: att.contentId || null, disposition: att.disposition || "attachment" });
		}
	}

	const extractMsgId = (s: string) => { const m = s.match(/<([^>]+)>/); return m ? m[1] : s.trim().split(/\s+/)[0]; };
	const inReplyTo = parsedEmail.inReplyTo ? extractMsgId(parsedEmail.inReplyTo) : null;
	const emailReferences = parsedEmail.references ? parsedEmail.references.split(/\s+/).filter(Boolean).map(extractMsgId) : [];
	let threadId = emailReferences[0] || inReplyTo || messageId;

	if (!inReplyTo && emailReferences.length === 0) {
		const subjectThread = await stub.findThreadBySubject(parsedEmail.subject || "", parsedEmail.from?.address || undefined);
		if (subjectThread) threadId = subjectThread;
	}

	const originalMessageId = parsedEmail.messageId ? extractMsgId(parsedEmail.messageId) : null;

	// Merge app-wide categories with this mailbox's own categories unless the
	// mailbox opted out. Global category edits then apply to all mailboxes
	// without rewriting each mailbox settings JSON.
	const globalCategories = categorization.useGlobalCategories
		? (await getGlobalCategorization(env.BUCKET)).categories
		: [];
	const effectiveCategorization = {
		...categorization,
		categories: mergeCategorizationCategories(
			globalCategories,
			categorization.categories,
			categorization.useGlobalCategories,
		),
	};

	// Model ids come from the mailbox settings, falling back to app-wide
	// settings and the built-in defaults.
	const models = await resolveMailboxModels(env, mailboxId, mailboxSettings);


	// ── Per-mailbox sender policy overrides the AI classifier ──────
	// One lookup plus one pure decision (workers/lib/sender-policy.ts):
	//   block → filed straight into Spam, classification and auto-draft
	//           skipped (the message is still STORED — never dropped)
	//   allow → treated as not-spam: the spam question is dropped, category
	//           classification still runs
	//   none  → today's behaviour
	// A lookup failure is non-fatal: the message is delivered exactly as if no
	// entry existed, mirroring how rule-evaluation failures are handled.
	const senderAddress = (parsedEmail.from?.address || "").toLowerCase();
	let senderPolicy: SenderPolicy | null = null;
	try {
		senderPolicy = (await stub.getSenderPolicy(senderAddress))?.policy ?? null;
	} catch (e) {
		console.error(
			"Sender policy lookup failed; falling back to the classifier:",
			(e as Error).message,
		);
	}
	const senderDecision = senderPolicyVerdict(senderPolicy);

	// Best-effort Jev classification, skipped for messages a rule already
	// routed (see the precedence note above) and for blocked senders. A null
	// result (disabled, failed, or skipped) still delivers the email.
	const classification = ruleResult.routed || !senderDecision.classify
		? null
		: await classifyIncomingEmail(env.AI, {
		sender: senderAddress,
		senderName: parsedEmail.from?.name || null,
		recipients: [...allRecipients, ...ccRecipients].join(", "),
		subject: parsedEmail.subject || "",
		body: parsedEmail.html || parsedEmail.text || "",
	}, senderDecision.forceNotSpam ? withoutSpamQuestion(effectiveCategorization) : effectiveCategorization, models.classifier);

	const isSpam = classification?.isSpam === true;
	// A rule that files mail somewhere outranks the AI's Inbox/Spam guess, but
	// a blocked sender outranks both. The folder can have been deleted since
	// the rule was saved, so it is checked before use and falls back to the
	// Inbox — the documented behaviour for a rule pointing at a dead folder.
	let ruleFolder: string | null = ruleResult.mutation.folder ?? null;
	if (ruleFolder) {
		try {
			const folders = (await stub.getFolders()) as { id: string }[];
			if (!folders.some((folder) => folder.id === ruleFolder)) ruleFolder = null;
		} catch (e) {
			console.error(
				"Rule folder lookup failed; filing in the Inbox instead:",
				(e as Error).message,
			);
			ruleFolder = null;
		}
	}
	// A blocked sender is always filed in Spam, regardless of the mailbox's
	// moveToSpam setting — blocking is an explicit per-sender instruction.
	const destinationFolder = senderDecision.folder
		? senderDecision.folder
		: ruleFolder ?? (isSpam && effectiveCategorization.spam.moveToSpam ? Folders.SPAM : Folders.INBOX);

	const createResult = await stub.createEmail(destinationFolder, {
		id: messageId, subject: parsedEmail.subject || "",
		sender: (parsedEmail.from?.address || "").toLowerCase(), recipient: allRecipients.join(", "),
		envelope_recipient: envelopeRecipient ?? routingRecipients[0] ?? null,
		cc: ccRecipients.join(", ") || null, bcc: bccRecipients.join(", ") || null,
		reply_to: replyToRecipients.join(", ") || null,
		date: new Date().toISOString(), // uses receive time, not the email's Date header
		body: parsedEmail.html || parsedEmail.text || "",
		body_text: parsedEmail.text ?? null,
		in_reply_to: inReplyTo, email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
		thread_id: threadId, message_id: originalMessageId, raw_headers: JSON.stringify(parsedEmail.headers),
		// Blocked senders always carry the spam category; otherwise a rule's
		// category is authoritative and the classifier only fills it in for
		// messages no rule matched.
		category: senderDecision.verdict === "block"
			? SPAM_CATEGORY_ID
			: ruleResult.mutation.category ?? classification?.category ?? null,
		category_confidence: classification?.categoryConfidence ?? null,
		classification: serializeClassification(classification),
		// Rule flags; undefined (no rule matched) leaves the createEmail default.
		read: ruleResult.mutation.read,
		starred: ruleResult.mutation.starred,
		// Which rule acted on this message. The first rule in evaluation order
		// owns the stamp, mirroring first-write-wins for the mutation.
		matched_rule_id: ruleResult.appliedRuleIds[0] ?? null,
		matched_rule_name: ruleResult.appliedRules[0] ?? null,
	}, attachmentData);

	// Duplicate delivery: this Message-ID is already stored in the mailbox, so
	// skip every downstream side effect — no auto-draft trigger, no
	// notification work — and leave the existing row where it is. The
	// attachment blobs uploaded above stay unreferenced; they are the only
	// artefact of the redelivery.
	if (createResult.duplicate) {
		console.log(
			`Skipping duplicate inbound email for ${mailboxId}: message_id ${originalMessageId} already stored as ${createResult.id}`,
		);
		return;
	}


	// Rule-driven outbound actions (forward / auto-reply). Both are skipped
	// for spam and for discarded messages (a discard rule returned above), and
	// auto-replies carry their own loop guards. Best-effort: a failed send
	// must never block delivery, so the report is only logged.
	const ruleMarkedSpam =
		destinationFolder === Folders.SPAM ||
		ruleResult.mutation.category === SPAM_CATEGORY_ID;
	if (ruleResult.outbound.length > 0) {
		try {
			const report = await handleInboundRuleOutbound(
				env,
				stub,
				{
					mailboxId,
					sender: (parsedEmail.from?.address || "").toLowerCase(),
					subject: parsedEmail.subject || "",
					body: parsedEmail.html || parsedEmail.text || "",
					rawHeaders: JSON.stringify(parsedEmail.headers),
				},
				ruleResult.outbound,
				isSpam || ruleMarkedSpam
					? {
							skip: true,
							skipReason: "spam: rule outbound actions are skipped",
						}
					: {},
			);
			for (const attempt of report.attempts) {
				if (attempt.status === "sent") continue;
				console.log(
					`Rule ${attempt.kind} (${attempt.rule_name}) ${attempt.status}: ${attempt.reason ?? ""}`,
				);
			}
		} catch (e) {
			console.error("Rule outbound action failed:", (e as Error).message);
		}
	}


	// Do not auto-draft replies to spam: neither AI-classified spam, mail a
	// rule filed in Spam or stamped with the spam category, nor mail from a
	// blocked sender (senderDecision.autoDraft). A discard rule has already
	// returned above. The mailbox switch turns this off entirely.
	if (normalizeAutoDraft(mailboxSettings["autoDraft"]) && senderDecision.autoDraft && !isSpam && !ruleMarkedSpam) {
		const agentStub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId));
		ctx.waitUntil(agentStub.fetch(new Request("https://agents/onNewEmail", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mailboxId, emailId: messageId, sender: (parsedEmail.from?.address || "").toLowerCase(), subject: parsedEmail.subject || "", threadId }),
		})).catch((e) => console.error("Auto-draft trigger failed:", (e as Error).message)));
	}

	// Outbound webhook notification for this arrival — notification only,
	// never a send path. Non-spam only, matching the auto-draft rule above,
	// and a failing webhook can never affect delivery: notifyNewEmail logs and
	// swallows every error (see workers/lib/webhook.ts).
	// Only schedule when a webhook is actually configured: notifyNewEmail is a
	// no-op without a URL, and an unconditional waitUntil would leave a
	// pointless pending promise on every delivery.
	if (!isSpam && !ruleMarkedSpam && normalizeWebhookUrl(mailboxSettings["notifyWebhookUrl"])) {
		ctx.waitUntil(notifyNewEmail(env, mailboxId, {
			id: messageId,
			subject: parsedEmail.subject || "",
			sender: (parsedEmail.from?.address || "").toLowerCase(),
			recipient: allRecipients.join(", "),
			date: new Date().toISOString(), // receive time, like the stored row
			folder: destinationFolder,
			category: ruleResult.mutation.category ?? classification?.category ?? null,
			body: parsedEmail.html || parsedEmail.text || "",
		}, mailboxSettings));
	}
}

export { app, receiveEmail };
