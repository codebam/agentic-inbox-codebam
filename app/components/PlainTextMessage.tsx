// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


interface PlainTextMessageProps {
	/** Already plain text: React escapes it, nothing is parsed as HTML. */
	text: string;
	/** True when the text was converted from HTML (no stored plain-text part). */
	converted?: boolean;
}


/**
 * Escaped, preformatted plain-text rendering of a message body. Rendered
 * instead of the sandboxed iframe when the reader picks the plain-text view.
 */
export default function PlainTextMessage({
	text,
	converted,
}: PlainTextMessageProps) {
	return (
		<div className="flex flex-col gap-2 px-4 py-4 md:px-6">
			{converted && (
				<p className="text-xs text-kumo-subtle">
					Converted from HTML — this message has no plain-text version.
				</p>
			)}
			<pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-kumo-default">{text || "(no text content)"}</pre>
		</div>
	);
}
