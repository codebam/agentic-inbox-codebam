// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Outbound rule actions: forwarding (`forward_to`) and auto-replies
 * (`auto_reply_text`).
 *
 * `runRules` (workers/lib/rules.ts) only *reports* outbound work; this module
 * decides whether it may happen and performs the send. It is shared by the
 * inbound pipeline (workers/index.ts) and the tests.
 *
 * Guard rails live here so no caller can forget them:
 *   - The pipeline never calls this module for spam or for a discarded
 *     message, and the `skip` option reports that decision explicitly.
 *   - Auto-replies are suppressed for machine-generated mail (Auto-Submitted,
 *     List-Id, or a bulk/junk/list Precedence header), when the sender is the
 *     mailbox itself, and when this mailbox already auto-replied to that
 *     sender within the last 24 hours.
 *   - Sends go through the existing send path (workers/email-sender.ts,
 *     `sendEmail`) behind an injectable seam: without an EMAIL binding (the
 *     test config has none) nothing is sent and the report says so.
 *   - `verifyDraft` is deliberately not applied on this path: the content is
 *     operator-authored automation (not model output), and AI-cleaning it
 *     would rewrite what the operator asked to send. The agent/MCP send paths
 *     keep their draft verification untouched.
 */

import { sendEmail, type SendEmailParams } from "../email-sender";
import { stripHtmlToText, textToHtml } from "./email-helpers";
import { isRuleEmailAddress, type RuleOutboundAction } from "./rules";
import { Folders } from "../../shared/folders";


/** Anything that can deliver one message. Tests inject a fake. */
export interface RuleOutboundSender {
	send(params: SendEmailParams): Promise<{ messageId: string }>;
}


/** The inbound message an outbound action reacts to. */
export interface RuleOutboundEmail {
	/** The mailbox the rule belongs to; used as the envelope sender. */
	mailboxId: string;
	/** Lower-cased address the message came from. */
	sender: string;
	subject: string;
	/** Stored body (HTML or text) of the inbound message. */
	body?: string | null;
	/** Raw headers JSON exactly as stored on the email row, or null. */
	rawHeaders?: string | null;
}


/**
 * The Sent copy of one rule-driven send, so a rule's forward or auto-reply
 * appears in the mailbox exactly like every other send path's copy does
 * (and feeds the contacts store). Metadata plus the sent body, which is what
 * createEmail stores for any other sent message.
 */
export interface RuleOutboundSentCopy {
	kind: "forward" | "auto_reply";
	/** The deliverable recipient the copy was sent to. */
	to: string;
	subject: string;
	/** The send's HTML when it had one, otherwise its text. */
	body: string;
}


export interface RuleOutboundDeps {
	/** null when this deployment has no EMAIL binding. */
	sender: RuleOutboundSender | null;
	/** Timestamp of the last auto-reply to this sender, or null. */
	lastAutoReplyAt: (senderAddress: string) => Promise<string | null>;
	/** Remember that an auto-reply went out to this sender at `at`. */
	recordAutoReply: (senderAddress: string, at: string) => Promise<void>;
	/**
	 * Store the Sent copy of a delivered message. Optional: a caller that
	 * cannot store mail (a test with a fake sender) simply omits it, and the
	 * message is delivered without a copy. Called best-effort — see
	 * storeSentCopy below.
	 */
	storeSentCopy?:
		| ((copy: RuleOutboundSentCopy) => Promise<void> | void)
		| undefined;
	now?: () => Date;
	log?: (message: string) => void;
}


/**
 * Best-effort store of the Sent copy for one delivered message. A storage
 * failure is logged and swallowed: the message has already gone out, so it
 * must not flip the attempt to "failed" (which would also skip the
 * auto-reply cooldown bookkeeping and let a duplicate reply go out).
 */
async function storeSentCopy(
	deps: RuleOutboundDeps,
	log: (message: string) => void,
	copy: RuleOutboundSentCopy,
): Promise<void> {
	if (!deps.storeSentCopy) return;
	try {
		await deps.storeSentCopy(copy);
	} catch (error) {
		log(
			`storing the Sent copy of the ${copy.kind} to ${copy.to} failed: ${(error as Error).message}`,
		);
	}
}


/** What happened to one outbound action. */
export interface RuleOutboundAttempt {
	kind: "forward" | "auto_reply";
	rule_id: string;
	rule_name: string;
	/** Where it went (or would have gone). */
	to: string;
	status: "sent" | "skipped" | "failed";
	reason?: string;
	messageId?: string;
}


export interface RuleOutboundReport {
	attempts: RuleOutboundAttempt[];
	sent: number;
	skipped: number;
	failed: number;
}


