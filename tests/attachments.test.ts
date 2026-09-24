import { describe, expect, it } from "vitest";
import {
	createPendingAttachment,
	describeAttachmentSummary,
	formatFileSize,
	getAttachmentTotalBytes,
	MAX_FILES,
	MAX_FILE_BYTES,
	MAX_TOTAL_BYTES,
	pendingAttachmentFromStored,
	stripDataUrlPrefix,
	toAttachmentPayloads,
	validateAttachmentSelection,
	type AttachmentCandidate,
	type PendingAttachment,
} from "../app/lib/attachments";
import { SendEmailRequestSchema } from "../workers/lib/schemas";


const MB = 1024 * 1024;


function candidate(filename: string, size: number, type = "application/octet-stream"): AttachmentCandidate {
	return { filename, type, size };
}


function pending(filename: string, size: number, content = "aGVsbG8="): PendingAttachment {
	return createPendingAttachment(candidate(filename, size), content, `local-${filename}`);
}


describe("attachment limits", () => {
	it("mirrors the 25 MB outbound message limit", () => {
		expect(MAX_FILE_BYTES).toBe(25 * MB);
		expect(MAX_TOTAL_BYTES).toBe(25 * MB);
		expect(MAX_FILES).toBe(20);
	});
});


describe("formatFileSize", () => {
	it("formats byte counts for display", () => {
		expect(formatFileSize(0)).toBe("0 B");
		expect(formatFileSize(900)).toBe("900 B");
		expect(formatFileSize(1024)).toBe("1 KB");
		expect(formatFileSize(1536)).toBe("1.5 KB");
		expect(formatFileSize(25 * MB)).toBe("25 MB");
	});


	it("treats negative and non-finite sizes as zero", () => {
		expect(formatFileSize(-5)).toBe("0 B");
		expect(formatFileSize(Number.NaN)).toBe("0 B");
	});
});


