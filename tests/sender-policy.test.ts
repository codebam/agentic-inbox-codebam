import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SPAM_CATEGORY_ID } from "../shared/categories";
import { Folders } from "../shared/folders";
import { receiveEmail } from "../workers/index";
import {
	SenderPolicyAddressSchema,
	SenderPolicyFeedbackSchema,
	SetSenderPolicySchema,
} from "../workers/lib/schemas";
import {
	isSenderPolicy,
	normalizeSenderAddress,
	senderPolicyVerdict,
	withoutSpamQuestion,
} from "../workers/lib/sender-policy";
import type { Env } from "../workers/types";


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


/** Register the mailbox record the API middleware checks before routing. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
}


/** Call a sender-policy route through the real worker. */
async function apiFetch(mailbox: string, path: string, init: RequestInit = {}) {
	await registerMailbox(mailbox);
	return SELF.fetch(`http://example.com/api/v1/mailboxes/${mailbox}${path}`, {
		...init,
		headers: {
			"content-type": "application/json",
			...(init.headers as Record<string, string> | undefined),
		},
	});
}


/** Seed one email row straight into a folder. */
async function seedEmail(
	stub: ReturnType<typeof stubFor>,
	id: string,
	folder: string,
	sender: string,
	extra: { category?: string | null; classification?: string | null } = {},
) {
	await stub.createEmail(
		folder,
		{
			id,
			subject: `Subject ${id}`,
			sender,
			recipient: "sender-policy@example.com",
			date: new Date().toISOString(),
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: id,
			category: extra.category ?? null,
			classification: extra.classification ?? null,
		},
		[],
	);
}


/** One raw RFC 822 message, enough for PostalMime to parse. */
function rawEmail(from: string, to: string, subject: string): Uint8Array {
	return new TextEncoder().encode(
		[
			`From: Spammy Sender <${from}>`,
			`To: ${to}`,
			`Subject: ${subject}`,
			`Message-ID: <${crypto.randomUUID()}@example.org>`,
			`Date: ${new Date().toUTCString()}`,
			"MIME-Version: 1.0",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"Hello from the other side.",
			"",
		].join("\r\n"),
	);
}


// ── Pure ingest decision ───────────────────────────────────────────


describe("senderPolicyVerdict", () => {
	it("blocks: Spam, no classification, no auto-draft", () => {
		const decision = senderPolicyVerdict("block");
		expect(decision.verdict).toBe("block");
		expect(decision.folder).toBe(Folders.SPAM);
		expect(decision.classify).toBe(false);
		expect(decision.forceNotSpam).toBe(true);
		expect(decision.autoDraft).toBe(false);
	});


	it("allows: not-spam but categories still classified, auto-draft unchanged", () => {
		const decision = senderPolicyVerdict("allow");
		expect(decision.verdict).toBe("allow");
		expect(decision.folder).toBeNull();
		expect(decision.classify).toBe(true);
		expect(decision.forceNotSpam).toBe(true);
		expect(decision.autoDraft).toBe(true);
	});


	it("falls back to today's behaviour for absent or unknown values", () => {
		for (const value of [null, undefined, "", "none", "BLOCK", "deny", 42]) {
			const decision = senderPolicyVerdict(value);
			expect(decision.verdict).toBe("none");
			expect(decision.folder).toBeNull();
			expect(decision.classify).toBe(true);
			expect(decision.forceNotSpam).toBe(false);
			expect(decision.autoDraft).toBe(true);
		}
	});
});


describe("withoutSpamQuestion", () => {
	it("drops only the spam question and leaves the settings untouched", () => {
		const settings = {
			enabled: true,
			spam: { enabled: true, threshold: 0.7, moveToSpam: true },
			categories: [{ id: "billing", name: "Billing", description: "" }],
			useGlobalCategories: true,
		};
		const patched = withoutSpamQuestion(settings);
		expect(patched.spam.enabled).toBe(false);
		expect(patched.spam.threshold).toBe(0.7);
		expect(patched.spam.moveToSpam).toBe(true);
		expect(patched.categories).toEqual(settings.categories);
		expect(patched.enabled).toBe(true);
		// The caller's object is not mutated.
		expect(settings.spam.enabled).toBe(true);
	});
});


describe("address normalization and the policy enum", () => {
	it("normalizes addresses to trimmed lowercase", () => {
		expect(normalizeSenderAddress("  Alice@Example.COM ")).toBe("alice@example.com");
		expect(normalizeSenderAddress(undefined)).toBe("");
		expect(normalizeSenderAddress(7)).toBe("");
	});


	it("only accepts the two known policies", () => {
		expect(isSenderPolicy("allow")).toBe(true);
		expect(isSenderPolicy("block")).toBe(true);
		expect(isSenderPolicy("deny")).toBe(false);
		expect(isSenderPolicy(null)).toBe(false);
	});
});


// ── Zod schemas (route validation) ─────────────────────────────────


