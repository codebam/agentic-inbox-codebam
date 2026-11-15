import { beforeEach } from "vitest";
import { setSendEmailSenderFactory } from "../workers/email-sender";

// wrangler.test.jsonc deliberately declares no send_email binding, so a test
// run can never deliver real mail. Now that the send routes await delivery
// (upstream #84), default every send to a successful fake sender; a test that
// needs a rejection or a specific Message-ID overrides the seam itself.
beforeEach(() => {
	setSendEmailSenderFactory(() => ({
		send: async () => ({ messageId: "test-binding-id@example.com" }),
	}));
});
