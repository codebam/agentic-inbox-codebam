import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import {
	toolClearReminder,
	toolListSnoozed,
	toolSetReminder,
	toolSnoozeEmail,
	toolUnsnoozeEmail,
} from "../workers/lib/tools";

type Stub = ReturnType<typeof stubFor>;

/** The columns the snooze/reminder tools own on a row. */
interface SnoozeRow {
	id: string;
	folder_id: string;
	snooze_until: string | null;
	snoozed_from_folder: string | null;
	remind_at: string | null;
	reminded_at: string | null;
}

function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}

/** Seed one email into a folder. */
async function seedEmail(stub: Stub, id: string, folder: string) {
	await stub.createEmail(
		folder,
		{
			id,
			subject: `Subject ${id}`,
			sender: "sender@example.org",
			recipient: "snooze-tools@example.com",
			date: new Date().toISOString(),
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: id,
		},
		[],
	);
}

/** ISO instant `ms` from now. */
function isoIn(ms: number) {
	return new Date(Date.now() + ms).toISOString();
}

/** Read a row back through the DO; null when the id is unknown. */
async function readRow(stub: Stub, id: string) {
	return (await stub.getEmail(id)) as SnoozeRow | null;
}

describe("toolSnoozeEmail", () => {
	it("moves the message to Snoozed and returns the row with snooze_until", async () => {
		const mailbox = "tools-snooze@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "snooze-1", Folders.ARCHIVE);
		const until = isoIn(60 * 60 * 1000);

		const row = (await toolSnoozeEmail(env, mailbox, "snooze-1", until)) as SnoozeRow;

		expect(row.folder_id).toBe(Folders.SNOOZED);
		expect(row.snooze_until).toBe(until);
		expect(row.snoozed_from_folder).toBe(Folders.ARCHIVE);
		// The stored row agrees with the returned one.
		expect((await readRow(stub, "snooze-1"))?.folder_id).toBe(Folders.SNOOZED);
	});

	it("resolves a relative shorthand against the current time", async () => {
		const mailbox = "tools-snooze-relative@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "snooze-2", Folders.INBOX);

		const before = Date.now();
		const row = (await toolSnoozeEmail(env, mailbox, "snooze-2", "30m")) as SnoozeRow;
		const after = Date.now();

		const at = Date.parse(row.snooze_until ?? "");
		expect(Number.isNaN(at)).toBe(false);
		expect(at).toBeGreaterThanOrEqual(before + 30 * 60_000);
		expect(at).toBeLessThanOrEqual(after + 30 * 60_000);
		expect(row.folder_id).toBe(Folders.SNOOZED);

		// Every accepted unit resolves: h, d and w (m is covered above).
		for (const [shorthand, ms] of [
			["4h", 4 * 3_600_000],
			["3d", 3 * 86_400_000],
			["1w", 7 * 86_400_000],
		] as const) {
			const start = Date.now();
			const re = (await toolSnoozeEmail(env, mailbox, "snooze-2", shorthand)) as SnoozeRow;
			const end = Date.now();
			const reAt = Date.parse(re.snooze_until ?? "");
			expect(reAt).toBeGreaterThanOrEqual(start + ms);
			expect(reAt).toBeLessThanOrEqual(end + ms);
		}
	});

	it("rejects malformed shorthand, past instants and unknown ids", async () => {
		const mailbox = "tools-snooze-invalid@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "snooze-3", Folders.INBOX);

		for (const bad of ["tomorrow", "30", "1.5h", "soon"]) {
			const result = (await toolSnoozeEmail(env, mailbox, "snooze-3", bad)) as {
				error?: string;
			};
			expect(result.error).toBeDefined();
			// The error names the accepted forms.
			expect(result.error).toContain("ISO 8601");
			expect(result.error).toContain("30m");
		}

		const past = (await toolSnoozeEmail(
			env,
			mailbox,
			"snooze-3",
			new Date(Date.now() - 60_000).toISOString(),
		)) as { error?: string };
		expect(past.error).toContain("ISO 8601");

		// Nothing was written by the rejected calls.
		expect((await readRow(stub, "snooze-3"))?.snooze_until).toBeNull();

		expect(await toolSnoozeEmail(env, mailbox, "missing", "30m")).toEqual({
			error: "Email not found",
		});
	});
});

