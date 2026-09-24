// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { htmlToPlainText, type EmailViewMode } from "shared/email-view";
import EmailIframe from "~/components/EmailIframe";
import PlainTextMessage from "~/components/PlainTextMessage";
import { rewriteInlineImages } from "~/lib/utils";
import type { Email } from "~/types";


interface MessageBodyProps {
	email: Email;
	mailboxId?: string;
	/** Effective view mode for the panel: manual choice or configured default. */
	viewMode: EmailViewMode;
	/** When true, the HTML iframe auto-sizes to its content height. */
	autoSize?: boolean;
}


/**
 * Renders one message body in the selected view mode.
 *
 * HTML mode keeps the sandboxed iframe. Plain-text mode never touches the
 * iframe: it shows the stored text/plain part as escaped preformatted text,
 * converting the HTML when the message has no plain-text part (labelled as
 * converted so the reader knows it is a fallback).
 */
export default function MessageBody({
	email,
	mailboxId,
	viewMode,
	autoSize,
}: MessageBodyProps) {
	if (viewMode === "text") {
		const stored =
			typeof email.body_text === "string" && email.body_text.trim()
				? email.body_text
				: null;
		return (
			<PlainTextMessage
				text={stored ?? htmlToPlainText(email.body || "")}
				converted={stored === null}
			/>
		);
	}

	return (
		<EmailIframe
			body={rewriteInlineImages(
				email.body || "",
				mailboxId || "",
				email.id,
				email.attachments,
			)}
			autoSize={autoSize}
		/>
	);
}
