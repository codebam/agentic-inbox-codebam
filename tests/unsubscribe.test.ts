/**
 * One-click unsubscribe (RFC 8058) tests.
 *
 * Covers, in order: the ingest path storing both headers verbatim, the SSRF
 * guard's rejection classes and guarded fetch behaviour, the header parsers,
 * the one-click POST request itself, the MailboxDO mutator, and the
 * POST /emails/:id/unsubscribe route end to end.
 *
 * The pool does not export `fetchMock` from `cloudflare:test`, so outbound
 * calls are captured by swapping the isolate's global `fetch` — tests and
 * the main worker run in the same isolate (see tests/webhook.test.ts), so a
 * SELF.fetch-dispatched route sees the swap too.
 */

import {
	SELF,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import PostalMime from "postal-mime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Folders } from "../shared/folders";
import {
	MAX_OUTBOUND_URL_LENGTH,
	OUTBOUND_TIMEOUT_MS,
	checkOutboundUrl,
	guardedFetch,
} from "../workers/lib/ssrf-guard";
import {
	extractUnsubscribeHeaders,
	isOneClickUnsubscribe,
	parseUnsubscribeHeader,
	sendOneClickUnsubscribe,
} from "../workers/lib/unsubscribe";
import { receiveEmail } from "../workers/index";
import type { Env } from "../workers/types";


/** The test config omits account-level vars; the inbound path only needs BUCKET + MAILBOX. */
const appEnv = env as unknown as Env;

type Stub = ReturnType<typeof stubFor>;

/** The `emails` columns this feature owns. */
interface UnsubscribeRow {
	id: string;
	list_unsubscribe: string | null;
	list_unsubscribe_post: string | null;
	unsubscribed_at: string | null;
}

/** Route answer shape for the unsubscribe endpoint. */
interface UnsubscribeResponse {
	status?: string;
	error?: string;
	email?: UnsubscribeRow;
}

const TARGET = "https://unsub.example.com/u?token=xyz";
const MAILTO = "mailto:unsub@example.org";
const MARKER = "List-Unsubscribe=One-Click";


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


/** Register the mailbox record the API middleware checks before routing. */
async function registerMailbox(
	mailbox: string,
	settings: Record<string, unknown> = {},
) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify(settings));
}


/** Seed one stored message into a mailbox's Inbox. */
async function seedEmail(
	stub: Stub,
	id: string,
	fields: Partial<UnsubscribeRow> = {},
) {
	await stub.createEmail(
		Folders.INBOX,
		{
			id,
			subject: `Subject ${id}`,
			sender: "sender@example.org",
			recipient: "unsub@example.com",
			date: new Date().toISOString(),
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: id,
			...fields,
		},
		[],
	);
}


// ── Inbound delivery ───────────────────────────────────────────────


/** One inbound MIME message with optional extra headers. */
function mimeMessage(mailbox: string, headers: string[] = []): string {
	return [
		"From: Alice <alice@example.org>",
		`To: ${mailbox}`,
		"Subject: Unsubscribe test",
		`Message-ID: <${crypto.randomUUID()}@example.org>`,
		...headers,
		"Content-Type: text/html; charset=utf-8",
		"",
		"<p>Hello <b>unsubscribe</b> world</p>",
	].join("\r\n");
}


/** Deliver one MIME message through the real inbound path. */
async function deliver(mailbox: string, mime: string) {
	const bytes = new TextEncoder().encode(mime);
	const ctx = createExecutionContext();
	await receiveEmail(
		{ raw: new Response(bytes).body!, rawSize: bytes.byteLength, to: mailbox },
		appEnv,
		ctx,
	);
	await waitOnExecutionContext(ctx);
}


/** Ids of the messages currently in a mailbox's Inbox. */
async function inboxIds(mailbox: string): Promise<string[]> {
	const rows = (await stubFor(mailbox).getEmails({ folder: Folders.INBOX })) as {
		id: string;
	}[];
	return rows.map((row) => row.id);
}


