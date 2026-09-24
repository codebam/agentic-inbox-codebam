import { describe, expect, it } from "vitest";
import {
	DEFAULT_MODELS,
	MODEL_CONFIG_KEYS,
	resolveModelConfig,
} from "../shared/models";
import {
	SIGNATURE_WRAPPER_STYLE,
	applySignatureToBody,
	buildSignatureBlock,
	type SignatureSettings,
} from "../shared/signature";


const textSignature = (text: string): SignatureSettings => ({
	enabled: true,
	text,
});


const htmlSignature = (html: string): SignatureSettings => ({
	enabled: true,
	text: "",
	html,
});


describe("resolveModelConfig", () => {
	it("falls back to the built-in defaults when nothing is configured", () => {
		expect(resolveModelConfig()).toEqual({ ...DEFAULT_MODELS });
		expect(resolveModelConfig({}, {})).toEqual({ ...DEFAULT_MODELS });
		expect(resolveModelConfig({ models: {} }, { models: {} })).toEqual({
			...DEFAULT_MODELS,
		});
	});

	it("ignores blank and whitespace-only values at every level", () => {
		const effective = resolveModelConfig(
			{ models: { agent: "   ", draftVerify: "" } },
			{ models: { classifier: "\n\t " } },
		);
		expect(effective.agent).toBe(DEFAULT_MODELS.agent);
		expect(effective.draftVerify).toBe(DEFAULT_MODELS.draftVerify);
		expect(effective.classifier).toBe(DEFAULT_MODELS.classifier);
	});

	it("falls through a blank mailbox value to a configured app-wide one", () => {
		const effective = resolveModelConfig(
			{ models: { agent: "  " } },
			{ models: { agent: "vendor/global-agent" } },
		);
		expect(effective.agent).toBe("vendor/global-agent");
	});

	it("prefers mailbox overrides over app-wide settings and defaults", () => {
		const effective = resolveModelConfig(
			{ models: { agent: "vendor/mailbox-agent" } },
			{
				models: {
					agent: "vendor/global-agent",
					draftVerify: "vendor/global-verify",
				},
			},
		);
		expect(effective.agent).toBe("vendor/mailbox-agent");
		expect(effective.draftVerify).toBe("vendor/global-verify");
		expect(effective.classifier).toBe(DEFAULT_MODELS.classifier);
		expect(effective.promptInjection).toBe(DEFAULT_MODELS.promptInjection);
	});

	it("resolves every configured model key", () => {
		const effective = resolveModelConfig(
			{},
			{ models: { promptInjection: "vendor/scanner" } },
		);
		expect(Object.keys(effective).sort()).toEqual([...MODEL_CONFIG_KEYS].sort());
		expect(effective.promptInjection).toBe("vendor/scanner");
	});
});


describe("buildSignatureBlock", () => {
	it("renders a plain-text signature escaped with line breaks", () => {
		const block = buildSignatureBlock(
			textSignature("Sean <sean@example.com>\nAgentic Inbox"),
		);
		expect(block).toBe(
			`<div style="${SIGNATURE_WRAPPER_STYLE}">` +
				"Sean &lt;sean@example.com&gt;<br>Agentic Inbox</div>",
		);
	});

	it("keeps safe HTML formatting and drops scripts", () => {
		const block = buildSignatureBlock(
			htmlSignature(
				"<p>Hi <strong>there</strong> &amp; welcome</p><script>alert(1)</script>",
			),
		);
		expect(block).toBe(
			`<div style="${SIGNATURE_WRAPPER_STYLE}">` +
				"<p>Hi <strong>there</strong> &amp; welcome</p></div>",
		);
	});

	it("drops javascript: URLs from HTML signature links", () => {
		const block = buildSignatureBlock(
			htmlSignature('<a href="javascript:alert(1)">click</a>'),
		);
		expect(block).toBe(
			`<div style="${SIGNATURE_WRAPPER_STYLE}"><a>click</a></div>`,
		);
	});

	it("prefers the HTML signature over the plain-text one", () => {
		const block = buildSignatureBlock({
			enabled: true,
			text: "plain text version",
			html: "<p>rich version</p>",
		});
		expect(block).toContain("<p>rich version</p>");
		expect(block).not.toContain("plain text version");
	});

	it("renders nothing when disabled or empty", () => {
		expect(buildSignatureBlock({ enabled: false, text: "bye" })).toBe("");
		expect(buildSignatureBlock(textSignature("   "))).toBe("");
		expect(buildSignatureBlock(htmlSignature(""))).toBe("");
		expect(buildSignatureBlock(undefined)).toBe("");
	});
});


describe("applySignatureToBody", () => {
	it("appends the signature block and is idempotent", () => {
		const signature = textSignature("Sean");
		const once = applySignatureToBody("<p>Hello</p>", signature);
		expect(once).toContain(buildSignatureBlock(signature));
		expect(applySignatureToBody(once, signature)).toBe(once);
	});

	it("inserts the signature above a trailing quoted reply", () => {
		const signature = textSignature("Sean");
		const block = buildSignatureBlock(signature);
		const body = "<p>Hello</p><blockquote>quoted</blockquote>";
		const withSignature = applySignatureToBody(body, signature);
		expect(withSignature).toContain(block);
		expect(withSignature.indexOf(block)).toBeLessThan(
			withSignature.indexOf("<blockquote>"),
		);
		expect(withSignature.endsWith("</blockquote>")).toBe(true);
	});

	it("leaves the body alone when no signature is enabled", () => {
		expect(applySignatureToBody("<p>Hello</p>", undefined)).toBe(
			"<p>Hello</p>",
		);
		expect(
			applySignatureToBody("<p>Hello</p>", { enabled: false, text: "bye" }),
		).toBe("<p>Hello</p>");
	});
});
