// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { PaperclipIcon, FileIcon, ImageIcon, LinkIcon } from "@phosphor-icons/react";
import {
	formatBytes,
	formatLinkExpiry,
	getAttachmentUrl,
	getNonInlineAttachments,
	getPublicAttachmentUrl,
} from "~/lib/utils";
import type { Attachment } from "~/types";

interface EmailAttachmentListProps {
	mailboxId?: string | undefined;
	emailId: string;
	attachments?: Attachment[] | undefined;
	onPreviewImage?: ((url: string, filename: string) => void) | undefined;
	className?: string;
	showHeading?: boolean;
}

export default function EmailAttachmentList({
	mailboxId,
	emailId,
	attachments,
	onPreviewImage,
	className,
	showHeading = false,
}: EmailAttachmentListProps) {
	if (!mailboxId) return null;

	const files = getNonInlineAttachments(attachments);
	if (files.length === 0) return null;

	return (
		<div className={className}>
			{showHeading && (
				<div className="flex items-center gap-2 mb-2">
					<PaperclipIcon size={14} className="text-kumo-subtle" />
					<span className="text-sm font-medium text-kumo-default">
						{files.length} attachment{files.length !== 1 ? "s" : ""}
					</span>
				</div>
			)}
			<div className="flex flex-wrap gap-2">
				{files.map((attachment) => {
					const url = getAttachmentUrl(mailboxId, emailId, attachment.id);
					const isImage = attachment.mimetype?.startsWith("image/");

					// A linked attachment lives in R2 behind a public token URL,
					// not in the message: show the link and when it expires.
					if (attachment.link_token && attachment.link_expires_at) {
						const linkUrl = getPublicAttachmentUrl(
							mailboxId,
							attachment.id,
							attachment.link_token,
						);
						return (
							<a
								key={attachment.id}
								href={linkUrl}
								target="_blank"
								rel="noopener noreferrer"
								title={`Download link, expires ${formatLinkExpiry(attachment.link_expires_at)}`}
								className="flex items-center gap-2 rounded-md border border-dashed border-kumo-line px-3 py-2 no-underline transition-colors hover:bg-kumo-tint text-sm"
							>
								<LinkIcon size={16} className="text-kumo-subtle shrink-0" />
								<span className="text-kumo-default font-medium truncate max-w-[140px]">
									{attachment.filename}
								</span>
								<span className="text-kumo-subtle">{formatBytes(attachment.size)}</span>
								<span className="rounded-sm bg-kumo-tint px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-kumo-subtle">
									Link
								</span>
								<span className="text-xs text-kumo-subtle">
									expires {formatLinkExpiry(attachment.link_expires_at)}
								</span>
							</a>
						);
					}

					if (isImage && onPreviewImage) {
						return (
							<button
								key={attachment.id}
								type="button"
								onClick={() => onPreviewImage(url, attachment.filename)}
								className="flex items-center gap-2 rounded-md border border-kumo-line px-3 py-2 transition-colors hover:bg-kumo-tint text-sm text-left"
							>
								<ImageIcon size={16} className="text-kumo-subtle shrink-0" />
								<span className="text-kumo-default font-medium truncate max-w-[140px]">
									{attachment.filename}
								</span>
								<span className="text-kumo-subtle">{formatBytes(attachment.size)}</span>
							</button>
						);
					}

					return (
						<a
							key={attachment.id}
							href={url}
							target="_blank"
							rel="noopener noreferrer"
							className="flex items-center gap-2 rounded-md border border-kumo-line px-3 py-2 no-underline transition-colors hover:bg-kumo-tint text-sm"
						>
							<FileIcon size={16} className="text-kumo-subtle shrink-0" />
							<span className="text-kumo-default font-medium truncate max-w-[140px]">
								{attachment.filename}
							</span>
							<span className="text-kumo-subtle">{formatBytes(attachment.size)}</span>
						</a>
					);
				})}
			</div>
		</div>
	);
}
