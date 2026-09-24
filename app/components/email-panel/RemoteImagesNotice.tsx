// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, useKumoToastManager } from "@cloudflare/kumo";
import { ImageIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import {
	hasRemoteImages,
	isSenderAllowlisted,
	normalizeImageAllowlist,
	senderAddress,
} from "shared/remote-images";
import { useImagesShownForMessage, useRemoteImagesStore } from "~/hooks/useRemoteImages";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";
import type { Email } from "~/types";

interface RemoteImagesNoticeProps {
	email: Email;
	mailboxId?: string | undefined;
}

/**
 * Privacy notice and opt-in controls for remote images (tracking pixels) in
 * one message body. Renders nothing when the message has no remote images.
 *
 * Three states:
 *  - blocked (default): "Show images" for this message only, or add the
 *    sender to the mailbox allowlist;
 *  - shown for the session: a quiet note plus "Block images" to undo;
 *  - sender allowlisted: a quiet note, no controls.
 */
export default function RemoteImagesNotice({ email, mailboxId }: RemoteImagesNoticeProps) {
	const toastManager = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailbox = useUpdateMailbox();
	const showImages = useRemoteImagesStore((state) => state.showImages);
	const hideImages = useRemoteImagesStore((state) => state.hideImages);
	const shownForSession = useImagesShownForMessage(email.id);
	const hasRemote = useMemo(() => hasRemoteImages(email.body || ""), [email.body]);

	const address = senderAddress(email.sender);
	const senderLabel = address || email.sender;
	const allowlisted = isSenderAllowlisted(
		email.sender,
		mailbox?.settings?.imageAllowlist,
	);

	const handleAlwaysShow = () => {
		if (!mailboxId || !mailbox || !address) return;
		const next = normalizeImageAllowlist([
			...(mailbox.settings?.imageAllowlist ?? []),
			address,
		]);
		updateMailbox.mutate(
			{ mailboxId, settings: { ...mailbox.settings, imageAllowlist: next } },
			{
				onSuccess: () =>
					toastManager.add({
						title: `Images from ${address} will always be shown`,
					}),
				onError: (error) =>
					toastManager.add({
						title:
							error instanceof Error
								? error.message
								: "Could not save the image allowlist.",
						variant: "error",
					}),
			},
		);
	};

	if (!hasRemote) return null;

	if (allowlisted) {
		return (
			<div className="flex items-center gap-2 px-4 py-1.5 border-b border-kumo-line text-xs text-kumo-subtle md:px-6">
				<ImageIcon size={14} className="shrink-0" />
				<span className="truncate">Images from {senderLabel} are always shown.</span>
			</div>
		);
	}

	if (shownForSession) {
		return (
			<div className="flex flex-wrap items-center gap-2 px-4 py-1.5 border-b border-kumo-line text-xs text-kumo-subtle md:px-6">
				<ImageIcon size={14} className="shrink-0" />
				<span>Remote images are shown for this message.</span>
				<Button variant="ghost" size="sm" onClick={() => hideImages(email.id)}>
					Block images
				</Button>
			</div>
		);
	}

	return (
		<div className="flex flex-wrap items-center gap-2 px-4 py-1.5 border-b border-kumo-line text-xs text-kumo-subtle md:px-6">
			<ImageIcon size={14} className="shrink-0" />
			<span>Remote images are blocked to protect your privacy.</span>
			<Button
				variant="secondary"
				size="sm"
				onClick={() => showImages(email.id)}
			>
				Show images
			</Button>
			<Button
				variant="ghost"
				size="sm"
				onClick={handleAlwaysShow}
				disabled={!mailboxId || !mailbox || !address}
				loading={updateMailbox.isPending}
			>
				Always show images from {senderLabel}
			</Button>
		</div>
	);
}
