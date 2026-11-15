// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Multi-domain mailbox creation (upstream #49): with DOMAINS configured, a
 * mailbox may only be created on one of those domains, mirroring the
 * front-end picker. Explicit EMAIL_ADDRESSES entries bypass the check (they
 * are the authoritative allow-list and may span domains), and an empty
 * DOMAINS imposes no restriction. Send/receive are domain-agnostic and
 * unaffected. Covers the pure helper and the POST /api/v1/mailboxes guard.
 */

import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isMailboxDomainAllowed } from "../shared/mailboxes";
import worker from "../workers/app";
import type { Env } from "../workers/types";

/** The pool's env plus DOMAINS/EMAIL_ADDRESSES overrides, as a deploy sets them. */
function withDomains(overrides: {
	DOMAINS?: string;
	EMAIL_ADDRESSES?: string[];
}): Env {
	return { ...env, ...overrides } as unknown as Env;
}

/** One mailbox-creation request through the real worker fetch. */
function createMailbox(email: string, requestEnv: Env): Promise<Response> {
	return worker.fetch(
		new Request("http://example.com/api/v1/mailboxes", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email, name: "Test" }),
		}),
		requestEnv,
		createExecutionContext(),
	);
}

describe("isMailboxDomainAllowed", () => {
	it("imposes no restriction when DOMAINS is empty", () => {
		expect(isMailboxDomainAllowed("x@anywhere.com", "", [])).toBe(true);
		expect(isMailboxDomainAllowed("x@anywhere.com", undefined, [])).toBe(true);
		expect(isMailboxDomainAllowed("x@anywhere.com", "  ,  ", [])).toBe(true);
	});

	it("restricts creation to the configured domains", () => {
		const domains = "example.com,another.com";
		expect(isMailboxDomainAllowed("hello@example.com", domains, [])).toBe(true);
		expect(isMailboxDomainAllowed("hi@another.com", domains, [])).toBe(true);
		expect(isMailboxDomainAllowed("x@notconfigured.com", domains, [])).toBe(false);
	});

	it("matches case-insensitively and tolerates whitespace", () => {
		expect(
			isMailboxDomainAllowed("Hello@EXAMPLE.COM", " example.com , another.com ", []),
		).toBe(true);
	});

	it("lets an explicit EMAIL_ADDRESSES entry span domains beyond DOMAINS", () => {
		expect(
			isMailboxDomainAllowed("special@other.com", "example.com", ["special@other.com"]),
		).toBe(true);
		// A different address on that same unconfigured domain is still refused.
		expect(
			isMailboxDomainAllowed("other@other.com", "example.com", ["special@other.com"]),
		).toBe(false);
	});

	it("accepts a comma-separated EMAIL_ADDRESSES string too", () => {
		expect(
			isMailboxDomainAllowed("special@other.com", "example.com", "special@other.com"),
		).toBe(true);
	});

	it("rejects a malformed address", () => {
		expect(isMailboxDomainAllowed("not-an-email", "example.com", [])).toBe(false);
		expect(isMailboxDomainAllowed("", "example.com", [])).toBe(false);
	});
});

describe("POST /api/v1/mailboxes domain guard", () => {
	it("creates a mailbox on each configured domain and refuses others", async () => {
		const multi = withDomains({ DOMAINS: "example.com,another.com", EMAIL_ADDRESSES: [] });
		expect((await createMailbox("hello@example.com", multi)).status).toBe(201);
		expect((await createMailbox("hi@another.com", multi)).status).toBe(201);
		const refused = await createMailbox("x@notconfigured.com", multi);
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as { error: string }).error).toBe(
			"Mailbox domain must be one of the configured DOMAINS",
		);
	});

	it("imposes no restriction when DOMAINS is empty", async () => {
		const open = withDomains({ DOMAINS: "", EMAIL_ADDRESSES: [] });
		expect((await createMailbox("x@anywhere.com", open)).status).toBe(201);
	});

	it("lets an explicit EMAIL_ADDRESSES entry bypass the domain check", async () => {
		const bypass = withDomains({
			DOMAINS: "example.com",
			EMAIL_ADDRESSES: ["special@other.com"],
		});
		expect((await createMailbox("special@other.com", bypass)).status).toBe(201);
	});
});
