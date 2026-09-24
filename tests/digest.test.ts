// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Morning-digest tests: the window helper, the Durable Object's buildDigest
 * (counts, caps, spam exclusion, the list query's needs-reply predicate and
 * fired reminders), the per-day claim, the cron sweep's delivery — captured
 * fetch, frozen payload, signature — and the digest route.
 *
 * Outbound calls are captured by swapping the isolate's global fetch, the
 * same technique tests/webhook.test.ts uses (vitest-pool-workers 0.22.0 does
 * not export `fetchMock` from `cloudflare:test`).
 */


import {
	SELF,
	createExecutionContext,
	createScheduledController,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { SPAM_CATEGORY_ID } from "../shared/categories";
import { Folders } from "../shared/folders";
import worker from "../workers/app";
import {
	digestWindow,
	type Digest,
	type DigestPayload,
} from "../workers/lib/digest";
import { DIGEST_CRON, sweepDigests } from "../workers/lib/digest-sweep";
import { listMailboxes } from "../workers/lib/email-helpers";
import { signWebhookBody } from "../workers/lib/webhook";
import type { Env } from "../workers/types";


/** The test config omits account-level vars; the digest path only needs BUCKET + MAILBOX. */
const appEnv = env as unknown as Env;


const WEBHOOK_URL = "https://hooks.example.com/digest";
const SECRET = "digest-s3cret";

/** Fixed clock, so every window and seeded date is deterministic. */
const FIXED_NOW = new Date("2026-09-24T11:00:00.000Z");
const WINDOW = digestWindow(FIXED_NOW);
const DAY = FIXED_NOW.toISOString().slice(0, 10);


type Stub = ReturnType<typeof stubFor>;


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


/** ISO instant `hours` before the fixed clock. */
function isoHoursBefore(hours: number): string {
	return new Date(FIXED_NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}


/** ISO instant `minutes` before the fixed clock. */
function isoMinutesBefore(minutes: number): string {
	return new Date(FIXED_NOW.getTime() - minutes * 60_000).toISOString();
}


interface SeedOptions {
	threadId?: string;
	date?: string;
	read?: boolean;
	starred?: boolean;
	category?: string | null;
	classification?: string | null;
}


/** Seed one email into a folder (mirrors tests/snooze-core.test.ts). */
async function seedEmail(
	stub: Stub,
	id: string,
	folder: string,
	options: SeedOptions = {},
) {
	await stub.createEmail(
		folder,
		{
			id,
			subject: `Subject ${id}`,
			sender: "sender@example.org",
			recipient: "digest@example.com",
			date: options.date ?? isoHoursBefore(6),
			read: options.read ?? false,
			starred: options.starred ?? false,
			category: options.category ?? null,
			classification: options.classification ?? null,
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: options.threadId ?? id,
		},
		[],
	);
}


/** Register a mailbox record in R2 so the HTTP routes accept its id. */
async function registerMailbox(
	mailbox: string,
	settings: Record<string, unknown> = {},
) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify(settings));
}


/**
 * Drop every mailbox record so a sweep only sees the mailboxes the test
 * registers — sweep summaries are otherwise order-dependent.
 */
async function resetMailboxes() {
	for (const mailbox of await listMailboxes(env.BUCKET)) {
		await env.BUCKET.delete(`mailboxes/${mailbox.id}.json`);
	}
}


/** Wipe a mailbox's delivery bookkeeping so a re-run of a test starts clean. */
async function clearDeliveries(stub: Stub) {
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec("DELETE FROM digest_deliveries");
	});
}


/** Raw read of a mailbox's digest_deliveries rows, newest day first. */
async function deliveryRows(stub: Stub) {
	return runInDurableObject(stub, async (_instance, state) => [
		...state.storage.sql.exec(
			"SELECT day, ok, status, error FROM digest_deliveries ORDER BY day DESC",
		),
	] as { day: string; ok: number; status: number | null; error: string | null }[]);
}


// ── Outbound fetch capture ─────────────────────────────────────────