describe("toolUnsnoozeEmail", () => {
	it("restores the folder the message was snoozed from", async () => {
		const mailbox = "tools-unsnooze@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "unsnooze-1", Folders.ARCHIVE);
		await toolSnoozeEmail(env, mailbox, "unsnooze-1", isoIn(60 * 60 * 1000));

		const row = (await toolUnsnoozeEmail(env, mailbox, "unsnooze-1")) as SnoozeRow;

		expect(row.folder_id).toBe(Folders.ARCHIVE);
		expect(row.snooze_until).toBeNull();
		expect(row.snoozed_from_folder).toBeNull();
	});

	it("reports an unknown id", async () => {
		const mailbox = "tools-unsnooze-missing@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "unsnooze-2", Folders.INBOX);
		expect(await toolUnsnoozeEmail(env, mailbox, "missing")).toEqual({
			error: "Email not found",
		});
	});
});

describe("toolSetReminder / toolClearReminder", () => {
	it("sets remind_at without moving the message, then clears both columns", async () => {
		const mailbox = "tools-reminder@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "reminder-1", Folders.INBOX);

		const before = Date.now();
		const set = (await toolSetReminder(env, mailbox, "reminder-1", "4h")) as SnoozeRow;
		const after = Date.now();

		const at = Date.parse(set.remind_at ?? "");
		expect(Number.isNaN(at)).toBe(false);
		expect(at).toBeGreaterThanOrEqual(before + 4 * 3_600_000);
		expect(at).toBeLessThanOrEqual(after + 4 * 3_600_000);
		// A reminder never moves the message.
		expect(set.folder_id).toBe(Folders.INBOX);

		const cleared = (await toolClearReminder(env, mailbox, "reminder-1")) as SnoozeRow;
		expect(cleared.remind_at).toBeNull();
		expect(cleared.reminded_at).toBeNull();
	});

	it("accepts an ISO timestamp and leaves the pending reminder alone on a bad time", async () => {
		const mailbox = "tools-reminder-iso@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "reminder-2", Folders.INBOX);
		const at = isoIn(2 * 60 * 60 * 1000);

		const set = (await toolSetReminder(env, mailbox, "reminder-2", at)) as SnoozeRow;
		expect(set.remind_at).toBe(at);

		const bad = (await toolSetReminder(env, mailbox, "reminder-2", "next week")) as {
			error?: string;
		};
		expect(bad.error).toContain("ISO 8601");
		expect((await readRow(stub, "reminder-2"))?.remind_at).toBe(at);
	});

	it("reports unknown ids", async () => {
		const mailbox = "tools-reminder-missing@example.com";
		await seedEmail(stubFor(mailbox), "reminder-3", Folders.INBOX);
		expect(await toolSetReminder(env, mailbox, "missing", "30m")).toEqual({
			error: "Email not found",
		});
		expect(await toolClearReminder(env, mailbox, "missing")).toEqual({
			error: "Email not found",
		});
	});
});

describe("toolListSnoozed", () => {
	it("lists the snoozed message and nothing else", async () => {
		const mailbox = "tools-list-snoozed@example.com";
		const stub = stubFor(mailbox);
		await seedEmail(stub, "listed-1", Folders.INBOX);
		await seedEmail(stub, "listed-2", Folders.ARCHIVE);
		await seedEmail(stub, "listed-3", Folders.INBOX);

		await toolSnoozeEmail(env, mailbox, "listed-2", isoIn(60 * 60 * 1000));

		const result = (await toolListSnoozed(env, mailbox)) as {
			mailboxId: string;
			emails: SnoozeRow[];
			totalCount: number;
		};

		expect(result.mailboxId).toBe(mailbox);
		expect(result.totalCount).toBe(1);
		expect(result.emails.map((email) => email.id)).toEqual(["listed-2"]);
		expect(result.emails[0]?.snooze_until).not.toBeNull();
	});
});
