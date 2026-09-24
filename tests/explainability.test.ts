import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	AUTH_RESULT_TOKENS,
	hasAuthResults,
	parseAuthResults,
} from "../shared/auth-results";
import { summarizeClassification } from "../shared/classification-summary";
import { Folders } from "../shared/folders";


/** Build the stored `raw_headers` JSON exactly as the Worker stores it. */
function rawHeaders(headers: [string, string][]): string {
	return JSON.stringify(headers.map(([key, value]) => ({ key, value })));
}


const GOOGLE_HEADER = [
	"mx.google.com;",
	"dkim=pass header.i=@sender.example header.s=sel2024 header.b=abc123;",
	"spf=pass (google.com: domain of alice@sender.example designates 203.0.113.7 as permitted sender) smtp.mailfrom=alice@sender.example;",
	"dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=sender.example",
].join(" ");


const CLASSIFICATION = JSON.stringify({
	model: "typesafe/jev",
	is_spam: true,
	spam_probability: 0.94,
	category: "spam",
	category_name: "Spam",
	category_confidence: 0.94,
	answers: { is_spam: { type: "noul", noul: 0.94 } },
	usage: { input_tokens: 10, output_tokens: 2 },
});


describe("parseAuthResults", () => {
	it("parses spf, dkim, and dmarc out of a typical header with comments", () => {
		const results = parseAuthResults(rawHeaders([["Authentication-Results", GOOGLE_HEADER]]));
		expect(results.spf).toEqual(
			expect.objectContaining({ method: "spf", result: "pass", domain: "sender.example" }),
		);
		expect(results.dkim).toEqual(
			expect.objectContaining({ method: "dkim", result: "pass", domain: "sender.example" }),
		);
		expect(results.dmarc).toEqual(
			expect.objectContaining({ method: "dmarc", result: "pass", domain: "sender.example" }),
		);
		expect(results.spf?.authservId).toBe("mx.google.com");
		expect(results.spf?.headerName).toBe("Authentication-Results");
		// The full raw header value stays available for tooltips/expansion.
		expect(results.spf?.headerValue).toBe(GOOGLE_HEADER);
	});


	it("matches header names and result tokens case-insensitively", () => {
		const results = parseAuthResults(
			rawHeaders([
				[
					"AUTHENTICATION-RESULTS",
					"MX.Example; SPF=Pass SMTP.MailFrom=Bob@Example.COM; DKIM=Fail header.d=Example.com",
				],
			]),
		);
		expect(results.spf?.result).toBe("pass");
		expect(results.spf?.domain).toBe("example.com");
		expect(results.dkim?.result).toBe("fail");
		expect(results.dkim?.domain).toBe("example.com");
		expect(results.dmarc).toBeUndefined();
	});


	it("returns {} for absent, empty, or unusable raw_headers", () => {
		expect(parseAuthResults(null)).toEqual({});
		expect(parseAuthResults(undefined)).toEqual({});
		expect(parseAuthResults("")).toEqual({});
		expect(parseAuthResults("not json at all")).toEqual({});
		expect(parseAuthResults(JSON.stringify({ from: "a@b.example" }))).toEqual({});
		expect(parseAuthResults([null, 42, "x", { key: "Authentication-Results" }, { value: "spf=pass" }])).toEqual({});
		expect(hasAuthResults(parseAuthResults(null))).toBe(false);
		expect(hasAuthResults(undefined)).toBe(false);
	});


	it("skips unknown result tokens but keeps the valid methods around them", () => {
		const results = parseAuthResults(
			rawHeaders([
				["Authentication-Results", "mx.example; spf=whatever smtp.mailfrom=a.example; dkim=pass header.d=a.example"],
			]),
		);
		expect(results.spf).toBeUndefined();
		expect(results.dkim?.result).toBe("pass");
	});


	it("skips entries without a method=result shape", () => {
		const results = parseAuthResults(
			rawHeaders([
				["Authentication-Results", "mx.example; header.d=a.example; dkim=pass header.d=a.example; ; spf=none"],
			]),
		);
		expect(results.dkim?.result).toBe("pass");
		expect(results.spf?.result).toBe("none");
	});


	it("prefers a passing DKIM entry when a message carries several signatures", () => {
		const results = parseAuthResults(
			rawHeaders([
				[
					"Authentication-Results",
					"mx.example; dkim=fail header.d=first.example; dkim=pass header.d=second.example",
				],
			]),
		);
		expect(results.dkim?.result).toBe("pass");
		expect(results.dkim?.domain).toBe("second.example");
	});


	it("keeps the first DKIM entry when none of them passed", () => {
		const results = parseAuthResults(
			rawHeaders([
				["Authentication-Results", "mx.example; dkim=neutral header.d=first.example; dkim=none"],
			]),
		);
		expect(results.dkim?.result).toBe("neutral");
		expect(results.dkim?.domain).toBe("first.example");
	});


	it("keeps the first SPF/DMARC verdict when several headers are present", () => {
		const results = parseAuthResults(
			rawHeaders([
				["Authentication-Results", "mx.first; spf=fail smtp.mailfrom=first.example"],
				["Authentication-Results", "mx.second; spf=pass smtp.mailfrom=second.example; dmarc=pass header.from=second.example"],
			]),
		);
		expect(results.spf?.result).toBe("fail");
		expect(results.spf?.domain).toBe("first.example");
		// The first header carried no DMARC verdict, so the later one is used.
		expect(results.dmarc?.result).toBe("pass");
		expect(results.dmarc?.domain).toBe("second.example");
	});


	it("falls back to Received-SPF when Authentication-Results has no SPF", () => {
		const receivedSpf =
			"pass (google.com: domain of alice@sender.example designates 203.0.113.7 as permitted sender) client-ip=203.0.113.7; envelope-from=alice@sender.example; helo=mail.sender.example";
		const results = parseAuthResults(
			rawHeaders([
				["Received-SPF", receivedSpf],
				["Authentication-Results", "mx.example; dkim=pass header.d=sender.example"],
			]),
		);
		expect(results.spf).toEqual(
			expect.objectContaining({ result: "pass", domain: "sender.example", headerName: "Received-SPF" }),
		);
		expect(results.spf?.headerValue).toBe(receivedSpf);
		expect(results.dkim?.result).toBe("pass");
	});


	it("prefers the Authentication-Results SPF verdict over Received-SPF", () => {
		const results = parseAuthResults(
			rawHeaders([
				["Received-SPF", "fail; envelope-from=alice@bad.example"],
				["Authentication-Results", "mx.example; spf=pass smtp.mailfrom=alice@good.example"],
			]),
		);
		expect(results.spf?.result).toBe("pass");
		expect(results.spf?.domain).toBe("good.example");
		expect(results.spf?.headerName).toBe("Authentication-Results");
	});


	it("ignores Received-SPF values that are not a known result token", () => {
		const results = parseAuthResults(rawHeaders([["Received-SPF", "unknown-token; envelope-from=a@b.example"]]));
		expect(results).toEqual({});
	});


	it("strips nested comments containing semicolons", () => {
		const results = parseAuthResults(
			rawHeaders([
				[
					"Authentication-Results",
					"mx.example; dmarc=fail (p=REJECT sp=REJECT (nested; still comment) dis=NONE) header.from=bad.example; spf=none",
				],
			]),
		);
		expect(results.dmarc?.result).toBe("fail");
		expect(results.dmarc?.domain).toBe("bad.example");
		expect(results.spf?.result).toBe("none");
	});


	it("unwraps quoted and angled property values", () => {
		const results = parseAuthResults(
			rawHeaders([
				[
					"Authentication-Results",
					'mx.example; dkim=pass header.d="sender.example" header.b="abc=def"; spf=pass smtp.helo=<mail.sender.example>',
				],
			]),
		);
		expect(results.dkim?.domain).toBe("sender.example");
		expect(results.spf?.domain).toBe("mail.sender.example");
	});


	it("accepts an already-parsed array or an object map of headers", () => {
		const parsed = parseAuthResults([
			{ key: "authentication-results", value: "mx.example; dkim=pass header.d=a.example" },
		]);
		expect(parsed.dkim?.result).toBe("pass");


		const mapped = parseAuthResults(
			JSON.stringify({ "Authentication-Results": "mx.example; dmarc=fail header.from=b.example" }),
		);
		expect(mapped.dmarc?.result).toBe("fail");
	});


	it("only reports the standard result tokens", () => {
		expect([...AUTH_RESULT_TOKENS]).toEqual([
			"pass",
			"fail",
			"softfail",
			"neutral",
			"none",
			"temperror",
			"permerror",
			"policy",
		]);
		expect(hasAuthResults(parseAuthResults(rawHeaders([["Authentication-Results", "mx; spf=softfail"]])))).toBe(true);
	});
});