describe("sender policy schemas", () => {
	it("trims the address and validates the policy enum", () => {
		const parsed = SetSenderPolicySchema.safeParse({
			address: "  Blocked@Example.org ",
			policy: "block",
		});
		expect(parsed.success).toBe(true);
		expect(parsed.success && parsed.data.address).toBe("Blocked@Example.org");
	});


	it("rejects an unknown policy", () => {
		const parsed = SetSenderPolicySchema.safeParse({
			address: "a@example.org",
			policy: "deny",
		});
		expect(parsed.success).toBe(false);
	});


	it("rejects a malformed address", () => {
		for (const address of ["", "not-an-address", "a b@example.org", "@example.org"]) {
			expect(SenderPolicyAddressSchema.safeParse(address).success).toBe(false);
		}
	});


	it("validates the feedback body", () => {
		expect(
			SenderPolicyFeedbackSchema.safeParse({ emailId: "e1", action: "allow" }).success,
		).toBe(true);
		expect(
			SenderPolicyFeedbackSchema.safeParse({ emailId: "", action: "allow" }).success,
		).toBe(false);
		expect(
			SenderPolicyFeedbackSchema.safeParse({ emailId: "e1", action: "spam" }).success,
		).toBe(false);
	});
});


// ── Durable Object CRUD ────────────────────────────────────────────


describe("MailboxDO sender policy CRUD", () => {
	it("stores addresses lowercased and trimmed", async () => {
		const stub = stubFor("sender-policy-do@example.com");
		const stored = await stub.setSenderPolicy("  Spammy@Example.ORG ", "block");
		expect(stored.address).toBe("spammy@example.org");
		expect(stored.policy).toBe("block");


		expect((await stub.getSenderPolicy("SPAMMY@example.org"))?.policy).toBe("block");
		expect((await stub.getSenderPolicy(" spammy@example.org "))?.policy).toBe("block");
		expect(await stub.getSenderPolicy("someone-else@example.org")).toBeNull();
	});


	it("upserts without duplicating rows and keeps created_at", async () => {
		const stub = stubFor("sender-policy-upsert@example.com");
		const first = await stub.setSenderPolicy("flaky@example.org", "allow");
		const second = await stub.setSenderPolicy("FLAKY@example.org", "block");


		expect(second.policy).toBe("block");
		expect(second.created_at).toBe(first.created_at);
		const entries = await stub.listSenderPolicy();
		expect(entries).toHaveLength(1);
		expect(entries[0].policy).toBe("block");
	});


	it("lists every entry and removes one", async () => {
		const stub = stubFor("sender-policy-list@example.com");
		await stub.setSenderPolicy("one@example.org", "allow");
		await stub.setSenderPolicy("two@example.org", "block");


		const entries = await stub.listSenderPolicy();
		expect(entries.map((entry) => entry.address).sort()).toEqual([
			"one@example.org",
			"two@example.org",
		]);


		expect(await stub.removeSenderPolicy("ONE@example.org")).toBe(true);
		expect(await stub.removeSenderPolicy("one@example.org")).toBe(false);
		expect((await stub.listSenderPolicy()).map((entry) => entry.address)).toEqual([
			"two@example.org",
		]);
	});


	it("rejects an empty address and an unknown policy", async () => {
		const stub = stubFor("sender-policy-invalid@example.com");
		await runInDurableObject(stub, async (instance) => {
			await expect(instance.setSenderPolicy("   ", "allow")).rejects.toThrow(
				/address is required/i,
			);
			await expect(
				instance.setSenderPolicy("a@example.org", "deny" as never),
			).rejects.toThrow(/unknown sender policy/i);
			expect(await instance.listSenderPolicy()).toEqual([]);
		});
	});


	it("applies one-click feedback: allow clears spam marks and moves to Inbox", async () => {
		const stub = stubFor("sender-policy-feedback-allow@example.com");
		await seedEmail(stub, "allow-1", Folders.SPAM, "marketing@example.org", {
			category: SPAM_CATEGORY_ID,
			classification: JSON.stringify({ is_spam: true, model: "test" }),
		});


		const entry = await stub.applySenderPolicyFeedback("allow-1", "allow");
		expect(entry?.address).toBe("marketing@example.org");
		expect(entry?.policy).toBe("allow");


		const email = await stub.getEmail("allow-1");
		expect(email?.folder_id).toBe(Folders.INBOX);
		expect(email?.category).toBeNull();
		expect(email?.category_confidence).toBeNull();
		expect(email?.classification).toBeNull();
	});


	it("applies one-click feedback: block moves the message to Spam", async () => {
		const stub = stubFor("sender-policy-feedback-block@example.com");
		await seedEmail(stub, "block-1", Folders.INBOX, "spammer@example.org");


		const entry = await stub.applySenderPolicyFeedback("block-1", "block");
		expect(entry?.policy).toBe("block");


		const email = await stub.getEmail("block-1");
		expect(email?.folder_id).toBe(Folders.SPAM);
		expect(email?.category).toBe(SPAM_CATEGORY_ID);


		// Unknown ids are a no-op, not a crash.
		expect(await stub.applySenderPolicyFeedback("missing", "block")).toBeNull();
	});
});


// ── Routes ─────────────────────────────────────────────────────────


