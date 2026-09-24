import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { listMailboxes } from "../workers/lib/email-helpers";
import { sweepTrash } from "../workers/lib/trash-retention";


type Stub = ReturnType<typeof stubFor>;


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


/** Seed one email (optionally with a single attachment) into a folder. */
async function seedEmail(
	stub: Stub,
	id: string,
	folder: string,
	{ attachment = false }: { attachment?: boolean } = {},
) {
	await stub.createEmail(
		folder,
		{
			id,
			subject: `Subject ${id}`,
			sender: "sender@example.org",
			recipient: "retention@example.com",
			date: new Date().toISOString(),
			body: "<p>body</p>",
			in_reply_to: null,
			email_references: null,
			thread_id: id,
		},
		attachment
			? [
					{
						id: `${id}-attachment`,
						email_id: id,
						filename: "notes.txt",
						mimetype: "text/plain",
						size: 5,
					},
				]
			: [],
	);
}


/** Raw read of `trashed_at`; undefined when the row no longer exists. */
async function readTrashedAt(stub: Stub, id: string) {
	return runInDurableObject(stub, async (_instance, state) => {
		const rows = [
			...state.storage.sql.exec("SELECT trashed_at FROM emails WHERE id = ?1", id),
		];
		return rows.length > 0
			? (rows[0] as { trashed_at: string | null }).trashed_at
			: undefined;
	});
}


/**
 * Rewrite a row's trashed_at with raw SQL — the only way to simulate mail that
 * entered Trash at a known instant without adding test-only production knobs.
 */
async function setTrashedAt(stub: Stub, id: string, trashedAt: string | null) {
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec(
			"UPDATE emails SET trashed_at = ?1 WHERE id = ?2",
			trashedAt,
			id,
		);
	});
}


/** Register a mailbox settings record in R2 (the sweep reads settings there). */
async function registerMailbox(
	mailbox: string,
	settings: Record<string, unknown> = {},
) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify(settings));
}