describe("summarizeClassification", () => {
	it("renders the AI verdict with its confidence", () => {
		const summary = summarizeClassification({
			classification: CLASSIFICATION,
			category: "spam",
			category_confidence: 0.94,
		});
		expect(summary.verdict).toBe("Spam — 0.94 confidence");
		expect(summary.isSpam).toBe(true);
		expect(summary.confidence).toBe(0.94);
		expect(summary.category).toBe("spam");
		expect(summary.categoryName).toBe("Spam");
		expect(summary.model).toBe("typesafe/jev");
		expect(summary.source).toBe("classification");
	});


	it("renders a not-spam verdict from the spam probability", () => {
		const summary = summarizeClassification({
			classification: JSON.stringify({
				is_spam: false,
				spam_probability: 0.12,
				category: "receipts",
				category_name: "Receipts",
				category_confidence: 0.87,
			}),
			category: "receipts",
		});
		expect(summary.verdict).toBe("Not spam — 0.12 confidence");
		expect(summary.isSpam).toBe(false);
		expect(summary.confidence).toBe(0.12);
		expect(summary.categoryName).toBe("Receipts");
	});


	it("accepts an already-parsed classification object", () => {
		const summary = summarizeClassification({
			classification: { is_spam: true, spam_probability: 0.8 },
		});
		expect(summary.verdict).toBe("Spam — 0.80 confidence");
	});


	it("returns 'No AI verdict' for null, undefined, and empty input", () => {
		for (const input of [null, undefined, {}, { classification: null }, { classification: "   " }]) {
			const summary = summarizeClassification(input);
			expect(summary.verdict).toBe("No AI verdict");
			expect(summary.source).toBe("none");
			expect(summary.isSpam).toBeNull();
			expect(summary.confidence).toBeNull();
		}
	});


	it("handles legacy plain-string classifications", () => {
		expect(summarizeClassification({ classification: "spam" }).verdict).toBe("Spam");
		expect(summarizeClassification({ classification: "not_spam" }).verdict).toBe("Not spam");
		expect(summarizeClassification({ classification: "not spam" }).verdict).toBe("Not spam");
		expect(summarizeClassification({ classification: "ham" }).verdict).toBe("Not spam");
		expect(summarizeClassification({ classification: '"spam"' }).verdict).toBe("Spam");
		const legacy = summarizeClassification({ classification: "spam", category_confidence: 0.91 });
		expect(legacy.verdict).toBe("Spam — 0.91 confidence");
		expect(legacy.source).toBe("classification");
	});


	it("falls back to the category when the JSON is malformed or unhelpful", () => {
		const malformed = summarizeClassification({
			classification: "{not json",
			category: "receipts",
			category_confidence: 0.87,
			categoryLabel: "Receipts",
		});
		expect(malformed.verdict).toBe("Filed as Receipts — 0.87 confidence");
		expect(malformed.source).toBe("category");
		expect(malformed.isSpam).toBeNull();


		const bare = summarizeClassification({ classification: "42" });
		expect(bare.verdict).toBe("No AI verdict");


		const arrayJson = summarizeClassification({ classification: "[1,2,3]" });
		expect(arrayJson.verdict).toBe("No AI verdict");


		const wrongType = summarizeClassification({
			classification: JSON.stringify({ is_spam: "yes", category: "receipts" }),
		});
		expect(wrongType.verdict).toBe("Filed as Receipts");
		expect(wrongType.isSpam).toBeNull();
	});


	it("never throws on odd shapes", () => {
		const shapes: unknown[] = [42, [], true, { classification: [] }, { classification: 42 }, { category: 42 }, { category_confidence: "0.9" }];
		for (const shape of shapes) {
			expect(() => summarizeClassification(shape as never)).not.toThrow();
		}
	});


	it("derives a spam verdict from the category alone", () => {
		const summary = summarizeClassification({ category: "spam", category_confidence: 0.9 });
		expect(summary.verdict).toBe("Spam — 0.90 confidence");
		expect(summary.isSpam).toBe(true);
		expect(summary.source).toBe("category");
	});


	it("humanizes unknown category ids and prefers stored labels", () => {
		const humanized = summarizeClassification({ category: "travel-plans" });
		expect(humanized.verdict).toBe("Filed as Travel Plans");
		expect(humanized.categoryName).toBe("Travel Plans");


		const labelled = summarizeClassification({
			classification: JSON.stringify({ category: "travel-plans" }),
			category: "travel-plans",
			categoryLabel: "Trips",
		});
		expect(labelled.verdict).toBe("Filed as Trips");
	});


	it("ignores non-finite confidences instead of printing NaN", () => {
		const summary = summarizeClassification({
			classification: JSON.stringify({ is_spam: true, spam_probability: null }),
			category_confidence: Number.POSITIVE_INFINITY,
		});
		expect(summary.verdict).toBe("Spam");
		expect(summary.confidence).toBeNull();
	});
});