interface CapturedCall {
	url: string;
	request: Request;
	body: string;
}


const originalFetch = globalThis.fetch;


/**
 * Swap the isolate's global fetch for a capture stub so the exact request the
 * digest delivery builds can be inspected. The responder decides what the
 * endpoint "answers".
 */
function captureFetch(
	respond: (request: Request) => Response | Promise<Response>,
): CapturedCall[] {
	const calls: CapturedCall[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init);
		calls.push({ url: request.url, request, body: await request.clone().text() });
		return respond(request);
	}) as typeof fetch;
	return calls;
}


function digestCalls(calls: CapturedCall[]): CapturedCall[] {
	return calls.filter((call) => call.url === WEBHOOK_URL);
}


afterEach(() => {
	globalThis.fetch = originalFetch;
});


// ── digestWindow ───────────────────────────────────────────────────


describe("digestWindow", () => {
	it("is the trailing 24 hours ending at `now`, as ISO 8601 instants", () => {
		expect(digestWindow(new Date("2026-09-24T11:00:00.000Z"))).toEqual({
			from: "2026-09-23T11:00:00.000Z",
			to: "2026-09-24T11:00:00.000Z",
		});
	});


	it("round-trips an arbitrary instant", () => {
		const now = new Date();
		const window = digestWindow(now);
		expect(window.to).toBe(now.toISOString());
		expect(Date.parse(window.to) - Date.parse(window.from)).toBe(86_400_000);
	});
});


// ── buildDigest ────────────────────────────────────────────────────