describe("inbound ingest", () => {
	it("stores List-Unsubscribe and List-Unsubscribe-Post verbatim", async () => {
		const mailbox = "unsub-ingest@example.com";
		await registerMailbox(mailbox);

		await deliver(
			mailbox,
			mimeMessage(mailbox, [
				`List-Unsubscribe: <${TARGET}>, <${MAILTO}>`,
				`List-Unsubscribe-Post: ${MARKER}`,
			]),
		);

		const [id] = await inboxIds(mailbox);
		const row = (await stubFor(mailbox).getEmail(id!)) as UnsubscribeRow | null;
		expect(row?.list_unsubscribe).toBe(`<${TARGET}>, <${MAILTO}>`);
		expect(row?.list_unsubscribe_post).toBe(MARKER);
		expect(row?.unsubscribed_at).toBeNull();
	});

	it("stores nulls when the sender set no unsubscribe headers", async () => {
		const mailbox = "unsub-ingest-none@example.com";
		await registerMailbox(mailbox);

		await deliver(mailbox, mimeMessage(mailbox));

		const [id] = await inboxIds(mailbox);
		const row = (await stubFor(mailbox).getEmail(id!)) as UnsubscribeRow | null;
		expect(row?.list_unsubscribe).toBeNull();
		expect(row?.list_unsubscribe_post).toBeNull();
	});

	it("finds the headers even though postal-mime lowercases their keys", async () => {
		// Pin the parser behaviour the extractor relies on: header keys are
		// lowercased (the sender's casing survives in `originalKey`), which
		// is why the case-insensitive lookup is what makes mixed-case
		// senders work. Verified empirically, not assumed.
		const parsed = await new PostalMime().parse(
			mimeMessage("probe@example.com", [
				`LIST-UNSUBSCRIBE: <${TARGET}>`,
				`List-Unsubscribe-Post: ${MARKER}`,
			]),
		);

		const keys = parsed.headers.map((header) => header.key);
		expect(keys).toContain("list-unsubscribe");
		expect(keys).toContain("list-unsubscribe-post");
		expect(keys).not.toContain("LIST-UNSUBSCRIBE");
		expect(extractUnsubscribeHeaders(parsed.headers)).toEqual({
			listUnsubscribe: `<${TARGET}>`,
			listUnsubscribePost: MARKER,
		});
	});

	it("exposes the columns on the detail row and leaves list rows alone", async () => {
		const mailbox = "unsub-shape@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		await deliver(
			mailbox,
			mimeMessage(mailbox, [
				`List-Unsubscribe: <${TARGET}>`,
				`List-Unsubscribe-Post: ${MARKER}`,
			]),
		);

		const [id] = await inboxIds(mailbox);
		const detail = (await stub.getEmail(id!)) as UnsubscribeRow | null;
		expect(detail?.list_unsubscribe).toBe(`<${TARGET}>`);
		expect(detail?.list_unsubscribe_post).toBe(MARKER);
		expect(detail?.unsubscribed_at).toBeNull();

		const list = (await stub.getEmails({ folder: Folders.INBOX })) as Record<
			string,
			unknown
		>[];
		const row = list.find((entry) => entry["id"] === id);
		expect(row).toBeDefined();
		expect("list_unsubscribe" in row!).toBe(false);
		expect("list_unsubscribe_post" in row!).toBe(false);
		expect("unsubscribed_at" in row!).toBe(false);
	});
});


// ── Outbound fetch capture ─────────────────────────────────────────


interface CapturedCall {
	url: string;
	request: Request;
	body: string;
}


/**
 * Swap the isolate's global fetch for a capture stub, so the exact request
 * the app builds can be inspected. Every outbound call is recorded; the
 * responder decides what the endpoint "answers".
 */
