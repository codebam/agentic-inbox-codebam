import {
	SELF,
	createExecutionContext,
	createScheduledController,
	runDurableObjectAlarm,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import worker from "../workers/app";
import { listMailboxes } from "../workers/lib/email-helpers";
import { sweepDueMail } from "../workers/lib/mail-sweep";


type Stub = ReturnType<typeof stubFor>;

/** Raw `emails` columns the snooze/reminder logic owns. */
interface SnoozeRow {
	folder_id: string;
	snooze_until: string | null;
	snoozed_from_folder: string | null;
	remind_at: string | null;
	reminded_at: string | null;
	read: number;
}


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


/** Seed one email into a folder. */
async function seedEmail(
	stub: Stub,
	id: string,
	folder: string,
	{
		threadId = id,
		date = new Date().toISOString(),
		read = false,
	}: { threadId?: string; date?: string; read?: boolean } = {},
) {
	await stub.createEmail(
		folder,
		{
			id,
			subject: `Subject ${id}`,
			sender: "sender@example.org",
			recipient: "snooze@example.com",
			date,
			read,
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: threadId,
		},
		[],
	);
}


/** ISO instant `ms` from now. */
function isoIn(ms: number) {
	return new Date(Date.now() + ms).toISOString();
}


/**
 * Rewrite a row's snooze/reminder columns with raw SQL — the only way to make
 * work come due at a known instant without adding test-only production knobs.
 */
async function forceDue(
	stub: Stub,
	id: string,
	columns: { snooze_until?: string; remind_at?: string },
) {
	await runInDurableObject(stub, async (_instance, state) => {
		if (columns.snooze_until !== undefined) {
			state.storage.sql.exec(
				"UPDATE emails SET snooze_until = ?1 WHERE id = ?2",
				columns.snooze_until,
				id,
			);
		}
		if (columns.remind_at !== undefined) {
			state.storage.sql.exec(
				"UPDATE emails SET remind_at = ?1 WHERE id = ?2",
				columns.remind_at,
				id,
			);
		}
	});
}


/**
 * Write a due snooze/reminder straight onto the row with raw SQL. Unlike
 * forceDue no alarm is armed by the call, so only the sweep can drain it —
 * the exact state the cron backstop exists for: due work whose alarm never
 * ran (throttled DO, evicted mid-flight).
 */
async function seedDueState(
	stub: Stub,
	id: string,
	state: {
		folder: string;
		snoozeUntil: string | null;
		fromFolder: string | null;
		remindAt: string | null;
	},
) {
	await runInDurableObject(stub, async (_instance, sqlState) => {
		sqlState.storage.sql.exec(
			`UPDATE emails
			 SET folder_id = ?1, snooze_until = ?2, snoozed_from_folder = ?3, remind_at = ?4
			 WHERE id = ?5`,
			state.folder,
			state.snoozeUntil,
			state.fromFolder,
			state.remindAt,
			id,
		);
	});
}


/** The Durable Object's armed alarm, or null when none is set. */
async function alarmAt(stub: Stub) {
	return runInDurableObject(stub, async (_instance, state) =>
		state.storage.getAlarm(),
	);
}


/** Raw read of the snooze/reminder columns; null when the row is gone. */
async function readSnoozeRow(stub: Stub, id: string) {
	return runInDurableObject(stub, async (_instance, state) => {
		const rows = [
			...state.storage.sql.exec(
				`SELECT folder_id, snooze_until, snoozed_from_folder, remind_at, reminded_at, read
				 FROM emails WHERE id = ?1`,
				id,
			),
		];
		return (rows[0] as SnoozeRow | undefined) ?? null;
	});
}


/** Register a mailbox record in R2 so the HTTP routes accept its id. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
}


/**
 * Drop every mailbox record so a sweep only sees the mailboxes the test itself
 * registers — sweep summaries are otherwise order-dependent (storage is shared
 * across the tests in this file).
 */
async function resetMailboxes() {
	for (const mailbox of await listMailboxes(env.BUCKET)) {
		await env.BUCKET.delete(`mailboxes/${mailbox.id}.json`);
	}
}


function jsonInit(body: unknown): RequestInit {
	return {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}


describe("snooze schema", () => {
	it("applies the snooze migration to a fresh mailbox", async () => {
		const stub = stubFor("snooze-migration@example.com");
		const info = await runInDurableObject(stub, async (_instance, state) => {
			const columns = [...state.storage.sql.exec("SELECT * FROM emails LIMIT 1").columnNames];
			const indexes = [
				...state.storage.sql.exec(
					"SELECT name FROM sqlite_master WHERE type = 'index'",
				),
			].map((row) => String((row as { name: unknown }).name));
			const folder = [
				...state.storage.sql.exec(
					"SELECT id, name, is_deletable FROM folders WHERE id = 'snoozed'",
				),
			][0] as { id: string; name: string; is_deletable: number } | undefined;
			const applied = [
				...state.storage.sql.exec(
					"SELECT name FROM d1_migrations WHERE name = '18_add_snooze_and_reminders'",
				),
			].length;
			return { columns, indexes, folder, applied };
		});

		expect(info.columns).toEqual(
			expect.arrayContaining([
				"snooze_until",
				"snoozed_from_folder",
				"remind_at",
				"reminded_at",
			]),
		);
		expect(info.indexes).toEqual(
			expect.arrayContaining(["idx_emails_snooze_until", "idx_emails_remind_at"]),
		);
		expect(info.folder).toEqual({ id: "snoozed", name: "Snoozed", is_deletable: 0 });
		expect(info.applied).toBe(1);
	});
});


describe("setSnooze / clearSnooze", () => {
	it("moves the message to Snoozed and arms the alarm at the due time", async () => {
		const stub = stubFor("snooze-set@example.com");
		await seedEmail(stub, "snooze-1", Folders.ARCHIVE);
		const until = isoIn(60 * 60 * 1000);

		const updated = (await stub.setSnooze("snooze-1", until)) as SnoozeRow | null;
		expect(updated?.folder_id).toBe(Folders.SNOOZED);
		expect(updated?.snooze_until).toBe(until);
		expect(updated?.snoozed_from_folder).toBe(Folders.ARCHIVE);
		expect(await alarmAt(stub)).toBe(Date.parse(until));

		const snoozed = (await stub.getSnoozed()) as { id: string }[];
		expect(snoozed.map((email) => email.id)).toEqual(["snooze-1"]);

		// A plain folder listing carries the same state, so the Snoozed folder
		// and the Snoozed list cannot disagree.
		const listed = (await stub.getEmails({ folder: Folders.SNOOZED })) as {
			id: string;
			snooze_until: string | null;
			remind_at: string | null;
			reminded_at: string | null;
		}[];
		expect(listed[0]?.snooze_until).toBe(until);
		expect(listed[0]?.remind_at).toBeNull();
		expect(listed[0]?.reminded_at).toBeNull();

		// An unknown id answers null and must not arm anything.
		expect(await stub.setSnooze("missing", until)).toBeNull();
	});


	it("clearSnooze restores the origin folder and clears the snooze columns", async () => {
		const stub = stubFor("snooze-clear@example.com");
		await seedEmail(stub, "clear-1", Folders.ARCHIVE);
		await stub.setSnooze("clear-1", isoIn(60 * 60 * 1000));

		const restored = (await stub.clearSnooze("clear-1")) as SnoozeRow | null;
		expect(restored?.folder_id).toBe(Folders.ARCHIVE);

		const row = await readSnoozeRow(stub, "clear-1");
		expect(row?.snooze_until).toBeNull();
		expect(row?.snoozed_from_folder).toBeNull();
		expect(await stub.clearSnooze("missing")).toBeNull();
	});
});


describe("snooze alarm", () => {
	it("wakes a due snooze back to its origin folder and leaves the future one alone", async () => {
		const stub = stubFor("snooze-alarm@example.com");
		await seedEmail(stub, "due", Folders.ARCHIVE, { read: true });
		await seedEmail(stub, "later", Folders.INBOX);
		const laterUntil = isoIn(2 * 60 * 60 * 1000);
		await stub.setSnooze("due", isoIn(60 * 60 * 1000));
		await stub.setSnooze("later", laterUntil);

		// Make the first snooze due without waiting for its time.
		await forceDue(stub, "due", {
			snooze_until: new Date(Date.now() - 60_000).toISOString(),
		});

		expect(await runDurableObjectAlarm(stub)).toBe(true);

		const woken = await readSnoozeRow(stub, "due");
		expect(woken?.folder_id).toBe(Folders.ARCHIVE);
		expect(woken?.snooze_until).toBeNull();
		// Snoozing never touches the read state.
		expect(woken?.read).toBe(1);

		const stillSleeping = await readSnoozeRow(stub, "later");
		expect(stillSleeping?.folder_id).toBe(Folders.SNOOZED);
		expect(stillSleeping?.snooze_until).toBe(laterUntil);
		// The alarm re-armed for the next pending snooze.
		expect(await alarmAt(stub)).toBe(Date.parse(laterUntil));

		// Idempotent: a second run finds nothing due and changes nothing.
		expect(await stub.wakeDueSnoozes(new Date().toISOString())).toBe(0);
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect((await readSnoozeRow(stub, "later"))?.folder_id).toBe(Folders.SNOOZED);
	});


	it("clears the alarm once nothing is left pending", async () => {
		const stub = stubFor("snooze-alarm-clear@example.com");
		await seedEmail(stub, "only", Folders.ARCHIVE);
		await stub.setSnooze("only", isoIn(60 * 60 * 1000));
		await forceDue(stub, "only", {
			snooze_until: new Date(Date.now() - 60_000).toISOString(),
		});

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect((await readSnoozeRow(stub, "only"))?.folder_id).toBe(Folders.ARCHIVE);
		expect(await alarmAt(stub)).toBeNull();
	});


	it("wakes a snoozed thread as soon as new mail lands in it", async () => {
		const stub = stubFor("snooze-thread@example.com");
		await seedEmail(stub, "thread-1", Folders.ARCHIVE, { threadId: "thread-a" });
		await seedEmail(stub, "other-thread", Folders.INBOX, { threadId: "thread-b" });
		await stub.setSnooze("thread-1", isoIn(60 * 60 * 1000));
		await stub.setSnooze("other-thread", isoIn(60 * 60 * 1000));

		await seedEmail(stub, "thread-2", Folders.INBOX, { threadId: "thread-a" });

		expect((await readSnoozeRow(stub, "thread-1"))?.folder_id).toBe(Folders.ARCHIVE);
		// A message in another thread leaves its snooze alone.
		expect((await readSnoozeRow(stub, "other-thread"))?.folder_id).toBe(
			Folders.SNOOZED,
		);

		// Mail that lands in Sent is an answer, not new activity: it must not
		// pull a snoozed message back into the inbox.
		await seedEmail(stub, "sent-1", Folders.SENT, { threadId: "thread-c" });
		await seedEmail(stub, "thread-c-1", Folders.INBOX, { threadId: "thread-c" });
		await stub.setSnooze("thread-c-1", isoIn(60 * 60 * 1000));
		await seedEmail(stub, "sent-2", Folders.SENT, { threadId: "thread-c" });
		expect((await readSnoozeRow(stub, "thread-c-1"))?.folder_id).toBe(
			Folders.SNOOZED,
		);
	});
});


describe("reminders", () => {
	it("fires a due reminder, pulling the message back to the inbox", async () => {
		const stub = stubFor("reminder-fire@example.com");
		await seedEmail(stub, "reminder-1", Folders.ARCHIVE, {
			threadId: "reminder-thread",
			date: new Date(Date.now() - 60_000).toISOString(),
		});

		const at = isoIn(60 * 60 * 1000);
		const pending = (await stub.setReminder("reminder-1", at)) as SnoozeRow | null;
		expect(pending?.remind_at).toBe(at);
		expect(pending?.reminded_at).toBeNull();
		expect(await alarmAt(stub)).toBe(Date.parse(at));

		await forceDue(stub, "reminder-1", {
			remind_at: new Date(Date.now() - 1_000).toISOString(),
		});
		expect(await runDurableObjectAlarm(stub)).toBe(true);

		const fired = await readSnoozeRow(stub, "reminder-1");
		expect(fired?.folder_id).toBe(Folders.INBOX);
		expect(typeof fired?.reminded_at).toBe("string");
		expect(fired?.remind_at).toBeNull();

		const reminders = (await stub.getReminders()) as { id: string }[];
		expect(reminders.map((email) => email.id)).toEqual(["reminder-1"]);

		// Idempotent: a second pass finds nothing due.
		expect(await stub.fireDueReminders(new Date().toISOString())).toBe(0);
	});


	it("clears a due reminder silently when the thread is already answered", async () => {
		const stub = stubFor("reminder-answered@example.com");
		await seedEmail(stub, "answered-1", Folders.INBOX, {
			threadId: "answered-thread",
			date: new Date(Date.now() - 60_000).toISOString(),
		});
		// The newest message in the thread sits in Sent: the reply is out.
		await seedEmail(stub, "answered-2", Folders.SENT, {
			threadId: "answered-thread",
			date: new Date().toISOString(),
		});
		await stub.setReminder("answered-1", isoIn(60 * 60 * 1000));
		await forceDue(stub, "answered-1", {
			remind_at: new Date(Date.now() - 1_000).toISOString(),
		});

		expect(await stub.fireDueReminders(new Date().toISOString())).toBe(0);

		const row = await readSnoozeRow(stub, "answered-1");
		expect(row?.remind_at).toBeNull();
		expect(row?.reminded_at).toBeNull();
		expect(row?.folder_id).toBe(Folders.INBOX);
		expect(await stub.getReminders()).toEqual([]);
	});


	it("a reply into Sent cancels the thread's pending reminder", async () => {
		const stub = stubFor("reminder-reply@example.com");
		await seedEmail(stub, "reply-1", Folders.INBOX, { threadId: "reply-thread" });
		await stub.setReminder("reply-1", isoIn(60 * 60 * 1000));
		expect((await readSnoozeRow(stub, "reply-1"))?.remind_at).not.toBeNull();

		await seedEmail(stub, "reply-2", Folders.SENT, { threadId: "reply-thread" });

		const row = await readSnoozeRow(stub, "reply-1");
		expect(row?.remind_at).toBeNull();
		expect(row?.reminded_at).toBeNull();
	});
});


describe("snooze routes", () => {
	const MAILBOX = "snooze-routes@example.com";

	it("snoozes, lists and wakes a message over HTTP", async () => {
		await registerMailbox(MAILBOX);
		const stub = stubFor(MAILBOX);
		await seedEmail(stub, "route-1", Folders.INBOX);
		const until = isoIn(60 * 60 * 1000);

		const created = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${MAILBOX}/emails/route-1/snooze`,
			jsonInit({ until }),
		);
		expect(created.status).toBe(200);
		const createdRow = (await created.json()) as SnoozeRow;
		expect(createdRow.folder_id).toBe(Folders.SNOOZED);
		expect(createdRow.snooze_until).toBe(until);
		expect(createdRow.snoozed_from_folder).toBe(Folders.INBOX);

		const listed = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${MAILBOX}/snoozed`,
		);
		expect(listed.status).toBe(200);
		const listing = (await listed.json()) as {
			emails: { id: string; snooze_until: string | null }[];
			totalCount: number;
		};
		expect(listing.totalCount).toBe(1);
		expect(listing.emails.map((email) => email.id)).toEqual(["route-1"]);
		expect(listing.emails[0]?.snooze_until).toBe(until);

		const woken = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${MAILBOX}/emails/route-1/snooze`,
			{ method: "DELETE" },
		);
		expect(woken.status).toBe(200);
		const wokenRow = (await woken.json()) as SnoozeRow;
		expect(wokenRow.folder_id).toBe(Folders.INBOX);
		expect(wokenRow.snooze_until).toBeNull();

		const empty = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${MAILBOX}/snoozed`,
		);
		expect(((await empty.json()) as { totalCount: number }).totalCount).toBe(0);
	});


	it("rejects missing, malformed and past times with 400", async () => {
		await registerMailbox(MAILBOX);
		const stub = stubFor(MAILBOX);
		await seedEmail(stub, "route-bad", Folders.INBOX);
		const url = `http://example.com/api/v1/mailboxes/${MAILBOX}/emails/route-bad/snooze`;

		for (const until of [
			undefined,
			"",
			"not-a-date",
			new Date(Date.now() - 60_000).toISOString(),
		]) {
			const res = await SELF.fetch(url, jsonInit({ until }));
			expect(res.status).toBe(400);
		}

		// The reminder route validates its own `at` the same way.
		const reminder = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${MAILBOX}/emails/route-bad/reminder`,
			jsonInit({ at: "tomorrow-ish" }),
		);
		expect(reminder.status).toBe(400);

		// Nothing was written by the rejected requests.
		const row = await readSnoozeRow(stub, "route-bad");
		expect(row?.snooze_until).toBeNull();
		expect(row?.remind_at).toBeNull();
	});


	it("answers 404 for an unknown email id", async () => {
		await registerMailbox(MAILBOX);
		const unknown = `http://example.com/api/v1/mailboxes/${MAILBOX}/emails/route-missing`;

		const snooze = await SELF.fetch(
			`${unknown}/snooze`,
			jsonInit({ until: isoIn(60 * 60 * 1000) }),
		);
		expect(snooze.status).toBe(404);

		const wake = await SELF.fetch(`${unknown}/snooze`, { method: "DELETE" });
		expect(wake.status).toBe(404);

		const reminder = await SELF.fetch(
			`${unknown}/reminder`,
			jsonInit({ at: isoIn(60 * 60 * 1000) }),
		);
		expect(reminder.status).toBe(404);

		const clear = await SELF.fetch(`${unknown}/reminder`, { method: "DELETE" });
		expect(clear.status).toBe(404);
	});


	it("sets and clears a reminder over HTTP", async () => {
		await registerMailbox(MAILBOX);
		const stub = stubFor(MAILBOX);
		await seedEmail(stub, "route-reminder", Folders.INBOX);
		const at = isoIn(60 * 60 * 1000);

		const set = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${MAILBOX}/emails/route-reminder/reminder`,
			jsonInit({ at }),
		);
		expect(set.status).toBe(200);
		expect(((await set.json()) as SnoozeRow).remind_at).toBe(at);

		const cleared = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${MAILBOX}/emails/route-reminder/reminder`,
			{ method: "DELETE" },
		);
		expect(cleared.status).toBe(200);
		expect(((await cleared.json()) as SnoozeRow).remind_at).toBeNull();

		const listed = await SELF.fetch(
			`http://example.com/api/v1/mailboxes/${MAILBOX}/reminders`,
		);
		expect(listed.status).toBe(200);
		expect((await listed.json()) as { emails: unknown[]; totalCount: number }).toEqual(
			{ emails: [], totalCount: 0 },
		);
	});
});