/** One auto-reply per sender per day, per mailbox. */
export const AUTO_REPLY_COOLDOWN_MS = 24 * 60 * 60 * 1000;


/** Header names that mark a message as automated mail, not a person. */
const AUTOMATED_HEADER_KEYS = new Set(["auto-submitted", "list-id"]);


/** Precedence values that mark bulk/junk/list mail (RFC 3834 / RFC 2076). */
const BULK_PRECEDENCE = /\b(bulk|junk|list)\b/i;


export function emptyRuleOutboundReport(): RuleOutboundReport {
	return { attempts: [], sent: 0, skipped: 0, failed: 0 };
}


/**
 * Stringify one raw header value. Strings pass through; the other primitives
 * keep their historical spelling. Objects, arrays and functions are dropped
 * rather than becoming "[object Object]" in a header.
 */
function headerText(value: unknown): string {
	switch (typeof value) {
		case "string":
			return value;
		case "number":
		case "bigint":
		case "boolean":
		case "symbol":
			return String(value);
		default:
			return "";
	}
}


/** Parse the stored `raw_headers` JSON into lower-cased key/value pairs. */
function parseHeaderPairs(
	rawHeaders: string | null | undefined,
): { key: string; value: string }[] {
	if (!rawHeaders) return [];
	try {
		const parsed = JSON.parse(rawHeaders) as unknown;
		if (Array.isArray(parsed)) {
			const pairs: { key: string; value: string }[] = [];
			for (const entry of parsed) {
				if (!entry || typeof entry !== "object") continue;
				const record = entry as Record<string, unknown>;
				const key = headerText(record["key"] ?? record["name"]).toLowerCase();
				if (!key) continue;
				pairs.push({ key, value: headerText(record["value"]) });
			}
			return pairs;
		}
		if (parsed && typeof parsed === "object") {
			return Object.entries(parsed as Record<string, unknown>).map(
				([key, value]) => ({ key: key.toLowerCase(), value: headerText(value) }),
			);
		}
	} catch {
		// A hand-edited or legacy row must never break delivery.
	}
	return [];
}


/**
 * True when the incoming message looks machine-generated: any Auto-Submitted
 * or List-Id header, or a bulk/junk/list Precedence. Such mail must never
 * receive an auto-reply (it would start a mail loop with a robot).
 */
export function isAutomatedMail(rawHeaders: string | null | undefined): boolean {
	for (const { key, value } of parseHeaderPairs(rawHeaders)) {
		if (AUTOMATED_HEADER_KEYS.has(key)) return true;
		if (key === "precedence" && BULK_PRECEDENCE.test(value)) return true;
	}
	return false;
}


/** True while the last auto-reply to a sender is still inside the cooldown. */
export function isWithinAutoReplyCooldown(
	lastAt: string | null | undefined,
	now: Date,
): boolean {
	if (!lastAt) return false;
	const last = Date.parse(lastAt);
	if (!Number.isFinite(last)) return false;
	return now.getTime() - last < AUTO_REPLY_COOLDOWN_MS;
}


/** "Re: " prefix that never doubles up. */
function replySubject(subject: string): string {
	const trimmed = (subject ?? "").trim();
	if (!trimmed) return "Re: (no subject)";
	return /^re\s*:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}


/** "Fwd: " prefix that never doubles up. */
function forwardSubject(subject: string): string {
	const trimmed = (subject ?? "").trim();
	if (!trimmed) return "Fwd: (no subject)";
	return /^fwd?\s*:/i.test(trimmed) ? trimmed : `Fwd: ${trimmed}`;
}


/** The forwarded copy: original body plus a short provenance header. */
function buildForwardParams(
	action: RuleOutboundAction,
	email: RuleOutboundEmail,
): SendEmailParams {
	const to = (action.to ?? "").trim();
	const body = email.body ?? "";
	return {
		to,
		from: email.mailboxId,
		subject: forwardSubject(email.subject),
		html:
			`<p>Forwarded automatically by a mail rule from ${email.mailboxId}.</p>` +
			`<p><strong>From:</strong> ${email.sender}<br/>` +
			`<strong>Subject:</strong> ${email.subject}</p><hr/>` +
			body,
		text:
			`Forwarded automatically by a mail rule from ${email.mailboxId}.\n\n` +
			`From: ${email.sender}\nSubject: ${email.subject}\n\n` +
			stripHtmlToText(body),
		...(isRuleEmailAddress(email.sender) ? { replyTo: email.sender } : {}),
		headers: { "Auto-Submitted": "auto-forwarded" },
	};
}


