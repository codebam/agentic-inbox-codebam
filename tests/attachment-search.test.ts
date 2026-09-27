// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Attachment-content search (migration 36, workers/lib/attachment-text.ts).
 *
 * Covers, in order: the pure extraction helpers (local decode, the character
 * and byte caps, invalid UTF-8, NUL stripping, binary/rich-type refusal, the
 * rich-type routing predicate), the AI conversion's contract through a fake
 * env seam, the Durable Object store's own clamps, the receive-path round
 * trip through the real inbound handler and the real search methods (a term
 * matches the message OR its attachment text, and countSearchResults agrees),
 * every email-delete path dropping the text with its message, and the import
 * path storing locally extracted text only.
 *
 * The pool cannot run Workers AI — `env.AI` answers "Binding AI needs to be
 * run remotely" — so the conversion itself is exercised against a fake
 * `AI.toMarkdown` (the function takes env as a parameter), and the ingest
 * tests pin the opposite property: the local path never reaches for AI. A
 * text attachment must produce no conversion attempt at all, which the
 * console capture below can see because a failed conversion logs.
 *
 * Nothing here sends mail.
 */

import {
	SELF,
	createExecutionContext,
	runDurableObjectAlarm,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import {
	MAX_ATTACHMENT_TEXT_CHARS,
	MAX_ATTACHMENT_TEXT_INPUT_BYTES,
	MAX_ATTACHMENT_TEXT_ROWS,
	extractAttachmentText,
	extractAttachmentTextViaAi,
	needsMarkdownConversion,
} from "../workers/lib/attachment-text";
import { encodeBase64Bytes } from "../workers/lib/attachments";
import worker from "../workers/app";
import type { Env } from "../workers/types";


const encoder = new TextEncoder();

/** A token that lives only inside the attachment's text. */
const TOKEN = "attachcontenttoken";
/** A token that lives only in the message body. */
const BODY_TOKEN = "bodytokenonly";
/** A token that lives nowhere. */
const MISSING_TOKEN = "nowheretoken";
/** A token only the import-path message carries. */
const IMPORT_TOKEN = "importfiletoken";


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


/** Register the mailbox record the receive path and the routes check. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(
		`mailboxes/${mailbox}.json`,
		// Both AI features off: the deliveries below must not reach the model
		// for anything else, so a conversion attempt could only come from the
		// attachment-text path this file tests.
		JSON.stringify({ categorization: { enabled: false }, items: { enabled: false } }),
	);
}


/** Extract result ids (rows come back ordered by date DESC). */
function ids(rows: unknown[]): string[] {
	return (rows as { id: string }[]).map((row) => row.id);
}


/** Raw attachment_text rows of one message, read straight from the DO. */
async function storedTextRows(stub: ReturnType<typeof stubFor>, emailId: string) {
	return (await runInDurableObject(stub, async (_instance, state) => [
		...state.storage.sql.exec(
			`SELECT attachment_id, email_id, filename, mimetype, text
			 FROM attachment_text WHERE email_id = ?1 ORDER BY filename`,
			emailId,
		),
	])) as unknown as {
		attachment_id: string;
		email_id: string;
		filename: string;
		mimetype: string;
		text: string;
	}[];
}


/**
 * Capture console output while `fn` runs, restoring the originals afterwards.
 * Every test using this logs a probe line first and asserts it was captured,
 * so a run where the swap silently failed cannot pass vacuously.
 */
async function withCapturedConsole<T>(
	fn: () => Promise<T>,
): Promise<{ result: T; logs: string[] }> {
	const logs: string[] = [];
	const originalLog = console.log;
	const originalError = console.error;
	const record = (...args: unknown[]) => {
		logs.push(args.map((arg) => String(arg)).join(" "));
	};
	console.log = record;
	console.error = record;
	try {
		const result = await fn();
		return { result, logs };
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}
}


/** No captured line mentions the AI conversion — the local path never tried it. */
function expectNoConversionAttempt(logs: string[]) {
	expect(logs.filter((line) => line.includes("Attachment conversion"))).toEqual([]);
}


/** A plain message with one text attachment holding TOKEN, as postal-mime parses it. */
function rawTokenMessage(mailbox: string) {
	return [
		"From: Sender <sender@example.org>",
		`To: ${mailbox}`,
		"Subject: Notes enclosed",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="BOUNDARY-AS"',
		"",
		"--BOUNDARY-AS",
		'Content-Type: text/plain; charset="utf-8"',
		"",
		`See the notes. ${BODY_TOKEN} lives in this body.`,
		"",
		"--BOUNDARY-AS",
		'Content-Type: text/plain; charset="utf-8"; name="notes.txt"',
		"Content-Transfer-Encoding: base64",
		'Content-Disposition: attachment; filename="notes.txt"',
		"",
		encodeBase64Bytes(encoder.encode(`The ${TOKEN} is in this file (ref zq).`)),
		"--BOUNDARY-AS--",
		"",
	].join("\r\n");
}


/** Deliver one raw message through the worker's inbound handler. */
async function deliverMessage(raw: string, mailbox: string) {
	const event = {
		from: "sender@example.org",
		to: mailbox,
		raw: new Response(raw).body,
		rawSize: raw.length,
	} as unknown as Parameters<typeof worker.email>[0];

	const ctx = createExecutionContext();
	await worker.email(event, env, ctx);
	await waitOnExecutionContext(ctx);
}


/** Deliver the token message and return the stored message's id. */
async function deliverTokenMessage(mailbox: string): Promise<string> {
	await registerMailbox(mailbox);
	await deliverMessage(rawTokenMessage(mailbox), mailbox);
	const inbox = (await stubFor(mailbox).getEmails({ folder: Folders.INBOX })) as {
		id: string;
	}[];
	if (inbox.length !== 1) {
		throw new Error(`expected one delivered message, got ${inbox.length}`);
	}
	return inbox[0]!.id;
}


/** The token search's verdict from both real search methods (they share a builder). */
async function tokenVerdict(mailbox: string): Promise<{ found: string[]; count: number }> {
	const stub = stubFor(mailbox);
	return {
		found: ids(await stub.searchEmails({ query: TOKEN })),
		count: await stub.countSearchResults({ query: TOKEN }),
	};
}


describe("extractAttachmentText", () => {
	it("decodes the text-ish types locally", () => {
		const notes = encoder.encode("Quarterly projections look healthy");
		expect(extractAttachmentText("text/plain", "notes.txt", notes)).toBe(
			"Quarterly projections look healthy",
		);
		// Parameters are dropped before the comparison, whatever the sender wrote.
		expect(extractAttachmentText("text/plain; charset=iso-8859-1", "notes.txt", notes)).toBe(
			"Quarterly projections look healthy",
		);
		expect(extractAttachmentText("application/json", "data.json", encoder.encode('{"ok":true}'))).toBe('{"ok":true}');
		expect(extractAttachmentText("application/xml", "feed.xml", encoder.encode("<a/>"))).toBe("<a/>");
		expect(extractAttachmentText("text/csv", "rows.csv", encoder.encode("a,b"))).toBe("a,b");
		expect(
			extractAttachmentText("application/vnd.acme+markdown", "readme.md", encoder.encode("# Hi")),
		).toBe("# Hi");
		expect(extractAttachmentText("application/vnd.acme+yaml", "conf.yaml", encoder.encode("a: 1"))).toBe("a: 1");
	});


	it("refuses binary and rich types locally", () => {
		expect(extractAttachmentText("image/png", "shot.png", new Uint8Array([0x89, 0x50]))).toBeNull();
		expect(extractAttachmentText("application/octet-stream", "blob.bin", new Uint8Array([1, 2, 3]))).toBeNull();
		// A PDF is the AI conversion's job: the local extractor answers null
		// and needsMarkdownConversion routes the type to the conversion path.
		expect(extractAttachmentText("application/pdf", "paper.pdf", encoder.encode("%PDF-1.4"))).toBeNull();
		expect(needsMarkdownConversion("application/pdf")).toBe(true);
		expect(needsMarkdownConversion("text/html")).toBe(true);
		expect(needsMarkdownConversion("application/pdf; charset=binary")).toBe(true);
		expect(needsMarkdownConversion("TEXT/HTML")).toBe(true);
		expect(needsMarkdownConversion("text/plain")).toBe(false);
		expect(needsMarkdownConversion("image/png")).toBe(false);
	});


	it("decodes HTML locally too, though the receive path prefers the conversion", () => {
		expect(extractAttachmentText("text/html", "page.html", encoder.encode("<p>Hi</p>"))).toBe("<p>Hi</p>");
	});


	it("caps the stored text at MAX_ATTACHMENT_TEXT_CHARS", () => {
		const long = "a".repeat(MAX_ATTACHMENT_TEXT_CHARS + 500);
		const text = extractAttachmentText("text/plain", "long.txt", encoder.encode(long));
		expect(text).toHaveLength(MAX_ATTACHMENT_TEXT_CHARS);
	});


	it("falls back to replacement characters on invalid UTF-8", () => {
		// "foo" + an invalid 0xFF byte + "bar": the valid runs survive and the
		// bad byte becomes U+FFFD instead of dropping the whole file.
		const bytes = new Uint8Array([0x66, 0x6f, 0x6f, 0xff, 0x62, 0x61, 0x72]);
		expect(extractAttachmentText("text/plain", "mixed.txt", bytes)).toBe("foo\uFFFDbar");
	});


	it("strips NULs so a bound parameter cannot truncate the text", () => {
		expect(extractAttachmentText("text/plain", "nul.txt", encoder.encode("abc\u0000def"))).toBe("abcdef");
	});


	it("answers null for empty or whitespace-only text", () => {
		expect(extractAttachmentText("text/plain", "empty.txt", new Uint8Array())).toBeNull();
		expect(extractAttachmentText("text/plain", "blank.txt", encoder.encode("  \n\t "))).toBeNull();
		expect(extractAttachmentText("text/plain", "nuls.txt", encoder.encode("\u0000\u0000"))).toBeNull();
	});


	it("skips an input over the size cap and logs the skip once", async () => {
		const { result, logs } = await withCapturedConsole(async () =>
			extractAttachmentText(
				"text/plain",
				"huge.txt",
				new Uint8Array(MAX_ATTACHMENT_TEXT_INPUT_BYTES + 1),
			),
		);
		expect(result).toBeNull();
		expect(logs.filter((line) => line.includes("Attachment text skipped for huge.txt"))).toHaveLength(1);
	});
});


describe("extractAttachmentTextViaAi (fake seam — the pool cannot run AI)", () => {
	it("converts through the binding and joins the non-error results", async () => {
		const calls: { name: string; type: string }[] = [];
		const fakeEnv = {
			AI: {
				toMarkdown: async (files: { name: string; blob: Blob }[]) => {
					for (const file of files) calls.push({ name: file.name, type: file.blob.type });
					return [
						{ id: "1", name: "page.html", mimeType: "text/html", format: "markdown", tokens: 3, data: "# Heading" },
						{ id: "2", name: "page.html", mimeType: "text/html", format: "error", error: "conversion failed" },
						{ id: "3", name: "page.html", mimeType: "text/html", format: "text", tokens: 3, data: "Body text" },
					];
				},
			},
		} as unknown as Env;

		const text = await extractAttachmentTextViaAi(
			fakeEnv,
			"page.html",
			encoder.encode("<h1>Heading</h1>"),
			"text/html",
		);
		// One document, named, with the declared type on the blob.
		expect(calls).toEqual([{ name: "page.html", type: "text/html" }]);
		// The error entry is skipped; markdown and text are joined in order.
		expect(text).toBe("# Heading\nBody text");
	});


	it("caps the converted text at the same character cap", async () => {
		const fakeEnv = {
			AI: {
				toMarkdown: async () => [
					{
						id: "1",
						name: "big.pdf",
						mimeType: "application/pdf",
						format: "markdown",
						tokens: 1,
						data: "x".repeat(MAX_ATTACHMENT_TEXT_CHARS + 500),
					},
				],
			},
		} as unknown as Env;
		const text = await extractAttachmentTextViaAi(fakeEnv, "big.pdf", new Uint8Array([1]), "application/pdf");
		expect(text).toHaveLength(MAX_ATTACHMENT_TEXT_CHARS);
	});


	it("never throws and answers null when the conversion fails", async () => {
		const fakeEnv = {
			AI: {
				toMarkdown: async () => {
					throw new Error("model unavailable");
				},
			},
		} as unknown as Env;
		const { result, logs } = await withCapturedConsole(async () =>
			extractAttachmentTextViaAi(fakeEnv, "broken.pdf", new Uint8Array([1]), "application/pdf"),
		);
		expect(result).toBeNull();
		expect(logs.filter((line) => line.includes("Attachment conversion unavailable for broken.pdf"))).toHaveLength(1);
	});


	it("skips an oversized input without calling the binding", async () => {
		let calls = 0;
		const fakeEnv = {
			AI: {
				toMarkdown: async () => {
					calls++;
					return [];
				},
			},
		} as unknown as Env;
		const text = await extractAttachmentTextViaAi(
			fakeEnv,
			"huge.pdf",
			new Uint8Array(MAX_ATTACHMENT_TEXT_INPUT_BYTES + 1),
			"application/pdf",
		);
		expect(text).toBeNull();
		expect(calls).toBe(0);
	});
});


describe("MailboxDO.storeAttachmentText bounds", () => {
	it("clamps a batch to MAX_ATTACHMENT_TEXT_ROWS rows and the text cap, upserting by id", async () => {
		const mailbox = "attachment-search-bounds@example.com";
		const stub = stubFor(mailbox);

		const rows = Array.from({ length: MAX_ATTACHMENT_TEXT_ROWS + 5 }, (_, index) => ({
			attachment_id: `bound-att-${index}`,
			email_id: "bound-email",
			filename: "notes.txt",
			mimetype: "text/plain",
			text: `bound token ${index}`,
		}));
		expect(await stub.storeAttachmentText(rows)).toBe(MAX_ATTACHMENT_TEXT_ROWS);
		expect(await storedTextRows(stub, "bound-email")).toHaveLength(MAX_ATTACHMENT_TEXT_ROWS);

		// A text over the cap is stored capped, and re-storing replaces the
		// row instead of appending a second one.
		await stub.storeAttachmentText([
			{
				attachment_id: "bound-att-0",
				email_id: "bound-email",
				filename: "notes.txt",
				mimetype: "text/plain",
				text: "y".repeat(MAX_ATTACHMENT_TEXT_CHARS + 100),
			},
		]);
		const replaced = await storedTextRows(stub, "bound-email");
		expect(replaced).toHaveLength(MAX_ATTACHMENT_TEXT_ROWS);
		expect(replaced.find((row) => row.attachment_id === "bound-att-0")?.text).toHaveLength(
			MAX_ATTACHMENT_TEXT_CHARS,
		);
	});
});


describe("attachment text search (receive path round trip)", () => {
	it("finds a message by a token that exists only in its attachment", async () => {
		const mailbox = "attachment-search-inbound@example.com";
		const stub = stubFor(mailbox);

		const { logs } = await withCapturedConsole(async () => {
			console.log("capture probe");
			await deliverTokenMessage(mailbox);
		});
		expect(logs.some((line) => line.includes("capture probe"))).toBe(true);
		// A text attachment is decoded locally: no conversion was attempted,
		// which the capture would show because a failed conversion logs.
		expectNoConversionAttempt(logs);

		const inbox = (await stub.getEmails({ folder: Folders.INBOX })) as { id: string }[];
		expect(inbox).toHaveLength(1);
		const emailId = inbox[0]!.id;

		// The body token and the attachment token both match, through their
		// own indexes, and countSearchResults agrees with searchEmails.
		expect(ids(await stub.searchEmails({ query: BODY_TOKEN }))).toEqual([emailId]);
		expect(await stub.countSearchResults({ query: BODY_TOKEN })).toBe(1);
		expect(await tokenVerdict(mailbox)).toEqual({ found: [emailId], count: 1 });

		// The words are ANDed across the two indexes: one term matches the
		// message, the other its attachment, and the message still matches.
		expect(ids(await stub.searchEmails({ query: `${BODY_TOKEN} ${TOKEN}` }))).toEqual([emailId]);
		expect(await stub.countSearchResults({ query: `${BODY_TOKEN} ${TOKEN}` })).toBe(1);

		// A token that exists nowhere matches nothing, and the count agrees.
		expect(ids(await stub.searchEmails({ query: MISSING_TOKEN }))).toEqual([]);
		expect(await stub.countSearchResults({ query: MISSING_TOKEN })).toBe(0);

		// One- and two-character terms stay on the message-columns LIKE path:
		// the "zq" run exists only in the attachment text (and nowhere in the
		// message's own columns), so it is not found — the documented boundary
		// of the trigram index, not a bug.
		expect(ids(await stub.searchEmails({ query: "zq" }))).toEqual([]);

		// The stored row is the attachment's own text, decoded locally.
		const rows = await storedTextRows(stub, emailId);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.filename).toBe("notes.txt");
		expect(rows[0]!.mimetype).toBe("text/plain");
		expect(rows[0]!.text).toBe(`The ${TOKEN} is in this file (ref zq).`);
	});


	it("removes the text with the message: the token stops matching", async () => {
		const mailbox = "attachment-search-delete@example.com";
		const stub = stubFor(mailbox);
		const emailId = await deliverTokenMessage(mailbox);
		expect(await tokenVerdict(mailbox)).toEqual({ found: [emailId], count: 1 });

		expect(await stub.deleteEmail(emailId)).not.toBeNull();

		// No row outlives the message, and the FTS triggers dropped its
		// postings with it — from the search results and the count alike.
		expect(await storedTextRows(stub, emailId)).toEqual([]);
		expect(await tokenVerdict(mailbox)).toEqual({ found: [], count: 0 });
	});


	it("emptyTrash drops attachment text with the purged messages", async () => {
		const mailbox = "attachment-search-emptied@example.com";
		const stub = stubFor(mailbox);
		const emailId = await deliverTokenMessage(mailbox);

		await stub.trashEmails([emailId]);
		const emptied = await stub.emptyTrash();
		expect(emptied.purged).toBe(1);

		expect(await storedTextRows(stub, emailId)).toEqual([]);
		expect(await tokenVerdict(mailbox)).toEqual({ found: [], count: 0 });
	});


	it("purgeTrashedBefore drops attachment text with the expired messages", async () => {
		const mailbox = "attachment-search-retention@example.com";
		const stub = stubFor(mailbox);
		const emailId = await deliverTokenMessage(mailbox);

		await stub.trashEmails([emailId]);
		// A cutoff in the future expires everything with a trashed_at stamp.
		const purged = await stub.purgeTrashedBefore(new Date(Date.now() + 60 * 60 * 1000).toISOString());
		expect(purged.purged).toBe(1);

		expect(await storedTextRows(stub, emailId)).toEqual([]);
		expect(await tokenVerdict(mailbox)).toEqual({ found: [], count: 0 });
	});


	it("keeps a working attachment index after the mailbox purge path", async () => {
		const mailbox = "attachment-search-purge@example.com";
		const stub = stubFor(mailbox);
		const seed = async (emailId: string, attachmentId: string, text: string) => {
			await stub.createEmail(
				Folders.INBOX,
				{
					id: emailId,
					subject: "Seeded",
					sender: "purge@example.org",
					recipient: mailbox,
					date: "2026-01-02T10:00:00.000Z",
					body: "<p>no token in this body</p>",
					thread_id: emailId,
				},
				[],
			);
			await stub.storeAttachmentText([
				{ attachment_id: attachmentId, email_id: emailId, filename: "notes.txt", mimetype: "text/plain", text },
			]);
		};

		await seed("purge-email-1", "purge-att-1", "prepurgeattachtoken");
		expect(ids(await stub.searchEmails({ query: "prepurgeattachtoken" }))).toEqual(["purge-email-1"]);

		// purgeAll empties storage and re-applies mailboxMigrations: the
		// table, its FTS index and the sync triggers have to come back with
		// the rest of the schema, or the live instance keeps serving searches
		// against tables that no longer exist.
		await stub.purgeAll();
		expect(ids(await stub.searchEmails({ query: "prepurgeattachtoken" }))).toEqual([]);

		await seed("purge-email-2", "purge-att-2", "postpurgeattachtoken");
		expect(ids(await stub.searchEmails({ query: "postpurgeattachtoken" }))).toEqual(["purge-email-2"]);
		// The delete hook still works on the re-created schema.
		await stub.deleteEmail("purge-email-2");
		expect(ids(await stub.searchEmails({ query: "postpurgeattachtoken" }))).toEqual([]);
	});


	it("bulkDeleteEmails drops attachment text with the deleted messages", async () => {
		const mailbox = "attachment-search-bulk@example.com";
		const stub = stubFor(mailbox);
		const emailId = await deliverTokenMessage(mailbox);

		await stub.bulkDeleteEmails([emailId]);

		expect(await storedTextRows(stub, emailId)).toEqual([]);
		expect(await tokenVerdict(mailbox)).toEqual({ found: [], count: 0 });
	});
});


