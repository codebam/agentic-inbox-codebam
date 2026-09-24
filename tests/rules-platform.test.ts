// Rules platform: dry-run preview, firing statistics, and the two outbound
// actions (forward + auto-reply) with their guards. Each test uses its own
// mailbox because Durable Object storage is shared within a file.
import { SELF, createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { SPAM_CATEGORY_ID } from "../shared/categories";
import {
	hasLocalRuleActions,
	isRuleEmailAddress,
	localRuleActions,
	ruleNeedsChange,
	runRules,
	stripOutboundActions,
	type RuleDraft,
	type RuleOutboundAction,
} from "../workers/lib/rules";
import {
	createRuleOutboundSender,
	handleInboundRuleOutbound,
	runRuleOutboundActions,
	setRuleOutboundSenderFactory,
	type RuleOutboundSender,
} from "../workers/lib/rule-outbound";
import { CreateRuleSchema } from "../workers/lib/schemas";
import {
	toolCreateRule,
	toolListRules,
	toolUpdateRule,
} from "../workers/lib/tools";
import { receiveEmail, type InboundEmailEvent } from "../workers/index";
import type { SendEmailParams } from "../workers/email-sender";




function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}




/** Register the mailbox record the API and the inbound pipeline check. */
async function registerMailbox(
	mailbox: string,
	settings: Record<string, unknown> = {},
) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify(settings));
}




/**
 * Pipeline tests disable categorization so the AI classifier is never called:
 * delivery stays deterministic and no AI binding is required.
 */
const PIPELINE_SETTINGS = { categorization: { enabled: false } };




/** Seed one stored email, optionally with a single attachment. */
async function seedEmail(
	stub: ReturnType<typeof stubFor>,
	id: string,
	folder: string,
	options: {
		subject?: string;
		sender?: string;
		body?: string;
		category?: string | null;
		attachment?: boolean;
	} = {},
) {
	await stub.createEmail(
		folder,
		{
			id,
			subject: options.subject ?? `Subject ${id}`,
			sender: options.sender ?? "sender@example.org",
			recipient: "seed@example.com",
			date: new Date().toISOString(),
			body: options.body ?? "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: id,
			category: options.category ?? null,
		},
		options.attachment
			? [
					{
						id: `${id}-attachment`,
						email_id: id,
						filename: "notes.txt",
						mimetype: "text/plain",
						size: 5,
					},
				]
			: [],
	);
}




/** A complete rule draft, mirroring what the editor sends. */
function ruleDraft(overrides: Partial<RuleDraft> = {}): RuleDraft {
	return {
		name: overrides.name ?? "Test rule",
		match: overrides.match ?? {
			mode: "all",
			conditions: { subject_contains: "invoice" },
		},
		actions: overrides.actions ?? { star: true },
		...(overrides.enabled === undefined ? {} : { enabled: overrides.enabled }),
		...(overrides.priority === undefined ? {} : { priority: overrides.priority }),
	};
}




/** A fake outbound sender: records every send, never touches the network. */
function fakeSender() {
	const sent: SendEmailParams[] = [];
	const sender: RuleOutboundSender = {
		send: async (params) => {
			sent.push(params);
			return { messageId: `fake-${sent.length}` };
		},
	};
	return { sender, sent };
}




/** Run one raw SQL query inside a mailbox DO. */
function sqlRows<T>(
	stub: ReturnType<typeof stubFor>,
	query: string,
): Promise<T[]> {
	return runInDurableObject(stub, async (_instance, state) => {
		return [...state.storage.sql.exec(query)] as unknown as T[];
	});
}




/** Push one raw message through the real receiveEmail path. */
async function deliver(
	mailbox: string,
	options: {
		from?: string;
		subject?: string;
		body?: string;
		extraHeaders?: string[];
	} = {},
) {
	const raw = [
		`From: ${options.from ?? "sender@example.org"}`,
		`To: ${mailbox}`,
		`Subject: ${options.subject ?? "Hello"}`,
		...(options.extraHeaders ?? []),
		"",
		options.body ?? "body",
		"",
	].join("\r\n");
	const bytes = new TextEncoder().encode(raw);
	const event: InboundEmailEvent = {
		raw: new Response(bytes).body as ReadableStream,
		rawSize: bytes.byteLength,
		to: mailbox,
	};
	await receiveEmail(event, env, createExecutionContext());
}




async function postPreview(mailbox: string, body: unknown) {
	await registerMailbox(mailbox, PIPELINE_SETTINGS);
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/rules/preview`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	return {
		status: res.status,
		body: (await res.json()) as {
			total?: number;
			scanned?: number;
			matches?: { id: string; subject: string; folder_id: string }[];
			error?: string;
		},
	};
}


/**
 * POST the retroactive apply route for one stored rule. Registers the
 * mailbox first, like every other rules route test.
 */
async function postApply(mailbox: string, ruleId: string, body: unknown = {}) {
	await registerMailbox(mailbox, PIPELINE_SETTINGS);
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/rules/${ruleId}/apply`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	return {
		status: res.status,
		body: (await res.json()) as {
			rule_id?: string;
			applied?: number;
			skipped?: number;
			matched?: number;
			remaining?: number;
			scanned?: number;
			scan_limit?: number;
			error?: string;
		},
	};
}




