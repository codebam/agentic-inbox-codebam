// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { EmailViewMode } from "shared/email-view";
import CalendarInviteCard from "~/components/CalendarInviteCard";
import EmailAttachmentList from "~/components/EmailAttachmentList";
import ItemsCard from "~/components/email-panel/ItemsCard";
import MessageBody from "~/components/MessageBody";
import { useRemoteImagesAllowed } from "~/hooks/useRemoteImages";
import type { Email } from "~/types";

interface SingleMessageViewProps {
	email: Email;
	mailboxId?: string | undefined;
	/** Effective HTML | plain text mode for the panel. */
	viewMode: EmailViewMode;
	onPreviewImage: (url: string, filename: string) => void;
}

export default function SingleMessageView({
	email,
	mailboxId,
	viewMode,
	onPreviewImage,
}: SingleMessageViewProps) {
	const allowRemoteImages = useRemoteImagesAllowed(email, mailboxId);
	return (
		<div className="flex flex-col h-full">
			{/* The sender / date / To-Cc header lives in EmailPanelHeader
			    (single-message view only), so this view starts at the
			    extracted items and the calendar invite. */}
			<ItemsCard email={email} mailboxId={mailboxId} />

			<CalendarInviteCard emailId={email.id} mailboxId={mailboxId} />

			<div className="flex-1 min-h-0 px-4 py-4 md:px-6">
				<div className="max-w-prose">
					<MessageBody email={email} mailboxId={mailboxId} viewMode={viewMode} allowRemoteImages={allowRemoteImages} />
				</div>
			</div>

			<EmailAttachmentList
				mailboxId={mailboxId}
				emailId={email.id}
				attachments={email.attachments}
				onPreviewImage={onPreviewImage}
				className="px-4 py-3 border-t border-kumo-line shrink-0 md:px-6"
				showHeading
			/>
		</div>
	);
}
