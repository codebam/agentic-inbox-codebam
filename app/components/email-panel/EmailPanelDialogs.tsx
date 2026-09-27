// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Dialog } from "@cloudflare/kumo";
import { useEffect, useRef, useState } from "react";
import { downloadFile } from "~/lib/utils";
import type { Email } from "~/types";

interface PreviewImage {
	url: string;
	filename: string;
}

/** A fetched preview: one image's blob URL, or why it did not arrive. */
interface LoadedPreview {
	url: string;
	src: string | null;
	error: string | null;
}

/**
 * The preview image, fetched rather than pointed at by the tag.
 *
 * An `<img src="/api/v1/...">` load has no way to report a failure — the
 * dialog showed a broken-image icon and nothing else — and it leaves the
 * browser to decide whether the response may be rendered as a subresource at
 * all (the download route serves `Content-Disposition: attachment`, which
 * some browsers honour for subresources too). Fetching the bytes the way the
 * rest of the app does keeps the session, renders from a blob URL the browser
 * cannot refuse, and turns a failure into a sentence.
 */
function usePreviewSrc(previewImage: PreviewImage | null) {
	const [loaded, setLoaded] = useState<LoadedPreview | null>(null);
	const liveUrlRef = useRef<string | null>(null);
	const url = previewImage?.url ?? null;
	// What the failure message names: the route the bytes should have come from.
	const shortPath = (() => {
		if (!url) return "";
		try {
			return new URL(url, window.location.origin).pathname;
		} catch {
			return url;
		}
	})();

	useEffect(() => {
		if (!url) return;
		let cancelled = false;
		const controller = new AbortController();
		void (async () => {
			try {
				const res = await fetch(url, { signal: controller.signal });
				if (!res.ok) {
					throw new Error(
						`Couldn't load this image (${res.status}) — ${shortPath}`,
					);
				}
				const blob = await res.blob();
				const objectUrl = URL.createObjectURL(blob);
				if (cancelled) {
					URL.revokeObjectURL(objectUrl);
					return;
				}
				// One preview at a time: the previous blob URL is released as
				// the next one arrives.
				if (liveUrlRef.current) URL.revokeObjectURL(liveUrlRef.current);
				liveUrlRef.current = objectUrl;
				setLoaded({ url, src: objectUrl, error: null });
			} catch (e) {
				if (!cancelled) {
					setLoaded({
						url,
						src: null,
						error:
							e instanceof Error && e.name !== "AbortError"
								? e.message
								: `Couldn't load this image — ${shortPath}`,
					});
				}
			}
		})();
		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [url, shortPath]);

	// The last blob URL lives as long as the panel does.
	useEffect(() => () => {
		if (liveUrlRef.current) URL.revokeObjectURL(liveUrlRef.current);
	}, []);

	if (!url) return { src: null, error: null };
	// Until this image's bytes arrive the dialog shows its loading line.
	return loaded?.url === url ? { src: loaded.src, error: loaded.error } : { src: null, error: null };
}

interface EmailPanelDialogsProps {
	sourceViewEmail: Email | null;
	previewImage: PreviewImage | null;
	onCloseSource: () => void;
	onClosePreview: () => void;
}

/** Read a stored header entry as a plain object; null when it is not one. */
function headerRecord(entry: unknown): Record<string, unknown> | null {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
	return entry as Record<string, unknown>;
}


/**
 * One stored header field as a string, mirroring `String(value || "")` for
 * the primitives a header can hold; anything else contributes nothing.
 */
function headerField(entry: unknown, field: string): string {
	const record = headerRecord(entry);
	if (!record) return "";
	const value = record[field];
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value ? String(value) : "";
	}
	return "";
}


