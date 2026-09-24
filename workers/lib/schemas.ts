// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared types and Zod schemas for email data.
 *
 * Types (from email-types.ts): used by the agent, MCP server, and route
 * handlers to avoid `as any` casting.
 *
 * Zod schemas: used across route handlers to eliminate duplication.
 */
import { z } from "zod";
import {
	hasActiveActions,
	hasActiveConditions,
	normalizeRuleActions,
	normalizeRuleConditions,
	MAX_RULE_CONDITION_LENGTH,
	MAX_RULE_NAME_LENGTH,
	MAX_RULE_PRIORITY,
	RULE_MATCH_MODES,
} from "./rules";

// ── TypeScript Interfaces ──────────────────────────────────────────

export interface EmailMetadata {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	envelope_recipient?: string | null;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	read: boolean;
	starred: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	folder_id?: string | null;
	category?: string | null;
	category_confidence?: number | null;
	snippet?: string | null;
}

export interface EmailFull extends EmailMetadata {
	body?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	classification?: string | null;
	attachments?: AttachmentInfo[];
}

export interface AttachmentInfo {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

// ── Zod Schemas ────────────────────────────────────────────────────

const RecipientFieldSchema = z.union([
	z.string().email(),
	z.array(z.string().email()).min(1),
]);

export const ErrorResponseSchema = z.object({
	error: z.string(),
});

export const SendEmailRequestSchema = z
	.object({
		to: RecipientFieldSchema,
		cc: RecipientFieldSchema.optional(),
		bcc: RecipientFieldSchema.optional(),
		from: z.union([
			z.string().email(),
			z.object({ email: z.string().email(), name: z.string() }),
		]),
		subject: z.string(),
		html: z.string().optional(),
		text: z.string().optional(),
		attachments: z
			.array(
				z.object({
					content: z.string(), // base64 encoded
					filename: z.string(),
					type: z.string(),
					disposition: z.enum(["attachment", "inline"]),
					contentId: z.string().optional(),
				}),
			)
			.optional(),
		in_reply_to: z.string().optional(),
		references: z.array(z.string()).optional(),
		thread_id: z.string().optional(),
	})
	.refine((data) => data.html || data.text, {
		message: "Either 'html' or 'text' must be provided",
	});

export const SendEmailResponseSchema = z.object({
	id: z.string(),
	status: z.string(),
});

/**
 * Batch action applied to a set of emails selected in the list UI.
 *
 * `threadIds` lets read/unread changes extend to whole conversations, so a
 * threaded list row's unread badge clears even when only the latest message
 * was selected.
 *
 * Delete semantics: `trash` always moves messages to the Trash folder,
 * `restore` moves Trash messages back to the inbox, and `delete` is
 * trash-aware — a message already in Trash is purged permanently, anything
 * else moves to Trash. The bulk route answers with the per-action counts
 * (`trashed`, `purged`, `restored`) so the UI can report what happened.
 *
 * Batches are capped well under SQLite's 100-bound-parameter limit, which
 * counts the SET values of an UPDATE alongside the ids in the IN clause.
 */
export const BulkEmailActionSchema = z
	.object({
		action: z.enum([
			"mark_read",
			"mark_unread",
			"star",
			"unstar",
			"move",
			"trash",
			"restore",
			"delete",
		]),
		ids: z.array(z.string().min(1)).min(1).max(90),
		threadIds: z.array(z.string().min(1)).max(90).optional(),
		folderId: z.string().min(1).optional(),
	})
	.refine((data) => data.action !== "move" || Boolean(data.folderId), {
		message: "folderId is required when action is 'move'",
		path: ["folderId"],
	});


// ── Rules (deterministic per-mailbox filters) ──────────────────────


/**
 * Match conditions. Values are trimmed by the engine, so empty strings are
 * tolerated here and simply mean "condition not set".
 */
const RuleConditionsSchema = z.object({
	from_contains: z.string().trim().max(MAX_RULE_CONDITION_LENGTH).optional(),
	to_contains: z.string().trim().max(MAX_RULE_CONDITION_LENGTH).optional(),
	subject_contains: z.string().trim().max(MAX_RULE_CONDITION_LENGTH).optional(),
	body_contains: z.string().trim().max(MAX_RULE_CONDITION_LENGTH).optional(),
	has_attachment: z.boolean().optional(),
	category_equals: z.string().trim().max(MAX_RULE_CONDITION_LENGTH).optional(),
});


const RuleMatchSchema = z.object({
	mode: z.enum(RULE_MATCH_MODES).default("all"),
	conditions: RuleConditionsSchema,
});


const RuleActionsSchema = z
	.object({
		move_to_folder: z.string().trim().min(1).max(MAX_RULE_NAME_LENGTH).optional(),
		set_category: z.string().trim().min(1).max(MAX_RULE_NAME_LENGTH).optional(),
		mark_read: z.boolean().optional(),
		mark_unread: z.boolean().optional(),
		star: z.boolean().optional(),
		unstar: z.boolean().optional(),
		discard: z.boolean().optional(),
	})
	.refine(
		(actions) => !(actions.mark_read === true && actions.mark_unread === true),
		{ message: "mark_read and mark_unread cannot both be set" },
	)
	.refine((actions) => !(actions.star === true && actions.unstar === true), {
		message: "star and unstar cannot both be set",
	});


/** Fields shared by create and update; update makes them all optional. */
const RuleShapeSchema = z.object({
	name: z.string().trim().min(1).max(MAX_RULE_NAME_LENGTH),
	enabled: z.boolean().optional(),
	priority: z.number().int().min(0).max(MAX_RULE_PRIORITY).optional(),
	match: RuleMatchSchema,
	actions: RuleActionsSchema,
});


export const CreateRuleSchema = RuleShapeSchema.superRefine((rule, ctx) => {
	if (!hasActiveConditions(normalizeRuleConditions(rule.match.conditions))) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["match", "conditions"],
			message: "A rule needs at least one match condition",
		});
	}
	if (!hasActiveActions(normalizeRuleActions(rule.actions))) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["actions"],
			message: "A rule needs at least one action",
		});
	}
});


export const UpdateRuleSchema = RuleShapeSchema.partial().superRefine(
	(rule, ctx) => {
		if (
			rule.match &&
			!hasActiveConditions(normalizeRuleConditions(rule.match.conditions))
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["match", "conditions"],
				message: "A rule needs at least one match condition",
			});
		}
		if (rule.actions && !hasActiveActions(normalizeRuleActions(rule.actions))) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["actions"],
				message: "A rule needs at least one action",
			});
		}
	},
);


/** Body for POST /rules/reorder: rule ids in their new evaluation order. */
export const ReorderRulesSchema = z.object({
	ids: z.array(z.string().min(1)).min(1).max(200),
});


/**
 * Draft save payload (POST /api/v1/mailboxes/:mailboxId/drafts).
 *
 * `applySignature` is opt-in: when true the mailbox signature is appended
 * to the stored body server-side. The browser composer prefills the
 * signature client-side and never sets it, so a draft is never signed twice.
 */
export const DraftBodySchema = z.object({
	to: z.string().optional(),
	cc: z.string().optional(),
	bcc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string(),
	// Same shape as SendEmailRequestSchema.attachments: the composer sends the
	// files it is holding so a saved draft keeps them.
	attachments: z
		.array(
			z.object({
				content: z.string(), // base64 encoded
				filename: z.string(),
				type: z.string(),
				disposition: z.enum(["attachment", "inline"]),
				contentId: z.string().optional(),
			}),
		)
		.optional(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	draft_id: z.string().optional(),
	applySignature: z.boolean().optional(),
});
