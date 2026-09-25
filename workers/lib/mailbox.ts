// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Hono middleware to handle repetitive Mailbox Durable Object instantiation.
 * Checks if the mailbox exists in R2, then instantiates the DO stub
 * and attaches it to the Hono context (`c.var.mailboxStub`).
 */
import { createMiddleware } from "hono/factory";
import { defaultCategorizationSettings } from "../../shared/categories";
import { DEFAULT_TRASH_RETENTION_DAYS } from "../../shared/trash-retention";
import type { MailboxDO } from "../durableObject";
import type { Env } from "../types";


/**
 * Default settings for a newly-created mailbox. Shared by the mailbox API and
 * the inbound catch-all provisioning path so both create identical records.
 */
export function defaultMailboxSettings(name: string) {
	return {
		fromName: name,
		signature: { enabled: false, text: "" },
		categorization: defaultCategorizationSettings(),
		// Explicit "inherit the app-wide default"; a mailbox can pin html/text.
		defaultEmailView: null,
		// Automatic Trash cleanup after 30 days; 0 disables it.
		trashRetentionDays: DEFAULT_TRASH_RETENTION_DAYS,
		notifyWebhookUrl: "",
		notifyWebhookSecret: "",
		imageAllowlist: [],
		// Opt-in: the digest POSTs to the notification webhook each morning.
		digestEnabled: false,
		// Task/deadline extraction from new mail; on unless switched off.
		items: { enabled: true },
	};
}


export type MailboxContext = {
	Bindings: Env;
	Variables: {
		mailboxStub: DurableObjectStub<MailboxDO>;
	};
};


export const requireMailbox = createMiddleware<MailboxContext>(async (c, next) => {
	const rawId = c.req.param("mailboxId");
	if (!rawId) return c.json({ error: "Mailbox ID required" }, 400);
	const mailboxId = decodeURIComponent(rawId);


	// Verify mailbox exists
	const key = `mailboxes/${mailboxId}.json`;
	const obj = await c.env.BUCKET.head(key);
	if (!obj) {
		return c.json({ error: "Not found" }, 404);
	}


	// Instantiate DO stub
	const ns = c.env.MAILBOX;
	const id = ns.idFromName(mailboxId);
	const stub = ns.get(id);


	c.set("mailboxStub", stub);
	
	return await next();
});

