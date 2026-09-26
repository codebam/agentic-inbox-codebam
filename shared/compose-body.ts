// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { htmlToPlainText } from "./email-view";

/**
 * The body a send request always carries.
 *
 * The send API requires `html` or `text` — the Email Service binding builds
 * the message from them, and with both missing there is nothing to send. The
 * composer's empty state is an empty string, though, so a message written
 * without a body used to be posted as `html: ""` and rejected ("Either 'html'
 * or 'text' must be provided"). An empty message is legitimate; an empty
 * payload is not. A blank body becomes the composer's own empty-paragraph
 * convention — the same string a signature-prefilled body starts with.
 */

/** The paragraph an empty composer body is sent as. */
export const EMPTY_MESSAGE_BODY = "<p><br></p>";

/**
 * The `html`/`text` pair for a composer body: the body itself when it has
 * content, the empty-paragraph convention when it does not.
 */
export function ensureMessageBody(html: string): {
	html: string;
	text: string;
} {
	const body = html.trim().length > 0 ? html : EMPTY_MESSAGE_BODY;
	return { html: body, text: htmlToPlainText(body) };
}