function captureFetch(
	respond: (request: Request) => Response | Promise<Response>,
): CapturedCall[] {
	const calls: CapturedCall[] = [];
	vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init);
		// Read the body as bytes and decode: Request.text() warns when the
		// Content-Type is not textual, and the one-click body is a form.
		const body = new TextDecoder().decode(await request.clone().arrayBuffer());
		calls.push({ url: request.url, request, body });
		return respond(request);
	}) as typeof fetch);
	return calls;
}


afterEach(() => {
	vi.unstubAllGlobals();
});


// ── SSRF guard ─────────────────────────────────────────────────────


/** Assert the guard refused `raw` and return the reason for further checks. */
function refusal(raw: string): string {
	const result = checkOutboundUrl(raw);
	expect(typeof result).toBe("string");
	return result as string;
}


describe("checkOutboundUrl", () => {
	it("accepts an https URL on the default port or 8443", () => {
		const url = checkOutboundUrl(TARGET);
		expect(url).toBeInstanceOf(URL);
		expect((url as URL).hostname).toBe("unsub.example.com");
		expect(checkOutboundUrl("https://unsub.example.com:443/u")).toBeInstanceOf(URL);
		expect(checkOutboundUrl("https://unsub.example.com:8443/u")).toBeInstanceOf(URL);
	});

	it("rejects anything that is not https", () => {
		for (const raw of [
			"http://unsub.example.com/u",
			"ftp://unsub.example.com/u",
			"javascript:alert(1)",
		]) {
			expect(refusal(raw)).toContain("https");
		}
	});

	it("rejects URLs that carry credentials", () => {
		expect(refusal("https://user:secret@unsub.example.com/u")).toContain(
			"credentials",
		);
		expect(refusal("https://user@unsub.example.com/u")).toContain("credentials");
	});

	it("rejects IP-literal hosts, v4 and v6, in every normalised form", () => {
		for (const raw of [
			"https://127.0.0.1/u",
			"https://10.0.0.1/u",
			"https://2130706433/u", // decimal form of 127.0.0.1
			"https://[::1]/u",
			"https://[2001:db8::1]/u",
			"https://[::ffff:127.0.0.1]/u",
		]) {
			expect(refusal(raw)).toContain("IP literal");
		}
	});

	it("rejects localhost, .local and .internal hosts", () => {
		for (const raw of [
			"https://localhost/u",
			"https://localhost./u",
			"https://mail.localhost/u",
			"https://printer.local/u",
			"https://vault.internal/u",
		]) {
			expect(refusal(raw)).toContain("local or internal");
		}
	});

	it("rejects ports other than 443 and 8443", () => {
		expect(refusal("https://unsub.example.com:8080/u")).toContain("port");
		expect(refusal("https://unsub.example.com:25/u")).toContain("port");
	});

	it("rejects over-length URLs and unusable input", () => {
		const long = `https://unsub.example.com/${"a".repeat(MAX_OUTBOUND_URL_LENGTH)}`;
		expect(long.length).toBeGreaterThan(MAX_OUTBOUND_URL_LENGTH);
		expect(refusal(long)).toContain(`longer than ${MAX_OUTBOUND_URL_LENGTH}`);
		expect(refusal("   ")).toContain("empty");
		expect(refusal("not a url")).toContain("valid absolute URL");
	});
});


