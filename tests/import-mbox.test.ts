// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { SELF, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { attachmentR2Key, encodeBase64Bytes } from "../workers/lib/attachments";
import { importJobR2Key, type ImportJobRow } from "../workers/lib/mbox-import";


type Stub = ReturnType<typeof stubFor>;


/** One stored message row, as the export RPC returns it. */
interface ExportRow {
	id: string;
	sender: string | null;
	recipient: string | null;
	cc: string | null;
	date: string | null;
	subject: string | null;
	message_id: string | null;
	body: string | null;
	attachments: { filename: string; mimetype: string; size: number }[];
}


/** Raw `import_jobs` columns, read straight from the Durable Object. */
interface ImportJobRawRow {
	id: string;
	filename: string;
	r2_key: string;
	size: number;
	cursor: number;
	status: string;
	imported: number;
	skipped: number;
	failed: number;
	last_error: string | null;
	created_at: string;
	updated_at: string;
}


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


/** Register the mailbox record the API middleware checks before routing. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(
		`mailboxes/${mailbox}.json`,
		JSON.stringify({ categorization: { enabled: false } }),
	);
}


/** Seed one stored message (and its attachment bytes) through createEmail. */
async function seedEmail(
	mailbox: string,
	email: {
		id: string;
		subject: string;
		body: string;
		sender?: string;
		recipient?: string;
		date?: string;
		message_id?: string | null;
		cc?: string | null;
	},
	attachments: { id: string; filename: string; mimetype: string; content: Uint8Array }[] = [],
) {
	for (const attachment of attachments) {
		await env.BUCKET.put(
			attachmentR2Key({
				email_id: email.id,
				id: attachment.id,
				filename: attachment.filename,
			}),
			attachment.content,
		);
	}
	await stubFor(mailbox).createEmail(
		Folders.INBOX,
		{
			id: email.id,
			subject: email.subject,
			sender: email.sender ?? "sender@example.org",
			recipient: email.recipient ?? mailbox,
			date: email.date ?? new Date().toISOString(),
			body: email.body,
			cc: email.cc ?? null,
			message_id: email.message_id ?? null,
			in_reply_to: null,
			email_references: null,
			thread_id: email.id,
		},
		attachments.map((attachment) => ({
			id: attachment.id,
			email_id: email.id,
			filename: attachment.filename,
			mimetype: attachment.mimetype,
			size: attachment.content.byteLength,
			content_id: null,
			disposition: "attachment",
		})),
	);
}


/** GET the mailbox's mbox export through the real route. */
async function exportMbox(mailbox: string): Promise<string> {
	const res = await SELF.fetch(`http://example.com/api/v1/mailboxes/${mailbox}/export`);
	expect(res.status).toBe(200);
	return res.text();
}


/** Normalise file bytes for File/BodyInit (keeps the generic ArrayBuffer form). */
function toBody(bytes: Uint8Array | string): string | Uint8Array<ArrayBuffer> {
	return typeof bytes === "string" ? bytes : new Uint8Array(bytes);
}


/** POST one file to the import route as multipart/form-data (field `file`). */
async function importMultipart(mailbox: string, filename: string, bytes: Uint8Array | string) {
	const form = new FormData();
	form.append("file", new File([toBody(bytes)], filename, { type: "application/mbox" }));
	const res = await SELF.fetch(`http://example.com/api/v1/mailboxes/${mailbox}/import`, {
		method: "POST",
		body: form,
	});
	return {
		status: res.status,
		body: (await res.json()) as { job?: ImportJobRow; error?: string },
	};
}


/** POST one file as the raw request body with a `filename` query parameter. */
async function importRawBody(mailbox: string, filename: string, bytes: Uint8Array | string) {
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/import?filename=${encodeURIComponent(filename)}`,
		{ method: "POST", body: bytes },
	);
	return {
		status: res.status,
		body: (await res.json()) as { job?: ImportJobRow; error?: string },
	};
}


/** The mailbox's import jobs as the route reports them, newest first. */
async function listJobs(mailbox: string): Promise<ImportJobRow[]> {
	const res = await SELF.fetch(`http://example.com/api/v1/mailboxes/${mailbox}/import`);
	expect(res.status).toBe(200);
	return ((await res.json()) as { jobs: ImportJobRow[] }).jobs;
}


/** Every stored message of the mailbox, via the Durable Object's own read. */
async function storedMessages(mailbox: string): Promise<ExportRow[]> {
	const page = await stubFor(mailbox).listEmailsForExport({ page: 1, limit: 100 });
	return page.emails as ExportRow[];
}