function getSourceHeaders(msg: Email): { key: string; value: string }[] {
	if (msg.raw_headers) {
		try {
			const parsed: unknown = JSON.parse(msg.raw_headers);
			if (Array.isArray(parsed)) {
				return parsed.map((header: unknown) => ({
					key: headerField(header, "key") || headerField(header, "name") || "",
					value: headerField(header, "value"),
				}));
			}
			const headerMap = headerRecord(parsed);
			if (headerMap) {
				return Object.entries(headerMap).map(([key, value]) => ({
					key,
					value: String(value),
				}));
			}
		} catch {
			// Fall through to field-based headers.
		}
	}

	const headers: { key: string; value: string }[] = [];
	if (msg.sender) headers.push({ key: "From", value: msg.sender });
	if (msg.recipient) headers.push({ key: "To", value: msg.recipient });
	if (msg.cc) headers.push({ key: "Cc", value: msg.cc });
	if (msg.bcc) headers.push({ key: "Bcc", value: msg.bcc });
	if (msg.subject) headers.push({ key: "Subject", value: msg.subject });
	if (msg.date) headers.push({ key: "Date", value: msg.date });
	if (msg.message_id) headers.push({ key: "Message-ID", value: msg.message_id });
	if (msg.in_reply_to) headers.push({ key: "In-Reply-To", value: msg.in_reply_to });
	if (msg.email_references) {
		headers.push({ key: "References", value: msg.email_references });
	}
	if (msg.thread_id) headers.push({ key: "X-Thread-ID", value: msg.thread_id });
	return headers;
}

export default function EmailPanelDialogs({
	sourceViewEmail,
	previewImage,
	onCloseSource,
	onClosePreview,
}: EmailPanelDialogsProps) {
	const sourceHeaders = sourceViewEmail ? getSourceHeaders(sourceViewEmail) : [];
	const preview = usePreviewSrc(previewImage);

	return (
		<>
			<Dialog.Root
				open={sourceViewEmail !== null}
				onOpenChange={(open) => {
					if (!open) onCloseSource();
				}}
			>
				<Dialog size="lg">
					<Dialog.Title>
						Email Source Headers
						{sourceViewEmail && (
							<span className="text-sm font-normal text-kumo-subtle ml-2">
								{sourceViewEmail.subject}
							</span>
						)}
					</Dialog.Title>
					{sourceViewEmail && (
						<div className="mt-4 max-h-[60vh] overflow-y-auto">
							<table className="w-full text-sm border-collapse">
								<tbody>
									{sourceHeaders.map((header, idx) => (
										<tr
											key={`${header.key}-${idx}`}
											className={idx % 2 === 0 ? "bg-kumo-tint/50" : ""}
										>
											<td className="py-1.5 px-3 font-mono font-semibold text-kumo-default whitespace-nowrap align-top w-[160px]">
												{header.key}
											</td>
											<td className="py-1.5 px-3 font-mono text-kumo-subtle break-all">
												{header.value}
											</td>
										</tr>
									))}
								</tbody>
							</table>
							{sourceHeaders.length === 0 && (
								<p className="text-sm text-kumo-subtle text-center py-8">
									No header data available for this email.
								</p>
							)}
						</div>
					)}
					<div className="flex justify-end mt-4">
						<Dialog.Close>
							<Button variant="secondary" size="sm">
								Close
							</Button>
						</Dialog.Close>
					</div>
				</Dialog>
			</Dialog.Root>

			<Dialog.Root
				open={previewImage !== null}
				onOpenChange={(open) => {
					if (!open) onClosePreview();
				}}
			>
				<Dialog size="lg">
					<Dialog.Title>{previewImage?.filename}</Dialog.Title>
					{previewImage && (
						<div className="mt-4 flex flex-col items-center justify-center bg-kumo-tint/30 rounded-lg p-4 min-h-[200px]">
							{preview.error ? (
								<p className="text-sm text-kumo-subtle py-8">{preview.error}</p>
							) : preview.src ? (
								<img
									src={preview.src}
									alt={previewImage.filename}
									className="max-w-full max-h-[70vh] object-contain rounded shadow-sm"
								/>
							) : (
								<p className="text-sm text-kumo-subtle py-8">Loading…</p>
							)}
						</div>
					)}
					<div className="flex justify-between items-center mt-4">
						<Button
							variant="secondary"
							size="sm"
							onClick={() => {
								if (previewImage) {
									downloadFile(previewImage.url, previewImage.filename);
								}
							}}
						>
							Download Original
						</Button>
						<Dialog.Close>
							<Button variant="primary" size="sm">
								Close
							</Button>
						</Dialog.Close>
					</div>
				</Dialog>
			</Dialog.Root>
		</>
	);
}