describe("buildDigest", () => {
	it("counts window arrivals and excludes Sent, Drafts and older mail", async () => {
		const stub = stubFor("digest-counts@example.com");
		await seedEmail(stub, "a", Folders.INBOX, {
			date: isoHoursBefore(2),
			read: true,
			starred: true,
			category: "work",
		});
		await seedEmail(stub, "b", Folders.INBOX, { date: isoHoursBefore(4) });
		await seedEmail(stub, "old", Folders.INBOX, { date: isoHoursBefore(25) });
		await seedEmail(stub, "sent", Folders.SENT, { date: isoHoursBefore(3), read: true });
		await seedEmail(stub, "draft", Folders.DRAFT, { date: isoHoursBefore(3) });
		await seedEmail(stub, "spam", Folders.SPAM, { date: isoHoursBefore(1) });

		const digest = await stub.buildDigest(WINDOW);

		expect(digest.mailbox).toBe("digest-counts@example.com");
		expect(digest.window).toEqual(WINDOW);
		expect(new Date(digest.generated_at).toISOString()).toBe(digest.generated_at);
		// a and b arrived, plus the spam message; `old` is outside the window and
		// the Sent copy and Draft are not arrivals. Only `a` was read, so only
		// its conversation needs a reply.
		expect(digest.counts).toEqual({
			received: 3,
			unread: 2,
			starred: 1,
			spam: 1,
			needs_reply: 1,
		});
		expect(digest.recent.map((item) => item.id)).toEqual(["a", "b"]);
		expect(digest.by_category).toEqual([{ category: "work", count: 1 }]);
		expect(digest.reminders).toEqual([]);
	});


	it("counts spam but keeps it out of recent and needs_reply", async () => {
		const stub = stubFor("digest-spam@example.com");
		// All three spam shapes getSpamEmails recognizes: the folder, the
		// built-in category, and a classifier audit trail that says is_spam.
		await seedEmail(stub, "spam-folder", Folders.SPAM, {
			date: isoHoursBefore(1),
			read: true,
		});
		await seedEmail(stub, "spam-category", Folders.INBOX, {
			date: isoHoursBefore(2),
			read: true,
			category: SPAM_CATEGORY_ID,
		});
		await seedEmail(stub, "spam-classified", Folders.INBOX, {
			date: isoHoursBefore(3),
			read: true,
			classification: JSON.stringify({ is_spam: true }),
		});
		await seedEmail(stub, "real", Folders.INBOX, {
			date: isoHoursBefore(4),
			read: true,
		});

		const digest = await stub.buildDigest(WINDOW);

		expect(digest.counts.received).toBe(4);
		expect(digest.counts.spam).toBe(3);
		expect(digest.recent.map((item) => item.id)).toEqual(["real"]);
		expect(digest.needs_reply.map((item) => item.id)).toEqual(["real"]);
	});


	it("caps recent at the ten newest arrivals", async () => {
		const stub = stubFor("digest-recent-cap@example.com");
		for (let i = 0; i < 12; i++) {
			await seedEmail(stub, `r-${String(i).padStart(2, "0")}`, Folders.INBOX, {
				date: isoHoursBefore(i + 1),
			});
		}

		const digest = await stub.buildDigest(WINDOW);

		expect(digest.counts.received).toBe(12);
		expect(digest.recent).toHaveLength(10);
		expect(digest.recent.map((item) => item.id)).toEqual([
			"r-00", "r-01", "r-02", "r-03", "r-04",
			"r-05", "r-06", "r-07", "r-08", "r-09",
		]);
	});


	it("caps needs_reply at ten rows while its count stays complete", async () => {
		const stub = stubFor("digest-reply-cap@example.com");
		for (let i = 0; i < 12; i++) {
			await seedEmail(stub, `n-${String(i).padStart(2, "0")}`, Folders.INBOX, {
				date: isoHoursBefore(i + 1),
				read: true,
			});
		}

		const digest = await stub.buildDigest(WINDOW);

		expect(digest.counts.needs_reply).toBe(12);
		expect(digest.needs_reply).toHaveLength(10);
		expect(digest.needs_reply.map((item) => item.id)).toEqual([
			"n-00", "n-01", "n-02", "n-03", "n-04",
			"n-05", "n-06", "n-07", "n-08", "n-09",
		]);
	});


	it("caps by_category at 20 rows, largest count first", async () => {
		const stub = stubFor("digest-category-cap@example.com");
		// Minutes apart so all 28 stay inside the 24-hour window.
		for (let i = 0; i < 3; i++) {
			await seedEmail(stub, `alpha-${i}`, Folders.INBOX, {
				date: isoMinutesBefore(30 + i * 10),
				category: "alpha",
			});
		}
		for (let i = 0; i < 25; i++) {
			await seedEmail(stub, `cat-${String(i).padStart(2, "0")}`, Folders.INBOX, {
				date: isoMinutesBefore(60 + i * 30),
				category: `cat-${String(i).padStart(2, "0")}`,
			});
		}

		const digest = await stub.buildDigest(WINDOW);

		expect(digest.counts.received).toBe(28);
		expect(digest.by_category).toHaveLength(20);
		expect(digest.by_category[0]).toEqual({ category: "alpha", count: 3 });
		const counts = digest.by_category.map((row) => row.count);
		expect(counts).toEqual([...counts].sort((left, right) => right - left));
	});


	it("mirrors the list predicate: answered and unread-only threads are not flagged", async () => {
		const stub = stubFor("digest-needs-reply@example.com");
		// The conversation's newest message is a read inbox arrival.
		await seedEmail(stub, "needs-1", Folders.INBOX, {
			threadId: "needs-thread",
			date: isoHoursBefore(2),
			read: true,
		});
		// The newest message of this conversation sits in Sent: already answered.
		await seedEmail(stub, "replied-1", Folders.INBOX, {
			threadId: "replied-thread",
			date: isoHoursBefore(5),
			read: true,
		});
		await seedEmail(stub, "replied-2", Folders.SENT, {
			threadId: "replied-thread",
			date: isoHoursBefore(3),
			read: true,
		});
		// Nothing in this conversation has been read, so nothing is waiting.
		await seedEmail(stub, "unread-1", Folders.INBOX, {
			threadId: "unread-thread",
			date: isoHoursBefore(4),
		});

		const digest = await stub.buildDigest(WINDOW);

		expect(digest.counts.needs_reply).toBe(1);
		expect(digest.needs_reply).toEqual([
			{
				id: "needs-1",
				subject: "Subject needs-1",
				sender: "sender@example.org",
				date: isoHoursBefore(2),
				folder: "Inbox",
				category: null,
			},
		]);
	});


	it("lists fired reminders newest first, capped at ten", async () => {
		const stub = stubFor("digest-reminders@example.com");
		for (let i = 0; i < 12; i++) {
			await seedEmail(stub, `rem-${String(i).padStart(2, "0")}`, Folders.INBOX, {
				date: isoHoursBefore(20),
			});
		}
		await runInDurableObject(stub, async (_instance, state) => {
			for (let i = 0; i < 12; i++) {
				state.storage.sql.exec(
					"UPDATE emails SET reminded_at = ?1 WHERE id = ?2",
					isoHoursBefore(12 - i),
					`rem-${String(i).padStart(2, "0")}`,
				);
			}
		});

		const digest = await stub.buildDigest(WINDOW);

		expect(digest.reminders).toHaveLength(10);
		expect(digest.reminders[0]).toEqual({
			id: "rem-11",
			subject: "Subject rem-11",
			sender: "sender@example.org",
			fired_at: isoHoursBefore(1),
		});
		expect(digest.reminders[9]?.id).toBe("rem-02");
	});
});