/** The auto-reply, marked as auto-submitted so peers can suppress loops. */
function buildAutoReplyParams(
	text: string,
	email: RuleOutboundEmail,
): SendEmailParams {
	return {
		to: email.sender,
		from: email.mailboxId,
		subject: replySubject(email.subject),
		html: textToHtml(text),
		text,
		headers: { "Auto-Submitted": "auto-replied" },
	};
}


/**
 * Decide and execute every outbound action for one inbound message.
 *
 * Returns a per-action report instead of throwing: a failed send must never
 * fail delivery, and the caller (or a test) can assert exactly what happened.
 */
export async function runRuleOutboundActions(
	actions: readonly RuleOutboundAction[],
	email: RuleOutboundEmail,
	deps: RuleOutboundDeps,
): Promise<RuleOutboundReport> {
	const now = deps.now ?? (() => new Date());
	const log = deps.log ?? (() => {});
	const report = emptyRuleOutboundReport();

	const record = (attempt: RuleOutboundAttempt) => {
		report.attempts.push(attempt);
		report[attempt.status] += 1;
	};

	for (const action of actions) {
		if (action.kind === "forward") {
			const to = (action.to ?? "").trim();
			if (!isRuleEmailAddress(to)) {
				record({
					kind: "forward",
					rule_id: action.rule_id,
					rule_name: action.rule_name,
					to,
					status: "skipped",
					reason: "forward_to is not a single deliverable address",
				});
				continue;
			}
			if (!deps.sender) {
				record({
					kind: "forward",
					rule_id: action.rule_id,
					rule_name: action.rule_name,
					to,
					status: "skipped",
					reason: "no EMAIL binding configured",
				});
				continue;
			}
			try {
				const params = buildForwardParams(action, email);
				const result = await deps.sender.send(params);
				await storeSentCopy(deps, log, {
					kind: "forward",
					to,
					subject: params.subject,
					body: params.html ?? params.text ?? "",
				});
				record({
					kind: "forward",
					rule_id: action.rule_id,
					rule_name: action.rule_name,
					to,
					status: "sent",
					messageId: result.messageId,
				});
			} catch (error) {
				const reason = (error as Error).message;
				log(`forward to ${to} failed: ${reason}`);
				record({
					kind: "forward",
					rule_id: action.rule_id,
					rule_name: action.rule_name,
					to,
					status: "failed",
					reason,
				});
			}
			continue;
		}

		// Auto-reply: every guard below is a loop or abuse protection.
		const to = (email.sender ?? "").trim().toLowerCase();
		const text = (action.text ?? "").trim();
		const skip = (reason: string) =>
			record({
				kind: "auto_reply",
				rule_id: action.rule_id,
				rule_name: action.rule_name,
				to,
				status: "skipped",
				reason,
			});

		if (!text) {
			skip("auto_reply_text is empty");
			continue;
		}
		if (!isRuleEmailAddress(to)) {
			skip("sender is not a deliverable address");
			continue;
		}
		if (to === email.mailboxId.trim().toLowerCase()) {
			skip("sender is this mailbox itself");
			continue;
		}
		if (isAutomatedMail(email.rawHeaders)) {
			skip("automated mail (Auto-Submitted / List-Id / bulk precedence)");
			continue;
		}
		if (!deps.sender) {
			skip("no EMAIL binding configured");
			continue;
		}
		const sentAt = now();
		const lastAutoReply = await deps.lastAutoReplyAt(to);
		if (isWithinAutoReplyCooldown(lastAutoReply, sentAt)) {
			skip("already auto-replied to this sender in the last 24h");
			continue;
		}
		try {
			const params = buildAutoReplyParams(text, email);
			const result = await deps.sender.send(params);
			await storeSentCopy(deps, log, {
				kind: "auto_reply",
				to,
				subject: params.subject,
				body: params.html ?? params.text ?? "",
			});
			// Recorded only after a successful send: a failed attempt must not
			// consume the sender's daily slot.
			await deps.recordAutoReply(to, sentAt.toISOString());
			record({
				kind: "auto_reply",
				rule_id: action.rule_id,
				rule_name: action.rule_name,
				to,
				status: "sent",
				messageId: result.messageId,
			});
		} catch (error) {
			const reason = (error as Error).message;
			log(`auto-reply to ${to} failed: ${reason}`);
			record({
				kind: "auto_reply",
				rule_id: action.rule_id,
				rule_name: action.rule_name,
				to,
				status: "failed",
				reason,
			});
		}
	}

	return report;
}


// ── Sender seam ────────────────────────────────────────────────────

type RuleOutboundEnv = { EMAIL?: SendEmail };

let senderFactoryOverride: (() => RuleOutboundSender | null) | null = null;


