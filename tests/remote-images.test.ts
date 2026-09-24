import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	BLOCKED_IMAGE_DATA_URI,
	MAX_IMAGE_ALLOWLIST_ENTRIES,
	blockRemoteImages,
	buildEmailIframeCsp,
	hasRemoteImages,
	isRemoteImageUrl,
	isSenderAllowlisted,
	normalizeImageAllowlist,
	senderAddress,
} from "../shared/remote-images";

const TRACKER = "https://tracker.example.com/open.gif";
const PROTOCOL_RELATIVE = "//cdn.example.com/banner.png";
const CID = "cid:logo@example.com";
const DATA_IMAGE = "data:image/png;base64,iVBORw0KGgo=";

describe("isRemoteImageUrl", () => {
	it("detects http(s) and protocol-relative URLs, case-insensitively", () => {
		expect(isRemoteImageUrl("http://example.com/a.gif")).toBe(true);
		expect(isRemoteImageUrl("https://example.com/a.gif")).toBe(true);
		expect(isRemoteImageUrl("HTTPS://EXAMPLE.COM/a.gif")).toBe(true);
		expect(isRemoteImageUrl("//example.com/a.gif")).toBe(true);
	});

	it("ignores non-remote schemes, relative paths and empty values", () => {
		expect(isRemoteImageUrl(CID)).toBe(false);
		expect(isRemoteImageUrl(DATA_IMAGE)).toBe(false);
		expect(isRemoteImageUrl("/api/v1/mailboxes/m/emails/e/attachments/a")).toBe(false);
		expect(isRemoteImageUrl("blob:https://example.com/id")).toBe(false);
		expect(isRemoteImageUrl("")).toBe(false);
	});

	it("sees through control characters browsers ignore when parsing URLs", () => {
		expect(isRemoteImageUrl(" ht\ntps://example.com/a.gif ")).toBe(true);
		expect(isRemoteImageUrl("https://exa\u0000mple.com/a.gif")).toBe(true);
	});
});

describe("blockRemoteImages", () => {
	it("replaces a remote src with the placeholder", () => {
		const result = blockRemoteImages(`<p>hi</p><img src="${TRACKER}" alt="logo">`);
		expect(result.blockedCount).toBe(1);
		expect(result.html).toBe(
			`<p>hi</p><img src="${BLOCKED_IMAGE_DATA_URI}" alt="logo">`,
		);
	});

	it("blocks protocol-relative sources and uppercase attribute names", () => {
		const result = blockRemoteImages(
			`<IMG SRC="${PROTOCOL_RELATIVE}" WIDTH="10">`,
		);
		expect(result.blockedCount).toBe(1);
		expect(result.html).toBe(
			`<IMG SRC="${BLOCKED_IMAGE_DATA_URI}" WIDTH="10">`,
		);
	});

	it("leaves cid: and data: images untouched", () => {
		const body = `<img src="${CID}"><img src="${DATA_IMAGE}"><img src="cid:inline-2">`;
		const result = blockRemoteImages(body);
		expect(result.blockedCount).toBe(0);
		expect(result.html).toBe(body);
	});

	it("keeps everything else in the tag byte for byte", () => {
		const body = `<img  SRC = "${TRACKER}"\n\talt='a "quoted" > value' data-x="1">`;
		const result = blockRemoteImages(body);
		expect(result.blockedCount).toBe(1);
		expect(result.html).toBe(
			`<img  SRC = "${BLOCKED_IMAGE_DATA_URI}"\n\talt='a "quoted" > value' data-x="1">`,
		);
	});

	it("never rewrites attribute values that merely mention src", () => {
		const body = `<img alt="src=https://evil.example.com/x" src="${CID}">`;
		const result = blockRemoteImages(body);
		expect(result.blockedCount).toBe(0);
		expect(result.html).toBe(body);
	});

	it("quotes a blocked unquoted src value", () => {
		const result = blockRemoteImages(`<img src=${TRACKER} alt=hi>`);
		expect(result.blockedCount).toBe(1);
		expect(result.html).toBe(`<img src="${BLOCKED_IMAGE_DATA_URI}" alt=hi>`);
	});

	it("rewrites remote srcset candidates and keeps descriptors and local ones", () => {
		const result = blockRemoteImages(
			`<img srcset="https://a.example.com/1.gif 1x, cid:big 2x, ${PROTOCOL_RELATIVE} 640w">`,
		);
		expect(result.blockedCount).toBe(2);
		expect(result.html).toBe(
			`<img srcset="${BLOCKED_IMAGE_DATA_URI} 1x, cid:big 2x, ${BLOCKED_IMAGE_DATA_URI} 640w">`,
		);
	});

	it("does not corrupt data: URIs inside a srcset", () => {
		const body = `<img srcset="data:image/gif;base64,AA,BB 1x, ${TRACKER} 2x">`;
		const result = blockRemoteImages(body);
		expect(result.blockedCount).toBe(1);
		expect(result.html).toBe(
			`<img srcset="data:image/gif;base64,AA,BB 1x, ${BLOCKED_IMAGE_DATA_URI} 2x">`,
		);
	});

	it("counts every blocked reference across the body", () => {
		const result = blockRemoteImages(
			`<img src="${TRACKER}"><img src="${PROTOCOL_RELATIVE}" srcset="${TRACKER} 2x">`,
		);
		expect(result.blockedCount).toBe(3);
	});

	it("returns image-free and empty bodies unchanged", () => {
		const body = `<p>no images here</p><a href="${TRACKER}">link</a>`;
		expect(blockRemoteImages(body)).toEqual({ html: body, blockedCount: 0 });
		expect(blockRemoteImages("")).toEqual({ html: "", blockedCount: 0 });
	});
});