describe("snooze sweep", () => {
	it("wakes due snoozes and fires due reminders for every mailbox", async () => {
		await resetMailboxes();
		const mailbox = "snooze-sweep@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		const now = new Date();

		const overdue = new Date(now.getTime() - 60_000).toISOString();

		await seedEmail(stub, "sweep-snoozed", Folders.ARCHIVE);
		await seedDueState(stub, "sweep-snoozed", {
			folder: Folders.SNOOZED,
			snoozeUntil: overdue,
			fromFolder: Folders.ARCHIVE,
			remindAt: null,
		});

		await seedEmail(stub, "sweep-reminder", Folders.ARCHIVE);
		await seedDueState(stub, "sweep-reminder", {
			folder: Folders.ARCHIVE,
			snoozeUntil: null,
			fromFolder: null,
			remindAt: overdue,
		});

		await seedEmail(stub, "sweep-future", Folders.INBOX);
		await seedDueState(stub, "sweep-future", {
			folder: Folders.SNOOZED,
			snoozeUntil: isoIn(60 * 60 * 1000),
			fromFolder: Folders.INBOX,
			remindAt: null,
		});

		const summary = await sweepDueMail(env, { now });
		expect(summary).toEqual({ mailboxes: 1, woken: 1, reminders: 1, sends: 0 });

		expect((await readSnoozeRow(stub, "sweep-snoozed"))?.folder_id).toBe(
			Folders.ARCHIVE,
		);
		expect((await readSnoozeRow(stub, "sweep-reminder"))?.reminded_at).not.toBeNull();
		// Still-sleeping mail is not touched by the sweep.
		expect((await readSnoozeRow(stub, "sweep-future"))?.folder_id).toBe(
			Folders.SNOOZED,
		);
	});


	it("the scheduled handler runs the snooze sweep", async () => {
		await resetMailboxes();
		const mailbox = "snooze-cron@example.com";
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);

		await seedEmail(stub, "cron-snoozed", Folders.ARCHIVE);
		await seedDueState(stub, "cron-snoozed", {
			folder: Folders.SNOOZED,
			snoozeUntil: "2020-01-01T00:00:00.000Z",
			fromFolder: Folders.ARCHIVE,
			remindAt: null,
		});

		const ctx = createExecutionContext();
		await worker.scheduled(createScheduledController({ cron: "0 3 * * *" }), env, ctx);
		// The handler fires the sweep through ctx.waitUntil(), so wait for it.
		await waitOnExecutionContext(ctx);

		expect((await readSnoozeRow(stub, "cron-snoozed"))?.folder_id).toBe(
			Folders.ARCHIVE,
		);
	});
});
