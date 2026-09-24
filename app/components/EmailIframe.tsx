// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import DOMPurify from "dompurify";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	blockRemoteImages,
	buildEmailIframeCsp,
	proxyRemoteImages,
} from "shared/remote-images";

interface EmailIframeProps {
	body: string;
	/** When true, iframe auto-sizes to content height instead of filling parent */
	autoSize?: boolean | undefined;
	/**
	 * Load remote images (tracking pixels) in this message. Defaults to
	 * false: the body is passed through `blockRemoteImages` and the CSP
	 * omits every remote host until the user opts in.
	 */
	allowRemoteImages?: boolean | undefined;
	/**
	 * Mailbox the message belongs to, used to build the same-origin image
	 * proxy route. When absent (or empty), an opted-in body renders exactly
	 * as before: no proxy rewriting, so no sender URL is relayed.
	 */
	mailboxId?: string | undefined;
}

/** The height report our sandboxed iframe posts to the parent window. */
interface EmailIframeHeightReport {
	__emailIframeHeight: unknown;
	height: number;
}


/**
 * A height report from the iframe: a non-null object that flags itself with
 * `__emailIframeHeight` and carries a positive numeric height.
 */
function isHeightReport(value: unknown): value is EmailIframeHeightReport {
	if (typeof value !== "object" || value === null) return false;
	if (!("__emailIframeHeight" in value) || !value["__emailIframeHeight"]) return false;
	if (!("height" in value)) return false;
	return typeof value["height"] === "number" && value["height"] > 0;
}


/**
 * Renders email HTML inside a sandboxed iframe.
 *
 * Security model:
 * - DOMPurify sanitises the HTML before injection.
 * - The iframe sandbox does NOT include `allow-same-origin`, so even if
 *   DOMPurify has a bypass the attacker's code runs in an opaque origin
 *   with no access to the parent page's cookies, DOM, or API.
 * - Because the iframe is cross-origin we cannot read `contentDocument`
 *   for auto-sizing. Instead, the injected HTML includes a tiny inline
 *   script that posts its body height to the parent via `postMessage`.
 *   The `allow-scripts` flag is required for this, but scripts inside
 *   the opaque-origin sandbox cannot access anything useful.
 * - A strict CSP meta tag blocks external resource loads inside the
 *   iframe as a defense-in-depth layer.
 * - Remote images (tracking pixels) are blocked by default: the sanitised
 *   body is passed through `blockRemoteImages` and the CSP allows no remote
 *   host. After an explicit opt-in (`allowRemoteImages`) they load through
 *   the same-origin image proxy (`mailboxId`), never from the sender.
 */
export default function EmailIframe({
	body,
	autoSize,
	allowRemoteImages = false,
	mailboxId,
}: EmailIframeProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(autoSize ? 100 : 0);

	// Listen for height reports from the sandboxed iframe
	const handleMessage = useCallback(
		(event: MessageEvent<unknown>) => {
			if (!autoSize) return;
			// Only accept messages from our own iframe
			if (event.source !== iframeRef.current?.contentWindow) return;
			if (!isHeightReport(event.data)) return;
			setHeight(event.data.height);
		},
		[autoSize],
	);

	useEffect(() => {
		window.addEventListener("message", handleMessage);
		return () => window.removeEventListener("message", handleMessage);
	}, [handleMessage]);

	useEffect(() => {
		const iframe = iframeRef.current;
		if (!iframe || !body) return;

		const sanitizedBody = DOMPurify.sanitize(body, {
			USE_PROFILES: { html: true },
			FORBID_TAGS: ["style"],
			ADD_ATTR: ["target"],
			FORCE_BODY: true,
		});

		// Tracking pixels stay blocked unless the user opted in for this
		// message or the sender sits on the mailbox's image allowlist. After
		// the opt-in they still do not load from the sender: with a mailbox
		// id the body's remote images are rewritten to the same-origin proxy
		// route, so the sender never sees this reader.
		const cleanBody = allowRemoteImages
			? mailboxId
				? proxyRemoteImages(sanitizedBody, mailboxId).html
				: sanitizedBody
			: blockRemoteImages(sanitizedBody).html;

		// Inline attachments are rewritten to same-origin API URLs and the
		// proxied remote images are same-origin too, so the CSP keeps the
		// app's own origin and still never allows a remote host.
		const csp = buildEmailIframeCsp(
			allowRemoteImages,
			typeof window === "undefined" ? "" : window.location.origin,
		);

		const padding = autoSize ? "0" : "24px";

		// Height-reporting script: sends body.scrollHeight to the parent.
		// Runs inside the opaque-origin sandbox so it has zero access to
		// the parent page — it can only postMessage.
		const heightScript = autoSize
			? `<script>
				function reportHeight() {
					var h = document.body.scrollHeight;
					if (h > 0) parent.postMessage({ __emailIframeHeight: true, height: h }, "*");
				}
				reportHeight();
				setTimeout(reportHeight, 50);
				setTimeout(reportHeight, 150);
				setTimeout(reportHeight, 400);
			</script>`
			: "";

		// Use srcdoc so the iframe is truly sandboxed (no same-origin access).
		// We can't use doc.write() because that requires allow-same-origin.
		iframe.srcdoc = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
* { box-sizing: border-box; }
html {
	background: #ffffff;
	color-scheme: light;
}
body {
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
	font-size: 14px;
	line-height: 1.6;
	color: #1a1a1a;
	background: #ffffff;
	padding: ${padding};
	margin: 0;
	word-wrap: break-word;
	overflow-wrap: break-word;
	${autoSize ? "overflow: hidden;" : ""}
}
[style*="position: fixed"], [style*="position:fixed"], [style*="position: absolute"], [style*="position:absolute"] {
	position: relative !important;
}
a { color: #2563eb; }
img { max-width: 100%; height: auto; }
blockquote {
	border-left: 3px solid #d1d5db;
	padding-left: 1em;
	margin-left: 0;
	color: #6b7280;
}
pre {
	background: #f3f4f6;
	padding: 12px;
	border-radius: 6px;
	overflow-x: auto;
	font-size: 13px;
}
table { border-collapse: collapse; max-width: 100%; }
td, th { padding: 4px 8px; }
p { margin: 4px 0; }
h1, h2, h3 { margin: 8px 0 4px; }
ul, ol { padding-left: 20px; margin: 4px 0; }
</style>
</head>
<body>${cleanBody}${heightScript}</body>
</html>`;
	}, [body, autoSize, allowRemoteImages, mailboxId]);

	return (
		<iframe
			ref={iframeRef}
			className="block w-full border-0"
			style={autoSize ? { height: `${height}px` } : { height: "100%" }}
			sandbox="allow-scripts allow-popups allow-top-navigation-by-user-activation"
			title="Email content"
		/>
	);
}
