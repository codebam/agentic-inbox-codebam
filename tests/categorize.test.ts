// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { classifyIncomingEmail } from "../workers/lib/categorize";


/** A capturing Workers AI double: records every call, answers the classifier. */
function capturingAi() {
	const calls: { model: string; params: Record<string, unknown> }[] = [];
	return {
		calls,
		run: async (model: string, params: Record<string, unknown>) => {
			calls.push({ model, params });
			return { model, answers: { is_spam: { type: "noul", noul: 0.1 } } };
		},
	};
}


/** The inbound shape the classifier accepts, in one example message. */
const EMAIL = {
	sender: "alice@example.org",
	senderName: "Alice",
	recipients: "bob@example.com",
	subject: "Hello",
	body: "A plain-text body.",
};


type ClassifierAi = Parameters<typeof classifyIncomingEmail>[0];


describe("Clef request shaping", () => {
	it("defaults to Clef-flash and sends the selector the API requires", async () => {
		const ai = capturingAi();
		const result = await classifyIncomingEmail(
			ai as unknown as ClassifierAi,
			EMAIL,
			{},
		);
		expect(ai.calls).toHaveLength(1);
		expect(ai.calls[0].model).toBe("@cf/cloudflare/clef-flash");
		expect(ai.calls[0].params.model).toBe("clef-flash");
		expect(result?.isSpam).toBe(false);
		expect(result?.model).toBe("@cf/cloudflare/clef-flash");
	});

	it("selects the 27B Clef model when a mailbox resolves to it", async () => {
		const ai = capturingAi();
		await classifyIncomingEmail(
			ai as unknown as ClassifierAi,
			EMAIL,
			{},
			"@cf/cloudflare/clef",
		);
		expect(ai.calls).toHaveLength(1);
		expect(ai.calls[0].model).toBe("@cf/cloudflare/clef");
		expect(ai.calls[0].params.model).toBe("clef");
	});

	it("sends no selector to models that do not take one", async () => {
		const ai = capturingAi();
		await classifyIncomingEmail(
			ai as unknown as ClassifierAi,
			EMAIL,
			{},
			"vendor/other-classifier",
		);
		expect(ai.calls).toHaveLength(1);
		expect(ai.calls[0].model).toBe("vendor/other-classifier");
		expect("model" in ai.calls[0].params).toBe(false);
	});
});
