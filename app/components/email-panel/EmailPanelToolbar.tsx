// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { Badge, Button, Tooltip } from "@cloudflare/kumo";
import { useEffect, useRef, useState } from "react";
import {
	AlarmIcon,
	ArrowBendUpLeftIcon,
	ArrowBendUpRightIcon,
	ArrowLeftIcon,
	ArrowUUpLeftIcon,
	BellRingingIcon,
	ChatCircleIcon,
	ClockCounterClockwiseIcon,
	CodeIcon,
	EnvelopeOpenIcon,
	EnvelopeSimpleIcon,
	FolderSimpleIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	StarIcon,
	TrashIcon,
	XIcon,
} from "@phosphor-icons/react";
import SnoozeMenu from "~/components/email-panel/SnoozeMenu";
import { formatSnoozeTime } from "~/lib/snooze";
import type { Folder, Email } from "~/types";


interface EmailPanelToolbarProps {
	email: Email;
	mailboxId?: string | undefined;
	isDraftFolder: boolean;
	/** The email sits in the Trash folder: delete purges and Restore is offered. */
	isTrash: boolean;
	isSending: boolean;
	moveToFolders: Folder[];
	lastReceivedMessage?: Email | undefined;
	onBack: () => void;
	onSendDraft: () => void;
	onEditDraft: () => void;
	onReply: () => void;
	onReplyAll: () => void;
	onForward: () => void;
	onToggleStar: () => void;
	onToggleRead: () => void;
	onMove: (folderId: string) => void;
	onViewSource: () => void;
	onDelete: () => void;
	onRestore: () => void;
	/** Snooze the message until the given ISO 8601 instant. */
	onSnooze: (untilIso: string) => void;
	/** Wake the message immediately and return it to its folder. */
	onUnsnooze: () => void;
	/** Schedule a follow-up reminder at the given ISO 8601 instant. */
	onRemind: (atIso: string) => void;
	/** Dismiss a fired reminder, or cancel a scheduled one. */
	onDismissReminder: () => void;
}