describe("hasRemoteImages", () => {
	it("is true only when a remote image reference is present", () => {
		expect(hasRemoteImages(`<img src="${TRACKER}">`)).toBe(true);
		expect(hasRemoteImages(`<img src="${PROTOCOL_RELATIVE}">`)).toBe(true);
		expect(hasRemoteImages(`<img src="${CID}">`)).toBe(false);
		expect(hasRemoteImages(`<img src="${DATA_IMAGE}">`)).toBe(false);
		expect(hasRemoteImages("<p>plain text</p>")).toBe(false);
		expect(hasRemoteImages("")).toBe(false);
	});
});

describe("buildEmailIframeCsp", () => {
	it("blocks remote hosts when images are blocked, keeping inline images", () => {
		const csp = buildEmailIframeCsp(false, "https://app.example.com");
		expect(csp).toBe(
			"default-src 'none'; style-src 'unsafe-inline'; img-src data: cid: https://app.example.com; script-src 'unsafe-inline';",
		);
		expect(csp).not.toContain("https:;");
	});

	it("allows https images only when the user opted in", () => {
		expect(buildEmailIframeCsp(true)).toBe(
			"default-src 'none'; style-src 'unsafe-inline'; img-src data: cid: https:; script-src 'unsafe-inline';",
		);
	});
});

describe("senderAddress", () => {
	it("extracts the bare address from display-name senders", () => {
		expect(senderAddress("Ada Lovelace <Ada@Example.com>")).toBe("ada@example.com");
		expect(senderAddress("ada@example.com")).toBe("ada@example.com");
		expect(senderAddress("  <ada@example.com>  ")).toBe("ada@example.com");
		expect(senderAddress("mailto:ada@example.com")).toBe("ada@example.com");
		expect(senderAddress("")).toBe("");
	});
});

describe("normalizeImageAllowlist", () => {
	it("lowercases, trims, dedupes and drops junk", () => {
		expect(
			normalizeImageAllowlist([
				"  Alerts@Example.COM ",
				"alerts@example.com",
				42,
				"not-an-address",
				"",
				null,
				"Ada <ada@example.com>",
			]),
		).toEqual(["alerts@example.com", "ada@example.com"]);
	});

	it("accepts @domain entries and rejects malformed ones", () => {
		expect(
			normalizeImageAllowlist(["@News.Example.com", "@", "@no-tld", "example.com"]),
		).toEqual(["@news.example.com"]);
	});

	it("returns an empty list for non-array values and caps the list", () => {
		expect(normalizeImageAllowlist(undefined)).toEqual([]);
		expect(normalizeImageAllowlist("a@b.com")).toEqual([]);
		const many = Array.from({ length: MAX_IMAGE_ALLOWLIST_ENTRIES + 20 }, (_v, i) => `user${i}@example.com`);
		expect(normalizeImageAllowlist(many)).toHaveLength(MAX_IMAGE_ALLOWLIST_ENTRIES);
	});
});

describe("isSenderAllowlisted", () => {
	it("matches exact addresses case-insensitively, display names included", () => {
		expect(isSenderAllowlisted("Ada <ADA@example.com>", ["ada@example.com"])).toBe(true);
		expect(isSenderAllowlisted("ada@example.com", ["Ada <ada@example.com>"])).toBe(true);
		expect(isSenderAllowlisted("other@example.com", ["ada@example.com"])).toBe(false);
	});

	it("matches @domain entries for any sender at that domain", () => {
		expect(isSenderAllowlisted("alerts@news.example.com", ["@news.example.com"])).toBe(true);
		expect(isSenderAllowlisted("alerts@other.example.com", ["@news.example.com"])).toBe(false);
		// No implicit subdomain or suffix matching.
		expect(isSenderAllowlisted("a@sub.news.example.com", ["@news.example.com"])).toBe(false);
		expect(isSenderAllowlisted("a@example.com", ["example.com"])).toBe(false);
	});

	it("is false for empty lists, missing lists and unusable senders", () => {
		expect(isSenderAllowlisted("ada@example.com", [])).toBe(false);
		expect(isSenderAllowlisted("ada@example.com", undefined)).toBe(false);
		expect(isSenderAllowlisted("", ["ada@example.com"])).toBe(false);
	});
});

describe("mailbox settings route", () => {
	it("normalises imageAllowlist on PUT", async () => {
		const mailbox = "remote-images@example.com";
		await env.BUCKET.put(`mailboxes/${mailbox}.json`, JSON.stringify({}));

		const res = await SELF.fetch(`http://example.com/api/v1/mailboxes/${mailbox}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				settings: {
					imageAllowlist: [
						"  Alerts@Example.COM ",
						"alerts@example.com",
						7,
						"nope",
						"@News.Example.com",
					],
				},
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { settings: { imageAllowlist: string[] } };
		expect(body.settings.imageAllowlist).toEqual([
			"alerts@example.com",
			"@news.example.com",
		]);

		const stored = (await (
			await env.BUCKET.get(`mailboxes/${mailbox}.json`)
		)!.json()) as { imageAllowlist: string[] };
		expect(stored.imageAllowlist).toEqual(["alerts@example.com", "@news.example.com"]);
	});
});