describe("import path stores local text only", () => {
	it("extracts a text attachment locally, never through AI, and skips the PDF", async () => {
		const mailbox = "attachment-search-import@example.com";
		await registerMailbox(mailbox);

		const eml = [
			"From: dave@example.org",
			`To: ${mailbox}`,
			"Date: 2026-09-05T08:00:00.000Z",
			"Subject: Imported notes",
			"Message-ID: <attachment-search-import-1@example.org>",
			"MIME-Version: 1.0",
			'Content-Type: multipart/mixed; boundary="b1"',
			"",
			"--b1",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"Body of the imported message.",
			"--b1",
			'Content-Type: text/plain; charset=utf-8; name="imported-notes.txt"',
			"Content-Transfer-Encoding: base64",
			'Content-Disposition: attachment; filename="imported-notes.txt"',
			"",
			encodeBase64Bytes(encoder.encode(`Imported ${IMPORT_TOKEN} lives here.`)),
			"--b1",
			'Content-Type: application/pdf; name="paper.pdf"',
			"Content-Transfer-Encoding: base64",
			'Content-Disposition: attachment; filename="paper.pdf"',
			"",
			encodeBase64Bytes(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])),
			"--b1--",
			"",
		].join("\r\n");

		const { result, logs } = await withCapturedConsole(async () => {
			console.log("capture probe");
			const res = await SELF.fetch(
				`http://example.com/api/v1/mailboxes/${mailbox}/import?filename=${encodeURIComponent("notes.eml")}`,
				{ method: "POST", body: eml },
			);
			return { status: res.status, body: (await res.json()) as { job?: { id: string } } };
		});
		expect(result.status).toBe(202);
		expect(result.body.job?.id).toBeDefined();
		expect(logs.some((line) => line.includes("capture probe"))).toBe(true);
		// The import path is storage-only: no conversion was ever attempted,
		// and the PDF got no text row because only the local extractor ran.
		expectNoConversionAttempt(logs);

		const stub = stubFor(mailbox);
		for (let runs = 0; runs < 50; runs++) {
			if (!(await runDurableObjectAlarm(stub))) break;
		}

		const inbox = (await stub.getEmails({ folder: Folders.INBOX })) as { id: string }[];
		expect(inbox).toHaveLength(1);
		const rows = await storedTextRows(stub, inbox[0]!.id);
		expect(rows.map((row) => row.filename)).toEqual(["imported-notes.txt"]);
		expect(rows[0]!.text).toBe(`Imported ${IMPORT_TOKEN} lives here.`);

		expect(ids(await stub.searchEmails({ query: IMPORT_TOKEN }))).toEqual([inbox[0]!.id]);
		expect(await stub.countSearchResults({ query: IMPORT_TOKEN })).toBe(1);
	});
});
