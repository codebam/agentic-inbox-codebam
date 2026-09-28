// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import DOMPurify from "dompurify";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	BLOCKED_IMAGE_DATA_URI,
	blockRemoteImages,
	buildEmailIframeCsp,
	collectBodyImageUrls,
	inlineBodyImages,
	proxyRemoteImages,
} from "shared/remote-images";
import { useRemoteImagesStore } from "~/hooks/useRemoteImages";
import { loadBodyImages } from "~/lib/body-images";

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
	/** Message the body belongs to; the notice above the body reads its image-load state. */
	emailId?: string | undefined;
}

/** The height report our sandboxed iframe posts to the parent window. */
interface EmailIframeHeightReport {
	__emailIframeHeight: unknown;
	height: number;
}

/** Fetched body images, tagged with the render inputs they belong to. */
interface InlinedImages {
	key: string;
	dataUrls: Map<string, string>;
}

/** The no-bytes-yet lookup for a body whose images are still being fetched. */
const NO_DATA_URLS: ReadonlyMap<string, string> = new Map();


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
 * - The body's app-origin images — proxied remote images and inline
 *   attachments — are fetched by THIS page and inlined as `data:` URLs
 *   before the body is handed to the iframe. A document in a sandbox
 *   without `allow-same-origin` sends its subresource requests with no
 *   cookies at all (Chromium marks them `Sec-Fetch-Site: cross-site`), so
 *   behind Cloudflare Access the iframe could never authenticate one; the
 *   page is first-party and can (app/lib/body-images.ts).
 */
export default function EmailIframe({
	body,
	autoSize,
	allowRemoteImages = false,
	mailboxId,
	emailId,
}: EmailIframeProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(autoSize ? 100 : 0);
	const [inlined, setInlined] = useState<InlinedImages | null>(null);
	const setImageState = useRemoteImagesStore((state) => state.setImageState);

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

		// Everything the body loads from the app's own origin — the proxy
		// routes above and the inline-attachment routes MessageBody built —
		// is fetched here, first-party, and inlined as a `data:` URL: the
		// sandboxed iframe cannot carry the session, this page can. Until
		// the bytes arrive the same references render as the blocked
		// placeholder, so the iframe never fires the unauthenticated
		// request the page is making on its behalf.
		const baseUrl = window.location.href;
		const renderKey = `${allowRemoteImages ? "show" : "block"}|${mailboxId ?? ""}|${body}`;
		const fetched = inlined?.key === renderKey ? inlined.dataUrls : null;
		const renderedBody = inlineBodyImages(
			cleanBody,
			fetched ?? NO_DATA_URLS,
			baseUrl,
			// An app-origin reference with no bytes — still loading, or a
			// fetch that failed — renders as the blocked placeholder: the
			// iframe must never issue the unauthenticated request the page
			// is making on its behalf.
			{ fallback: BLOCKED_IMAGE_DATA_URI },
		).html;

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
		// the parent page — it can only postMessage. The `load` listener
		// catches the height once the body's images have decoded.
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
				addEventListener("load", reportHeight);
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
<body>${renderedBody}${heightScript}</body>
</html>`;

		// Nothing left to fetch once the body carries its images, or when it
		// references none from this origin.
		if (fetched) return;

		const urls = collectBodyImageUrls(cleanBody, baseUrl);
		if (urls.length === 0) return;

		const controller = new AbortController();
		if (emailId) setImageState(emailId, { pending: urls.length, failed: 0 });
		loadBodyImages(urls, { signal: controller.signal })
			.then((result) => {
				if (controller.signal.aborted) return;
				if (emailId) {
					setImageState(emailId, { pending: 0, failed: result.failed });
				}
				setInlined({ key: renderKey, dataUrls: result.dataUrls });
			})
			.catch(() => {});
		return () => controller.abort();
	}, [body, autoSize, allowRemoteImages, mailboxId, emailId, inlined, setImageState]);

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