describe("guardedFetch", () => {
	it("never touches the network when the guard rejects the URL", async () => {
		const fetchImpl = vi.fn<typeof fetch>();

		const result = await guardedFetch("http://127.0.0.1/u", { method: "POST" }, fetchImpl);

		expect(result.ok).toBe(false);
		expect(result.status).toBeNull();
		expect(result.ok ? "" : result.error).toContain("https");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("sends redirect: manual with a 10-second timeout and cancels the body unread", async () => {
		let cancelled = false;
		const stream = new ReadableStream({
			cancel() {
				cancelled = true;
			},
		});
		const fetchImpl = vi.fn<typeof fetch>(async (request: Request) => {
			expect(request.redirect).toBe("manual");
			expect(request.signal).toBeInstanceOf(AbortSignal);
			return new Response(stream, { status: 200 });
		});

		const result = await guardedFetch(TARGET, { method: "POST" }, fetchImpl);

		expect(result).toEqual({ ok: true, status: 200 });
		expect(cancelled).toBe(true);
		expect(OUTBOUND_TIMEOUT_MS).toBe(10_000);
	});

	it("treats a 3xx as a failure and never follows it", async () => {
		const calls = captureFetch(() => new Response(null, { status: 302 }));

		const result = await guardedFetch(TARGET, { method: "POST" });

		expect(result).toEqual({
			ok: false,
			status: 302,
			error: "Redirect refused (302)",
		});
		expect(calls).toHaveLength(1);
	});

	it("reports a non-2xx answer without throwing", async () => {
		captureFetch(() => new Response("nope", { status: 500 }));

		const result = await guardedFetch(TARGET, { method: "POST" });

		expect(result).toEqual({
			ok: false,
			status: 500,
			error: "Endpoint responded 500",
		});
	});

	it("reports an unreachable endpoint as a reason", async () => {
		captureFetch(() => {
			throw new Error("connection refused");
		});

		const result = await guardedFetch(TARGET, { method: "POST" });

		expect(result.ok).toBe(false);
		expect(result.status).toBeNull();
		expect(result.ok ? "" : result.error).toContain("connection refused");
	});
});


// ── Header parsing ─────────────────────────────────────────────────


describe("parseUnsubscribeHeader", () => {
	it("parses the bracketed https + mailto pair", () => {
		expect(parseUnsubscribeHeader(`<${TARGET}>, <${MAILTO}>`)).toEqual({
			httpsUrl: TARGET,
			mailto: MAILTO,
		});
	});

	it("parses bare, comma-separated entries and uppercase schemes", () => {
		expect(parseUnsubscribeHeader(`${TARGET}, ${MAILTO}`)).toEqual({
			httpsUrl: TARGET,
			mailto: MAILTO,
		});
		expect(parseUnsubscribeHeader(`<HTTPS://unsub.example.com/u>, <MAILTO:u@example.org>`)).toEqual({
			httpsUrl: "HTTPS://unsub.example.com/u",
			mailto: "MAILTO:u@example.org",
		});
	});

	it("keeps commas that live inside an entry", () => {
		const target = "https://unsub.example.com/u?a=1,2";
		expect(parseUnsubscribeHeader(`<${target}>, <${MAILTO}>`)).toEqual({
			httpsUrl: target,
			mailto: MAILTO,
		});
	});

	it("takes the first https target and the first mailto target", () => {
		expect(
			parseUnsubscribeHeader(
				`<${MAILTO}>, <https://one.example.com/u>, <https://two.example.com/u>`,
			),
		).toEqual({ httpsUrl: "https://one.example.com/u", mailto: MAILTO });
	});

	it("ignores a non-https web target and reports nulls for missing input", () => {
		expect(parseUnsubscribeHeader("<http://unsub.example.com/u>")).toEqual({
			httpsUrl: null,
			mailto: null,
		});
		expect(parseUnsubscribeHeader(null)).toEqual({ httpsUrl: null, mailto: null });
		expect(parseUnsubscribeHeader("")).toEqual({ httpsUrl: null, mailto: null });
		expect(parseUnsubscribeHeader(undefined)).toEqual({ httpsUrl: null, mailto: null });
	});
});


describe("isOneClickUnsubscribe", () => {
	it("matches the RFC 8058 marker case-insensitively", () => {
		expect(isOneClickUnsubscribe(MARKER)).toBe(true);
		expect(isOneClickUnsubscribe("list-unsubscribe=one-click")).toBe(true);
		expect(isOneClickUnsubscribe("LIST-UNSUBSCRIBE=ONE-CLICK")).toBe(true);
		expect(isOneClickUnsubscribe(" List-Unsubscribe = One-Click ")).toBe(true);
	});

	it("rejects anything else", () => {
		expect(isOneClickUnsubscribe(null)).toBe(false);
		expect(isOneClickUnsubscribe(undefined)).toBe(false);
		expect(isOneClickUnsubscribe("")).toBe(false);
		expect(isOneClickUnsubscribe("One-Click")).toBe(false);
		expect(isOneClickUnsubscribe("List-Unsubscribe=Two-Click")).toBe(false);
	});
});


// ── One-click POST ─────────────────────────────────────────────────


describe("sendOneClickUnsubscribe", () => {
	it("POSTs the one-click body with the form content type, through the guard", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));

		const result = await sendOneClickUnsubscribe(TARGET, fetchImpl);

		expect(result).toEqual({ ok: true, status: 204 });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const request = fetchImpl.mock.calls[0]![0] as Request;
		expect(request.method).toBe("POST");
		expect(request.url).toBe(TARGET);
		expect(request.headers.get("content-type")).toBe(
			"application/x-www-form-urlencoded",
		);
		expect(new TextDecoder().decode(await request.arrayBuffer())).toBe(
			"List-Unsubscribe=One-Click",
		);
		expect(request.redirect).toBe("manual");
	});

	it("uses the global fetch when no implementation is injected", async () => {
		const calls = captureFetch(() => new Response(null, { status: 200 }));

		const result = await sendOneClickUnsubscribe(TARGET);

		expect(result).toEqual({ ok: true, status: 200 });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.body).toBe("List-Unsubscribe=One-Click");
	});

	it("refuses a guarded URL without making a request", async () => {
		const fetchImpl = vi.fn<typeof fetch>();

		const result = await sendOneClickUnsubscribe("https://127.0.0.1/u", fetchImpl);

		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.error).toContain("IP literal");
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});