/**
 * Run the mailbox alarm until nothing is scheduled any more. The import drain
 * re-arms immediately while a job still has bytes left, so a small file
 * finishes in one or two wakes; the bound turns a stuck job into a test
 * failure rather than a hang.
 */
async function drainAlarm(stub: Stub) {
	for (let runs = 0; runs < 50; runs++) {
		if (!(await runDurableObjectAlarm(stub))) return runs;
	}
	throw new Error("the alarm kept re-arming; the import never finished");
}


/** Force one alarm run now, whether or not one is already scheduled. */
async function forceAlarm(stub: Stub): Promise<boolean> {
	// A minute out: an alarm due right now is fired by the environment on its
	// own, and would be gone before the manual run could see it.
	await runInDurableObject(stub, async (_instance, state) => {
		await state.storage.setAlarm(Date.now() + 60_000);
	});
	return runDurableObjectAlarm(stub);
}


const originalFetch = globalThis.fetch;

/**
 * Run `fn` with globalThis.fetch recording every call, and restore the
 * original afterwards. Returns fn's result plus the recorded call targets.
 */
async function withFetchRecorder<T>(
	fn: () => Promise<T>,
): Promise<{ result: T; calls: string[] }> {
	const calls: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		calls.push(
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url,
		);
		return new Response("ok");
	}) as typeof fetch;
	try {
		return { result: await fn(), calls };
	} finally {
		globalThis.fetch = originalFetch;
	}
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});


