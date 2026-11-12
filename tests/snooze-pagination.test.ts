// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Paginated Snoozed/Reminders listings (workers/durableObject/snooze.ts):
 * the queries run LIMIT + one row of over-fetch, and `hasMore` rides on
 * the returned array only when the result was actually truncated, so the
 * historical no-arguments array shape never changes.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";


function stubFor(mailbox: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


describe("paginated snooze/reminder listings", () => {
	it("flags hasMore only on a truncated page and pages via limit/offset", async () => {
		const stub = stubFor("snooze-page@example.com");
		// Seed 501 snoozed rows: createEmail per row, then one SQL stamp.
		const until = new Date(Date.now() + 3_600_000).toISOString();
		for (let i = 0; i < 501; i += 1) {
			await stub.createEmail(
				Folders.INBOX,
				{
					id: `page-${i}`,
					subject: `Page ${i}`,
					sender: "sender@example.org",
					recipient: "snooze@example.com",
					date: new Date().toISOString(),
					read: false,
					body: "<p>body</p>",
					in_reply_to: null,
					email_references: null,
					thread_id: `page-${i}`,
				},
				[],
			);
		}
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE emails SET snooze_until = ?1, folder_id = ?2, snoozed_from_folder = ?3",
				until,
				Folders.SNOOZED,
				Folders.INBOX,
			);
		});

		// Default page: first 500 rows with the truncation flag attached.
		const first = (await stub.getSnoozed()) as { id: string }[] & { hasMore?: boolean };
		expect(first.length).toBe(500);
		expect(first.hasMore).toBe(true);

		// Explicit limit: still truncated, same flag.
		const limited = (await stub.getSnoozed({ limit: 10 })) as { id: string }[] & {
			hasMore?: boolean;
		};
		expect(limited.length).toBe(10);
		expect(limited.hasMore).toBe(true);

		// Second page: the 501st row, which fits — no flag.
		const second = (await stub.getSnoozed({ offset: 500 })) as { id: string }[] & {
			hasMore?: boolean;
		};
		expect(second.length).toBe(1);
		expect(second.hasMore).toBeUndefined();

		// The limit clamps at the 500 ceiling even when asked for more.
		const clamped = (await stub.getSnoozed({ limit: 10_000 })) as { id: string }[] & {
			hasMore?: boolean;
		};
		expect(clamped.length).toBe(500);
		expect(clamped.hasMore).toBe(true);
	});

	it("an untruncated reminders listing carries no hasMore flag", async () => {
		const stub = stubFor("reminder-page@example.com");
		for (const id of ["r-1", "r-2"]) {
			await stub.createEmail(
				Folders.INBOX,
				{
					id,
					subject: `Reminder ${id}`,
					sender: "sender@example.org",
					recipient: "snooze@example.com",
					date: new Date().toISOString(),
					read: false,
					body: "<p>body</p>",
					in_reply_to: null,
					email_references: null,
					thread_id: id,
				},
				[],
			);
		}
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE emails SET reminded_at = ?1",
				new Date().toISOString(),
			);
		});

		const reminders = (await stub.getReminders()) as { id: string }[] & {
			hasMore?: boolean;
		};
		expect(reminders.map((email) => email.id).sort()).toEqual(["r-1", "r-2"]);
		expect(reminders.hasMore).toBeUndefined();
	});
});