// ── MailboxDO mutator ──────────────────────────────────────────────


describe("MailboxDO.setUnsubscribed", () => {
	it("stamps unsubscribed_at and returns the updated row", async () => {
		const stub = stubFor("unsub-do@example.com");
		await seedEmail(stub, "do-1", {
			list_unsubscribe: `<${TARGET}>`,
			list_unsubscribe_post: MARKER,
		});
		expect(((await stub.getEmail("do-1")) as UnsubscribeRow | null)?.unsubscribed_at).toBeNull();

		const row = (await stub.setUnsubscribed(
			"do-1",
			"2026-01-02T03:04:05.000Z",
		)) as UnsubscribeRow | null;

		expect(row?.unsubscribed_at).toBe("2026-01-02T03:04:05.000Z");
		expect(row?.list_unsubscribe).toBe(`<${TARGET}>`);
		expect(
			((await stub.getEmail("do-1")) as UnsubscribeRow | null)?.unsubscribed_at,
		).toBe("2026-01-02T03:04:05.000Z");
	});

	it("returns null for an unknown id", async () => {
		const stub = stubFor("unsub-do-missing@example.com");
		expect(await stub.setUnsubscribed("nope", "2026-01-02T03:04:05.000Z")).toBeNull();
	});
});


// ── Route ──────────────────────────────────────────────────────────


