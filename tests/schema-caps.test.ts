// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Server-side size caps for SendEmailRequestSchema / DraftBodySchema
 * (workers/lib/schemas.ts): subject and body/html character caps mirror
 * MAX_SCHEDULED_* (workers/lib/scheduled-sends.ts), attachment count and
 * bytes mirror the composer caps (app/lib/attachments.ts). Bytes are
 * estimated server-side as floor(base64 length * 3 / 4) without decoding.
 */
import { describe, expect, it } from "vitest";
import {
	MAX_FILES,
	MAX_FILE_BYTES,
	MAX_TOTAL_BYTES,
} from "../app/lib/attachments";
import {
	MAX_SCHEDULED_BODY_CHARS,
	MAX_SCHEDULED_SUBJECT_CHARS,
} from "../workers/lib/scheduled-sends";
import {
	DraftBodySchema,
	SendEmailRequestSchema,
} from "../workers/lib/schemas";


const BASE_SEND = {
	to: "recipient@example.com",
	from: "sender@example.com",
	subject: "hello",
	html: "<p>hi</p>",
};

function sendWith(overrides: Record<string, unknown>) {
	return SendEmailRequestSchema.safeParse({ ...BASE_SEND, ...overrides });
}

describe("SendEmailRequestSchema size caps", () => {
	it("caps the subject at the scheduled-send bound", () => {
		const atLimit = sendWith({
			subject: "s".repeat(MAX_SCHEDULED_SUBJECT_CHARS),
		});
		expect(atLimit.success).toBe(true);

		const overLimit = sendWith({
			subject: "s".repeat(MAX_SCHEDULED_SUBJECT_CHARS + 1),
		});
		expect(overLimit.success).toBe(false);
		if (!overLimit.success) {
			expect(overLimit.error.issues[0]?.path).toEqual(["subject"]);
			expect(overLimit.error.issues[0]?.message).toContain(
				String(MAX_SCHEDULED_SUBJECT_CHARS),
			);
		}
	});

	it("caps html and text at the scheduled-send body bound", () => {
		for (const field of ["html", "text"] as const) {
			const atLimit = sendWith({
				[field]: "b".repeat(MAX_SCHEDULED_BODY_CHARS),
			});
			expect(atLimit.success).toBe(true);

			const overLimit = sendWith({
				[field]: "b".repeat(MAX_SCHEDULED_BODY_CHARS + 1),
			});
			expect(overLimit.success).toBe(false);
			if (!overLimit.success) {
				expect(overLimit.error.issues[0]?.path).toEqual([field]);
			}
		}
	});

	it("caps the attachment count at MAX_FILES", () => {
		const entry = {
			content: "aGk=",
			filename: "hi.txt",
			type: "text/plain",
			disposition: "attachment",
		};
		const atLimit = sendWith({
			attachments: Array.from({ length: MAX_FILES }, () => entry),
		});
		expect(atLimit.success).toBe(true);

		const overLimit = sendWith({
			attachments: Array.from({ length: MAX_FILES + 1 }, () => entry),
		});
		expect(overLimit.success).toBe(false);
		if (!overLimit.success) {
			expect(overLimit.error.issues[0]?.message).toContain(
				`${MAX_FILES} files`,
			);
		}
	});

	it("caps a single file at MAX_FILE_BYTES estimated from base64", () => {
		// floor(len * 3 / 4) > MAX_FILE_BYTES needs len just over
		// (MAX_FILE_BYTES + 1) * 4 / 3 characters.
		const overLen = Math.ceil(((MAX_FILE_BYTES + 1) * 4) / 3);
		const overLimit = sendWith({
			attachments: [
				{
					content: "A".repeat(overLen),
					filename: "huge.bin",
					type: "application/octet-stream",
					disposition: "attachment",
				},
			],
		});
		expect(overLimit.success).toBe(false);
		if (!overLimit.success) {
			expect(overLimit.error.issues[0]?.message).toContain("huge.bin");
		}
	}, 60000);

	it("caps the attachment total at MAX_TOTAL_BYTES", () => {
		// Two files each under the per-file cap that add up over the total:
		// each estimates to just over half of MAX_TOTAL_BYTES.
		const halfLen = Math.ceil(((MAX_TOTAL_BYTES / 2 + 1) * 4) / 3);
		const overLimit = sendWith({
			attachments: [
				{
					content: "A".repeat(halfLen),
					filename: "half-a.bin",
					type: "application/octet-stream",
					disposition: "attachment",
				},
				{
					content: "A".repeat(halfLen),
					filename: "half-b.bin",
					type: "application/octet-stream",
					disposition: "attachment",
				},
			],
		});
		expect(overLimit.success).toBe(false);
		if (!overLimit.success) {
			const messages = overLimit.error.issues.map((issue) => issue.message);
			expect(messages.some((message) => message.includes("total"))).toBe(
				true,
			);
		}
	}, 60000);
});

describe("DraftBodySchema size caps", () => {
	function draftWith(overrides: Record<string, unknown>) {
		return DraftBodySchema.safeParse({
			to: "recipient@example.com",
			subject: "draft",
			body: "<p>draft</p>",
			...overrides,
		});
	}

	it("caps the draft subject and body at the scheduled-send bounds", () => {
		expect(
			draftWith({ subject: "s".repeat(MAX_SCHEDULED_SUBJECT_CHARS) }).success,
		).toBe(true);
		expect(
			draftWith({ subject: "s".repeat(MAX_SCHEDULED_SUBJECT_CHARS + 1) })
				.success,
		).toBe(false);
		expect(
			draftWith({ body: "b".repeat(MAX_SCHEDULED_BODY_CHARS) }).success,
		).toBe(true);
		const overBody = draftWith({
			body: "b".repeat(MAX_SCHEDULED_BODY_CHARS + 1),
		});
		expect(overBody.success).toBe(false);
	});

	it("caps draft attachments like the send schema", () => {
		const entry = {
			content: "aGk=",
			filename: "hi.txt",
			type: "text/plain",
			disposition: "attachment",
		};
		expect(
			draftWith({
				attachments: Array.from({ length: MAX_FILES }, () => entry),
			}).success,
		).toBe(true);
		expect(
			draftWith({
				attachments: Array.from({ length: MAX_FILES + 1 }, () => entry),
			}).success,
		).toBe(false);
	});
});