// ── claimDigestDay / recordDigestDelivery ──────────────────────────


describe("claimDigestDay", () => {
	it("claims a day once, and reports every later claim for it", async () => {
		const stub = stubFor("digest-claim@example.com");
		await clearDeliveries(stub);

		expect(await stub.claimDigestDay(DAY)).toBe(true);
		expect(await stub.claimDigestDay(DAY)).toBe(false);
		expect(await stub.claimDigestDay("2026-09-25")).toBe(true);

		const rows = await deliveryRows(stub);
		expect(rows.map((row) => row.day)).toEqual(["2026-09-25", DAY]);
		// A claim starts pending; the sweep settles it with the outcome.
		expect(rows[0]?.ok).toBe(0);
		expect(rows[1]?.ok).toBe(0);
	});


	it("records the delivery outcome on the claimed day", async () => {
		const stub = stubFor("digest-record@example.com");
		await clearDeliveries(stub);
		await stub.claimDigestDay(DAY);

		await stub.recordDigestDelivery(DAY, {
			ok: false,
			status: 503,
			error: "Webhook responded 503",
		});
		const [failed] = await deliveryRows(stub);
		expect(failed).toMatchObject({
			day: DAY,
			ok: 0,
			status: 503,
			error: "Webhook responded 503",
		});

		await stub.recordDigestDelivery(DAY, { ok: true, status: 200, error: null });
		const [delivered] = await deliveryRows(stub);
		expect(delivered).toMatchObject({ day: DAY, ok: 1, status: 200, error: null });
	});


	it("prunes the mailbox back to its newest 90 days when a claim lands", async () => {
		const stub = stubFor("digest-prune@example.com");
		await clearDeliveries(stub);
		await runInDurableObject(stub, async (_instance, state) => {
			for (let day = 1; day <= 95; day++) {
				const stamp = new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10);
				state.storage.sql.exec(
					"INSERT OR IGNORE INTO digest_deliveries (day, delivered_at, ok) VALUES (?1, ?2, 1)",
					stamp,
					isoHoursBefore(1),
				);
			}
		});

		expect(await stub.claimDigestDay("2026-12-31")).toBe(true);

		const total = await runInDurableObject(stub, async (_instance, state) => {
			const row = [
				...state.storage.sql.exec("SELECT COUNT(*) as total FROM digest_deliveries"),
			][0] as { total: number };
			return row.total;
		});
		expect(total).toBe(90);
	});
});


// ── Digest sweep ───────────────────────────────────────────────────