describe("sender policy routes", () => {
	const MAILBOX = "sender-policy-routes@example.com";
	const PATH = "/sender-policy";


	it("starts empty, upserts, lists, and deletes", async () => {
		const empty = await apiFetch(MAILBOX, PATH);
		expect(empty.status).toBe(200);
		expect(await empty.json()).toEqual([]);


		const created = await apiFetch(MAILBOX, PATH, {
			method: "PUT",
			body: JSON.stringify({ address: " Blocked@Example.org ", policy: "block" }),
		});
		expect(created.status).toBe(200);
		const createdBody = (await created.json()) as { address: string; policy: string };
		expect(createdBody.address).toBe("blocked@example.org");
		expect(createdBody.policy).toBe("block");


		// Upsert: same address, new policy, still one entry.
		const updated = await apiFetch(MAILBOX, PATH, {
			method: "PUT",
			body: JSON.stringify({ address: "blocked@example.org", policy: "allow" }),
		});
		expect(updated.status).toBe(200);
		expect(((await updated.json()) as { policy: string }).policy).toBe("allow");


		const listed = await apiFetch(MAILBOX, PATH);
		expect(await listed.json()).toHaveLength(1);


		const removed = await apiFetch(
			MAILBOX,
			`${PATH}?address=${encodeURIComponent("BLOCKED@example.org")}`,
			{ method: "DELETE" },
		);
		expect(removed.status).toBe(204);
		expect(await (await apiFetch(MAILBOX, PATH)).json()).toEqual([]);
	});


	it("rejects invalid bodies and unknown entries", async () => {
		const badPolicy = await apiFetch(MAILBOX, PATH, {
			method: "PUT",
			body: JSON.stringify({ address: "a@example.org", policy: "deny" }),
		});
		expect(badPolicy.status).toBe(400);
		expect(((await badPolicy.json()) as { error: string }).error).toContain(
			"Invalid sender policy",
		);


		const badAddress = await apiFetch(MAILBOX, PATH, {
			method: "PUT",
			body: JSON.stringify({ address: "not-an-address", policy: "allow" }),
		});
		expect(badAddress.status).toBe(400);


		const noAddress = await apiFetch(MAILBOX, PATH, { method: "DELETE" });
		expect(noAddress.status).toBe(400);


		const missing = await apiFetch(
			MAILBOX,
			`${PATH}?address=${encodeURIComponent("nobody@example.org")}`,
			{ method: "DELETE" },
		);
		expect(missing.status).toBe(404);
	});


	it("applies one-click feedback through the feedback route", async () => {
		const mailbox = "sender-policy-feedback-route@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "route-1", Folders.SPAM, "feedback@example.org", {
			category: SPAM_CATEGORY_ID,
		});


		const allowed = await apiFetch(mailbox, `${PATH}/feedback`, {
			method: "POST",
			body: JSON.stringify({ emailId: "route-1", action: "allow" }),
		});
		expect(allowed.status).toBe(200);
		expect(((await allowed.json()) as { policy: string }).policy).toBe("allow");


		const email = await stub.getEmail("route-1");
		expect(email?.folder_id).toBe(Folders.INBOX);
		expect(email?.category).toBeNull();


		const unknown = await apiFetch(mailbox, `${PATH}/feedback`, {
			method: "POST",
			body: JSON.stringify({ emailId: "missing", action: "block" }),
		});
		expect(unknown.status).toBe(404);


		const badAction = await apiFetch(mailbox, `${PATH}/feedback`, {
			method: "POST",
			body: JSON.stringify({ emailId: "route-1", action: "maybe" }),
		});
		expect(badAction.status).toBe(400);
	});
});


// ── Inbound ingest decision (block path) ───────────────────────────


describe("inbound ingest with a blocked sender", () => {
	it("files the message into Spam without classifying or auto-drafting", async () => {
		const mailbox = "sender-policy-ingest@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await stub.setSenderPolicy("  Spammy@Example.ORG ", "block");


		const raw = rawEmail("spammy@example.org", mailbox, "Cheap pills");
		// Auto-draft triggers are recorded instead of awaited: a blocked
		// sender must not queue one.
		const pending: Promise<unknown>[] = [];
		const ctx = {
			waitUntil: (promise: Promise<unknown>) => {
				pending.push(promise);
			},
			passThroughOnException: () => {},
		} as unknown as ExecutionContext;


		await receiveEmail(
			{ raw: new Response(raw).body!, rawSize: raw.byteLength, to: mailbox },
			env as unknown as Env,
			ctx,
		);


		expect(pending).toHaveLength(0);


		const rows = await runInDurableObject(stub, async (_instance, state) => [
			...state.storage.sql.exec(
				"SELECT id, folder_id, category, classification FROM emails",
			),
		]) as unknown as {
			id: string;
			folder_id: string;
			category: string | null;
			classification: string | null;
		}[];


		// The message is STORED — blocked mail is never silently dropped.
		expect(rows).toHaveLength(1);
		expect(rows[0].folder_id).toBe(Folders.SPAM);
		expect(rows[0].category).toBe(SPAM_CATEGORY_ID);
		// Classification was skipped entirely (no Jev call, no audit trail).
		expect(rows[0].classification).toBeNull();
	});
});
