import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_EMAIL_VIEW,
	htmlToPlainText,
	normalizeEmailViewMode,
	normalizeGlobalEmailViewSettings,
	resolveDefaultEmailView,
} from "../shared/email-view";
import { Folders } from "../shared/folders";


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


/** Register the mailbox record the API middleware checks before routing. */
async function registerMailbox(mailbox: string, settings: unknown = {}) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify(settings));
}


describe("htmlToPlainText", () => {
	it("returns an empty string for empty or blank input", () => {
		expect(htmlToPlainText("")).toBe("");
		expect(htmlToPlainText("   \n\t ")).toBe("");
	});


	it("drops tags and turns block elements into line breaks", () => {
		expect(htmlToPlainText("<p>Hello</p><p>World</p>")).toBe("Hello\nWorld");
		expect(htmlToPlainText("<div>line one</div><div>line two</div>")).toBe(
			"line one\nline two",
		);
		expect(htmlToPlainText("one<br>two<br/>three")).toBe("one\ntwo\nthree");
		expect(htmlToPlainText("<ul><li>a</li><li>b</li></ul>")).toBe("a\nb");
		expect(htmlToPlainText("<h1>Title</h1><p>Body <b>text</b></p>")).toBe(
			"Title\nBody text",
		);
	});


	it("keeps a blank line for a run of <br>", () => {
		expect(htmlToPlainText("A<br><br>B")).toBe("A\n\nB");
		expect(htmlToPlainText("A<br><br/><br />B")).toBe("A\n\nB");
	});


	it("decodes named and numeric entities in a single pass", () => {
		expect(htmlToPlainText("<p>Tom &amp; Jerry &lt;3 &hellip;&nbsp;end</p>")).toBe(
			"Tom & Jerry <3 … end",
		);
		expect(htmlToPlainText("&#8212; &#x1F600; &#39;")).toBe("— 😀 '");
		// Single pass: an escaped entity stays literal instead of double-decoding.
		expect(htmlToPlainText("&amp;lt; stays")).toBe("&lt; stays");
		// Unknown entities are left verbatim rather than dropped.
		expect(htmlToPlainText("&notreal;")).toBe("&notreal;");
	});


	it("keeps links as `label (href)`", () => {
		expect(
			htmlToPlainText('<p>See <a href="https://example.com/docs">the docs</a>.</p>'),
		).toBe("See the docs (https://example.com/docs).");
		// A link whose label already is the URL is not repeated.
		expect(
			htmlToPlainText('<a href="https://example.com">https://example.com</a>'),
		).toBe("https://example.com");
		// Unsafe schemes keep the label only.
		expect(htmlToPlainText('<a href="javascript:alert(1)">click</a>')).toBe(
			"click",
		);
		// An anchor without href keeps its text.
		expect(htmlToPlainText("<a>plain</a>")).toBe("plain");
		// Nested markup inside the label is stripped.
		expect(
			htmlToPlainText('<a href="https://x.test"><b>Bold</b> link</a>'),
		).toBe("Bold link (https://x.test)");
	});


	it("removes script and style content entirely", () => {
		expect(
			htmlToPlainText(
				'<p>Hi</p><script>alert("x")</script><style>p { color: red }</style><p>Bye</p>',
			),
		).toBe("Hi\nBye");
		expect(
			htmlToPlainText("<div>keep</div><script>\nmulti\nline()\n</script>"),
		).toBe("keep");
		// An unterminated script tag never leaks its body either.
		expect(htmlToPlainText("<p>keep</p><script>var x = 1;")).toBe("keep");
		expect(htmlToPlainText("<head><title>t</title></head><p>body</p>")).toBe(
			"body",
		);
	});


	it("collapses whitespace and trims the result", () => {
		expect(htmlToPlainText("<span>hello     world</span>")).toBe("hello world");
		expect(htmlToPlainText("<p>a</p>\n\n\n\n<p>b</p>")).toBe("a\nb");
		expect(htmlToPlainText("\t  <p>  padded  </p>  ")).toBe("padded");
		expect(htmlToPlainText("<div>a&nbsp;&nbsp;b</div>")).toBe("a b");
	});


	it("ignores comments", () => {
		expect(htmlToPlainText("<p>Hi<!-- hidden --> there</p>")).toBe("Hi there");
	});
});


describe("email view settings", () => {
	it("normalizes a single view mode value", () => {
		expect(normalizeEmailViewMode("html")).toBe("html");
		expect(normalizeEmailViewMode(" TEXT ")).toBe("text");
		expect(normalizeEmailViewMode("")).toBeUndefined();
		expect(normalizeEmailViewMode("   ")).toBeUndefined();
		expect(normalizeEmailViewMode(null)).toBeUndefined();
		expect(normalizeEmailViewMode("banana")).toBeUndefined();
		expect(normalizeEmailViewMode(7)).toBeUndefined();
	});


	it("resolves mailbox override, then app-wide setting, then the default", () => {
		expect(resolveDefaultEmailView()).toBe(DEFAULT_EMAIL_VIEW);
		expect(DEFAULT_EMAIL_VIEW).toBe("html");
		expect(resolveDefaultEmailView({}, {})).toBe("html");
		expect(resolveDefaultEmailView({ defaultEmailView: "text" }, {})).toBe("text");
		expect(resolveDefaultEmailView({}, { defaultEmailView: "text" })).toBe("text");
		expect(
			resolveDefaultEmailView(
				{ defaultEmailView: "text" },
				{ defaultEmailView: "html" },
			),
		).toBe("text");
		// Blank and null values inherit instead of pinning a mode.
		expect(
			resolveDefaultEmailView(
				{ defaultEmailView: null },
				{ defaultEmailView: "text" },
			),
		).toBe("text");
		expect(
			resolveDefaultEmailView({ defaultEmailView: "  " }, { defaultEmailView: "text" }),
		).toBe("text");
		expect(resolveDefaultEmailView({ defaultEmailView: "nope" }, {})).toBe("html");
	});


	it("normalizes the app-wide payload, dropping blanks and junk", () => {
		expect(normalizeGlobalEmailViewSettings({ defaultEmailView: "text" })).toEqual({
			defaultEmailView: "text",
		});
		expect(normalizeGlobalEmailViewSettings({ defaultEmailView: null })).toEqual({});
		expect(normalizeGlobalEmailViewSettings({ defaultEmailView: "nope" })).toEqual({});
		expect(normalizeGlobalEmailViewSettings(null)).toEqual({});
	});
});