describe("sweepDigests", () => {
	it("posts nothing for a mailbox that has the digest disabled", async () => {
		await resetMailboxes();
		await registerMailbox("digest-off@example.com", {
			notifyWebhookUrl: WEBHOOK_URL,
			digestEnabled: false,
		});
		const calls = captureFetch(() => new Response("ok", { status: 200 }));

		const summary = await sweepDigests(appEnv, { now: FIXED_NOW });

		expect(summary).toEqual({
			mailboxes: 1,
			considered: 0,
			delivered: 0,
			skipped: 1,
			failed: 0,
		});
		expect(calls).toHaveLength(0);
	});


	it("skips a mailbox with no webhook URL to deliver to", async () => {
		await resetMailboxes();
		await registerMailbox("digest-nourl@example.com", { digestEnabled: true });
		const calls = captureFetch(() => new Response("ok", { status: 200 }));

		const summary = await sweepDigests(appEnv, { now: FIXED_NOW });

		expect(summary).toEqual({
			mailboxes: 1,
			considered: 0,
			delivered: 0,
			skipped: 1,
			failed: 0,
		});
		expect(calls).toHaveLength(0);
	});


	it("delivers exactly one signed POST whose body is the frozen payload", async () => {
		await resetMailboxes();
		const mailbox = "digest-on@example.com";
		await registerMailbox(mailbox, {
			notifyWebhookUrl: WEBHOOK_URL,
			notifyWebhookSecret: SECRET,
			digestEnabled: true,
		});
		const stub = stubFor(mailbox);
		await clearDeliveries(stub);
		await seedEmail(stub, "on-1", Folders.INBOX, {
			date: isoHoursBefore(2),
			read: true,
			starred: true,
			category: "work",
		});
		await seedEmail(stub, "on-2", Folders.SPAM, { date: isoHoursBefore(1) });
		const calls = captureFetch(() => new Response("ok", { status: 200 }));

		const summary = await sweepDigests(appEnv, { now: FIXED_NOW });

		expect(summary).toEqual({
			mailboxes: 1,
			considered: 1,
			delivered: 1,
			skipped: 0,
			failed: 0,
		});
		expect(digestCalls(calls)).toHaveLength(1);
		const [call] = digestCalls(calls);
		expect(call.request.method).toBe("POST");
		expect(call.request.headers.get("content-type")).toBe("application/json");
		expect(call.request.headers.get("X-Agentic-Inbox-Signature")).toBe(
			await signWebhookBody(SECRET, call.body),
		);

		const payload = JSON.parse(call.body) as DigestPayload;
		expect(Object.keys(payload).sort()).toEqual([
			"by_category",
			"counts",
			"generated_at",
			"items",
			"mailbox",
			"needs_reply",
			"recent",
			"reminders",
			"type",
			"window",
		]);
		expect(payload).toMatchObject({
			type: "digest",
			mailbox,
			window: WINDOW,
			counts: { received: 2, unread: 1, starred: 1, spam: 1, needs_reply: 1 },
			items: { open: 0, overdue: 0, due_today: 0, due: [] },
			by_category: [{ category: "work", count: 1 }],
			needs_reply: [
				{
					id: "on-1",
					subject: "Subject on-1",
					sender: "sender@example.org",
					date: isoHoursBefore(2),
					folder: "Inbox",
					category: "work",
				},
			],
			recent: [
				{
					id: "on-1",
					subject: "Subject on-1",
					sender: "sender@example.org",
					date: isoHoursBefore(2),
					folder: "Inbox",
					category: "work",
				},
			],
			reminders: [],
		});
		expect(new Date(payload.generated_at).toISOString()).toBe(payload.generated_at);

		// The claimed day is settled with the outcome.
		const rows = await deliveryRows(stub);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ day: DAY, ok: 1, status: 200, error: null });
	});


	it("records a non-2xx answer as a failed delivery and never throws", async () => {
		await resetMailboxes();
		const mailbox = "digest-503@example.com";
		await registerMailbox(mailbox, {
			notifyWebhookUrl: WEBHOOK_URL,
			digestEnabled: true,
		});
		const stub = stubFor(mailbox);
		await clearDeliveries(stub);
		await seedEmail(stub, "fail-1", Folders.INBOX, { date: isoHoursBefore(2) });
		const calls = captureFetch(() => new Response("nope", { status: 503 }));

		const summary = await sweepDigests(appEnv, { now: FIXED_NOW });

		expect(summary).toEqual({
			mailboxes: 1,
			considered: 1,
			delivered: 0,
			skipped: 0,
			failed: 1,
		});
		expect(digestCalls(calls)).toHaveLength(1);
		const rows = await deliveryRows(stub);
		expect(rows[0]).toMatchObject({
			day: DAY,
			ok: 0,
			status: 503,
			error: "Webhook responded 503",
		});
	});


	it("never delivers the same UTC day twice", async () => {
		await resetMailboxes();
		const mailbox = "digest-once@example.com";
		await registerMailbox(mailbox, {
			notifyWebhookUrl: WEBHOOK_URL,
			digestEnabled: true,
		});
		const stub = stubFor(mailbox);
		await clearDeliveries(stub);
		await seedEmail(stub, "once-1", Folders.INBOX, { date: isoHoursBefore(2) });
		const calls = captureFetch(() => new Response("ok", { status: 200 }));

		const first = await sweepDigests(appEnv, { now: FIXED_NOW });
		const second = await sweepDigests(appEnv, { now: FIXED_NOW });

		expect(first.delivered).toBe(1);
		expect(second).toEqual({
			mailboxes: 1,
			considered: 1,
			delivered: 0,
			skipped: 1,
			failed: 0,
		});
		expect(digestCalls(calls)).toHaveLength(1);
	});
});