describe("migration 15_add_rule_stats", () => {
	it("creates rule_stats and the two matched_rule columns", async () => {
		const stub = stubFor("migration-15@example.com");
		const state = await runInDurableObject(stub, async (_instance, storage) => {
			const table = (name: string) =>
				[...storage.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'")].some(
					(row) => String((row as { name: unknown }).name) === name,
				);
			const columns = [
				...storage.storage.sql.exec("SELECT name FROM pragma_table_info('emails')"),
			].map((row) => String((row as { name: unknown }).name));
			const migrations = [
				...storage.storage.sql.exec("SELECT name FROM d1_migrations"),
			].map((row) => String((row as { name: unknown }).name));
			const statsColumns = [
				...storage.storage.sql.exec("SELECT name FROM pragma_table_info('rule_stats')"),
			].map((row) => String((row as { name: unknown }).name));
			return {
				hasRuleStats: table("rule_stats"),
				columns,
				migrations,
				statsColumns,
			};
		});

		expect(state.hasRuleStats).toBe(true);
		expect(state.columns).toContain("matched_rule_id");
		expect(state.columns).toContain("matched_rule_name");
		expect(state.migrations).toContain("15_add_rule_stats");
		expect(state.statsColumns).toEqual([
			"rule_id",
			"fired_count",
			"last_fired_at",
		]);
	});
});




describe("previewRule (dry run)", () => {
	it("matches with the live engine and writes nothing", async () => {
		const stub = stubFor("preview-do@example.com");
		await seedEmail(stub, "p-1", Folders.INBOX, {
			subject: "Invoice 42",
			sender: "billing@vendor.example",
			attachment: true,
		});
		await seedEmail(stub, "p-2", Folders.ARCHIVE, {
			subject: "Lunch on Friday?",
			sender: "friend@example.org",
		});
		await seedEmail(stub, "p-3", Folders.INBOX, {
			subject: "Invoice 43",
			sender: "billing@vendor.example",
		});

		const before = await stub.getEmails({ folder: Folders.INBOX });
		const preview = await stub.previewRule({
			name: "Invoices",
			match: { mode: "all", conditions: { subject_contains: "invoice" } },
		});

		expect(preview.total).toBe(2);
		expect(preview.scanned).toBe(3);
		expect(preview.matches.map((match) => match.id).sort()).toEqual([
			"p-1",
			"p-3",
		]);
		expect(preview.matches[0]).toMatchObject({
			subject: expect.stringContaining("Invoice"),
			sender: "billing@vendor.example",
			folder_id: expect.any(String),
			date: expect.any(String),
		});

		// The same matcher the live engine uses: has_attachment is exact.
		const withAttachment = await stub.previewRule({
			match: { mode: "all", conditions: { has_attachment: true } },
		});
		expect(withAttachment.matches.map((match) => match.id)).toEqual(["p-1"]);

		// Nothing changed: no rows touched, no stats, no rule stamped.
		expect(await stub.getEmails({ folder: Folders.INBOX })).toEqual(before);
		const state = await runInDurableObject(stub, async (_instance, storage) => {
			const count = (query: string) =>
				Number(
					(
						[...storage.storage.sql.exec(query)][0] as { c: number }
					).c,
				);
			return {
				stats: count("SELECT COUNT(*) AS c FROM rule_stats"),
				stamped: count(
					"SELECT COUNT(*) AS c FROM emails WHERE matched_rule_id IS NOT NULL",
				),
			};
		});
		expect(state).toEqual({ stats: 0, stamped: 0 });
	});




	// A rejected Durable Object RPC call is reported by the vitest pool as an
	// unhandled rejection even when the test catches it, so the "no usable
	// conditions" rejection is asserted at the HTTP contract below instead.




	it("honours the summary limit while still counting every match", async () => {
		const stub = stubFor("preview-limit@example.com");
		for (const id of ["l-1", "l-2", "l-3"]) {
			await seedEmail(stub, id, Folders.INBOX, { subject: "Invoice" });
		}
		const preview = await stub.previewRule(
			{ match: { mode: "all", conditions: { subject_contains: "invoice" } } },
			2,
		);
		expect(preview.total).toBe(3);
		expect(preview.matches).toHaveLength(2);
		expect(preview.limit).toBe(2);
	});
});




describe("POST /rules/preview", () => {
	it("returns the matches for a stored mailbox", async () => {
		const mailbox = "preview-route@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "r-1", Folders.INBOX, { subject: "Invoice 9" });
		await seedEmail(stub, "r-2", Folders.INBOX, { subject: "Hello" });

		const res = await postPreview(mailbox, {
			name: "Invoices",
			match: { mode: "all", conditions: { subject_contains: "invoice" } },
			actions: { move_to_folder: Folders.ARCHIVE },
		});

		expect(res.status).toBe(200);
		expect(res.body.total).toBe(1);
		expect(res.body.matches?.map((match) => match.id)).toEqual(["r-1"]);
	});




	it("validates conditions and folder targets like create", async () => {
		const mailbox = "preview-route-invalid@example.com";

		const noConditions = await postPreview(mailbox, {
			match: { mode: "all", conditions: { subject_contains: "  " } },
		});
		expect(noConditions.status).toBe(400);
		expect(noConditions.body.error).toMatch(/at least one match condition/);

		const badFolder = await postPreview(mailbox, {
			match: { mode: "all", conditions: { subject_contains: "invoice" } },
			actions: { move_to_folder: "no-such-folder" },
		});
		expect(badFolder.status).toBe(400);
		expect(badFolder.body.error).toMatch(/Unknown folder/);
	});
});




