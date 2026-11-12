// Rule outbound quota and forward cooldown: the mailbox send rate limit is
// consulted before every forward/auto-reply, and a sender's mail is
// forwarded at most once per 24 hours (mirroring the auto-reply cap).
// The core cases run runRuleOutboundActions with injected fakes;
// the wiring cases drive handleInboundRuleOutbound with a fake bookkeeping
// stub, exercising the same seam the inbound pipeline uses.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	FORWARD_COOLDOWN_MS,
	handleInboundRuleOutbound,
	isWithinForwardCooldown,
	runRuleOutboundActions,
	setRuleOutboundSenderFactory,
	type RuleOutboundAction,
	type RuleOutboundDeps,
	type RuleOutboundSender,
} from "../workers/lib/rule-outbound";
import type { SendEmailParams } from "../workers/email-sender";


/** A sender that records what it was asked to deliver. */
function fakeSender() {
	const sent: SendEmailParams[] = [];
	const sender: RuleOutboundSender = {
		send: async (params: SendEmailParams) => {
			sent.push(params);
			return { messageId: `fake-${sent.length}` };
		},
	};
	return { sender, sent };
}


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
	mailboxId: "outbound-guards@example.com",
	sender: "sender@example.org",
	subject: "Invoice 3",
	body: "<p>body</p>",
	rawHeaders: null as string | null,
};


/** Deps with in-memory cooldown books and a controllable rate limit. */
function deps(
	sender: RuleOutboundSender | null,
	options: { rateLimit?: (calls: number) => string | null } = {},
) {
	const lastReplies = new Map<string, string>();
	const lastForwards = new Map<string, string>();
	let rateLimitCalls = 0;
	const config = {
		sender,
		checkSendRateLimit: async (): Promise<string | null> => {
			rateLimitCalls += 1;
			return options.rateLimit?.(rateLimitCalls) ?? null;
		},
		lastAutoReplyAt: async (address: string) =>
			lastReplies.get(address) ?? null,
		recordAutoReply: async (address: string, at: string) => {
			lastReplies.set(address, at);
		},
		lastForwardAt: async (address: string) =>
			lastForwards.get(address) ?? null,
		recordForward: async (address: string, at: string) => {
			lastForwards.set(address, at);
		},
		now: () => new Date("2026-09-23T12:00:00.000Z"),
	} satisfies RuleOutboundDeps;
	return { config, lastReplies, lastForwards, rateLimitCalls: () => rateLimitCalls };
}


const RATE_LIMIT_ERROR = "Rate limit exceeded: max 20 emails per hour per mailbox";


describe("rule outbound rate limit", () => {
	it("skips a forward when the mailbox quota is exhausted", async () => {
		const { sender, sent } = fakeSender();
		const { config } = deps(sender, { rateLimit: () => RATE_LIMIT_ERROR });

		const report = await runRuleOutboundActions([forward], email, config);

		expect(report.sent).toBe(0);
		expect(report.skipped).toBe(1);
		expect(report.attempts[0]).toMatchObject({
			kind: "forward",
			status: "skipped",
			reason: RATE_LIMIT_ERROR,
		});
		expect(sent).toHaveLength(0);
	});


	it("skips an auto-reply when the mailbox quota is exhausted", async () => {
		const { sender, sent } = fakeSender();
		const { config } = deps(sender, { rateLimit: () => RATE_LIMIT_ERROR });

		const report = await runRuleOutboundActions([autoReply], email, config);

		expect(report.sent).toBe(0);
		expect(report.skipped).toBe(1);
		expect(report.attempts[0]).toMatchObject({
			kind: "auto_reply",
			status: "skipped",
			reason: RATE_LIMIT_ERROR,
		});
		expect(sent).toHaveLength(0);
	});


	it("consults the quota before each send, not just the first", async () => {
		const { sender, sent } = fakeSender();
		const { config } = deps(sender, {
			rateLimit: (calls) => (calls === 1 ? null : RATE_LIMIT_ERROR),
		});

		// One action of each kind, so the forward cooldown cannot pre-empt
		// the second quota check.
		const report = await runRuleOutboundActions(
			[forward, autoReply],
			email,
			config,
		);

		expect(report.sent).toBe(1);
		expect(report.skipped).toBe(1);
		expect(report.attempts[0]).toMatchObject({ status: "sent" });
		expect(report.attempts[1]).toMatchObject({
			kind: "auto_reply",
			status: "skipped",
			reason: RATE_LIMIT_ERROR,
		});
		expect(sent).toHaveLength(1);
	});
});


