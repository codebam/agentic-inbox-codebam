import { describe, expect, it } from "vitest";
import {
	extractModelText,
	reasoningEffortParam,
} from "../workers/lib/model-output";


describe("extractModelText", () => {
	it("reads the native Workers AI response shape", () => {
		expect(extractModelText({ response: "YES" })).toBe("YES");
	});

	it("reads the OpenAI-compatible chat completions shape", () => {
		expect(
			extractModelText({
				choices: [
					{ message: { role: "assistant", content: "NO" } },
				],
			}),
		).toBe("NO");
	});

	it("never returns the reasoning trace as the answer", () => {
		expect(
			extractModelText({
				choices: [
					{
						message: {
							content: "",
							reasoning_content: "The email looks like a normal message.",
						},
					},
				],
			}),
		).toBe("");
	});

	it("joins content parts", () => {
		expect(
			extractModelText({
				choices: [{ message: { content: [{ text: "Hello" }, { text: ", world" }] } }],
			}),
		).toBe("Hello, world");
	});

	it("returns an empty string for anything unusable", () => {
		expect(extractModelText(null)).toBe("");
		expect(extractModelText(undefined)).toBe("");
		expect(extractModelText("YES")).toBe("");
		expect(extractModelText({})).toBe("");
		expect(extractModelText({ choices: [] })).toBe("");
		expect(extractModelText({ choices: [{ message: {} }] })).toBe("");
	});
});


describe("reasoningEffortParam", () => {
	it("passes a documented effort level to the default reasoning model", () => {
		expect(
			reasoningEffortParam("@cf/deepseek-ai/deepseek-v4.1-flash-1017", "none"),
		).toEqual({ reasoning_effort: "none" });
		expect(
			reasoningEffortParam("@cf/deepseek-ai/deepseek-v4.1-flash-1017", "low"),
		).toEqual({ reasoning_effort: "low" });
	});

	it("omits the field for models that do not document it", () => {
		// A mailbox can point any job at any model; an unknown parameter must
		// never be sent to a model that may reject it.
		expect(
			reasoningEffortParam("@cf/meta/llama-4-scout-17b-16e-instruct", "none"),
		).toEqual({});
		expect(reasoningEffortParam("meta/muse-ember-1.0", "low")).toEqual({});
	});
});
