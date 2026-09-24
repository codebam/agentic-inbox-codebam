// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * List-Unsubscribe parsing shared by the message panel's unsubscribe banner.
 *
 * The raw header never reaches the screen; the banner only needs to know
 * which of three affordances a message offers, following RFC 2369 (header
 * format) and RFC 8058 (the one-click marker):
 *  - "one_click": an https: URL plus the marker — the banner may POST to
 *    the URL, and only from an explicit user click;
 *  - "manual": an https: URL without the marker — link out only;
 *  - "mailto": a mailto: address — open the composer, the user sends it.
 */

export type UnsubscribeMethod = "one_click" | "manual" | "mailto";

export interface UnsubscribeTarget {
	method: UnsubscribeMethod;
	/** https: URL to POST to (one_click) or open in a new tab (manual). */
	url: string | null;
	/** Address the composer is prefilled with (mailto). */
	address: string | null;
}

/** True when the List-Unsubscribe-Post header carries the RFC 8058 marker. */
function hasOneClickMarker(header: string | null | undefined): boolean {
	return /List-Unsubscribe\s*=\s*One-Click/i.test(header ?? "");
}

/** The <...> entries of the header, in order; some senders omit the brackets. */
function headerEntries(header: string): string[] {
	const bracketed = [...header.matchAll(/<([^>]*)>/g)]
		.map((match) => match[1]?.trim() ?? "")
		.filter((entry) => entry !== "");
	if (bracketed.length > 0) return bracketed;
	return header
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
}

/** The entry as an https: URL, or null when it is not one. */
function asHttpsUrl(entry: string): string | null {
	try {
		return new URL(entry).protocol === "https:" ? entry : null;
	} catch {
		return null;
	}
}

/** The address in a mailto: entry, without any `?subject=`-style query. */
function asMailtoAddress(entry: string): string | null {
	const address = entry.slice("mailto:".length).split("?")[0]?.trim() ?? "";
	if (address === "") return null;
	try {
		return decodeURIComponent(address);
	} catch {
		return address;
	}
}

/**
 * Which unsubscribe affordance `list_unsubscribe` offers, or null when the
 * header is missing or carries no usable URL or address. An https: URL wins
 * over a mailto: entry, and the one-click marker only changes the URL case.
 */
export function resolveUnsubscribeTarget(
	listUnsubscribe: string | null | undefined,
	listUnsubscribePost: string | null | undefined,
): UnsubscribeTarget | null {
	const header = (listUnsubscribe ?? "").trim();
	if (header === "") return null;

	let url: string | null = null;
	let address: string | null = null;
	for (const entry of headerEntries(header)) {
		const lower = entry.toLowerCase();
		if (!url && lower.startsWith("https:")) {
			url = asHttpsUrl(entry);
		} else if (!address && lower.startsWith("mailto:")) {
			address = asMailtoAddress(entry);
		}
	}

	if (url) {
		return {
			method: hasOneClickMarker(listUnsubscribePost) ? "one_click" : "manual",
			url,
			address: null,
		};
	}
	if (address) return { method: "mailto", url: null, address };
	return null;
}