export default function EmailPanelToolbar({
	email,
	isDraftFolder,
	isTrash,
	isSending,
	moveToFolders,
	onBack,
	onSendDraft,
	onEditDraft,
	onReply,
	onReplyAll,
	onForward,
	onToggleStar,
	onToggleRead,
	onMove,
	onViewSource,
	onDelete,
	onRestore,
	onSnooze,
	onUnsnooze,
	onRemind,
	onDismissReminder,
}: EmailPanelToolbarProps) {
	return (
		<div className="flex items-center gap-1 px-3 py-2 border-b border-kumo-line shrink-0 md:px-4">
			<Button
				variant="ghost"
				shape="square"
				size="sm"
				icon={<ArrowLeftIcon size={18} />}
				onClick={onBack}
				aria-label="Back to list"
				className="md:hidden shrink-0"
			/>


			{isDraftFolder ? (
				<>
					<Button
						variant="primary"
						size="sm"
						icon={<PaperPlaneTiltIcon size={16} />}
						onClick={onSendDraft}
						loading={isSending}
					>
						{isSending ? "Sending..." : "Send"}
					</Button>
					<Button
						variant="secondary"
						size="sm"
						icon={<PencilSimpleIcon size={16} />}
						onClick={onEditDraft}
					>
						Edit
					</Button>
				</>
			) : (
				<>
					<Tooltip content="Reply" side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<ArrowBendUpLeftIcon size={18} />}
							onClick={onReply}
							aria-label="Reply"
						/>
					</Tooltip>
					<Tooltip content="Reply All" side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<ChatCircleIcon size={18} />}
							onClick={onReplyAll}
							aria-label="Reply All"
						/>
					</Tooltip>
					<Tooltip content="Forward" side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<ArrowBendUpRightIcon size={18} />}
							onClick={onForward}
							aria-label="Forward"
						/>
					</Tooltip>
				</>
			)}


			<div className="h-5 w-px bg-kumo-fill mx-0.5" />


			<Tooltip content={email.starred ? "Unstar" : "Star"} side="bottom" asChild>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={
						<StarIcon
							size={18}
							weight={email.starred ? "fill" : "regular"}
							className={email.starred ? "text-kumo-warning" : ""}
						/>
					}
					onClick={onToggleStar}
					aria-label={email.starred ? "Unstar" : "Star"}
				/>
			</Tooltip>


			<Tooltip content={email.read ? "Mark as unread" : "Mark as read"} side="bottom" asChild>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={email.read ? <EnvelopeSimpleIcon size={18} /> : <EnvelopeOpenIcon size={18} />}
					onClick={onToggleRead}
					aria-label={email.read ? "Mark as unread" : "Mark as read"}
				/>
			</Tooltip>


			<MoveToFolderMenu folders={moveToFolders} onMove={onMove} />

			{/* Snooze, follow-up reminders and the fired-reminder nudge.
			    Drafts and trashed messages are not snoozable. */}
			{!isDraftFolder && !isTrash && (
				<>
					{email.snooze_until ? (
						<>
							<Tooltip content="Unsnooze" side="bottom" asChild>
								<Button
									variant="ghost"
									shape="square"
									size="sm"
									icon={<ClockCounterClockwiseIcon size={18} />}
									onClick={onUnsnooze}
									aria-label="Unsnooze"
								/>
							</Tooltip>
							<span className="hidden text-xs text-kumo-subtle sm:inline">
								Snoozed until {formatSnoozeTime(email.snooze_until)}
							</span>
						</>
					) : (
						<SnoozeMenu
							label="Snooze"
							icon={<ClockCounterClockwiseIcon size={18} />}
							header="Snooze until"
							onPick={onSnooze}
						/>
					)}
					<SnoozeMenu
						label={
							email.remind_at && !email.reminded_at
								? `Reminder set for ${formatSnoozeTime(email.remind_at)}`
								: "Remind me"
						}
						ariaLabel="Remind me"
						icon={<AlarmIcon size={18} />}
						header="Remind me"
						active={!!email.remind_at && !email.reminded_at}
						onPick={onRemind}
						extraItems={
							email.remind_at
								? [{ label: "Clear reminder", onSelect: onDismissReminder }]
								: undefined
						}
					/>
					{email.reminded_at && (
						<Badge variant="warning" className="gap-1.5">
							<BellRingingIcon size={14} weight="bold" />
							Reminder
							<button
								type="button"
								onClick={onDismissReminder}
								aria-label="Dismiss reminder"
								className="flex cursor-pointer items-center border-0 bg-transparent p-0 text-kumo-warning hover:text-kumo-default"
							>
								<XIcon size={12} weight="bold" />
							</button>
						</Badge>
					)}
				</>
			)}


			<div className="ml-auto flex items-center gap-0.5">
				<Tooltip content="View source" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<CodeIcon size={18} />}
						onClick={onViewSource}
						aria-label="View source"
					/>
				</Tooltip>
				{isTrash && (
					<Tooltip content="Restore to Inbox" side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<ArrowUUpLeftIcon size={18} />}
							onClick={onRestore}
							aria-label="Restore to Inbox"
						/>
					</Tooltip>
				)}
				<Tooltip
					content={isTrash ? "Delete forever" : "Move to Trash"}
					side="bottom"
					asChild
				>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<TrashIcon size={18} />}
						onClick={onDelete}
						aria-label={isTrash ? "Delete forever" : "Move to Trash"}
					/>
				</Tooltip>
				<Tooltip content="Close" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<XIcon size={18} />}
						onClick={onBack}
						aria-label="Close"
						className="hidden md:inline-flex"
					/>
				</Tooltip>
			</div>
		</div>
	);
}


function MoveToFolderMenu({ folders, onMove }: { folders: Folder[]; onMove: (id: string) => void }) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);


	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);


	return (
		<div ref={ref} className="relative">
			<Tooltip content="Move to folder" side="bottom" asChild>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={<FolderSimpleIcon size={18} />}
					onClick={() => setOpen((o) => !o)}
					aria-label="Move to folder"
				/>
			</Tooltip>
			{open && (
				<div className="absolute top-full left-0 z-50 mt-1 min-w-[160px] rounded-lg border border-kumo-line bg-kumo-elevated shadow-lg py-1">
					<div className="px-3 py-1.5 text-xs font-medium text-kumo-subtle">Move to</div>
					<div className="h-px bg-kumo-line my-1" />
					{folders.map((f) => (
						<button
							key={f.id}
							type="button"
							className="w-full text-left px-3 py-1.5 text-sm text-kumo-default hover:bg-kumo-overlay transition-colors"
							onClick={() => { onMove(f.id); setOpen(false); }}
						>
							{f.name}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