async function postUnsubscribe(mailbox: string, id: string) {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/emails/${id}/unsubscribe`,
		{ method: "POST" },
	);
	return { status: res.status, body: (await res.json()) as UnsubscribeResponse };
}


describe("POST /api/v1/mailboxes/:mailboxId/emails/:id/unsubscribe", () => {
	it("unsubscribes end to end: a 2xx answer sets unsubscribed_at", async () => {
		const mailbox = "unsub-route@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, "route-1", {
			list_unsubscribe: `<${TARGET}>, <${MAILTO}>`,
			list_unsubscribe_post: MARKER,
		});
		const calls = captureFetch(() => new Response(null, { status: 200 }));

		const { status, body } = await postUnsubscribe(mailbox, "route-1");

		expect(status).toBe(200);
		expect(body.status).toBe("unsubscribed");
		expect(body.email?.unsubscribed_at).toEqual(expect.any(String));
		expect(body.email?.list_unsubscribe).toBe(`<${TARGET}>, <${MAILTO}>`);

		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call!.url).toBe(TARGET);
		expect(call!.request.method).toBe("POST");
		expect(call!.request.headers.get("content-type")).toBe(
			"application/x-www-form-urlencoded",
		);
		expect(call!.body).toBe("List-Unsubscribe=One-Click");
		expect(call!.request.redirect).toBe("manual");

		expect(
			((await stub.getEmail("route-1")) as UnsubscribeRow | null)?.unsubscribed_at,
		).toEqual(expect.any(String));
	});

	it("answers 502 and leaves unsubscribed_at unset when the endpoint fails", async () => {
		const mailbox = "unsub-route-500@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, "route-2", {
			list_unsubscribe: `<${TARGET}>`,
			list_unsubscribe_post: MARKER,
		});
		const calls = captureFetch(() => new Response("nope", { status: 500 }));

		const { status, body } = await postUnsubscribe(mailbox, "route-2");

		expect(status).toBe(502);
		expect(body.error).toContain("500");
		expect(calls).toHaveLength(1);
		expect(
			((await stub.getEmail("route-2")) as UnsubscribeRow | null)?.unsubscribed_at,
		).toBeNull();
	});

	it("answers 502 and makes no request when the guard rejects the stored URL", async () => {
		const mailbox = "unsub-route-guard@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, "route-3", {
			list_unsubscribe: "<https://127.0.0.1/u>",
			list_unsubscribe_post: MARKER,
		});
		const calls = captureFetch(() => new Response(null, { status: 200 }));

		const { status, body } = await postUnsubscribe(mailbox, "route-3");

		expect(status).toBe(502);
		expect(body.error).toContain("IP literal");
		expect(calls).toHaveLength(0);
		expect(
			((await stub.getEmail("route-3")) as UnsubscribeRow | null)?.unsubscribed_at,
		).toBeNull();
	});

	it("answers 400 when the header carries no https target", async () => {
		const mailbox = "unsub-route-mailto@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, "route-4", {
			list_unsubscribe: `<${MAILTO}>`,
			list_unsubscribe_post: MARKER,
		});
		const calls = captureFetch(() => new Response(null, { status: 200 }));

		const { status, body } = await postUnsubscribe(mailbox, "route-4");

		expect(status).toBe(400);
		expect(body.error).toContain("one-click");
		expect(calls).toHaveLength(0);
		expect(
			((await stub.getEmail("route-4")) as UnsubscribeRow | null)?.unsubscribed_at,
		).toBeNull();
	});

	it("answers 400 when the one-click marker is missing", async () => {
		const mailbox = "unsub-route-nomarker@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		await seedEmail(stub, "route-5", {
			list_unsubscribe: `<${TARGET}>`,
		});
		await seedEmail(stub, "route-6", {
			list_unsubscribe: `<${TARGET}>`,
			list_unsubscribe_post: "List-Unsubscribe=Two-Click",
		});
		const calls = captureFetch(() => new Response(null, { status: 200 }));

		expect((await postUnsubscribe(mailbox, "route-5")).status).toBe(400);
		expect((await postUnsubscribe(mailbox, "route-6")).status).toBe(400);
		expect(calls).toHaveLength(0);
	});

	it("answers 404 for an unknown email id", async () => {
		const mailbox = "unsub-route-404@example.com";
		await registerMailbox(mailbox);
		const calls = captureFetch(() => new Response(null, { status: 200 }));

		const { status, body } = await postUnsubscribe(mailbox, "missing-id");

		expect(status).toBe(404);
		expect(body.error).toBe("Email not found");
		expect(calls).toHaveLength(0);
	});
});