/** R2 key for the single attachment seedEmail can create. */
function attachmentKey(emailId: string) {
	return `attachments/${emailId}/${emailId}-attachment/notes.txt`;
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


/** ISO instant `daysAgo` days before `now`. */
function isoDaysBefore(daysAgo: number, now: Date) {
	return new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}


describe("Trash retention stamping", () => {
	it("stamps trashed_at when a message enters Trash and clears it when it leaves", async () => {
		const stub = stubFor("retention-stamp@example.com");
		await seedEmail(stub, "stamp-1", Folders.INBOX);

		// Fresh inbox mail is not retention-eligible.
		expect(await readTrashedAt(stub, "stamp-1")).toBeNull();

		await stub.trashEmails(["stamp-1"]);
		const stamped = await readTrashedAt(stub, "stamp-1");
		expect(typeof stamped).toBe("string");
		expect(Number.isNaN(Date.parse(stamped as string))).toBe(false);

		// Restoring clears the stamp so a restored message is never swept.
		await stub.restoreEmails(["stamp-1"]);
		expect(await readTrashedAt(stub, "stamp-1")).toBeNull();

		// Trashing again starts a fresh clock.
		await stub.trashEmails(["stamp-1"]);
		expect(typeof (await readTrashedAt(stub, "stamp-1"))).toBe("string");
	});


	it("stamps and clears the move paths (moveEmail and bulkMoveEmails)", async () => {
		const stub = stubFor("retention-move@example.com");
		await seedEmail(stub, "move-1", Folders.INBOX);
		await seedEmail(stub, "move-2", Folders.INBOX);

		expect(await stub.moveEmail("move-1", Folders.TRASH)).toBe(true);
		expect(typeof (await readTrashedAt(stub, "move-1"))).toBe("string");

		// Moving out of Trash clears it again.
		expect(await stub.moveEmail("move-1", Folders.ARCHIVE)).toBe(true);
		expect(await readTrashedAt(stub, "move-1")).toBeNull();

		expect(await stub.bulkMoveEmails(["move-2"], Folders.TRASH)).toBe(true);
		expect(typeof (await readTrashedAt(stub, "move-2"))).toBe("string");

		expect(await stub.bulkMoveEmails(["move-2"], Folders.SPAM)).toBe(true);
		expect(await readTrashedAt(stub, "move-2")).toBeNull();
	});


	it("stamps messages created straight in Trash (inbound rule routing)", async () => {
		const stub = stubFor("retention-create@example.com");
		await seedEmail(stub, "created-in-trash", Folders.TRASH);
		expect(typeof (await readTrashedAt(stub, "created-in-trash"))).toBe("string");
	});
});


describe("purgeTrashedBefore", () => {
	it("purges only rows trashed before the cutoff", async () => {
		const stub = stubFor("retention-purge@example.com");
		const cutoff = "2025-06-01T00:00:00.000Z";

		await seedEmail(stub, "expired", Folders.TRASH, { attachment: true });
		await seedEmail(stub, "newer", Folders.TRASH);
		await seedEmail(stub, "unstamped", Folders.TRASH);
		await seedEmail(stub, "inbox-old", Folders.INBOX, { attachment: true });

		await setTrashedAt(stub, "expired", "2024-01-01T00:00:00.000Z");
		await setTrashedAt(stub, "newer", "2026-01-01T00:00:00.000Z");
		// Rows trashed before the column existed carry NULL and stay put.
		await setTrashedAt(stub, "unstamped", null);
		// A stamp on a row that is not in Trash must never make it eligible.
		await setTrashedAt(stub, "inbox-old", "2020-01-01T00:00:00.000Z");

		const { purged, attachments } = await stub.purgeTrashedBefore(cutoff);
		expect(purged).toBe(1);
		expect(attachments.map((att) => att.email_id)).toEqual(["expired"]);

		expect(await stub.getEmail("expired")).toBeNull();
		expect(await stub.getEmail("newer")).not.toBeNull();
		expect(await stub.getEmail("unstamped")).not.toBeNull();
		expect(await stub.getEmail("inbox-old")).not.toBeNull();

		// Nothing left past the cutoff -> no-op.
		expect(await stub.purgeTrashedBefore("2020-01-01T00:00:00.000Z")).toEqual({
			purged: 0,
			attachments: [],
		});
	});
});


describe("sweepTrash", () => {
	it("purges expired Trash and deletes the R2 attachment blobs", async () => {
		await resetMailboxes();
		const mailbox = "retention-sweep@example.com";
		// No trashRetentionDays in the settings: the 30-day default applies.
		await registerMailbox(mailbox);
		const stub = stubFor(mailbox);
		const now = new Date("2026-02-01T00:00:00.000Z");

		await seedEmail(stub, "sweep-expired", Folders.TRASH, { attachment: true });
		await seedEmail(stub, "sweep-fresh", Folders.TRASH, { attachment: true });
		await seedEmail(stub, "sweep-unstamped", Folders.TRASH, { attachment: true });
		await env.BUCKET.put(attachmentKey("sweep-expired"), "expired blob");
		await env.BUCKET.put(attachmentKey("sweep-fresh"), "fresh blob");

		// 40 days old: past the 30-day default. 20 days old: still inside it.
		await setTrashedAt(stub, "sweep-expired", isoDaysBefore(40, now));
		await setTrashedAt(stub, "sweep-fresh", isoDaysBefore(20, now));
		await setTrashedAt(stub, "sweep-unstamped", null);

		const summary = await sweepTrash(env, { now });
		expect(summary).toEqual({ mailboxes: 1, purged: 1, blobsDeleted: 1 });

		expect(await stub.getEmail("sweep-expired")).toBeNull();
		expect(await stub.getEmail("sweep-fresh")).not.toBeNull();
		expect(await stub.getEmail("sweep-unstamped")).not.toBeNull();

		// The expired message's blob is gone; the kept message's blob survives.
		expect(await env.BUCKET.head(attachmentKey("sweep-expired"))).toBeNull();
		expect(await env.BUCKET.head(attachmentKey("sweep-fresh"))).not.toBeNull();
	});


	it("does nothing for a mailbox with retention disabled", async () => {
		await resetMailboxes();
		const mailbox = "retention-off@example.com";
		await registerMailbox(mailbox, { trashRetentionDays: 0 });
		const stub = stubFor(mailbox);
		const now = new Date("2026-02-01T00:00:00.000Z");

		await seedEmail(stub, "off-old", Folders.TRASH, { attachment: true });
		await env.BUCKET.put(attachmentKey("off-old"), "kept blob");
		await setTrashedAt(stub, "off-old", "2020-01-01T00:00:00.000Z");

		const summary = await sweepTrash(env, { now });
		expect(summary).toEqual({ mailboxes: 0, purged: 0, blobsDeleted: 0 });

		expect(await stub.getEmail("off-old")).not.toBeNull();
		expect(await env.BUCKET.head(attachmentKey("off-old"))).not.toBeNull();
	});


	it("respects each mailbox's own retention setting", async () => {
		await resetMailboxes();
		const daily = "retention-daily@example.com";
		const yearly = "retention-yearly@example.com";
		await registerMailbox(daily, { trashRetentionDays: 1 });
		await registerMailbox(yearly, { trashRetentionDays: 365 });
		const dailyStub = stubFor(daily);
		const yearlyStub = stubFor(yearly);
		const now = new Date("2026-02-01T00:00:00.000Z");

		await seedEmail(dailyStub, "daily-old", Folders.TRASH);
		await seedEmail(yearlyStub, "yearly-old", Folders.TRASH);
		await setTrashedAt(dailyStub, "daily-old", isoDaysBefore(10, now));
		await setTrashedAt(yearlyStub, "yearly-old", isoDaysBefore(10, now));

		const summary = await sweepTrash(env, { now });
		expect(summary).toEqual({ mailboxes: 2, purged: 1, blobsDeleted: 0 });

		// Ten days is past a one-day window but well inside a 365-day one.
		expect(await dailyStub.getEmail("daily-old")).toBeNull();
		expect(await yearlyStub.getEmail("yearly-old")).not.toBeNull();
	});
});


describe("mailbox settings", () => {
	async function putSettings(mailbox: string, settings: Record<string, unknown>) {
		const res = await SELF.fetch(`http://example.com/api/v1/mailboxes/${mailbox}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ settings }),
		});
		return {
			status: res.status,
			settings: ((await res.json()) as { settings: Record<string, unknown> })
				.settings,
		};
	}


	it("defaults, caps and disables trashRetentionDays on save", async () => {
		const mailbox = "retention-settings@example.com";
		await registerMailbox(mailbox);

		// Missing field -> the 30-day default is stored.
		const omitted = await putSettings(mailbox, { fromName: "Retention" });
		expect(omitted.status).toBe(200);
		expect(omitted.settings.trashRetentionDays).toBe(30);

		// Absurd values are capped instead of stored.
		const capped = await putSettings(mailbox, { trashRetentionDays: 99999 });
		expect(capped.settings.trashRetentionDays).toBe(3650);

		// 0 means "never auto-delete" and survives the round trip.
		const disabled = await putSettings(mailbox, { trashRetentionDays: 0 });
		expect(disabled.settings.trashRetentionDays).toBe(0);

		const stored = await env.BUCKET.get(`mailboxes/${mailbox}.json`);
		const storedSettings = (await stored?.json()) as Record<string, unknown>;
		expect(storedSettings.trashRetentionDays).toBe(0);
	});
});
