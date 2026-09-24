// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, DropdownMenu, Tooltip } from "@cloudflare/kumo";
import {
	ArchiveIcon,
	ArrowUUpLeftIcon,
	CaretDownIcon,
	EnvelopeOpenIcon,
	EnvelopeSimpleIcon,
	FolderIcon,
	ProhibitIcon,
	StarIcon,
	TrashIcon,
	XIcon,
} from "@phosphor-icons/react";

interface BulkActionBarProps {
	/** Number of selected rows. */
	count: number;
	/** A batch request is in flight; actions are disabled. */
	isPending?: boolean;
	/** Folders offered by the "Move to folder" menu. */
	folders: Array<{ id: string; name: string }>;
	/**
	 * Selected rows live in the Trash folder: the destructive action purges
	 * them for good and Restore is offered.
	 */
	inTrash?: boolean;
	onMarkRead: () => void;
	onMarkUnread: () => void;
	onStar: () => void;
	onUnstar: () => void;
	onArchive: () => void;
	onSpam: () => void;
	onMove: (folderId: string) => void;
	/** Move the selection to Trash. Without it the destructive button keeps the legacy delete action. */
	onTrash?: () => void;
	/** Move the selection from Trash back to the inbox. */
	onRestore?: () => void;
	onDelete: () => void;
	onClear: () => void;
}

/**
 * Toolbar shown in place of a list header while rows are selected. Actions
 * are icon buttons with tooltips so the bar fits the narrow list column.
 *
 * The destructive slot is trash-aware: outside Trash it moves the selection
 * to Trash (bulk action "trash"), inside Trash it deletes for good (bulk
 * action "delete", which purges messages that are already in Trash). Restore
 * is only offered while viewing Trash.
 */
export default function BulkActionBar({
	count,
	isPending = false,
	folders,
	inTrash = false,
	onMarkRead,
	onMarkUnread,
	onStar,
	onUnstar,
	onArchive,
	onSpam,
	onMove,
	onTrash,
	onRestore,
	onDelete,
	onClear,
}: BulkActionBarProps) {
	const destructiveLabel = inTrash
		? "Delete forever"
		: onTrash
			? "Move to Trash"
			: "Delete";
	const onDestructive = inTrash ? onDelete : (onTrash ?? onDelete);
	return (
		<div
			role="toolbar"
			aria-label="Actions for selected emails"
			className="flex min-w-0 flex-1 items-center gap-2"
		>
			<span
				aria-live="polite"
				className="shrink-0 text-sm font-medium text-kumo-default whitespace-nowrap"
			>
				{count} selected
			</span>

			<div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
				<Tooltip side="bottom" content="Mark read" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<EnvelopeOpenIcon size={16} />}
						onClick={onMarkRead}
						disabled={isPending}
						aria-label="Mark read"
					/>
				</Tooltip>
				<Tooltip side="bottom" content="Mark unread" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<EnvelopeSimpleIcon size={16} />}
						onClick={onMarkUnread}
						disabled={isPending}
						aria-label="Mark unread"
					/>
				</Tooltip>
				<Tooltip side="bottom" content="Star" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<StarIcon size={16} />}
						onClick={onStar}
						disabled={isPending}
						aria-label="Star"
					/>
				</Tooltip>
				<Tooltip side="bottom" content="Remove star" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<StarIcon size={16} weight="fill" />}
						onClick={onUnstar}
						disabled={isPending}
						aria-label="Remove star"
					/>
				</Tooltip>

				<span className="mx-1 h-4 w-px shrink-0 bg-kumo-line" aria-hidden="true" />

				<Tooltip side="bottom" content="Archive" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<ArchiveIcon size={16} />}
						onClick={onArchive}
						disabled={isPending}
						aria-label="Archive"
					/>
				</Tooltip>
				<DropdownMenu>
					<Tooltip side="bottom" content="Move to folder" asChild>
						<DropdownMenu.Trigger
							render={
								<Button
									variant="ghost"
									size="sm"
									icon={<FolderIcon size={16} />}
									disabled={isPending}
									aria-label="Move to folder"
								/>
							}
						>
							<CaretDownIcon size={12} className="opacity-60" />
						</DropdownMenu.Trigger>
					</Tooltip>
					<DropdownMenu.Content align="start" className="max-h-72 overflow-y-auto">
						<DropdownMenu.Group>
							<DropdownMenu.Label>Move to folder</DropdownMenu.Label>
							<DropdownMenu.Separator />
							{folders.length > 0 ? (
								folders.map((folder) => (
									<DropdownMenu.Item
										key={folder.id}
										icon={FolderIcon}
										onClick={() => onMove(folder.id)}
									>
										{folder.name}
									</DropdownMenu.Item>
								))
							) : (
								<DropdownMenu.Item disabled>No other folders</DropdownMenu.Item>
							)}
						</DropdownMenu.Group>
					</DropdownMenu.Content>
				</DropdownMenu>
				<Tooltip side="bottom" content="Mark as spam" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<ProhibitIcon size={16} />}
						onClick={onSpam}
						disabled={isPending}
						aria-label="Mark as spam"
					/>
				</Tooltip>

				<span className="mx-1 h-4 w-px shrink-0 bg-kumo-line" aria-hidden="true" />

				{inTrash && onRestore && (
					<Tooltip side="bottom" content="Restore to Inbox" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<ArrowUUpLeftIcon size={16} />}
							onClick={onRestore}
							disabled={isPending}
							aria-label="Restore to Inbox"
						/>
					</Tooltip>
				)}
				<Tooltip side="bottom" content={destructiveLabel} asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<TrashIcon size={16} />}
						onClick={onDestructive}
						disabled={isPending}
						aria-label={destructiveLabel}
					/>
				</Tooltip>
			</div>

			<Tooltip side="bottom" content="Clear selection" asChild>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={<XIcon size={16} />}
					onClick={onClear}
					className="shrink-0"
					aria-label="Clear selection"
				/>
			</Tooltip>
		</div>
	);
}
