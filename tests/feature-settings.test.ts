import { describe, expect, it } from "vitest";
import { normalizeDigestEnabled } from "../shared/digest";
import { normalizeItemsSettings } from "../shared/items";
import { defaultMailboxSettings } from "../workers/lib/mailbox";

describe("normalizeDigestEnabled", () => {
	it("is off unless explicitly enabled", () => {
		expect(normalizeDigestEnabled(undefined)).toBe(false);
		expect(normalizeDigestEnabled(false)).toBe(false);
		expect(normalizeDigestEnabled("true")).toBe(false);
		expect(normalizeDigestEnabled(1)).toBe(false);
		expect(normalizeDigestEnabled(true)).toBe(true);
	});
});

describe("normalizeItemsSettings", () => {
	it("defaults to enabled for mailboxes that predate the switch", () => {
		expect(normalizeItemsSettings(undefined)).toEqual({ enabled: true });
		expect(normalizeItemsSettings({})).toEqual({ enabled: true });
		expect(normalizeItemsSettings("junk")).toEqual({ enabled: true });
	});

	it("only an explicit false turns extraction off", () => {
		expect(normalizeItemsSettings({ enabled: false })).toEqual({ enabled: false });
		expect(normalizeItemsSettings({ enabled: true })).toEqual({ enabled: true });
		expect(normalizeItemsSettings({ enabled: "no" })).toEqual({ enabled: true });
	});
});

describe("defaultMailboxSettings", () => {
	it("carries the wave-4 settings slots", () => {
		const settings = defaultMailboxSettings("Test");
		expect(settings.digestEnabled).toBe(false);
		expect(settings.items).toEqual({ enabled: true });
	});
});
