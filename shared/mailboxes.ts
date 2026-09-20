// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mailbox naming and catch-all configuration shared by the Worker and the UI.
 *
 * Every configured domain gets a conventional catch-all mailbox:
 * `catch-all@<domain>`. Dedicated mailboxes always take precedence; messages
 * to an address without its own mailbox are delivered to that domain's
 * catch-all mailbox instead of being dropped.
 */

export const CATCH_ALL_LOCAL_PART = "catch-all";

/**
 * Durable Object instance name used by the built-in agent chat when it is
 * opened from the All Accounts view. The agent recognizes this sentinel and
 * exposes cross-mailbox tools instead of being bound to one inbox.
 *
 * The double underscores keep it from ever colliding with a real mailbox
 * address (which always contains `@`).
 */
export const ALL_MAILBOXES_AGENT_ID = "__all_mailboxes__";

/** True when an EmailAgent instance name is the all-mailboxes sentinel. */
export function isAllMailboxesAgentId(value: unknown): boolean {
	return typeof value === "string" && value === ALL_MAILBOXES_AGENT_ID;
}

/**
 * Conventional spellings recognised as catch-all mailboxes. The first one is
 * the address the app creates automatically; the rest are accepted for
 * deployments that already made a mailbox by hand.
 */
export const CATCH_ALL_LOCAL_PARTS = [
	"catch-all",
	"catchall",
	"catch_all",
] as const;

export interface CatchAllMailboxConfig {
	DOMAINS?: unknown;
	CATCH_ALL_MAILBOX?: unknown;
	CATCH_ALL_MAILBOXES?: unknown;
}

/** Normalize a single email address, or return null when it is not usable. */
export function normalizeEmailAddress(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const address = value.trim().toLowerCase();
	if (!address || /[\s<>]/.test(address)) return null;
	const at = address.lastIndexOf("@");
	if (at <= 0 || at === address.length - 1) return null;
	const localPart = address.slice(0, at);
	const domain = address.slice(at + 1);
	if (!localPart || !domain) return null;
	return address;
}

/** Split a comma-separated DOMAINS value (or array) into unique lower-case domains. */
export function parseDomains(value: unknown): string[] {
	const values = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(",")
			: [];
	return [
		...new Set(
			values
				.map((domain) => String(domain).trim().toLowerCase())
				.filter(Boolean),
		),
	];
}

/** Normalize an EMAIL_ADDRESSES-style value into a de-duplicated list. */
export function normalizeEmailAddressList(value: unknown): string[] {
	const values = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(",")
			: [];
	const addresses = values
		.map((address) => normalizeEmailAddress(address))
		.filter((address): address is string => address !== null);
	return [...new Set(addresses)];
}

/** True when an EMAIL_ADDRESSES value is configured (even if malformed). */
export function hasConfiguredAddresses(value: unknown): boolean {
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "string") return value.trim().length > 0;
	return false;
}

/** Domain part of a normalized email address. */
export function emailDomain(address: string): string | null {
	const normalized = normalizeEmailAddress(address);
	if (!normalized) return null;
	return normalized.slice(normalized.lastIndexOf("@") + 1);
}

/** Canonical catch-all mailbox for a domain. */
export function catchAllAddressForDomain(domain: string): string {
	return `${CATCH_ALL_LOCAL_PART}@${domain.trim().toLowerCase()}`;
}

/** True when the address uses one of the conventional catch-all local parts. */
export function isCatchAllAddress(value: string): boolean {
	const normalized = normalizeEmailAddress(value);
	if (!normalized) return false;
	const localPart = normalized.slice(0, normalized.lastIndexOf("@"));
	return (CATCH_ALL_LOCAL_PARTS as readonly string[]).includes(localPart);
}

export function isMailboxCreationAllowed(
	rawEmail: unknown,
	rawConfiguredAddresses: unknown,
	extraAllowed: Iterable<string> = [],
): boolean {
	const email = normalizeEmailAddress(rawEmail);
	if (!email) return false;
	if (!hasConfiguredAddresses(rawConfiguredAddresses)) return true;
	if (normalizeEmailAddressList(rawConfiguredAddresses).includes(email))
		return true;
	for (const allowed of extraAllowed) {
		if (normalizeEmailAddress(allowed) === email) return true;
	}
	return false;
}

/**
 * Resolve the catch-all mailbox for every configured domain.
 *
 * Precedence:
 * 1. `CATCH_ALL_MAILBOXES`: a comma-separated/array list of mailbox addresses.
 * 2. `CATCH_ALL_MAILBOX`: one global catch-all mailbox for all domains.
 * 3. Derived defaults: `catch-all@<domain>` for every domain in `DOMAINS`.
 *
 * An explicitly configured but invalid/empty value disables catch-all rather
 * than silently falling back to a different address.
 */
export function resolveCatchAllMailboxes(
	env: CatchAllMailboxConfig,
): Map<string, string> {
	const domains = parseDomains(env.DOMAINS);
	const map = new Map<string, string>();

	if (
		env.CATCH_ALL_MAILBOXES !== undefined &&
		env.CATCH_ALL_MAILBOXES !== null
	) {
		const configured = normalizeEmailAddressList(env.CATCH_ALL_MAILBOXES);
		if (configured.length === 0) return map;
		for (const address of configured) {
			const domain = emailDomain(address);
			if (!domain) continue;
			if (domains.length > 0 && !domains.includes(domain)) continue;
			map.set(domain, address);
		}
		return map;
	}

	if (env.CATCH_ALL_MAILBOX !== undefined && env.CATCH_ALL_MAILBOX !== null) {
		const address = normalizeEmailAddress(env.CATCH_ALL_MAILBOX);
		if (!address) return map;
		const domain = emailDomain(address);
		if (!domain) return map;
		if (domains.length > 0 && !domains.includes(domain)) return map;
		const targetDomains = domains.length > 0 ? domains : [domain];
		for (const targetDomain of targetDomains) map.set(targetDomain, address);
		return map;
	}

	for (const domain of domains) {
		map.set(domain, catchAllAddressForDomain(domain));
	}
	return map;
}
