// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Tooltip } from "@cloudflare/kumo";
import {
	CaretDownIcon,
	CaretUpIcon,
	CodeIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import type { EmailViewMode } from "shared/email-view";
import EmailAttachmentList from "~/components/EmailAttachmentList";
import MessageBody from "~/components/MessageBody";
import RemoteImagesNotice from "~/components/email-panel/RemoteImagesNotice";
import { useRemoteImagesAllowed } from "~/hooks/useRemoteImages";
import {
	formatDetailDate,
	formatShortDate,
	stripHtml,
} from "~/lib/utils";
import type { Email } from "~/types";

interface ThreadMessageProps {
	email: Email;
	mailboxId?: string | undefined;
	mailboxEmail?: string | undefined;
	/** Effective HTML | plain text mode for the panel. */
	viewMode: EmailViewMode;
	isLast: boolean;
	isDraft?: boolean | undefined;
	isSending?: boolean | undefined;
	isExpanded: boolean;
	onToggleExpand: () => void;
	onSendDraft?: (() => void) | undefined;
	onEditDraft?: (() => void) | undefined;
	onDeleteDraft?: (() => void) | undefined;
	onViewSource?: () => void;
	onPreviewImage?: (url: string, filename: string) => void;
}

/** Split a `Name <addr>` sender into display name and address. */
function parseSender(sender: string): { name: string; address: string | null } {
	const match = sender.match(/^(.*?)\s*<([^>]+)>\s*$/);
	if (match?.[1]?.trim() && match[2]) {
		return { name: match[1].trim(), address: match[2].trim() };
	}
	return { name: sender.trim(), address: null };
}

function Avatar({ isDraft, sender }: { isDraft?: boolean | undefined; isSelf: boolean; sender: string }) {
	return (
		<div
			aria-hidden="true"
			className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
				isDraft
					? "bg-kumo-fill text-kumo-subtle"
					: "bg-kumo-fill text-kumo-default"
			}`}
		>
			{isDraft ? "D" : sender.charAt(0).toUpperCase()}
		</div>
	);
}

export default function ThreadMessage({
	email,
	mailboxId,
	mailboxEmail,
	viewMode,
	isLast,
	isDraft,
	isSending,
	isExpanded,
	onToggleExpand,
	onSendDraft,
	onEditDraft,
	onDeleteDraft,
	onViewSource,
	onPreviewImage,
}: ThreadMessageProps) {
	const isSelf = email.sender === mailboxEmail;
	const allowRemoteImages = useRemoteImagesAllowed(email, mailboxId);
	const containerClassName = `${!isLast ? "border-b border-kumo-line" : ""} ${isDraft ? "border-l-2 border-l-kumo-warning bg-kumo-warning/[0.02]" : ""}`;
	const parsedSender = parseSender(email.sender);
	const senderLabel = isDraft ? "Draft reply" : isSelf ? "You" : parsedSender.name;
	const senderAddress = parsedSender.address ?? (parsedSender.name.includes("@") ? parsedSender.name : null);

	if (!isExpanded) {
		return (
			<div className={containerClassName}>
				<button
					type="button"
					onClick={onToggleExpand}
					className="w-full flex items-center gap-3 px-4 py-3 hover:bg-kumo-tint rounded-lg text-left"
				>
					<Avatar isDraft={isDraft} isSelf={isSelf} sender={email.sender} />
					<div className="flex-1 min-w-0">
						<div className="flex items-center justify-between gap-3">
							<span className="truncate text-[15px] font-medium text-kumo-default">
								{senderLabel}
							</span>
							<time dateTime={email.date} className="text-xs text-kumo-subtle shrink-0">
								{formatDetailDate(email.date)}
							</time>
						</div>
						<p className="text-xs text-kumo-subtle truncate">
							{stripHtml(email.body || "").slice(0, 80)}
						</p>
					</div>
					<CaretDownIcon size={14} className="text-kumo-subtle shrink-0" />
				</button>
			</div>
		);
	}

	return (
		<div className={`group/thread-msg ${containerClassName}`}>
			<div className="px-4 py-4 md:px-6">
				<div className="flex items-center justify-between gap-3 mb-3">
					<div className="flex items-center gap-2.5 min-w-0">
						<button
							type="button"
							onClick={onToggleExpand}
							className="shrink-0"
							aria-label="Collapse message"
						>
							<div className="cursor-pointer hover:ring-2 hover:ring-kumo-brand/30 transition-shadow rounded-full">
								<Avatar isDraft={isDraft} isSelf={isSelf} sender={email.sender} />
							</div>
						</button>
						<div className="min-w-0">
							<div className="flex flex-wrap items-baseline gap-x-2">
								<span className="truncate text-[15px] font-medium leading-tight text-kumo-default">
									{senderLabel}
								</span>
								{!isDraft && senderAddress && senderAddress !== senderLabel && (
									<span className="truncate text-xs text-kumo-subtle">{senderAddress}</span>
								)}
								{isDraft && <Badge variant="outline">Draft</Badge>}
							</div>
							<div className="mt-0.5 truncate text-xs text-kumo-subtle">
								To: {email.recipient}
								{email.cc ? ` · Cc: ${email.cc}` : ""}
							</div>
							{email.envelope_recipient && email.envelope_recipient !== email.recipient && (
								<div className="truncate text-xs text-kumo-subtle">Delivered to: {email.envelope_recipient}</div>
							)}
						</div>
					</div>
					<div className="flex items-center gap-1 shrink-0">
						<time dateTime={email.date} className="text-xs text-kumo-subtle">
							{formatShortDate(email.date)}
						</time>
						{onViewSource && (
							<Tooltip content="View source" side="bottom" asChild>
								<Button
									variant="ghost"
									shape="square"
									size="sm"
									icon={<CodeIcon size={14} />}
									onClick={onViewSource}
									aria-label="View source"
									className="transition-opacity !h-6 !w-6"
								/>
							</Tooltip>
						)}
						<button
							type="button"
							onClick={onToggleExpand}
							className="ml-1"
							aria-label="Collapse message"
						>
							<CaretUpIcon
								size={14}
								className="text-kumo-subtle hover:text-kumo-default transition-colors"
							/>
						</button>
					</div>
				</div>

				<RemoteImagesNotice email={email} mailboxId={mailboxId} />


				<div className="max-w-prose md:ml-[44px]">
					<MessageBody email={email} mailboxId={mailboxId} viewMode={viewMode} autoSize allowRemoteImages={allowRemoteImages} />
				</div>

				{isDraft && (onSendDraft || onEditDraft || onDeleteDraft) && (
					<div className="flex gap-2 mt-3 md:ml-[44px]">
						{onSendDraft && (
							<Button
								variant="primary"
								size="sm"
								icon={<PaperPlaneTiltIcon size={14} />}
								onClick={onSendDraft}
								loading={isSending ?? false}
								disabled={isSending}
							>
								{isSending ? "Sending..." : "Send"}
							</Button>
						)}
						{onEditDraft && (
							<Button
								variant="secondary"
								size="sm"
								icon={<PencilSimpleIcon size={14} />}
								onClick={onEditDraft}
								disabled={isSending}
							>
								Edit
							</Button>
						)}
						{onDeleteDraft && (
							<Button
								variant="ghost"
								size="sm"
								icon={<TrashIcon size={14} />}
								onClick={onDeleteDraft}
								disabled={isSending}
							>
								Discard
							</Button>
						)}
					</div>
				)}

				<EmailAttachmentList
					mailboxId={mailboxId}
					emailId={email.id}
					attachments={email.attachments}
					onPreviewImage={onPreviewImage}
					className="mt-3 max-w-prose md:ml-[44px]"
				/>
			</div>
		</div>
	);
}