describe("email detail payload feeds the explainers", () => {
	async function registerMailbox(mailbox: string) {
		await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
	}


	it("returns raw_headers, classification, and category on the detail route", async () => {
		const mailbox = "explain-detail@example.com";
		await registerMailbox(mailbox);
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
		const headers = rawHeaders([["Authentication-Results", GOOGLE_HEADER]]);
		await stub.createEmail(
			Folders.INBOX,
			{
				id: "explain-1",
				subject: "Invoice",
				sender: "alice@sender.example",
				recipient: mailbox,
				date: new Date().toISOString(),
				body: "<p>hi</p>",
				in_reply_to: null,
				email_references: null,
				thread_id: "explain-1",
				raw_headers: headers,
				category: "spam",
				category_confidence: 0.94,
				classification: CLASSIFICATION,
			},
			[],
		);


		const res = await SELF.fetch(`http://example.com/api/v1/mailboxes/${mailbox}/emails/explain-1`);
		expect(res.status).toBe(200);
		const payload = (await res.json()) as Record<string, unknown>;


		expect(payload.raw_headers).toBe(headers);
		expect(payload.classification).toBe(CLASSIFICATION);
		expect(payload.category).toBe("spam");
		expect(payload.category_confidence).toBe(0.94);


		const auth = parseAuthResults(payload.raw_headers);
		expect(hasAuthResults(auth)).toBe(true);
		expect(auth.dmarc?.result).toBe("pass");


		const summary = summarizeClassification({
			classification: payload.classification as string,
			category: payload.category as string,
			category_confidence: payload.category_confidence as number,
		});
		expect(summary.verdict).toBe("Spam — 0.94 confidence");
	});


	it("has nothing to explain for a sent-style message", async () => {
		const mailbox = "explain-sent@example.com";
		await registerMailbox(mailbox);
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
		await stub.createEmail(
			Folders.SENT,
			{
				id: "explain-sent-1",
				subject: "Re: Invoice",
				sender: mailbox,
				recipient: "alice@sender.example",
				date: new Date().toISOString(),
				body: "<p>sent</p>",
				in_reply_to: null,
				email_references: null,
				thread_id: "explain-sent-1",
				raw_headers: rawHeaders([
					["from", mailbox],
					["to", "alice@sender.example"],
					["subject", "Re: Invoice"],
				]),
			},
			[],
		);


		const res = await SELF.fetch(`http://example.com/api/v1/mailboxes/${mailbox}/emails/explain-sent-1`);
		expect(res.status).toBe(200);
		const payload = (await res.json()) as Record<string, unknown>;


		expect(hasAuthResults(parseAuthResults(payload.raw_headers))).toBe(false);
		expect(
			summarizeClassification({
				classification: payload.classification as string | null,
				category: payload.category as string | null,
				category_confidence: payload.category_confidence as number | null,
			}).source,
		).toBe("none");
	});
});
