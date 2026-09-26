// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
	type EmailListCache,
	INVALIDATION_WINDOW_MS,
	invalidateCoalesced,
	patchEmailInCaches,
	restoreEmailCaches,
} from "../app/queries/email-cache";

/**
 * The request budget of the hot path.
 *
 * Opening a message marks it read, so a read/star toggle fires once per
 * message the operator looks at. These tests pin the two properties that
 * keep that from turning into a request per family per message: an
 * optimistic patch reaches every cached copy of the row, and a burst of
 * invalidations refetches once per window instead of once per action.
 */

const MAILBOX = "request-budget@example.com";

interface Row {
	id: string;
	read: boolean;
	starred: boolean;
}

function row(id: string, patch: Partial<Row> = {}): Row {
	return { id, read: false, starred: false, ...patch };
}

function seedList(qc: QueryClient, key: readonly unknown[], rows: Row[]): void {
	qc.setQueryData(key, {
		emails: rows,
		totalCount: rows.length,
	} as unknown as EmailListCache);
}

function rowsAt(qc: QueryClient, key: readonly unknown[]): Row[] {
	const cached = qc.getQueryData(key) as unknown as EmailListCache | undefined;
	return (cached?.emails ?? []) as unknown as Row[];
}

/**
 * A query with a live observer, so react-query treats it as active and
 * refetches it on invalidation. `calls` counts queryFn invocations — the
 * requests, in other words.
 */
function activeQuery(qc: QueryClient, key: readonly unknown[]) {
	let calls = 0;
	const observer = new QueryObserver(qc, {
		queryKey: key,
		queryFn: async () => {
			calls += 1;
			return calls;
		},
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	const unsubscribe = observer.subscribe(() => {});
	return { calls: () => calls, unsubscribe };
}

async function until(predicate: () => boolean, timeoutMs = 5_000) {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) {
			throw new Error("timed out waiting for the expected request count");
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/**
 * Wait until nothing is fetching for this key. react-query folds an
 * invalidation into a fetch that is already in flight (no new request), so a
 * test that invalidates mid-fetch measures the dedupe, not the coalescer.
 */
async function idle(qc: QueryClient, key: readonly unknown[]) {
	await until(
		() =>
			qc.getQueryCache().find({ queryKey: key })?.state.fetchStatus !==
			"fetching",
	);
}

function settleWindow(): Promise<void> {
	return new Promise((resolve) =>
		setTimeout(resolve, INVALIDATION_WINDOW_MS + 250),
	);
}

describe("optimistic patching", () => {
	it("patches the row in the mailbox list, the aggregate and the detail", () => {
		const qc = new QueryClient();
		const listKey = ["emails", MAILBOX, { folder: "inbox" }];
		const aggregateKey = ["all-emails", { folder: "inbox" }];
		const detailKey = ["emails", MAILBOX, "m1"];
		seedList(qc, listKey, [row("m1"), row("m2")]);
		seedList(qc, aggregateKey, [row("m1")]);
		qc.setQueryData(detailKey, row("m1"));

		const snapshot = patchEmailInCaches(qc, MAILBOX, "m1", { read: true });

		expect(rowsAt(qc, listKey)[0]?.read).toBe(true);
		expect(rowsAt(qc, listKey)[1]?.read).toBe(false);
		expect(rowsAt(qc, aggregateKey)[0]?.read).toBe(true);
		expect((qc.getQueryData(detailKey) as Row | undefined)?.read).toBe(true);

		// A failed mutation must put every copy back.
		restoreEmailCaches(qc, snapshot);
		expect(rowsAt(qc, listKey)[0]?.read).toBe(false);
		expect(rowsAt(qc, aggregateKey)[0]?.read).toBe(false);
		expect((qc.getQueryData(detailKey) as Row | undefined)?.read).toBe(false);
	});
});

describe("coalesced invalidation", () => {
	it("folds a burst of triage into one leading and one trailing refetch", async () => {
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const listKey = ["emails", MAILBOX, { folder: "inbox" }];
		const list = activeQuery(qc, listKey);
		await until(() => list.calls() >= 1);
		await idle(qc, listKey);
		const baseline = list.calls();

		// Five read toggles in a burst — what scrolling through unread
		// messages looks like from the cache's side. Before coalescing this
		// was five list refetches (plus a folder and an aggregate refetch
		// each); now it is one leading refetch and one catch-up.
		for (let i = 0; i < 5; i += 1) {
			invalidateCoalesced(qc, ["emails", MAILBOX]);
		}

		await until(() => list.calls() === baseline + 1);
		// The catch-up lands when the window closes.
		await until(() => list.calls() === baseline + 2);
		await settleWindow();
		expect(list.calls()).toBe(baseline + 2);
		list.unsubscribe();
	});

	it("refetches once per window, and not again without a fold", async () => {
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const listKey = ["emails", MAILBOX, { folder: "inbox" }];
		const list = activeQuery(qc, listKey);
		await until(() => list.calls() >= 1);
		await idle(qc, listKey);
		const baseline = list.calls();

		invalidateCoalesced(qc, ["emails", MAILBOX]);
		await until(() => list.calls() === baseline + 1);
		await settleWindow();
		// Nothing folded, so the window owed no catch-up.
		expect(list.calls()).toBe(baseline + 1);

		// An action outside the window refetches on its own leading edge.
		invalidateCoalesced(qc, ["emails", MAILBOX]);
		await until(() => list.calls() === baseline + 2);
		await settleWindow();
		expect(list.calls()).toBe(baseline + 2);
		list.unsubscribe();
	});

	it("keys windows per query key, so folders and the list are independent", async () => {
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const listKey = ["emails", MAILBOX, { folder: "inbox" }];
		const foldersKey = ["folders", MAILBOX];
		const list = activeQuery(qc, listKey);
		const folders = activeQuery(qc, foldersKey);
		await until(() => list.calls() >= 1 && folders.calls() >= 1);
		await idle(qc, listKey);
		await idle(qc, foldersKey);

		invalidateCoalesced(qc, ["emails", MAILBOX]);
		invalidateCoalesced(qc, foldersKey);

		await until(() => list.calls() === 2 && folders.calls() === 2);
		list.unsubscribe();
		folders.unsubscribe();
	});

	it("still refetches when the leading edge lands during an in-flight fetch", async () => {
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const listKey = ["emails", MAILBOX, { folder: "inbox" }];
		const list = activeQuery(qc, listKey);
		// Deliberately do not wait for idle: the initial fetch is in flight,
		// so react-query will fold the leading invalidation into it and make
		// no new request. The window must still catch up.
		await until(() => list.calls() >= 1);
		const baseline = list.calls();

		invalidateCoalesced(qc, ["emails", MAILBOX]);

		await until(() => list.calls() === baseline + 1);
		expect(list.calls()).toBe(baseline + 1);
		list.unsubscribe();
	});
});