describe("rule outbound forward cooldown", () => {
	it("forwards one sender's mail per 24 hours, mirroring auto-reply", async () => {
		expect(FORWARD_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);

		const { sender, sent } = fakeSender();
		const { config } = deps(sender);

		const first = await runRuleOutboundActions([forward], email, config);
		expect(first.sent).toBe(1);
		expect(sent).toHaveLength(1);

		const second = await runRuleOutboundActions([forward], email, config);
		expect(second.skipped).toBe(1);
		expect(second.attempts[0]).toMatchObject({
			kind: "forward",
			status: "skipped",
		});
		expect(second.attempts[0].reason).toMatch(/last 24h/);
		expect(sent).toHaveLength(1);

		// A different original sender still forwards.
		const other = await runRuleOutboundActions(
			[forward],
			{ ...email, sender: "other@example.org" },
			config,
		);
		expect(other.sent).toBe(1);
		expect(sent).toHaveLength(2);
	});


	it("does not consume the forward slot on a failed send", async () => {
		const failing: RuleOutboundSender = {
			send: async () => {
				throw new Error("binding exploded");
			},
		};
		const { config, lastForwards } = deps(failing);

		const failed = await runRuleOutboundActions([forward], email, config);
		expect(failed.failed).toBe(1);
		expect(lastForwards.has("sender@example.org")).toBe(false);

		// The failure consumed nothing: a working sender is not cooled down.
		const { sender, sent } = fakeSender();
		config.sender = sender;
		const retried = await runRuleOutboundActions([forward], email, config);
		expect(retried.sent).toBe(1);
		expect(sent).toHaveLength(1);
	});


	it("isWithinForwardCooldown mirrors isWithinAutoReplyCooldown", () => {
		const now = new Date("2026-09-23T12:00:00.000Z");
		expect(isWithinForwardCooldown(null, now)).toBe(false);
		expect(isWithinForwardCooldown(undefined, now)).toBe(false);
		expect(isWithinForwardCooldown("not-a-date", now)).toBe(false);
		expect(
			isWithinForwardCooldown(
				new Date(now.getTime() - FORWARD_COOLDOWN_MS + 1000).toISOString(),
				now,
			),
		).toBe(true);
		expect(
			isWithinForwardCooldown(
				new Date(now.getTime() - FORWARD_COOLDOWN_MS).toISOString(),
				now,
			),
		).toBe(false);
	});
});


describe("handleInboundRuleOutbound quota wiring", () => {
	it("skips outbound actions when the stub reports the quota exhausted", async () => {
		const { sender, sent } = fakeSender();
		setRuleOutboundSenderFactory(() => sender);
		let rateLimitChecks = 0;
		try {
			const report = await handleInboundRuleOutbound(
				env,
				{
					getLastAutoReplyAt: async () => null,
					recordAutoReply: async () => {},
					checkSendRateLimit: async () => {
						rateLimitChecks += 1;
						return RATE_LIMIT_ERROR;
					},
				},
				email,
				[forward, autoReply],
			);

			expect(report.sent).toBe(0);
			expect(report.skipped).toBe(2);
			expect(
				report.attempts.map((attempt) => attempt.reason),
			).toEqual([RATE_LIMIT_ERROR, RATE_LIMIT_ERROR]);
			expect(rateLimitChecks).toBe(2);
			expect(sent).toHaveLength(0);
		} finally {
			setRuleOutboundSenderFactory(null);
		}
	});


	it("enforces the forward cooldown through the stub bookkeeping", async () => {
		const { sender, sent } = fakeSender();
		setRuleOutboundSenderFactory(() => sender);
		const lastForwards = new Map<string, string>();
		try {
			const stub = {
				getLastAutoReplyAt: async () => null,
				recordAutoReply: async () => {},
				checkSendRateLimit: async () => null,
				getLastForwardAt: async (address: string) =>
					lastForwards.get(address) ?? null,
				recordForward: async (address: string, at: string) => {
					lastForwards.set(address, at);
				},
			};

			const first = await handleInboundRuleOutbound(env, stub, email, [forward]);
			expect(first.sent).toBe(1);
			expect(lastForwards.get("sender@example.org")).toBeTruthy();

			const second = await handleInboundRuleOutbound(env, stub, email, [forward]);
			expect(second.skipped).toBe(1);
			expect(second.attempts[0].reason).toMatch(/last 24h/);
			expect(sent).toHaveLength(1);
		} finally {
			setRuleOutboundSenderFactory(null);
		}
	});
});