describe("validateAttachmentSelection", () => {
	it("accepts files inside every limit", () => {
		const file = candidate("report.pdf", 2 * MB, "application/pdf");
		const result = validateAttachmentSelection([file]);


		expect(result.errors).toEqual([]);
		expect(result.accepted).toEqual([file]);
	});


	it("rejects a single oversized file", () => {
		const result = validateAttachmentSelection([candidate("huge.zip", MAX_FILE_BYTES + 1)]);


		expect(result.accepted).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("huge.zip");
		expect(result.errors[0]).toContain("25 MB");
	});


	it("accepts a file exactly at the per-file limit", () => {
		const result = validateAttachmentSelection([candidate("exact.bin", MAX_FILE_BYTES)]);


		expect(result.accepted).toHaveLength(1);
		expect(result.errors).toEqual([]);
	});


	it("rejects empty files", () => {
		const result = validateAttachmentSelection([candidate("empty.txt", 0)]);


		expect(result.accepted).toEqual([]);
		expect(result.errors[0]).toContain("empty.txt");
	});


	it("stops at the file-count limit", () => {
		const existing = Array.from({ length: MAX_FILES }, (_, index) => ({ size: 1, filename: `f${index}` }));


		const full = validateAttachmentSelection([candidate("one-too-many.txt", 1)], existing);
		expect(full.accepted).toEqual([]);
		expect(full.errors[0]).toContain("up to 20 files");


		const almostFull = validateAttachmentSelection(
			[candidate("last.txt", 1), candidate("overflow.txt", 1)],
			existing.slice(0, MAX_FILES - 1),
		);
		expect(almostFull.accepted.map((file) => file.filename)).toEqual(["last.txt"]);
		expect(almostFull.errors).toHaveLength(1);
		expect(almostFull.errors[0]).toContain("overflow.txt");
	});


	it("stops at the total-size limit", () => {
		const existing = [{ size: MAX_TOTAL_BYTES - 1024 }];


		const over = validateAttachmentSelection([candidate("extra.bin", 2048)], existing);
		expect(over.accepted).toEqual([]);
		expect(over.errors[0]).toContain("extra.bin");
		expect(over.errors[0]).toContain("total limit");


		const exact = validateAttachmentSelection([candidate("fit.bin", 1024)], existing);
		expect(exact.accepted.map((file) => file.filename)).toEqual(["fit.bin"]);
		expect(exact.errors).toEqual([]);
	});


	it("keeps the valid files of a mixed batch", () => {
		const result = validateAttachmentSelection([
			candidate("ok.txt", 10),
			candidate("too-big.bin", MAX_FILE_BYTES + 1),
			candidate("also-ok.txt", 20),
		]);


		expect(result.accepted.map((file) => file.filename)).toEqual(["ok.txt", "also-ok.txt"]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("too-big.bin");
	});


	it("counts the running total against the limit", () => {
		// Two files that each pass the per-file cap but together blow the total.
		const half = MAX_TOTAL_BYTES / 2;
		const result = validateAttachmentSelection([candidate("second-half.bin", half + 1)], [{ size: half }]);


		expect(result.accepted).toEqual([]);
		expect(result.errors).toHaveLength(1);
	});
});


describe("getAttachmentTotalBytes", () => {
	it("sums sizes and ignores non-finite entries", () => {
		expect(getAttachmentTotalBytes([{ size: 10 }, { size: 32 }])).toBe(42);
		expect(getAttachmentTotalBytes([])).toBe(0);
		expect(getAttachmentTotalBytes([{ size: Number.NaN }, { size: 5 }])).toBe(5);
	});
});


describe("createPendingAttachment", () => {
	it("defaults the mime type and disposition", () => {
		const attachment = createPendingAttachment(candidate("notes", 12, ""), "aGVsbG8=", "local-1");


		expect(attachment).toEqual({
			id: "local-1",
			filename: "notes",
			type: "application/octet-stream",
			size: 12,
			content: "aGVsbG8=",
			disposition: "attachment",
		});
	});
});


describe("pendingAttachmentFromStored", () => {
	it("maps stored draft metadata back into composer state", () => {
		const attachment = pendingAttachmentFromStored(
			{
				id: "att-1",
				filename: "invoice.pdf",
				mimetype: "application/pdf",
				size: 2048,
				content_id: null,
				disposition: null,
			},
			"aGVsbG8=",
		);


		expect(attachment.id).toBe("att-1");
		expect(attachment.type).toBe("application/pdf");
		expect(attachment.disposition).toBe("attachment");
		expect(attachment.content).toBe("aGVsbG8=");
		expect(attachment).not.toHaveProperty("contentId");
	});


	it("keeps inline parts and their content id", () => {
		const attachment = pendingAttachmentFromStored(
			{
				id: "att-2",
				filename: "logo.png",
				mimetype: "image/png",
				size: 512,
				content_id: "<logo@example.com>",
				disposition: "inline",
			},
			"aGVsbG8=",
		);


		expect(attachment.disposition).toBe("inline");
		expect(attachment.contentId).toBe("<logo@example.com>");
	});
});


describe("toAttachmentPayloads", () => {
	it("shapes composer files for the API", () => {
		const payloads = toAttachmentPayloads([pending("report.pdf", 2048)]);


		expect(payloads).toEqual([
			{
				content: "aGVsbG8=",
				filename: "report.pdf",
				type: "application/octet-stream",
				disposition: "attachment",
			},
		]);
		expect(payloads[0]).not.toHaveProperty("contentId");
	});


	it("carries the content id of inline parts", () => {
		const inline = { ...pending("logo.png", 512), disposition: "inline" as const, contentId: "<logo@example.com>" };


		expect(toAttachmentPayloads([inline])[0].contentId).toBe("<logo@example.com>");
	});


	it("skips files whose bytes were never read", () => {
		expect(toAttachmentPayloads([pending("broken.bin", 10, "")])).toEqual([]);
	});


	it("produces payloads the send schema accepts", () => {
		const payloads = toAttachmentPayloads([pending("report.pdf", 2048), pending("data.csv", 128)]);


		const parsed = SendEmailRequestSchema.safeParse({
			to: "recipient@example.com",
			from: "sender@example.com",
			subject: "With attachments",
			html: "<p>See attached</p>",
			attachments: payloads,
		});


		expect(parsed.success).toBe(true);
	});


	it("keeps the schema strict about the disposition enum", () => {
		const [payload] = toAttachmentPayloads([pending("report.pdf", 2048)]);


		const parsed = SendEmailRequestSchema.safeParse({
			to: "recipient@example.com",
			from: "sender@example.com",
			subject: "Bad disposition",
			html: "<p>See attached</p>",
			attachments: [{ ...payload, disposition: "bogus" }],
		});


		expect(parsed.success).toBe(false);
	});


	it("round-trips a re-opened draft attachment through the schema", () => {
		const hydrated = pendingAttachmentFromStored(
			{
				id: "att-1",
				filename: "invoice.pdf",
				mimetype: "application/pdf",
				size: 2048,
				content_id: null,
				disposition: "attachment",
			},
			"aGVsbG8=",
		);


		const parsed = SendEmailRequestSchema.safeParse({
			to: "recipient@example.com",
			from: "sender@example.com",
			subject: "Re-opened draft",
			html: "<p>See attached</p>",
			attachments: toAttachmentPayloads([hydrated]),
		});


		expect(parsed.success).toBe(true);
	});
});


describe("describeAttachmentSummary", () => {
	it("is null with nothing attached", () => {
		expect(describeAttachmentSummary([])).toBeNull();
	});


	it("reports the count and total size", () => {
		expect(describeAttachmentSummary([{ size: 1024 }])).toBe("1 file · 1 KB of 25 MB");
		expect(describeAttachmentSummary([{ size: 1024 }, { size: 512 }])).toBe("2 files · 1.5 KB of 25 MB");
	});
});


describe("stripDataUrlPrefix", () => {
	it("removes the data URL prefix FileReader adds", () => {
		expect(stripDataUrlPrefix("data:application/pdf;base64,aGVsbG8=")).toBe("aGVsbG8=");
		expect(stripDataUrlPrefix("data:;base64,aGVsbG8=")).toBe("aGVsbG8=");
	});


	it("leaves bare base64 untouched", () => {
		expect(stripDataUrlPrefix("aGVsbG8=")).toBe("aGVsbG8=");
	});
});