describe("mbox/EML import", () => {
	it("round-trips an exported mailbox into a second mailbox", async () => {
		const source = "import-src@example.com";
		const target = "import-dst@example.com";
		await registerMailbox(source);
		await registerMailbox(target);

		await seedEmail(source, {
			id: "src-1",
			subject: "First message",
			sender: "alice@example.org",
			date: "2026-09-01T10:00:00.000Z",
			body: "Hello from the first message.",
			message_id: "first@example.org",
		});
		// A body line that begins "From " is exported quoted (RFC 4155) and
		// must come back unquoted.
		await seedEmail(source, {
			id: "src-2",
			subject: "Second message",
			sender: "bob@example.org",
			date: "2026-09-02T11:30:00.000Z",
			body: "Second body.\nFrom the beginning it looked fine.",
			message_id: "second@example.org",
		});
		// No stored Message-ID: the record omits the header and the import
		// must not invent one (and must not deduplicate it away).
		await seedEmail(source, {
			id: "src-3",
			subject: "Third message",
			sender: "carol@example.org",
			date: "2026-09-03T09:15:00.000Z",
			body: "Third body.",
			message_id: null,
		});
		// One stored attachment. The mbox export inlines no attachment bytes
		// (the mailbox never stores the wire source), so the source's file
		// cannot travel through this leg — the .eml case below proves
		// attachment bytes survive the import path byte for byte.
		await seedEmail(
			source,
			{
				id: "src-4",
				subject: "With an attachment",
				sender: "dave@example.org",
				date: "2026-09-04T12:00:00.000Z",
				body: "See attached.",
				message_id: "fourth@example.org",
			},
			[
				{
					id: "att-1",
					filename: "note.txt",
					mimetype: "text/plain",
					content: new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x0d, 0x0a]),
				},
			],
		);

		const exported = await exportMbox(source);
		expect(exported).toContain(">From the beginning it looked fine.");

		const { status, body } = await importMultipart(target, "mailbox.mbox", exported);
		expect(status).toBe(202);
		expect(body.job?.status).toBe("pending");
		expect(body.job?.size).toBe(new TextEncoder().encode(exported).byteLength);

		await drainAlarm(stubFor(target));

		const [job] = await listJobs(target);
		expect(job!.id).toBe(body.job!.id);
		expect(job!.status).toBe("done");
		expect(job!.imported).toBe(4);
		expect(job!.skipped).toBe(0);
		expect(job!.failed).toBe(0);
		expect(job!.cursor).toBe(job!.size);
		expect(job!.last_error).toBeNull();
		// The staged object is removed once the job is done.
		expect(await env.BUCKET.head(importJobR2Key(target, job!.id))).toBeNull();

		// The imported mailbox exports byte-identically: same messages, same
		// order, same framing, same escaped body line.
		expect(await exportMbox(target)).toBe(exported);

		const imported = await storedMessages(target);
		expect(imported.map((row) => row.subject)).toEqual([
			"First message",
			"Second message",
			"Third message",
			"With an attachment",
		]);
		expect(imported.map((row) => row.body)).toEqual([
			"Hello from the first message.",
			"Second body.\nFrom the beginning it looked fine.",
			"Third body.",
			"See attached.",
		]);
		expect(imported.map((row) => row.message_id)).toEqual([
			"first@example.org",
			"second@example.org",
			null,
			"fourth@example.org",
		]);
		expect(imported.map((row) => row.date)).toEqual([
			"2026-09-01T10:00:00.000Z",
			"2026-09-02T11:30:00.000Z",
			"2026-09-03T09:15:00.000Z",
			"2026-09-04T12:00:00.000Z",
		]);

		// Imported mail is Inbox mail and unread.
		const full = await stubFor(target).getEmail(imported[0]!.id);
		expect(full?.folder_id).toBe(Folders.INBOX);
		expect(full?.read).toBe(false);
	});

	it("re-importing the same file imports nothing and skips every duplicate", async () => {
		const source = "import-again-src@example.com";
		const target = "import-again-dst@example.com";
		await registerMailbox(source);
		await registerMailbox(target);
		await seedEmail(source, {
			id: "again-1",
			subject: "One",
			sender: "alice@example.org",
			date: "2026-09-01T10:00:00.000Z",
			body: "First.",
			message_id: "again-1@example.org",
		});
		await seedEmail(source, {
			id: "again-2",
			subject: "Two",
			sender: "bob@example.org",
			date: "2026-09-02T10:00:00.000Z",
			body: "Second.",
			message_id: "again-2@example.org",
		});
		const exported = await exportMbox(source);

		const first = await importMultipart(target, "again.mbox", exported);
		expect(first.status).toBe(202);
		await drainAlarm(stubFor(target));
		const firstJob = (await listJobs(target)).find((job) => job.id === first.body.job!.id)!;
		expect(firstJob.status).toBe("done");
		expect(firstJob.imported).toBe(2);
		expect(firstJob.skipped).toBe(0);

		const second = await importMultipart(target, "again.mbox", exported);
		expect(second.status).toBe(202);
		await drainAlarm(stubFor(target));
		const secondJob = (await listJobs(target)).find((job) => job.id === second.body.job!.id)!;
		expect(secondJob.status).toBe("done");
		expect(secondJob.imported).toBe(0);
		expect(secondJob.skipped).toBe(2);
		expect(secondJob.failed).toBe(0);

		// Nothing was duplicated.
		expect(await storedMessages(target)).toHaveLength(2);
	});

	it("imports a single .eml as one message, attachment bytes intact", async () => {
		const target = "import-eml@example.com";
		await registerMailbox(target);

		// A PNG signature plus bytes a text-only trip would corrupt.
		const attachmentBytes = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0d, 0x0a, 0xff, 0x10,
			0x20, 0x7f, 0x00,
		]);
		const eml = [
			"From: dave@example.org",
			"To: import-eml@example.com",
			"Date: 2026-09-05T08:00:00.000Z",
			"Subject: With an attachment",
			"Message-ID: <eml-1@example.org>",
			"MIME-Version: 1.0",
			"Content-Type: multipart/mixed; boundary=\"b1\"",
			"",
			"--b1",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"See attached.",
			"--b1",
			"Content-Type: image/png; name=\"pixel.png\"",
			"Content-Transfer-Encoding: base64",
			"Content-Disposition: attachment; filename=\"pixel.png\"",
			"",
			encodeBase64Bytes(attachmentBytes),
			"--b1--",
			"",
		].join("\r\n");

		const { status, body } = await importRawBody(target, "message.eml", eml);
		expect(status).toBe(202);
		await drainAlarm(stubFor(target));

		const job = (await listJobs(target)).find((entry) => entry.id === body.job!.id)!;
		expect(job.status).toBe("done");
		expect(job.imported).toBe(1);
		expect(job.failed).toBe(0);

		const rows = await storedMessages(target);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.subject).toBe("With an attachment");
		expect(rows[0]!.message_id).toBe("eml-1@example.org");
		expect(rows[0]!.date).toBe("2026-09-05T08:00:00.000Z");
		expect(rows[0]!.attachments).toEqual([
			{ filename: "pixel.png", mimetype: "image/png", size: attachmentBytes.byteLength },
		]);

		// The stored bytes are the file's own bytes, byte for byte.
		const stored = (await runInDurableObject(stubFor(target), async (_instance, state) => {
			return [
				...state.storage.sql.exec("SELECT id, email_id, filename FROM attachments"),
			];
		})) as unknown as { id: string; email_id: string; filename: string }[];
		expect(stored).toHaveLength(1);
		const object = await env.BUCKET.get(
			attachmentR2Key({
				email_id: stored[0]!.email_id,
				id: stored[0]!.id,
				filename: stored[0]!.filename,
			}),
		);
		expect(object).not.toBeNull();
		expect(new Uint8Array(await object!.arrayBuffer())).toEqual(attachmentBytes);
	});

	it("cancel marks the job cancelled, removes its staged object and imports nothing", async () => {
		const target = "import-cancel@example.com";
		await registerMailbox(target);
		const file = [
			"From alice@example.org Tue Sep  1 10:00:00 2026",
			"From: alice@example.org",
			"To: import-cancel@example.com",
			"Date: 2026-09-01T10:00:00.000Z",
			"Subject: Never imported",
			"",
			"Body.",
			"",
		].join("\n");

		// Seed the job the way a staged import leaves it: bytes in R2, a
		// pending row, no alarm armed. Staging through the route would not do
		// for this test — the environment fires a due alarm almost instantly,
		// so the drain would finish a small file before the cancel could land.
		const jobId = "cancel-job-1";
		const r2Key = importJobR2Key(target, jobId);
		const bytes = new TextEncoder().encode(file);
		await env.BUCKET.put(r2Key, bytes);
		await runInDurableObject(stubFor(target), async (_instance, state) => {
			const now = new Date().toISOString();
			state.storage.sql.exec(
				`INSERT INTO import_jobs (id, filename, r2_key, size, cursor, status, imported, skipped, failed, last_error, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, 0, 'pending', 0, 0, 0, NULL, ?5, ?5)`,
				jobId,
				"cancel.mbox",
				r2Key,
				bytes.byteLength,
				now,
			);
		});
		expect(await env.BUCKET.head(r2Key)).not.toBeNull();

		const res = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${target}/import/${jobId}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(200);
		const cancelled = (await res.json()) as { job: ImportJobRow };
		expect(cancelled.job.status).toBe("cancelled");
		expect(await env.BUCKET.head(r2Key)).toBeNull();

		// Even with an alarm forced afterwards, the cancelled job is never
		// drained: the message never lands.
		expect(await forceAlarm(stubFor(target))).toBe(true);
		expect(await storedMessages(target)).toHaveLength(0);
		const job = (await listJobs(target))[0]!;
		expect(job.id).toBe(jobId);
		expect(job.status).toBe("cancelled");
		expect(job.imported).toBe(0);
		expect(job.cursor).toBe(0);
		const raw = (await runInDurableObject(stubFor(target), async (_instance, state) => {
			return [
				...state.storage.sql.exec("SELECT * FROM import_jobs WHERE id = ?1", jobId),
			];
		})) as unknown as ImportJobRawRow[];
		expect(raw[0]!.status).toBe("cancelled");

		// A terminal job cannot be cancelled again; an unknown id is a 404.
		const again = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${target}/import/${jobId}`,
			{ method: "DELETE" },
		);
		expect(again.status).toBe(400);
		const missing = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${target}/import/unknown-job`,
			{ method: "DELETE" },
		);
		expect(missing.status).toBe(404);
	});

	it("is storage only: nothing notification-shaped fires", async () => {
		const source = "import-quiet-src@example.com";
		const target = "import-quiet-dst@example.com";
		await registerMailbox(source);
		await registerMailbox(target);
		await seedEmail(source, {
			id: "quiet-1",
			subject: "Quiet",
			sender: "alice@example.org",
			date: "2026-09-01T10:00:00.000Z",
			body: "Body.",
			message_id: "quiet-1@example.org",
		});
		const exported = await exportMbox(source);

		// Install the fetch stub before staging, so the drain — on whichever
		// wake it runs, the environment fires a due alarm on its own — happens
		// under it. The manual runs after are a safety net for the assertion.
		const { result, calls } = await withFetchRecorder(async () => {
			const staged = await importMultipart(target, "quiet.mbox", exported);
			expect(staged.status).toBe(202);
			await drainAlarm(stubFor(target));
			await forceAlarm(stubFor(target));
			return staged.body;
		});

		// No push, webhook or digest call — not one outbound request.
		expect(calls).toEqual([]);
		const job = (await listJobs(target)).find((entry) => entry.id === result.job!.id)!;
		expect(job.status).toBe("done");
		expect(job.imported).toBe(1);
		expect(await storedMessages(target)).toHaveLength(1);
	});

	it("refuses an empty upload and a raw body without a filename", async () => {
		const target = "import-guard@example.com";
		await registerMailbox(target);

		const empty = await importMultipart(target, "empty.mbox", "");
		expect(empty.status).toBe(400);
		expect(empty.body.error).toContain("empty");

		const noFilename = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${target}/import`,
			{
				method: "POST",
				body: "From alice@example.org Tue Sep  1 10:00:00 2026\n",
				headers: { "content-type": "text/plain" },
			},
		);
		expect(noFilename.status).toBe(400);
		expect(((await noFilename.json()) as { error: string }).error).toContain("filename");
	});
});