// ── Cron routing ───────────────────────────────────────────────────


describe("scheduled() cron routing", () => {
	it("runs the digest sweep for the 11:00 trigger", async () => {
		await resetMailboxes();
		const mailbox = "digest-cron@example.com";
		await registerMailbox(mailbox, {
			notifyWebhookUrl: WEBHOOK_URL,
			digestEnabled: true,
		});
		const stub = stubFor(mailbox);
		await clearDeliveries(stub);
		await seedEmail(stub, "cron-1", Folders.INBOX, {
			date: new Date().toISOString(),
		});
		const calls = captureFetch(() => new Response("ok", { status: 200 }));

		const ctx = createExecutionContext();
		await worker.scheduled(createScheduledController({ cron: DIGEST_CRON }), appEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(digestCalls(calls)).toHaveLength(1);
		const [call] = digestCalls(calls);
		const payload = JSON.parse(call.body) as DigestPayload;
		expect(payload.type).toBe("digest");
		expect(payload.mailbox).toBe(mailbox);
		expect(payload.recent.map((item) => item.id)).toEqual(["cron-1"]);
		// The digest covers the trailing 24 hours of the real clock.
		expect(Date.parse(payload.window.to) - Date.parse(payload.window.from)).toBe(
			86_400_000,
		);
		expect(Math.abs(Date.parse(payload.window.to) - Date.now())).toBeLessThan(60_000);
	});


	it("does not run the digest sweep for the housekeeping trigger", async () => {
		await resetMailboxes();
		const mailbox = "digest-cron-off@example.com";
		await registerMailbox(mailbox, {
			notifyWebhookUrl: WEBHOOK_URL,
			digestEnabled: true,
		});
		const stub = stubFor(mailbox);
		await clearDeliveries(stub);
		await seedEmail(stub, "cron-off-1", Folders.INBOX, {
			date: new Date().toISOString(),
		});
		const calls = captureFetch(() => new Response("ok", { status: 200 }));

		const ctx = createExecutionContext();
		await worker.scheduled(createScheduledController({ cron: "0 3 * * *" }), appEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(digestCalls(calls)).toHaveLength(0);
		expect(await deliveryRows(stub)).toHaveLength(0);
	});
});


// ── Digest route ───────────────────────────────────────────────────


function jsonInit(method: string, body: unknown): RequestInit {
	return {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}


describe("GET /api/v1/mailboxes/:mailboxId/digest", () => {
	it("returns the trailing-24-hour digest", async () => {
		const mailbox = "digest-route@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, "route-1", Folders.INBOX, {
			date: new Date(Date.now() - 60_000).toISOString(),
			read: true,
			category: "work",
		});

		const res = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/digest`,
		);

		expect(res.status).toBe(200);
		const { digest } = (await res.json()) as { digest: Digest };
		expect(digest.mailbox).toBe(mailbox);
		expect(digest.counts).toEqual({
			received: 1,
			unread: 0,
			starred: 0,
			spam: 0,
			needs_reply: 1,
		});
		expect(digest.recent.map((item) => item.id)).toEqual(["route-1"]);
		expect(digest.by_category).toEqual([{ category: "work", count: 1 }]);
		expect(digest.reminders).toEqual([]);
		expect(Date.parse(digest.window.to) - Date.parse(digest.window.from)).toBe(
			86_400_000,
		);
		expect(Math.abs(Date.parse(digest.window.to) - Date.now())).toBeLessThan(60_000);
	});


	it("404s for an unknown mailbox", async () => {
		const res = await SELF.fetch(
			"http://example.com/api/v1/mailboxes/digest-missing@example.com/digest",
		);
		expect(res.status).toBe(404);
	});


	it("round-trips digestEnabled through the settings PUT", async () => {
		const mailbox = "digest-settings@example.com";
		await registerMailbox(mailbox);
		const url = `http://example.com/api/v1/mailboxes/${mailbox}`;

		const on = await SELF.fetch(url, jsonInit("PUT", { settings: { digestEnabled: true } }));
		expect(on.status).toBe(200);
		expect(
			((await on.json()) as { settings?: Record<string, unknown> }).settings
				?.digestEnabled,
		).toBe(true);
		const stored = await env.BUCKET.get(`mailboxes/${mailbox}.json`);
		expect(
			((await stored!.json()) as Record<string, unknown>).digestEnabled,
		).toBe(true);

		const off = await SELF.fetch(
			url,
			jsonInit("PUT", { settings: { digestEnabled: false } }),
		);
		expect(off.status).toBe(200);
		expect(
			((await off.json()) as { settings?: Record<string, unknown> }).settings
				?.digestEnabled,
		).toBe(false);
	});
});


describe("buildDigest items section", () => {
	it("summarizes open items and lists the soonest due first", async () => {
		const mailbox = "digest-items@example.com";
		const stub = stubFor(mailbox);
		await stub.insertItems("item-msg-1", "item-thread-1", [
			{
				kind: "deadline",
				title: "Invoice due",
				details: null,
				due_at: isoHoursBefore(30),
			},
			{
				kind: "task",
				title: "Reply to landlord",
				details: null,
				due_at: isoHoursBefore(-4),
			},
			{ kind: "task", title: "Undated chore", details: null, due_at: null },
		]);

		const digest = await stub.buildDigest(WINDOW);

		expect(digest.items.open).toBe(3);
		expect(digest.items.overdue).toBe(1);
		expect(digest.items.due_today).toBe(1);
		expect(digest.items.due.map((item) => item.title)).toEqual([
			"Invoice due",
			"Reply to landlord",
		]);
		expect(digest.items.due[0]).toMatchObject({
			email_id: "item-msg-1",
			due_at: isoHoursBefore(30),
		});
	});

	it("counts only open items in the overdue and due-today buckets", async () => {
		const mailbox = "digest-items-closed@example.com";
		const stub = stubFor(mailbox);
		const [item] = await stub.insertItems("item-msg-2", null, [
			{
				kind: "task",
				title: "Old chore",
				details: null,
				due_at: isoHoursBefore(48),
			},
		]);
		await stub.updateItemStatus(item.id, "done");

		const digest = await stub.buildDigest(WINDOW);
		expect(digest.items.open).toBe(0);
		expect(digest.items.overdue).toBe(0);
		expect(digest.items.due).toEqual([]);
	});
});
