import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import {
	emptyRuleRunResult,
	matchRule,
	runRules,
	type MailRule,
	type RuleDraft,
	type RuleEmail,
} from "../workers/lib/rules";
import { CreateRuleSchema, ReorderRulesSchema } from "../workers/lib/schemas";


const MAILBOX = "rules@example.com";


function stubFor(mailbox = MAILBOX) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
}


/** Register the mailbox record the API middleware checks before routing. */
async function registerMailbox(mailbox: string) {
	await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));
}


/**
 * POST a rule through the real route.
 *
 * Validation failures are asserted at the HTTP contract on purpose: a rejected
 * Durable Object RPC call is also reported by the vitest pool as an unhandled
 * rejection, which would fail the whole run even though the test passed.
 */
async function postRule(mailbox: string, body: unknown) {
	await registerMailbox(mailbox);
	const res = await SELF.fetch(
		`http://example.com/api/v1/mailboxes/${mailbox}/rules`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	return { status: res.status, body: (await res.json()) as { error?: string } };
}


/** Build a complete rule from partial overrides (pure tests). */
function makeRule(overrides: Partial<MailRule> = {}): MailRule {
	return {
		id: overrides.id ?? crypto.randomUUID(),
		name: overrides.name ?? "rule",
		enabled: overrides.enabled ?? true,
		priority: overrides.priority ?? 0,
		match: overrides.match ?? { mode: "all", conditions: {} },
		actions: overrides.actions ?? {},
		created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
	};
}


const EMAIL: RuleEmail = {
	sender: "Alice <alice@Corp.example>",
	recipient: "me@example.com",
	envelope_recipient: "me@example.com",
	cc: null,
	bcc: null,
	subject: "Quarterly INVOICE for March",
	body: "<p>Please find the invoice attached.</p>",
	has_attachment: true,
	category: null,
};


describe("matchRule", () => {
	it("requires every condition in 'all' mode", () => {
		const rule = makeRule({
			match: {
				mode: "all",
				conditions: { from_contains: "corp.example", subject_contains: "invoice" },
			},
		});

		expect(matchRule(rule, EMAIL)).toBe(true);
		expect(
			matchRule(rule, { ...EMAIL, subject: "Lunch on Friday?" }),
		).toBe(false);
		expect(
			matchRule(rule, { ...EMAIL, sender: "bob@other.example" }),
		).toBe(false);
	});


	it("matches on a single condition in 'any' mode", () => {
		const rule = makeRule({
			match: {
				mode: "any",
				conditions: { from_contains: "nobody@nowhere.example", subject_contains: "invoice" },
			},
		});

		expect(matchRule(rule, EMAIL)).toBe(true);
		expect(matchRule(rule, { ...EMAIL, subject: "hello" })).toBe(false);
	});


	it("compares case-insensitively and as substrings", () => {
		expect(
			matchRule(
				makeRule({ match: { mode: "all", conditions: { from_contains: "ALICE@corp" } } }),
				EMAIL,
			),
		).toBe(true);
		expect(
			matchRule(
				makeRule({ match: { mode: "all", conditions: { subject_contains: "invoice" } } }),
				EMAIL,
			),
		).toBe(true);
		expect(
			matchRule(
				makeRule({ match: { mode: "all", conditions: { body_contains: "INVOICE ATTACHED" } } }),
				EMAIL,
			),
		).toBe(true);
		expect(
			matchRule(
				makeRule({ match: { mode: "all", conditions: { body_contains: "not present" } } }),
				EMAIL,
			),
		).toBe(false);
	});


	it("tests has_attachment exactly", () => {
		const withAttachment = makeRule({
			match: { mode: "all", conditions: { has_attachment: true } },
		});
		const withoutAttachment = makeRule({
			match: { mode: "all", conditions: { has_attachment: false } },
		});

		expect(matchRule(withAttachment, EMAIL)).toBe(true);
		expect(matchRule(withoutAttachment, EMAIL)).toBe(false);
		expect(matchRule(withAttachment, { ...EMAIL, has_attachment: false })).toBe(false);
		expect(matchRule(withoutAttachment, { ...EMAIL, has_attachment: undefined })).toBe(true);
	});


	it("matches category_equals case-insensitively but not partially", () => {
		const rule = makeRule({
			match: { mode: "all", conditions: { category_equals: "Work" } },
		});

		expect(matchRule(rule, { ...EMAIL, category: "work" })).toBe(true);
		expect(matchRule(rule, { ...EMAIL, category: "work-archive" })).toBe(false);
		expect(matchRule(rule, { ...EMAIL, category: null })).toBe(false);
	});


	it("matches to_contains against envelope, cc, and bcc recipients", () => {
		const rule = makeRule({
			match: { mode: "all", conditions: { to_contains: "hidden@example.com" } },
		});

		expect(matchRule(rule, { ...EMAIL, bcc: "hidden@example.com" })).toBe(true);
		expect(matchRule(rule, { ...EMAIL, cc: "Hidden@Example.com" })).toBe(true);
		expect(matchRule(rule, { ...EMAIL, envelope_recipient: "hidden@example.com" })).toBe(true);
		expect(matchRule(rule, EMAIL)).toBe(false);
	});


	it("never matches a rule without active conditions or when disabled", () => {
		expect(matchRule(makeRule(), EMAIL)).toBe(false);
		expect(
			matchRule(
				makeRule({
					enabled: false,
					match: { mode: "any", conditions: { from_contains: "alice" } },
				}),
				EMAIL,
			),
		).toBe(false);
		// Blank strings are not conditions.
		expect(
			matchRule(
				makeRule({ match: { mode: "all", conditions: { subject_contains: "   " } } }),
				EMAIL,
			),
		).toBe(false);
	});
});


describe("runRules", () => {
	it("returns an inert result when nothing matches", () => {
		const result = runRules(
			[makeRule({ match: { mode: "all", conditions: { subject_contains: "nope" } } })],
			EMAIL,
		);

		expect(result).toEqual(emptyRuleRunResult());
	});


	it("applies matching rules in ascending priority order", () => {
		const result = runRules(
			[
				makeRule({
					id: "second",
					name: "file-invoice",
					priority: 2,
					match: { mode: "all", conditions: { subject_contains: "invoice" } },
					actions: { move_to_folder: Folders.ARCHIVE },
				}),
				makeRule({
					id: "first",
					name: "star-boss",
					priority: 1,
					match: { mode: "all", conditions: { from_contains: "corp.example" } },
					actions: { star: true },
				}),
			],
			EMAIL,
		);

		expect(result.appliedRules).toEqual(["star-boss", "file-invoice"]);
		expect(result.appliedRuleIds).toEqual(["first", "second"]);
		expect(result.mutation).toEqual({
			folder: Folders.ARCHIVE,
			starred: true,
		});
		expect(result.routed).toBe(true);
		expect(result.discarded).toBe(false);
	});


	it("keeps the first rule's value when rules conflict", () => {
		const result = runRules(
			[
				makeRule({
					name: "high-precedence",
					priority: 0,
					match: { mode: "any", conditions: { from_contains: "alice" } },
					actions: { move_to_folder: Folders.ARCHIVE, set_category: "work", mark_read: true },
				}),
				makeRule({
					name: "low-precedence",
					priority: 9,
					match: { mode: "any", conditions: { subject_contains: "invoice" } },
					actions: { move_to_folder: Folders.TRASH, set_category: "spam", mark_unread: true },
				}),
			],
			EMAIL,
		);

		expect(result.appliedRules).toEqual(["high-precedence", "low-precedence"]);
		expect(result.mutation).toEqual({
			folder: Folders.ARCHIVE,
			category: "work",
			read: true,
		});
	});


	it("fills in fields the earlier rule left unset", () => {
		const result = runRules(
			[
				makeRule({
					name: "folder-only",
					priority: 0,
					match: { mode: "any", conditions: { from_contains: "alice" } },
					actions: { move_to_folder: Folders.ARCHIVE },
				}),
				makeRule({
					name: "category-only",
					priority: 1,
					match: { mode: "any", conditions: { subject_contains: "invoice" } },
					actions: { set_category: "finance", star: true },
				}),
			],
			EMAIL,
		);

		expect(result.mutation).toEqual({
			folder: Folders.ARCHIVE,
			category: "finance",
			starred: true,
		});
	});


	it("skips disabled rules", () => {
		const result = runRules(
			[
				makeRule({
					name: "disabled",
					enabled: false,
					priority: 0,
					match: { mode: "any", conditions: { from_contains: "alice" } },
					actions: { discard: true },
				}),
			],
			EMAIL,
		);

		expect(result).toEqual(emptyRuleRunResult());
	});


	it("stops at a discard match and reports no routing", () => {
		const result = runRules(
			[
				makeRule({
					name: "drop-newsletters",
					priority: 0,
					match: { mode: "all", conditions: { from_contains: "alice" } },
					actions: { discard: true },
				}),
				makeRule({
					name: "never-reached",
					priority: 1,
					match: { mode: "any", conditions: { subject_contains: "invoice" } },
					actions: { move_to_folder: Folders.ARCHIVE },
				}),
			],
			EMAIL,
		);

		expect(result.discarded).toBe(true);
		expect(result.routed).toBe(false);
		expect(result.appliedRules).toEqual(["drop-newsletters"]);
		expect(result.mutation).toEqual({});
	});


	it("maps mark_unread and unstar to false flags", () => {
		const result = runRules(
			[
				makeRule({
					match: { mode: "any", conditions: { from_contains: "alice" } },
					actions: { mark_unread: true, unstar: true },
				}),
			],
			EMAIL,
		);

		expect(result.mutation).toEqual({ read: false, starred: false });
	});
});


describe("MailboxDO rules CRUD", () => {
	const draft = (overrides: Partial<RuleDraft> = {}): RuleDraft => ({
		name: overrides.name ?? "File invoices",
		match: overrides.match ?? {
			mode: "all",
			conditions: { subject_contains: "invoice" },
		},
		actions: overrides.actions ?? { move_to_folder: Folders.ARCHIVE },
		...(overrides.enabled === undefined ? {} : { enabled: overrides.enabled }),
		...(overrides.priority === undefined ? {} : { priority: overrides.priority }),
	});


	it("creates a rule with defaults and reads it back", async () => {
		const stub = stubFor("crud@example.com");
		const created = await stub.createRule(draft({ name: "Invoices" }));

		expect(created.id).toBeTruthy();
		expect(created.name).toBe("Invoices");
		expect(created.enabled).toBe(true);
		expect(created.priority).toBe(0);
		expect(created.match.conditions.subject_contains).toBe("invoice");
		expect(created.actions.move_to_folder).toBe(Folders.ARCHIVE);
		expect(typeof created.created_at).toBe("string");

		const listed = await stub.listRules();
		expect(listed.map((rule) => rule.id)).toEqual([created.id]);
	});


	it("resolves folder display names and rejects unknown folders", async () => {
		const mailbox = "folders@example.com";
		const stub = stubFor(mailbox);
		const created = await stub.createRule(
			draft({ actions: { move_to_folder: "Archive" } }),
		);
		expect(created.actions.move_to_folder).toBe(Folders.ARCHIVE);

		const rejected = await postRule(
			mailbox,
			draft({ actions: { move_to_folder: "no-such-folder" } }),
		);
		expect(rejected.status).toBe(400);
		expect(rejected.body.error).toMatch(/Unknown folder/);
	});


	it("rejects rules with no conditions or no actions", async () => {
		const mailbox = "invalid@example.com";

		const noConditions = await postRule(
			mailbox,
			draft({ match: { mode: "all", conditions: { subject_contains: "  " } } }),
		);
		expect(noConditions.status).toBe(400);
		expect(noConditions.body.error).toMatch(/at least one match condition/);

		const noActions = await postRule(mailbox, draft({ actions: { discard: false } }));
		expect(noActions.status).toBe(400);
		expect(noActions.body.error).toMatch(/at least one action/);

		const conflicting = await postRule(
			mailbox,
			draft({ actions: { mark_read: true, mark_unread: true } }),
		);
		expect(conflicting.status).toBe(400);
		expect(conflicting.body.error).toMatch(/cannot both be set/);
	});


	it("appends new rules to the end of the priority order", async () => {
		const stub = stubFor("priority@example.com");
		const first = await stub.createRule(draft({ name: "first" }));
		const second = await stub.createRule(draft({ name: "second" }));
		const explicit = await stub.createRule(draft({ name: "explicit", priority: 0 }));

		expect(first.priority).toBe(0);
		expect(second.priority).toBe(1);
		expect(explicit.priority).toBe(0);

		const listed = await stub.listRules();
		// Ascending priority; ties keep creation order.
		expect(listed.map((rule) => rule.name)).toEqual(["first", "explicit", "second"]);
	});


	it("updates a rule and reports unknown ids", async () => {
		const stub = stubFor("update@example.com");
		const created = await stub.createRule(draft());

		const updated = await stub.updateRule(created.id, {
			name: "Renamed",
			enabled: false,
			match: { mode: "any", conditions: { from_contains: "billing@" } },
			actions: { star: true },
		});

		expect(updated?.name).toBe("Renamed");
		expect(updated?.enabled).toBe(false);
		expect(updated?.match.mode).toBe("any");
		expect(updated?.match.conditions.from_contains).toBe("billing@");
		expect(updated?.actions).toEqual({ star: true });
		expect(updated?.created_at).toBe(created.created_at);

		// A partial patch leaves other fields alone.
		const patched = await stub.updateRule(created.id, { enabled: true });
		expect(patched?.enabled).toBe(true);
		expect(patched?.name).toBe("Renamed");
		expect(patched?.actions).toEqual({ star: true });

		expect(await stub.updateRule("missing-id", { name: "nope" })).toBeNull();
	});


	it("deletes rules and reports unknown ids", async () => {
		const stub = stubFor("delete@example.com");
		const created = await stub.createRule(draft());

		expect(await stub.deleteRule(created.id)).toBe(true);
		expect(await stub.deleteRule(created.id)).toBe(false);
		expect(await stub.listRules()).toEqual([]);
	});


	it("reorders rules by id", async () => {
		const stub = stubFor("reorder@example.com");
		const a = await stub.createRule(draft({ name: "a" }));
		const b = await stub.createRule(draft({ name: "b" }));
		const c = await stub.createRule(draft({ name: "c" }));

		const reordered = await stub.reorderRules([c.id, a.id, b.id]);
		expect(reordered.map((rule) => rule.name)).toEqual(["c", "a", "b"]);
		expect(reordered.map((rule) => rule.priority)).toEqual([0, 1, 2]);

		// Unknown ids are ignored; unlisted rules keep their relative order.
		const again = await stub.reorderRules(["not-a-rule", b.id]);
		expect(again.map((rule) => rule.name)).toEqual(["b", "c", "a"]);
	});


	it("runs stored rules in priority order through the engine", async () => {
		const stub = stubFor("engine@example.com");
		await stub.createRule(
			draft({
				name: "archive-invoices",
				priority: 1,
				actions: { move_to_folder: Folders.ARCHIVE, mark_read: true },
			}),
		);
		await stub.createRule(
			draft({
				name: "star-boss",
				priority: 0,
				match: { mode: "all", conditions: { from_contains: "corp.example" } },
				actions: { star: true },
			}),
		);

		const result = runRules(await stub.listRules(), EMAIL);

		expect(result.appliedRules).toEqual(["star-boss", "archive-invoices"]);
		expect(result.mutation).toEqual({
			folder: Folders.ARCHIVE,
			read: true,
			starred: true,
		});
		expect(result.routed).toBe(true);
	});
});




describe("rule editor payload contract", () => {
	// The rules UI (app/routes/rules.tsx) builds this exact shape and the API
	// validates it with CreateRuleSchema, so any drift between the two shows up
	// as a 400 in the browser. Pin them together here.
	const uiPayload = {
		name: "File invoices from Alice",
		enabled: true,
		match: {
			mode: "all" as const,
			conditions: {
				from_contains: "alice@corp.example",
				to_contains: "me@example.com",
				subject_contains: "invoice",
				body_contains: "purchase order",
				has_attachment: true,
				category_equals: "finance",
			},
		},
		actions: {
			move_to_folder: Folders.ARCHIVE,
			set_category: "finance",
			mark_read: true,
			star: true,
		},
	};




	it("accepts the fully-populated editor payload and stores it intact", async () => {
		const parsed = CreateRuleSchema.safeParse(uiPayload);
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;




		const stub = stubFor("editor@example.com");
		const created = await stub.createRule(parsed.data);
		const stored = (await stub.listRules()).find((rule) => rule.id === created.id);




		expect(stored?.match).toEqual(uiPayload.match);
		expect(stored?.actions).toEqual(uiPayload.actions);
		expect(stored?.enabled).toBe(true);
		expect(stored?.priority).toBe(0);
	});




	it("accepts the editor's tri-state choices for unset fields", () => {
		// "Any message" / "Any category" / "Leave unchanged" map to omitted
		// keys; "Has no attachment" is the one condition that sends `false`.
		const parsed = CreateRuleSchema.safeParse({
			name: "No attachments",
			match: { mode: "any", conditions: { has_attachment: false } },
			actions: { unstar: true, discard: true },
		});


		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.match.conditions).toEqual({ has_attachment: false });
		expect(parsed.data.actions).toEqual({ unstar: true, discard: true });
	});




	it("rejects the half-finished forms the editor blocks client-side", () => {
		// Empty form: no conditions, no actions.
		expect(
			CreateRuleSchema.safeParse({
				name: "Empty",
				match: { mode: "all", conditions: {} },
				actions: {},
			}).success,
		).toBe(false);


		// Conditions but nothing to do.
		expect(
			CreateRuleSchema.safeParse({
				name: "Conditions only",
				match: { mode: "all", conditions: { subject_contains: "hi" } },
				actions: {},
			}).success,
		).toBe(false);


		// An action but nothing to match on.
		expect(
			CreateRuleSchema.safeParse({
				name: "Actions only",
				match: { mode: "all", conditions: {} },
				actions: { mark_read: true },
			}).success,
		).toBe(false);
	});




	it("accepts the reorder payload the up/down buttons send", () => {
		expect(ReorderRulesSchema.safeParse({ ids: ["a", "b"] }).success).toBe(true);
		expect(ReorderRulesSchema.safeParse({ ids: [] }).success).toBe(false);
	});
});
