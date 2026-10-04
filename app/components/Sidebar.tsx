// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Dialog, Input, Tooltip } from "@cloudflare/kumo";
import {
	ArchiveIcon,
	CaretLeftIcon,
	CheckSquareIcon,
	ClockCounterClockwiseIcon,
	ClockIcon,
	EnvelopeOpenIcon,
	FileIcon,
	FolderIcon,
	FunnelIcon,
	MagnifyingGlassIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	PlusIcon,
	ProhibitIcon,
	PulseIcon,
	SunIcon,
	TrashIcon,
	TrayIcon,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { NavLink, useNavigate, useParams, useSearchParams } from "react-router";
import { Folders, SYSTEM_FOLDER_IDS } from "shared/folders";
import { SNOOZE_FOLDER_ID } from "~/lib/snooze";
import { useCreateFolder, useDeleteFolder, useFolders, useUpdateFolder } from "~/queries/folders";
import { useMailbox } from "~/queries/mailboxes";
import {
	useDeleteSavedSearch,
	useSavedSearches,
} from "~/queries/saved-searches";
import { useUIStore } from "~/hooks/useUIStore";
import type { Folder } from "~/types";

const FOLDER_ICONS: Record<string, React.ReactNode> = {
	[Folders.INBOX]: <TrayIcon size={18} weight="regular" />,
	[Folders.SENT]: <PaperPlaneTiltIcon size={18} weight="regular" />,
	[Folders.DRAFT]: <FileIcon size={18} weight="regular" />,
	[Folders.ARCHIVE]: <ArchiveIcon size={18} weight="regular" />,
	[SNOOZE_FOLDER_ID]: <ClockCounterClockwiseIcon size={18} weight="regular" />,
	[Folders.SPAM]: <ProhibitIcon size={18} weight="regular" />,
	[Folders.TRASH]: <TrashIcon size={18} weight="regular" />,
};

const SYSTEM_FOLDER_LINKS = [
	{ id: Folders.INBOX, label: "Inbox" },
	{ id: Folders.SENT, label: "Sent" },
	{ id: Folders.DRAFT, label: "Drafts" },
	{ id: Folders.ARCHIVE, label: "Archive" },
	{ id: SNOOZE_FOLDER_ID, label: "Snoozed" },
	{ id: Folders.SPAM, label: "Spam" },
	{ id: Folders.TRASH, label: "Trash" },
];

interface FolderLinkProps {
	to: string;
	icon: React.ReactNode;
	label: string;
	unreadCount?: number;
	onClick?: () => void;
	className?: string;
}

function FolderLink({
	to,
	icon,
	label,
	unreadCount,
	onClick,
	className,
}: FolderLinkProps) {
	return (
		<NavLink
			to={to}
			onClick={onClick}
			className={({ isActive }) =>
				`flex items-center gap-3 py-2 px-3 rounded-md text-sm transition-colors ${className ?? ""} ${
					isActive
						? "bg-kumo-fill font-semibold text-kumo-default"
						: "text-kumo-strong hover:bg-kumo-tint"
				}`
			}
		>
			<span className="shrink-0">{icon}</span>
			<span className="truncate flex-1">{label}</span>
			{unreadCount != null && unreadCount > 0 && (
				<Badge variant="secondary">{unreadCount}</Badge>
			)}
		</NavLink>
	);
}

export default function Sidebar() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const navigate = useNavigate();
	const { data: folders = [] } = useFolders(mailboxId);
	const createFolderMutation = useCreateFolder();
	const updateFolderMutation = useUpdateFolder();
	const deleteFolderMutation = useDeleteFolder();
	const { startCompose, closeSidebar } = useUIStore();
	const { data: currentMailbox } = useMailbox(mailboxId);
	const { data: savedSearchesData } = useSavedSearches(mailboxId);
	const savedSearches = savedSearchesData?.searches ?? [];
	const [searchParams] = useSearchParams();
	// Every saved search shares the search route's pathname, so NavLink's
	// isActive is true for all of them there; the row only counts as the
	// current one when the page is showing its own query.
	const currentSearchQuery = searchParams.get("q") ?? "";
	const deleteSavedSearch = useDeleteSavedSearch();
	// The saved search whose delete control is showing its confirm step.
	const [confirmingSearchId, setConfirmingSearchId] = useState<string | null>(
		null,
	);
	const [isCreateFolderOpen, setIsCreateFolderOpen] = useState(false);
	const [newFolderName, setNewFolderName] = useState("");
	// The custom folder whose rename dialog is open, and its draft name.
	const [renameFolder, setRenameFolder] = useState<Folder | null>(null);
	const [renameFolderName, setRenameFolderName] = useState("");
	// The custom folder whose delete confirmation is open.
	const [folderToDelete, setFolderToDelete] = useState<Folder | null>(null);

	const customFolders = useMemo(
		() =>
			// Snoozed is a system view (own sidebar entry) even though the
			// workers side may also list it among the API folders.
			folders.filter(
				(f) =>
					!(SYSTEM_FOLDER_IDS as readonly string[]).includes(f.id) &&
					f.id !== SNOOZE_FOLDER_ID,
			),
		[folders],
	);

	const getUnreadCount = (folderId: string) => {
		const found = folders.find((f) => f.id === folderId);
		return found?.unreadCount || 0;
	};

	const handleCreateFolder = (e: React.FormEvent) => {
		e.preventDefault();
		if (newFolderName.trim() && mailboxId) {
			createFolderMutation.mutate({ mailboxId, name: newFolderName.trim() });
			setNewFolderName("");
			setIsCreateFolderOpen(false);
		}
	};

	// A rename may not collide with another folder's name (the database
	// enforces a unique index; catching it here keeps the dialog honest
	// instead of surfacing a failed request).
	const renameFolderConflict = useMemo(() => {
		const trimmed = renameFolderName.trim();
		if (trimmed === "") return false;
		return folders.some(
			(f) =>
				f.id !== renameFolder?.id &&
				f.name.toLowerCase() === trimmed.toLowerCase(),
		);
	}, [folders, renameFolder, renameFolderName]);

	const handleRenameFolder = (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = renameFolderName.trim();
		if (!trimmed || !mailboxId || !renameFolder || renameFolderConflict) return;
		if (trimmed !== renameFolder.name) {
			updateFolderMutation.mutate({
				mailboxId,
				id: renameFolder.id,
				name: trimmed,
			});
		}
		setRenameFolder(null);
	};

	const handleDeleteFolder = () => {
		if (!mailboxId || !folderToDelete) return;
		deleteFolderMutation.mutate(
			{ mailboxId, id: folderToDelete.id },
			{ onSettled: () => setFolderToDelete(null) },
		);
	};

	const handleDeleteSavedSearch = (searchId: string) => {
		setConfirmingSearchId(null);
		if (mailboxId) deleteSavedSearch.mutate({ mailboxId, searchId });
	};

	const displayName = useMemo(() => {
		if (!currentMailbox) return mailboxId?.split("@")[0] || "Mailbox";
		// Prefer settings.fromName > name > local part of email
		if (currentMailbox.settings?.fromName) {
			return currentMailbox.settings.fromName;
		}
		if (currentMailbox.name && currentMailbox.name !== currentMailbox.email) {
			return currentMailbox.name;
		}
		return currentMailbox.email.split("@")[0] || currentMailbox.name;
	}, [currentMailbox, mailboxId]);

	const handleNavClick = () => {
		// Close mobile sidebar on navigation
		closeSidebar();
	};

	return (
		<aside className="h-full w-64 bg-kumo-recessed flex flex-col shrink-0 border-r border-kumo-line">
			{/* Back + identity */}
			<div className="px-4 pt-4 pb-1">
				<button
					type="button"
					onClick={() => {
						void navigate("/");
						closeSidebar();
					}}
					className="flex items-center gap-1.5 text-kumo-subtle text-sm hover:text-kumo-default transition-colors mb-2.5 cursor-pointer bg-transparent border-0 p-0"
				>
					<CaretLeftIcon size={14} />
					<span>Mailboxes</span>
				</button>
				<div className="px-1">
					<div className="text-base font-semibold text-kumo-default truncate">
						{displayName}
					</div>
					<div className="text-sm text-kumo-subtle truncate mt-0.5">
						{currentMailbox?.email || mailboxId}
					</div>
				</div>
			</div>

			{/* Compose */}
			<div className="px-3 py-3">
				<Button
					variant="primary"
					icon={<PencilSimpleIcon size={16} />}
					onClick={() => startCompose()}
					className="w-full"
				>
					Compose
				</Button>
			</div>

			{/* Navigation */}
			<nav className="flex-1 overflow-y-auto px-2 space-y-0.5">
				<FolderLink
					to="/all"
					icon={<EnvelopeOpenIcon size={18} />}
					label="All Accounts"
					onClick={handleNavClick}
				/>

				{SYSTEM_FOLDER_LINKS.map((folder) => (
					<FolderLink
						key={folder.id}
						to={`/mailbox/${mailboxId}/emails/${folder.id}`}
						icon={FOLDER_ICONS[folder.id]}
						label={folder.label}
						unreadCount={getUnreadCount(folder.id)}
						onClick={handleNavClick}
					/>
				))}

				{/* Custom folders */}
				{customFolders.length > 0 && (
					<div className="pt-5">
						<div className="flex items-center justify-between px-3 mb-1.5">
							<span className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle">
								Folders
							</span>
							<Tooltip content="New folder" asChild>
								<Button
									variant="ghost"
									shape="square"
									size="sm"
									icon={<PlusIcon size={16} />}
									onClick={() => setIsCreateFolderOpen(true)}
									aria-label="Create new folder"
								/>
							</Tooltip>
						</div>
						{customFolders.map((folder) => (
							<div key={folder.id} className="group flex items-center gap-1">
								<FolderLink
									to={`/mailbox/${mailboxId}/emails/${folder.id}`}
									icon={<FolderIcon size={18} />}
									label={folder.name}
									unreadCount={folder.unreadCount}
									onClick={handleNavClick}
									className="flex-1 min-w-0"
								/>
								<button
									type="button"
									onClick={() => {
										setRenameFolder(folder);
										setRenameFolderName(folder.name);
									}}
									aria-label={`Rename folder ${folder.name}`}
									className="shrink-0 rounded p-1 text-kumo-subtle opacity-0 transition-opacity hover:text-kumo-default focus-visible:opacity-100 group-hover:opacity-100"
								>
									<PencilSimpleIcon size={14} />
								</button>
								<button
									type="button"
									onClick={() => setFolderToDelete(folder)}
									aria-label={`Delete folder ${folder.name}`}
									className="shrink-0 rounded p-1 text-kumo-subtle opacity-0 transition-opacity hover:text-kumo-danger focus-visible:opacity-100 group-hover:opacity-100"
								>
									<TrashIcon size={14} />
								</button>
							</div>
						))}
					</div>
				)}

				{/* Add folder button when no custom folders */}
				{customFolders.length === 0 && (
					<div className="pt-5">
						<div className="flex items-center justify-between px-3 mb-1.5">
							<span className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle">
								Folders
							</span>
							<Tooltip content="New folder" asChild>
								<Button
									variant="ghost"
									shape="square"
									size="sm"
									icon={<PlusIcon size={16} />}
									onClick={() => setIsCreateFolderOpen(true)}
									aria-label="Create new folder"
								/>
							</Tooltip>
						</div>
					</div>
				)}
				{/* Saved searches — named queries kept per mailbox. The section
				    only appears once the mailbox holds at least one. */}
				{savedSearches.length > 0 && (
					<div className="pt-5">
						<div className="flex items-center justify-between px-3 mb-1.5">
							<span className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle">
								Saved searches
							</span>
						</div>
						{savedSearches.map((search) => (
							<div key={search.id} className="group flex items-center gap-1">
								<NavLink
									to={`/mailbox/${mailboxId}/search?q=${encodeURIComponent(search.query)}`}
									onClick={handleNavClick}
									title={search.query}
									className={({ isActive }) =>
										`flex min-w-0 flex-1 items-center gap-3 py-2 px-3 rounded-md text-sm transition-colors ${
											isActive && currentSearchQuery === search.query
												? "bg-kumo-fill font-semibold text-kumo-default"
												: "text-kumo-strong hover:bg-kumo-tint"
										}`
									}
								>
									<MagnifyingGlassIcon size={18} className="shrink-0" />
									<span className="truncate flex-1">{search.name}</span>
								</NavLink>
								{confirmingSearchId === search.id ? (
									<>
										<button
											type="button"
											onClick={() => handleDeleteSavedSearch(search.id)}
											className="shrink-0 rounded px-1 text-xs font-medium text-kumo-danger hover:underline"
										>
											Delete
										</button>
										<button
											type="button"
											onClick={() => setConfirmingSearchId(null)}
											className="shrink-0 rounded px-1 text-xs text-kumo-subtle hover:text-kumo-default"
										>
											Cancel
										</button>
									</>
								) : (
									<button
										type="button"
										onClick={() => setConfirmingSearchId(search.id)}
										aria-label={`Delete saved search ${search.name}`}
										className="shrink-0 rounded p-1 text-kumo-subtle opacity-0 transition-opacity hover:text-kumo-danger focus-visible:opacity-100 group-hover:opacity-100"
									>
										<TrashIcon size={14} />
									</button>
								)}
							</div>
						))}
					</div>
				)}

				{/* Today — the morning brief for this mailbox */}
				<div className="pt-5">
					<div className="flex items-center justify-between px-3 mb-1.5">
						<span className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle">
							Today
						</span>
					</div>
					<FolderLink
						to={`/mailbox/${mailboxId}/digest`}
						icon={<SunIcon size={18} />}
						label="Digest"
						onClick={handleNavClick}
					/>
				</div>

				{/* Sending — the composer's queued and past scheduled sends */}
				<div className="pt-5">
					<div className="flex items-center justify-between px-3 mb-1.5">
						<span className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle">
							Sending
						</span>
					</div>
					<FolderLink
						to={`/mailbox/${mailboxId}/scheduled`}
						icon={<ClockIcon size={18} />}
						label="Scheduled"
						onClick={handleNavClick}
					/>
				</div>

				{/* Automation — deterministic rules run before the AI classifier */}
				<div className="pt-5">
					<div className="flex items-center justify-between px-3 mb-1.5">
						<span className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle">
							Automation
						</span>
					</div>
					<FolderLink
						to={`/mailbox/${mailboxId}/rules`}
						icon={<FunnelIcon size={18} />}
						label="Rules"
						onClick={handleNavClick}
					/>
				</div>

				{/* Tasks — deadlines and obligations extracted from incoming mail */}
				<div className="pt-5">
					<div className="flex items-center justify-between px-3 mb-1.5">
						<span className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle">
							Tasks
						</span>
					</div>
					<FolderLink
						to={`/mailbox/${mailboxId}/tasks`}
						icon={<CheckSquareIcon size={18} />}
						label="Tasks"
						onClick={handleNavClick}
					/>
				</div>

				{/* Agent — what the AI agent and MCP clients did to this mailbox */}
				<div className="pt-5">
					<div className="flex items-center justify-between px-3 mb-1.5">
						<span className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle">
							Agent
						</span>
					</div>
					<FolderLink
						to={`/mailbox/${mailboxId}/activity`}
						icon={<PulseIcon size={18} />}
						label="Activity"
						onClick={handleNavClick}
					/>
				</div>


			</nav>

			{/* Create folder dialog */}
			<Dialog.Root
				open={isCreateFolderOpen}
				onOpenChange={setIsCreateFolderOpen}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-4">
						Create folder
					</Dialog.Title>
					<form onSubmit={handleCreateFolder} className="space-y-4">
						<Input
							label="Folder name"
							placeholder="e.g. Projects"
							value={newFolderName}
							onChange={(e) => setNewFolderName(e.target.value)}
							required
						/>
						<div className="flex justify-end gap-2">
							<Dialog.Close
								render={({ className, ...props }) => (
									<Button {...props} {...(className ? { className } : {})} variant="secondary">
										Cancel
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								disabled={!newFolderName.trim()}
							>
								Create
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>

			{/* Rename folder dialog */}
			<Dialog.Root
				open={renameFolder !== null}
				onOpenChange={(open) => {
					if (!open) setRenameFolder(null);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-4">
						Rename folder
					</Dialog.Title>
					<form onSubmit={handleRenameFolder} className="space-y-4">
						<Input
							label="Folder name"
							value={renameFolderName}
							onChange={(e) => setRenameFolderName(e.target.value)}
							required
						/>
						{renameFolderConflict && (
							<p className="text-xs text-kumo-danger">
								A folder with this name already exists.
							</p>
						)}
						<div className="flex justify-end gap-2">
							<Dialog.Close
								render={({ className, ...props }) => (
									<Button {...props} {...(className ? { className } : {})} variant="secondary">
										Cancel
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								disabled={
									!renameFolderName.trim() ||
									renameFolderName.trim() === renameFolder?.name ||
									renameFolderConflict
								}
							>
								Save
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>

			{/* Delete folder dialog — deleting a folder takes its messages with it */}
			<Dialog.Root
				open={folderToDelete !== null}
				onOpenChange={(open) => {
					if (!open) setFolderToDelete(null);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="mb-2 text-base font-semibold">
						Delete folder
					</Dialog.Title>
					<Dialog.Description className="mb-4 text-sm text-kumo-subtle">
						“{folderToDelete?.name}” will be deleted, along with any messages in
						it. This cannot be undone.
					</Dialog.Description>
					<div className="flex justify-end gap-2">
						<Dialog.Close
							render={({ className, ...props }) => (
								<Button {...props} {...(className ? { className } : {})} variant="secondary">
									Cancel
								</Button>
							)}
						/>
						<Button
							variant="destructive"
							onClick={handleDeleteFolder}
							loading={deleteFolderMutation.isPending}
						>
							Delete
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</aside>
	);
}