describe("MailboxDO body_text", () => {
	it("stores the text/plain part and reads it back with the HTML body", async () => {
		const stub = stubFor("bodytext-roundtrip@example.com");
		await stub.createEmail(
			Folders.INBOX,
			{
				id: "bt-1",
				subject: "Both parts",
				sender: "sender@example.org",
				recipient: "bodytext-roundtrip@example.com",
				date: new Date().toISOString(),
				body: "<p>Hello <b>HTML</b></p>",
				body_text: "Hello plain text",
				in_reply_to: null,
				email_references: null,
				thread_id: "bt-1",
			},
			[],
		);


		const email = await stub.getEmail("bt-1");
		expect(email).not.toBeNull();
		expect(email?.body_text).toBe("Hello plain text");
		// The HTML body is untouched by the new column.
		expect(email?.body).toBe("<p>Hello <b>HTML</b></p>");


		// List rows stay lean: the message panel reads the detail endpoint
		// (which selects every column), so a list response must not ship
		// whole bodies — body_text included.
		const listed = (await stub.getEmails({ folder: Folders.INBOX })) as {
			id: string;
			body_text?: string | null;
		}[];
		expect(listed.find((row) => row.id === "bt-1")?.body_text).toBeUndefined();
	});


	it("stores NULL when a message has no text/plain part", async () => {
		const stub = stubFor("bodytext-null@example.com");
		await stub.createEmail(
			Folders.INBOX,
			{
				id: "bt-null",
				subject: "HTML only",
				sender: "sender@example.org",
				recipient: "bodytext-null@example.com",
				date: new Date().toISOString(),
				body: "<p>only html</p>",
				in_reply_to: null,
				email_references: null,
				thread_id: "bt-null",
			},
			[],
		);


		const email = await stub.getEmail("bt-null");
		expect(email?.body_text).toBeNull();


		const stored = await runInDurableObject(stub, async (_instance, state) => {
			const rows = [
				...state.storage.sql.exec(
					"SELECT body_text FROM emails WHERE id = ?1",
					"bt-null",
				),
			];
			return rows[0] as { body_text: string | null };
		});
		expect(stored.body_text).toBeNull();
	});
});


describe("email view routes", () => {
	it("serves body_text on the email detail endpoint", async () => {
		const mailbox = "bodytext-detail@example.com";
		await registerMailbox(mailbox);
		await stubFor(mailbox).createEmail(
			Folders.INBOX,
			{
				id: "detail-1",
				subject: "Detail",
				sender: "sender@example.org",
				recipient: mailbox,
				date: new Date().toISOString(),
				body: "<p>html body</p>",
				body_text: "plain body",
				in_reply_to: null,
				email_references: null,
				thread_id: "detail-1",
			},
			[],
		);


		const res = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}/emails/detail-1`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { body: string; body_text: string | null };
		expect(body.body_text).toBe("plain body");
		expect(body.body).toBe("<p>html body</p>");
	});


	it("round-trips the app-wide default view through /api/v1/email-view", async () => {
		const put = await SELF.fetch("http://example.com/api/v1/email-view", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ defaultEmailView: "text" }),
		});
		expect(put.status).toBe(200);
		expect((await put.json()) as unknown).toEqual({ defaultEmailView: "text" });


		const get = await SELF.fetch("http://example.com/api/v1/email-view");
		expect(get.status).toBe(200);
		expect((await get.json()) as unknown).toEqual({ defaultEmailView: "text" });
	});


	it("rejects an unknown default view and accepts a blank one", async () => {
		const bad = await SELF.fetch("http://example.com/api/v1/email-view", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ defaultEmailView: "banana" }),
		});
		expect(bad.status).toBe(400);


		const blank = await SELF.fetch("http://example.com/api/v1/email-view", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(blank.status).toBe(200);
		expect((await blank.json()) as unknown).toEqual({});
	});


	it("normalizes the per-mailbox override on the mailbox PUT route", async () => {
		const mailbox = "bodytext-settings@example.com";
		await registerMailbox(mailbox);


		const put = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}`,
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					settings: { fromName: "Body Text", defaultEmailView: "TEXT" },
				}),
			},
		);
		expect(put.status).toBe(200);
		const saved = (await put.json()) as { settings: { defaultEmailView: string } };
		expect(saved.settings.defaultEmailView).toBe("text");


		// Junk falls back to the explicit "inherit" value, never a broken mode.
		const junk = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${mailbox}`,
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ settings: { defaultEmailView: "banana" } }),
			},
		);
		expect(junk.status).toBe(200);
		const normalized = (await junk.json()) as {
			settings: { defaultEmailView: string | null };
		};
		expect(normalized.settings.defaultEmailView).toBeNull();
	});
});