describe("firing statistics", () => {
	it("counts firings, ignores unknown ids, and cascades with the rule", async () => {
		const stub = stubFor("stats@example.com");
		const rule = await stub.createRule(ruleDraft());

		expect((await stub.listRules())[0].fired_count).toBe(0);

		await stub.recordRuleFirings([rule.id]);
		// One message can fire a rule once, so duplicates inside one call
		// count once; ids of deleted rules are ignored.
		await stub.recordRuleFirings([rule.id, rule.id]);
		await stub.recordRuleFirings([rule.id, "rule-that-no-longer-exists"]);

		const listed = await stub.listRules();
		expect(listed[0].fired_count).toBe(3);
		expect(typeof listed[0].last_fired_at).toBe("string");

		// The stats row is owned by the rule and goes away with it.
		await stub.deleteRule(rule.id);
		const rows = await sqlRows<{ c: number }>(
			stub,
			"SELECT COUNT(*) AS c FROM rule_stats",
		);
		expect(rows[0].c).toBe(0);
	});




	it("exposes fired_count and last_fired_at on the rules list API", async () => {
		const mailbox = "stats-route@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const stub = stubFor(mailbox);
		const rule = await stub.createRule(ruleDraft({ name: "Counted" }));
		await stub.recordRuleFirings([rule.id]);

		const res = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/rules`,
		);
		const body = (await res.json()) as {
			id: string;
			fired_count: number;
			last_fired_at: string | null;
		}[];

		expect(res.status).toBe(200);
		expect(body[0].fired_count).toBe(1);
		expect(typeof body[0].last_fired_at).toBe("string");
	});
});




describe("inbound pipeline: stats, stamp, and outbound actions", () => {
	it("stamps matched_rule_id/name, counts the firing, and applies the flags", async () => {
		const mailbox = "pipeline-stamp@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const stub = stubFor(mailbox);
		const rule = await stub.createRule(
			ruleDraft({
				name: "Star invoices",
				actions: { star: true },
			}),
		);

		await deliver(mailbox, {
			from: "billing@vendor.example",
			subject: "Invoice 12",
		});

		const stored = await sqlRows<{
			id: string;
			starred: number;
			matched_rule_id: string | null;
			matched_rule_name: string | null;
		}>(
			stub,
			"SELECT id, starred, matched_rule_id, matched_rule_name FROM emails",
		);
		expect(stored).toHaveLength(1);
		expect(stored[0].starred).toBe(1);
		expect(stored[0].matched_rule_id).toBe(rule.id);
		expect(stored[0].matched_rule_name).toBe("Star invoices");

		const listed = await stub.listRules();
		expect(listed[0].fired_count).toBe(1);
		expect(typeof listed[0].last_fired_at).toBe("string");
	});




	it("leaves unmatched mail unstamped", async () => {
		const mailbox = "pipeline-unmatched@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const stub = stubFor(mailbox);
		await stub.createRule(ruleDraft({ actions: { star: true } }));

		await deliver(mailbox, { subject: "Nothing to do with the rule" });

		const stored = await sqlRows<{ matched_rule_id: string | null }>(
			stub,
			"SELECT matched_rule_id FROM emails",
		);
		expect(stored[0].matched_rule_id).toBeNull();
		expect((await stub.listRules())[0].fired_count).toBe(0);
	});




	it("forwards through the injectable sender", async () => {
		const mailbox = "pipeline-forward@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const stub = stubFor(mailbox);
		await stub.createRule(
			ruleDraft({
				name: "Forward invoices",
				actions: { forward_to: "archive@example.org", star: true },
			}),
		);

		const { sender, sent } = fakeSender();
		setRuleOutboundSenderFactory(() => sender);
		try {
			await deliver(mailbox, {
				from: "billing@vendor.example",
				subject: "Invoice 77",
			});
		} finally {
			setRuleOutboundSenderFactory(null);
		}

		expect(sent).toHaveLength(1);
		expect(sent[0].to).toBe("archive@example.org");
		expect(sent[0].from).toBe(mailbox);
		expect(sent[0].subject).toBe("Fwd: Invoice 77");
		expect(sent[0].html).toContain("billing@vendor.example");
	});




	it("skips outbound actions without an EMAIL binding", async () => {
		const mailbox = "pipeline-no-binding@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const stub = stubFor(mailbox);
		await stub.createRule(
			ruleDraft({ actions: { forward_to: "archive@example.org" } }),
		);

		// wrangler.test.jsonc has no send_email binding, so the real sender
		// factory returns null — nothing may leave the mailbox. (The
		// `deps(null)` case above covers the skip reason.)
		expect(createRuleOutboundSender({})).toBeNull();
		await deliver(mailbox, { subject: "Invoice 78" });

		const stored = await sqlRows<{ matched_rule_id: string | null }>(
			stub,
			"SELECT matched_rule_id FROM emails",
		);
		expect(stored).toHaveLength(1);
		expect(stored[0].matched_rule_id).not.toBeNull();
	});




	it("counts a discard rule as fired and sends nothing", async () => {
		const mailbox = "pipeline-discard@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const stub = stubFor(mailbox);
		await stub.createRule(
			ruleDraft({
				name: "Drop spam-ish invoices",
				actions: { discard: true, forward_to: "archive@example.org" },
			}),
		);

		const { sender, sent } = fakeSender();
		setRuleOutboundSenderFactory(() => sender);
		try {
			await deliver(mailbox, {
				from: "billing@vendor.example",
				subject: "Invoice 99",
			});
		} finally {
			setRuleOutboundSenderFactory(null);
		}

		// Discarded: never stored, and the outbound action never runs.
		const stored = await sqlRows<{ c: number }>(
			stub,
			"SELECT COUNT(*) AS c FROM emails",
		);
		expect(stored[0].c).toBe(0);
		expect(sent).toHaveLength(0);

		// The rule still counts as fired: it acted on the message.
		expect((await stub.listRules())[0].fired_count).toBe(1);
	});




	it("skips outbound actions for mail a rule marks as spam", async () => {
		const mailbox = "pipeline-spam@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const stub = stubFor(mailbox);
		await stub.createRule(
			ruleDraft({
				name: "Spam invoices",
				actions: {
					set_category: SPAM_CATEGORY_ID,
					forward_to: "archive@example.org",
					auto_reply_text: "Thanks!",
				},
			}),
		);

		const { sender, sent } = fakeSender();
		setRuleOutboundSenderFactory(() => sender);
		try {
			await deliver(mailbox, {
				from: "billing@vendor.example",
				subject: "Invoice 100",
			});
		} finally {
			setRuleOutboundSenderFactory(null);
		}

		// Stored (only `discard` drops mail), stamped, counted — but silent.
		const stored = await sqlRows<{ category: string | null; matched_rule_id: string | null }>(
			stub,
			"SELECT category, matched_rule_id FROM emails",
		);
		expect(stored).toHaveLength(1);
		expect(stored[0].category).toBe(SPAM_CATEGORY_ID);
		expect(stored[0].matched_rule_id).not.toBeNull();
		expect(sent).toHaveLength(0);
		expect((await stub.listRules())[0].fired_count).toBe(1);
	});




	it("auto-replies through the pipeline and records the daily slot", async () => {
		const mailbox = "pipeline-autoreply@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const stub = stubFor(mailbox);
		await stub.createRule(
			ruleDraft({
				name: "Out of office",
				actions: { auto_reply_text: "Thanks — I'll reply within two days." },
			}),
		);

		const { sender, sent } = fakeSender();
		setRuleOutboundSenderFactory(() => sender);
		try {
			await deliver(mailbox, {
				from: "billing@vendor.example",
				subject: "Invoice 5",
			});
		} finally {
			setRuleOutboundSenderFactory(null);
		}

		expect(sent).toHaveLength(1);
		expect(sent[0].to).toBe("billing@vendor.example");
		expect(sent[0].from).toBe(mailbox);
		expect(sent[0].subject).toBe("Re: Invoice 5");
		expect(typeof (await stub.getLastAutoReplyAt("billing@vendor.example"))).toBe(
			"string",
		);
	});
});




describe("runRuleOutboundActions guards", () => {
	const forward: RuleOutboundAction = {
		kind: "forward",
		rule_id: "rule-1",
		rule_name: "Forward",
		to: "archive@example.org",
	};
	const autoReply: RuleOutboundAction = {
		kind: "auto_reply",
		rule_id: "rule-2",
		rule_name: "Auto-reply",
		text: "Thanks for your message.",
	};
	const email = {
		mailboxId: "guards@example.com",
		sender: "sender@example.org",
		subject: "Invoice 3",
		body: "<p>body</p>",
		rawHeaders: null as string | null,
	};

	function deps(sender: RuleOutboundSender | null) {
		const lastReplies = new Map<string, string>();
		return {
			lastReplies,
			deps: {
				sender,
				lastAutoReplyAt: async (address: string) =>
					lastReplies.get(address) ?? null,
				recordAutoReply: async (address: string, at: string) => {
					lastReplies.set(address, at);
				},
				now: () => new Date("2026-09-23T12:00:00.000Z"),
			},
		};
	}




	it("forwards a copy with the mailbox as sender", async () => {
		const { sender, sent } = fakeSender();
		const report = await runRuleOutboundActions([forward], email, deps(sender).deps);

		expect(report.sent).toBe(1);
		expect(report.attempts[0]).toMatchObject({
			kind: "forward",
			status: "sent",
			rule_id: "rule-1",
		});
		expect(sent[0].to).toBe("archive@example.org");
		expect(sent[0].subject).toBe("Fwd: Invoice 3");
		expect(sent[0].headers).toMatchObject({ "Auto-Submitted": "auto-forwarded" });
	});




	it("reports a failed send without throwing", async () => {
		const failing: RuleOutboundSender = {
			send: async () => {
				throw new Error("binding exploded");
			},
		};
		const report = await runRuleOutboundActions([forward], email, deps(failing).deps);

		expect(report.failed).toBe(1);
		expect(report.attempts[0]).toMatchObject({
			status: "failed",
			reason: "binding exploded",
		});
	});




	it("skips outbound actions when there is no sender", async () => {
		const report = await runRuleOutboundActions(
			[forward, autoReply],
			email,
			deps(null).deps,
		);

		expect(report.sent).toBe(0);
		expect(report.skipped).toBe(2);
		expect(report.attempts.map((attempt) => attempt.reason)).toEqual([
			"no EMAIL binding configured",
			"no EMAIL binding configured",
		]);
	});




	it("auto-replies once per sender per day", async () => {
		const { sender, sent } = fakeSender();
		const context = deps(sender);

		const first = await runRuleOutboundActions([autoReply], email, context.deps);
		expect(first.sent).toBe(1);
		expect(sent[0].to).toBe("sender@example.org");
		expect(sent[0].subject).toBe("Re: Invoice 3");
		expect(sent[0].headers).toMatchObject({ "Auto-Submitted": "auto-replied" });

		const second = await runRuleOutboundActions([autoReply], email, context.deps);
		expect(second.skipped).toBe(1);
		expect(second.attempts[0].reason).toMatch(/last 24h/);
		expect(sent).toHaveLength(1);
	});




	it("suppresses auto-replies for automated mail and self-sent mail", async () => {
		const { sender, sent } = fakeSender();
		const context = deps(sender);

		for (const header of [
			"Auto-Submitted: auto-generated",
			"List-Id: <list.example.com>",
			"Precedence: bulk",
		]) {
			const headers = JSON.stringify([{ key: header.split(":")[0], value: header.split(":").slice(1).join(":").trim() }]);
			const report = await runRuleOutboundActions(
				[autoReply],
				{ ...email, rawHeaders: headers },
				context.deps,
			);
			expect(report.sent).toBe(0);
			expect(report.attempts[0].reason).toMatch(/automated mail/);
		}

		const selfSent = await runRuleOutboundActions(
			[autoReply],
			{ ...email, sender: email.mailboxId },
			context.deps,
		);
		expect(selfSent.sent).toBe(0);
		expect(selfSent.attempts[0].reason).toMatch(/this mailbox itself/);

		expect(sent).toHaveLength(0);
	});




	it("skips auto-replies to undeliverable senders and empty text", async () => {
		const { sender } = fakeSender();
		const context = deps(sender);

		const noAddress = await runRuleOutboundActions(
			[autoReply],
			{ ...email, sender: "not-an-address" },
			context.deps,
		);
		expect(noAddress.attempts[0].reason).toMatch(/not a deliverable address/);

		const noText = await runRuleOutboundActions(
			[{ ...autoReply, text: "   " }],
			email,
			context.deps,
		);
		expect(noText.attempts[0].reason).toMatch(/empty/);
	});




	it("does not consume the daily slot when the send fails", async () => {
		const { lastReplies, deps: outboundDeps } = deps({
			send: async () => {
				throw new Error("nope");
			},
		});
		const report = await runRuleOutboundActions([autoReply], email, outboundDeps);
		expect(report.failed).toBe(1);
		expect(lastReplies.size).toBe(0);
	});




	it("reports skipped outbound actions for spam and discarded mail", async () => {
		const { sender, sent } = fakeSender();
		const stub = stubFor("guards-skip@example.com");
		const report = await handleInboundRuleOutbound(
			env,
			stub,
			email,
			[forward, autoReply],
			{ skip: true, skipReason: "spam: rule outbound actions are skipped" },
		);

		expect(report.sent).toBe(0);
		expect(report.skipped).toBe(2);
		expect(report.attempts[0].reason).toMatch(/spam/);
		expect(sent).toHaveLength(0);
		// The injected sender is never consulted for skipped work.
		void sender;
	});
});




describe("agent/MCP rule tools", () => {
	it("strips forward_to and auto_reply_text from created rules", async () => {
		const mailbox = "agent-create@example.com";
		const stub = stubFor(mailbox);

		const result = await toolCreateRule(env, mailbox, ruleDraft({
			name: "Agent rule",
			actions: {
				star: true,
				forward_to: "archive@example.org",
				auto_reply_text: "Hi!",
			},
		}));

		expect("error" in result).toBe(false);
		expect(result).toHaveProperty("note");
		const stored = (await stub.listRules())[0];
		expect(stored.actions.star).toBe(true);
		expect(stored.actions.forward_to).toBeUndefined();
		expect(stored.actions.auto_reply_text).toBeUndefined();
	});




	it("refuses a rule whose only actions are outbound", async () => {
		const mailbox = "agent-create-only-outbound@example.com";
		const stub = stubFor(mailbox);

		const result = await toolCreateRule(env, mailbox, ruleDraft({
			actions: { forward_to: "archive@example.org" },
		}));

		expect("error" in result).toBe(true);
		expect(await stub.listRules()).toEqual([]);
	});




	it("cannot edit or enable a rule the operator armed to send", async () => {
		const mailbox = "agent-update@example.com";
		const stub = stubFor(mailbox);
		const armed = await stub.createRule(
			ruleDraft({
				name: "Operator forwarder",
				enabled: false,
				actions: { forward_to: "archive@example.org" },
			}),
		);

		const enable = await toolUpdateRule(env, mailbox, armed.id, { enabled: true });
		expect("error" in enable).toBe(true);

		const rewrite = await toolUpdateRule(env, mailbox, armed.id, {
			actions: { star: true },
		});
		expect("error" in rewrite).toBe(true);

		// Widening the conditions would send more mail, so it is refused too.
		const widen = await toolUpdateRule(env, mailbox, armed.id, {
			match: { mode: "any", conditions: { from_contains: "@" } },
		});
		expect("error" in widen).toBe(true);

		const stored = (await stub.listRules())[0];
		expect(stored.enabled).toBe(false);
		expect(stored.actions.forward_to).toBe("archive@example.org");
		expect(stored.match.conditions.subject_contains).toBe("invoice");

		// Pausing noise stays allowed: it cannot turn sending on.
		const disable = await toolUpdateRule(env, mailbox, armed.id, {
			enabled: false,
		});
		expect("error" in disable).toBe(false);
	});




	it("strips outbound actions from a patch on a plain rule", async () => {
		const mailbox = "agent-update-strip@example.com";
		const stub = stubFor(mailbox);
		const plain = await stub.createRule(
			ruleDraft({ name: "Plain", actions: { star: true } }),
		);

		const result = await toolUpdateRule(env, mailbox, plain.id, {
			actions: { unstar: true, auto_reply_text: "hi" },
		});
		expect("error" in result).toBe(false);
		const stored = (await stub.listRules())[0];
		expect(stored.actions).toEqual({ unstar: true });
	});




	it("lists rules with firing statistics", async () => {
		const mailbox = "agent-list@example.com";
		const stub = stubFor(mailbox);
		const rule = await stub.createRule(ruleDraft({ name: "Listed" }));
		await stub.recordRuleFirings([rule.id]);

		const result = await toolListRules(env, mailbox);
		expect(result.rules[0]).toMatchObject({
			name: "Listed",
			fired_count: 1,
		});
	});




	it("keeps the operator API able to author both actions", () => {
		// The guard is on the agent/MCP tools, not on the operator's own API:
		// the editor must still be able to save sending rules.
		const parsed = CreateRuleSchema.safeParse({
			name: "Operator rule",
			match: { mode: "all", conditions: { subject_contains: "invoice" } },
			actions: {
				forward_to: "archive@example.org",
				auto_reply_text: "Thanks!",
			},
		});
		expect(parsed.success).toBe(true);
	});




	it("validates the new action shapes", () => {
		expect(isRuleEmailAddress("archive@example.org")).toBe(true);
		expect(isRuleEmailAddress("Archive <archive@example.org>")).toBe(false);
		expect(isRuleEmailAddress("archive@example.org, other@example.org")).toBe(false);
		expect(stripOutboundActions({ star: true, forward_to: "a@b.co" })).toEqual({
			star: true,
		});

		expect(
			CreateRuleSchema.safeParse({
				name: "Bad forward",
				match: { mode: "all", conditions: { subject_contains: "x" } },
				actions: { forward_to: "not-an-address" },
			}).success,
		).toBe(false);
	});
});




describe("engine: outbound collection", () => {
	const email = {
		sender: "alice@corp.example",
		recipient: "me@example.com",
		envelope_recipient: "me@example.com",
		cc: null,
		bcc: null,
		subject: "Invoice 1",
		body: "<p>invoice</p>",
		has_attachment: false,
		category: null,
	};

	it("reports forwards and one auto-reply, deduplicated", () => {
		const rule = (name: string, actions: RuleDraft["actions"], priority: number) =>
			ruleDraft({ name, actions, priority });

		const result = runRules(
			[
				rule("forward-a", { forward_to: "archive@example.org" }, 0),
				rule("forward-b", { forward_to: "ARCHIVE@example.org" }, 1),
				rule("reply-a", { auto_reply_text: "first" }, 2),
				rule("reply-b", { auto_reply_text: "second" }, 3),
			].map((draft, index) => ({
				id: `rule-${index}`,
				name: draft.name,
				enabled: true,
				priority: draft.priority ?? 0,
				match: draft.match,
				actions: draft.actions,
				created_at: "2026-01-01T00:00:00.000Z",
			})),
			email,
		);

		expect(result.outbound).toEqual([
			{
				kind: "forward",
				rule_id: "rule-0",
				rule_name: "forward-a",
				to: "archive@example.org",
			},
			{
				kind: "auto_reply",
				rule_id: "rule-2",
				rule_name: "reply-a",
				text: "first",
			},
		]);
		expect(result.routed).toBe(true);
	});




	it("ignores outbound actions on a rule that did not match", () => {
		const result = runRules(
			[
				{
					id: "no-match",
					name: "no-match",
					enabled: true,
					priority: 0,
					match: { mode: "all", conditions: { subject_contains: "nothing" } },
					actions: { forward_to: "archive@example.org" },
					created_at: "2026-01-01T00:00:00.000Z",
				},
			],
			email,
		);
		expect(result.outbound).toEqual([]);
	});
});


describe("rule move_to_folder reaches the stored row", () => {
	it("files an arriving message in the folder the rule chose", async () => {
		const mailbox = "rule-move@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const stub = stubFor(mailbox);
		await stub.createFolder("archive-ish", "Archive-ish");
		await stub.createRule(
			ruleDraft({
				name: "File invoices",
				match: { mode: "all", conditions: { subject_contains: "invoice" } },
				actions: { move_to_folder: "archive-ish" },
			}),
		);

		await deliver(mailbox, { subject: "Invoice 42" });

		const filed = (await stub.getEmails({ folder: "archive-ish" })) as { subject: string }[];
		expect(filed.map((email) => email.subject)).toEqual(["Invoice 42"]);
		const inbox = (await stub.getEmails({ folder: Folders.INBOX })) as { subject: string }[];
		expect(inbox.map((email) => email.subject)).not.toContain("Invoice 42");
	});

	it("falls back to the Inbox when the rule's folder no longer exists", async () => {
		const mailbox = "rule-move-gone@example.com";
		await registerMailbox(mailbox, PIPELINE_SETTINGS);
		const stub = stubFor(mailbox);
		await stub.createFolder("temp-folder", "Temp");
		await stub.createRule(
			ruleDraft({
				name: "File invoices",
				match: { mode: "all", conditions: { subject_contains: "invoice" } },
				actions: { move_to_folder: "temp-folder" },
			}),
		);
		await stub.deleteFolder("temp-folder");

		await deliver(mailbox, { subject: "Invoice 43" });

		const inbox = (await stub.getEmails({ folder: Folders.INBOX })) as { subject: string }[];
		expect(inbox.map((email) => email.subject)).toEqual(["Invoice 43"]);
	});
});


describe("retroactive apply helpers", () => {
	it("keeps only the stored-mail actions", () => {
		expect(
			localRuleActions({
				move_to_folder: "archive",
				set_category: "invoices",
				mark_read: true,
				star: true,
				discard: true,
				forward_to: "archive@example.org",
				auto_reply_text: "Thanks!",
			}),
		).toEqual({
			folder: "archive",
			category: "invoices",
			read: true,
			starred: true,
		});
		expect(localRuleActions({ mark_unread: true, unstar: true })).toEqual({
			read: false,
			starred: false,
		});

		// Outbound-only and discard-only rules have nothing to apply.
		expect(hasLocalRuleActions({ forward_to: "archive@example.org" })).toBe(false);
		expect(hasLocalRuleActions({ discard: true })).toBe(false);
		expect(hasLocalRuleActions({ unstar: true })).toBe(true);
	});


	it("treats a message already in the target state as needing no change", () => {
		const actions = {
			folder: "archive",
			category: "invoices",
			read: true,
			starred: true,
		};
		expect(
			ruleNeedsChange(
				{ folder_id: "archive", category: "INVOICES", read: true, starred: true },
				actions,
			),
		).toBe(false);
		expect(
			ruleNeedsChange({ folder_id: "inbox", category: "invoices" }, actions),
		).toBe(true);
		expect(ruleNeedsChange({ folder_id: "archive", category: null }, actions)).toBe(true);
		expect(
			ruleNeedsChange(
				{ folder_id: "archive", category: "invoices", read: false },
				actions,
			),
		).toBe(true);
		expect(
			ruleNeedsChange(
				{ folder_id: "archive", category: "invoices", read: true, starred: false },
				actions,
			),
		).toBe(true);
	});
});




describe("retroactive apply", () => {
	it("applies folder, category, read and star to exactly the matching mail", async () => {
		const mailbox = "apply-route@example.com";
		const stub = stubFor(mailbox);
		await stub.createFolder("archive-x", "Archive X");
		await seedEmail(stub, "a-1", Folders.INBOX, { subject: "Invoice 1" });
		await seedEmail(stub, "a-2", Folders.INBOX, { subject: "Invoice 2" });
		await seedEmail(stub, "a-3", Folders.INBOX, { subject: "Lunch on Friday?" });

		const rule = await stub.createRule(
			ruleDraft({
				name: "File invoices",
				match: { mode: "all", conditions: { subject_contains: "invoice" } },
				actions: {
					move_to_folder: "archive-x",
					set_category: "invoices",
					mark_read: true,
					star: true,
				},
			}),
		);

		const res = await postApply(mailbox, rule.id);

		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			rule_id: rule.id,
			applied: 2,
			skipped: 0,
			matched: 2,
			remaining: 0,
			scanned: 3,
			scan_limit: 2000,
		});

		// Exactly the two matching messages changed; the third is untouched.
		const rows = await sqlRows<{
			id: string;
			folder_id: string;
			category: string | null;
			read: number;
			starred: number;
			trashed_at: string | null;
			matched_rule_id: string | null;
		}>(
			stub,
			"SELECT id, folder_id, category, read, starred, trashed_at, matched_rule_id FROM emails ORDER BY id",
		);
		expect(rows).toEqual([
			{
				id: "a-1",
				folder_id: "archive-x",
				category: "invoices",
				read: 1,
				starred: 1,
				trashed_at: null,
				matched_rule_id: null,
			},
			{
				id: "a-2",
				folder_id: "archive-x",
				category: "invoices",
				read: 1,
				starred: 1,
				trashed_at: null,
				matched_rule_id: null,
			},
			{
				id: "a-3",
				folder_id: Folders.INBOX,
				category: null,
				read: 0,
				starred: 0,
				trashed_at: null,
				matched_rule_id: null,
			},
		]);

		// A retroactive apply is not a firing: no stats, no stamp.
		expect((await stub.listRules())[0].fired_count).toBe(0);
		const stats = await sqlRows<{ c: number }>(
			stub,
			"SELECT COUNT(*) AS c FROM rule_stats",
		);
		expect(stats[0].c).toBe(0);
	});


	it("counts already-filed mail as skipped and applies nothing on a second run", async () => {
		const stub = stubFor("apply-idempotent@example.com");
		await stub.createFolder("archive-y", "Archive Y");
		// Already in the target state: right folder, category and flags.
		await seedEmail(stub, "b-1", "archive-y", {
			subject: "Invoice 10",
			category: "invoices",
		});
		await stub.updateEmail("b-1", { read: true, starred: true });
		// Needs the move, the category and both flags.
		await seedEmail(stub, "b-2", Folders.INBOX, { subject: "Invoice 11" });

		const rule = await stub.createRule(
			ruleDraft({
				match: { mode: "all", conditions: { subject_contains: "invoice" } },
				actions: {
					move_to_folder: "archive-y",
					set_category: "invoices",
					mark_read: true,
					star: true,
				},
			}),
		);

		const first = await stub.applyRuleToExisting(rule.id);
		expect(first).toMatchObject({
			rule_id: rule.id,
			applied: 1,
			skipped: 1,
			matched: 2,
			remaining: 0,
			scanned: 2,
			scan_limit: 2000,
		});

		// Nothing left to change: the same window now reports 0 applied.
		const second = await stub.applyRuleToExisting(rule.id);
		expect(second).toMatchObject({
			applied: 0,
			skipped: 2,
			matched: 2,
			remaining: 0,
		});
	});


	it("clamps the limit to 1..90 and reports the overflow as remaining", async () => {
		const stub = stubFor("apply-limit@example.com");
		for (let index = 0; index < 95; index += 1) {
			await seedEmail(stub, `c-${index}`, Folders.INBOX, { subject: "Invoice bulk" });
		}
		const rule = await stub.createRule(ruleDraft({ actions: { star: true } }));

		// Above-range limits clamp down to the bulk-action cap...
		const first = await stub.applyRuleToExisting(rule.id, 500);
		expect(first).toMatchObject({
			applied: 90,
			skipped: 0,
			matched: 95,
			remaining: 5,
			scanned: 95,
			scan_limit: 2000,
		});

		// ...and the overflow is what the next batch reports.
		const second = await stub.applyRuleToExisting(rule.id, 500);
		expect(second).toMatchObject({
			applied: 5,
			skipped: 90,
			matched: 95,
			remaining: 0,
		});

		// Below-range limits clamp up to a single message.
		await seedEmail(stub, "c-extra", Folders.INBOX, { subject: "Invoice bulk" });
		const third = await stub.applyRuleToExisting(rule.id, 0);
		expect(third).toMatchObject({
			applied: 1,
			skipped: 95,
			matched: 96,
			remaining: 0,
			scanned: 96,
		});
	});


	it("applies a paused rule the way the dry run previews it", async () => {
		const stub = stubFor("apply-paused@example.com");
		await seedEmail(stub, "p-1", Folders.INBOX, { subject: "Invoice 41" });
		const rule = await stub.createRule(
			ruleDraft({ enabled: false, actions: { star: true } }),
		);

		const result = await stub.applyRuleToExisting(rule.id, 90);
		expect(result).toMatchObject({ applied: 1, matched: 1 });

		const rows = await sqlRows<{ starred: number }>(stub, "SELECT starred FROM emails");
		expect(rows).toEqual([{ starred: 1 }]);
	});


	it("refuses a rule with no stored-mail actions and sends nothing", async () => {
		const mailbox = "apply-outbound-only@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "d-1", Folders.INBOX, { subject: "Invoice 20" });
		const forwardOnly = await stub.createRule(
			ruleDraft({
				name: "Forward only",
				actions: { forward_to: "archive@example.org" },
			}),
		);
		const replyOnly = await stub.createRule(
			ruleDraft({
				name: "Auto-reply only",
				actions: { auto_reply_text: "Thanks for your mail!" },
			}),
		);

		// A sender is wired up but must never be consulted: a retroactive
		// apply has no outbound path at all.
		const { sender, sent } = fakeSender();
		setRuleOutboundSenderFactory(() => sender);
		// Both refusals come from the route's own checks: no RPC rejection
		// is logged, no send is attempted, nothing is changed.
		const results: Awaited<ReturnType<typeof postApply>>[] = [];
		try {
			results.push(await postApply(mailbox, forwardOnly.id));
			results.push(await postApply(mailbox, replyOnly.id));
		} finally {
			setRuleOutboundSenderFactory(null);
		}

		expect(results.map((result) => result.status)).toEqual([400, 400]);
		expect(results[0].body.error).toMatch(
			/no folder, category, read or star action/,
		);
		expect(sent).toHaveLength(0);

		// The message the rules match is untouched: nothing sent, nothing changed.
		const rows = await sqlRows<{ read: number; starred: number }>(
			stub,
			"SELECT read, starred FROM emails",
		);
		expect(rows).toEqual([{ read: 0, starred: 0 }]);
	});


	it("ignores discard, keeps the message stored, and never bumps firing stats", async () => {
		const mailbox = "apply-discard@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "e-1", Folders.INBOX, { subject: "Invoice 30" });
		const rule = await stub.createRule(
			ruleDraft({
				name: "Drop and read",
				actions: { discard: true, mark_read: true },
			}),
		);

		const res = await postApply(mailbox, rule.id);
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ applied: 1, matched: 1 });

		// Discard is a delivery-time action: the stored message survives and
		// only the read flag was applied.
		const rows = await sqlRows<{ id: string; read: number }>(
			stub,
			"SELECT id, read FROM emails",
		);
		expect(rows).toEqual([{ id: "e-1", read: 1 }]);

		expect((await stub.listRules())[0].fired_count).toBe(0);
		const stats = await sqlRows<{ c: number }>(
			stub,
			"SELECT COUNT(*) AS c FROM rule_stats",
		);
		expect(stats[0].c).toBe(0);
	});


	it("answers 404 for an unknown rule and 400 for a bad limit or dead folder", async () => {
		const mailbox = "apply-errors@example.com";
		const stub = stubFor(mailbox);
		await stub.createFolder("temp-z", "Temp Z");
		const rule = await stub.createRule(
			ruleDraft({ actions: { move_to_folder: "temp-z", star: true } }),
		);

		const unknown = await postApply(mailbox, "no-such-rule");
		expect(unknown.status).toBe(404);
		expect(unknown.body.error).toMatch(/Rule not found/);

		const badLimit = await postApply(mailbox, rule.id, { limit: 0 });
		expect(badLimit.status).toBe(400);
		expect(badLimit.body.error).toMatch(/limit/);

		// Folder validation mirrors rules/preview: a dead target is a 400,
		// not a 500 from the Durable Object.
		await stub.deleteFolder("temp-z");
		const deadFolder = await postApply(mailbox, rule.id);
		expect(deadFolder.status).toBe(400);
		expect(deadFolder.body.error).toMatch(/Unknown folder/);
	});
});