/**
 * Test seam: replace the sender the inbound pipeline uses. Passing null
 * restores the real Cloudflare Email Service binding path.
 */
export function setRuleOutboundSenderFactory(
	factory: (() => RuleOutboundSender | null) | null,
): void {
	senderFactoryOverride = factory;
}


/** The real sender, or null when this deployment has no EMAIL binding. */
export function createRuleOutboundSender(
	env: RuleOutboundEnv,
): RuleOutboundSender | null {
	const binding = env.EMAIL;
	if (!binding) return null;
	return { send: (params: SendEmailParams) => sendEmail(binding, params) };
}


/** The sender the pipeline should use (honours the test override). */
export function resolveRuleOutboundSender(
	env: RuleOutboundEnv,
): RuleOutboundSender | null {
	if (senderFactoryOverride) return senderFactoryOverride();
	return createRuleOutboundSender(env);
}


/**
 * The stored-message fields a rule-driven Sent copy needs. Structural on
 * purpose: MailboxDO.createEmail takes its own EmailData, and this is the
 * subset of it the copy fills in.
 */
export interface RuleOutboundStoredEmail {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	date: string;
	body: string;
	thread_id: string;
	message_id: string;
	in_reply_to: null;
	email_references: null;
}


/** Minimal DO surface the pipeline needs for the auto-reply daily cap. */
export interface RuleOutboundBookkeepingStub {
	getLastAutoReplyAt: (senderAddress: string) => Promise<string | null>;
	recordAutoReply: (senderAddress: string, at: string) => Promise<void>;
	/**
	 * Store a message in a folder (MailboxDO.createEmail). Optional: the
	 * pipeline uses it to keep the Sent copy of a rule-driven send like every
	 * other send path does; a caller that cannot store mail omits it and the
	 * message is delivered without a copy.
	 */
	createEmail?:
		| ((
				folder: string,
				email: RuleOutboundStoredEmail,
				attachments: [],
		  ) => Promise<unknown>)
		| undefined;
}


/**
 * The Sent-copy store for one mailbox: MailboxDO.createEmail with a
 * generated id, exactly like the other send paths (workers/index.ts,
 * workers/routes/reply-forward.ts, workers/lib/tools.ts). Undefined when
 * the stub cannot store mail.
 */
function buildSentCopyStore(
	stub: RuleOutboundBookkeepingStub,
	mailboxId: string,
): ((copy: RuleOutboundSentCopy) => Promise<void>) | undefined {
	if (!stub.createEmail) return undefined;
	const sender = mailboxId.trim().toLowerCase();
	const domain = sender.split("@")[1] ?? "";
	return async (copy: RuleOutboundSentCopy) => {
		const id = crypto.randomUUID();
		await stub.createEmail!(Folders.SENT, {
			id,
			subject: copy.subject,
			sender,
			recipient: copy.to.trim().toLowerCase(),
			date: new Date().toISOString(),
			body: copy.body,
			thread_id: id,
			message_id: domain ? `<${id}@${domain}>` : id,
			in_reply_to: null,
			email_references: null,
		}, []);
	};
}


export interface HandleInboundRuleOutboundOptions {
	/**
	 * True for spam and for discarded messages: both outbound actions are
	 * skipped and reported as such.
	 */
	skip?: boolean;
	skipReason?: string;
}


/**
 * Pipeline-facing entry point: resolves the sender, wires the Durable
 * Object's auto-reply bookkeeping, and reports what happened. Called from
 * workers/index.ts after the message is stored and classified.
 */
export async function handleInboundRuleOutbound(
	env: RuleOutboundEnv,
	stub: RuleOutboundBookkeepingStub,
	email: RuleOutboundEmail,
	actions: readonly RuleOutboundAction[],
	options: HandleInboundRuleOutboundOptions = {},
): Promise<RuleOutboundReport> {
	if (options.skip) {
		const reason = options.skipReason ?? "skipped for this message";
		const report = emptyRuleOutboundReport();
		for (const action of actions) {
			report.attempts.push({
				kind: action.kind,
				rule_id: action.rule_id,
				rule_name: action.rule_name,
				to: action.to ?? email.sender,
				status: "skipped",
				reason,
			});
			report.skipped += 1;
		}
		return report;
	}
	if (actions.length === 0) return emptyRuleOutboundReport();

	return runRuleOutboundActions(actions, email, {
		sender: resolveRuleOutboundSender(env),
		lastAutoReplyAt: (address) => stub.getLastAutoReplyAt(address),
		recordAutoReply: (address, at) => stub.recordAutoReply(address, at),
		storeSentCopy: buildSentCopyStore(stub, email.mailboxId),
		log: (message) => console.log(`Rule outbound: ${message}`),
	});
}
