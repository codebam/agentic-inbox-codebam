// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Checkbox, Pagination, Select, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import {
	ArchiveIcon,
	ArrowBendUpLeftIcon,
	ArrowsClockwiseIcon,
	EnvelopeOpenIcon,
	EnvelopeSimpleIcon,
	FileIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	ProhibitIcon,
	StarIcon,
	TrashIcon,
	TrayIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { Folders, SYSTEM_FOLDER_IDS } from "shared/folders";
import { mergeCategorizationCategories } from "shared/categories";
import { formatListDate } from "shared/dates";
import BulkActionBar from "~/components/BulkActionBar";
import CategoryBadge from "~/components/CategoryBadge";
import KeyboardCheatsheet, { KeyboardCheatsheetButton } from "~/components/KeyboardCheatsheet";
import MailboxSplitView from "~/components/MailboxSplitView";
import SelectionCheckbox from "~/components/SelectionCheckbox";
import { getSnippetText } from "~/lib/utils";
import {
	useBulkEmailAction,
	useDeleteEmail,
	useEmails,
	useEmptyTrash,
	useMarkThreadRead,
	useUpdateEmail,
} from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import { useMailbox } from "~/queries/mailboxes";
import { useGlobalCategorization } from "~/queries/categorization";
import { queryKeys } from "~/queries/keys";
import { useEmailSelection } from "~/hooks/useEmailSelection";
import { useKeyboardTriage } from "~/hooks/useKeyboardTriage";
import { useUIStore } from "~/hooks/useUIStore";
import type { BulkEmailAction, Email } from "~/types";

const PAGE_SIZE = 25;
const CATEGORY_FILTER_ALL = "__all__";

const FOLDER_EMPTY_STATES: Record<
	string,
	{
		icon: React.ReactNode;
		title: string;
		description: string;
		showCompose?: boolean;
	}
> = {
	[Folders.INBOX]: {
		icon: <TrayIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "Your inbox is empty",
		description:
			"New emails will appear here when they arrive. Send an email to get the conversation started.",
		showCompose: true,
	},
	[Folders.SENT]: {
		icon: (
			<PaperPlaneTiltIcon size={48} weight="thin" className="text-kumo-subtle" />
		),
		title: "No sent emails",
		description: "Emails you send will show up here.",
		showCompose: true,
	},
	[Folders.DRAFT]: {
		icon: <FileIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "No drafts",
		description: "Emails you're still working on will be saved here.",
		showCompose: true,
	},
	[Folders.ARCHIVE]: {
		icon: <ArchiveIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "Archive is empty",
		description:
			"Move emails here to keep your inbox clean without deleting them.",
	},
	[Folders.TRASH]: {
		icon: <TrashIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "Trash is empty",
		description:
			"Deleted emails will appear here. You can restore them or permanently delete them.",
	},
	[Folders.SPAM]: {
		icon: <ProhibitIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "No spam",
		description:
			"Emails that Jev flags as spam will be routed here when spam detection is enabled.",
	},
};

function EmailListSkeleton() {
	return (
		<div className="animate-pulse space-y-1 p-2">
			{Array.from({ length: 8 }).map((_, i) => (
				<div key={i} className="flex items-center gap-3 px-3 py-3">
					<div className="w-4 h-4 rounded bg-kumo-fill" />
					<div className="w-5 h-5 rounded bg-kumo-fill" />
					<div className="flex-1 space-y-2">
						<div className="flex items-center gap-2">
							<div className="h-3 w-24 rounded bg-kumo-fill" />
							<div className="h-3 w-4 rounded bg-kumo-fill" />
							<div className="h-3 flex-1 rounded bg-kumo-fill" />
							<div className="h-3 w-12 rounded bg-kumo-fill" />
						</div>
						<div className="h-2.5 w-3/4 rounded bg-kumo-fill" />
					</div>
				</div>
			))}
		</div>
	);
}

function FolderEmptyState({
	folder,
	onCompose,
}: {
	folder?: string;
	onCompose: () => void;
}) {
	const config = (folder && FOLDER_EMPTY_STATES[folder]) || {
		icon: (
			<EnvelopeSimpleIcon size={48} weight="thin" className="text-kumo-subtle" />
		),
		title: "No emails",
		description: "This folder is empty.",
	};

	return (
		<div className="flex flex-col items-center justify-center py-24 px-6 text-center">
			<div className="mb-4">{config.icon}</div>
			<h3 className="text-base font-semibold text-kumo-default mb-1.5">
				{config.title}
			</h3>
			<p className="text-sm text-kumo-subtle max-w-xs mb-5">
				{config.description}
			</p>
			{"showCompose" in config && config.showCompose && (
				<Button
					variant="primary"
					size="sm"
					icon={<PencilSimpleIcon size={16} />}
					onClick={onCompose}
				>
					Compose
				</Button>
			)}
		</div>
	);
}

export default function EmailListRoute() {
	const { mailboxId, folder } = useParams<{
		mailboxId: string;
		folder: string;
	}>();
	const isTrashFolder = folder === Folders.TRASH;
	const {
		selectedEmailId,
		isComposing,
		selectEmail,
		closePanel,
		startCompose,
	} = useUIStore();
	const [page, setPage] = useState(1);
	const [categoryFilter, setCategoryFilter] = useState("");

	const queryClient = useQueryClient();
	const updateEmail = useUpdateEmail();
	const markThreadRead = useMarkThreadRead();
	const deleteEmail = useDeleteEmail();
	const emptyTrash = useEmptyTrash();
	const toastManager = useKumoToastManager();

	const { data: mailbox } = useMailbox(mailboxId);
	const { data: globalCategorization } = useGlobalCategorization();
	const categories = useMemo(
		() =>
			mergeCategorizationCategories(
				globalCategorization?.categories ?? [],
				mailbox?.settings?.categorization?.categories ?? [],
				mailbox?.settings?.categorization?.useGlobalCategories !== false,
			),
		[globalCategorization, mailbox],
	);

	const params = useMemo(
		() => ({
			folder: folder || "",
			page: String(page),
			limit: String(PAGE_SIZE),
			...(categoryFilter ? { category: categoryFilter } : {}),
		}),
		[folder, page, categoryFilter],
	);

	const {
		data: emailData,
		isFetching: isRefreshing,
	} = useEmails(mailboxId, params, { refetchInterval: 30_000 });

	const emails = emailData?.emails ?? [];
	const totalCount = emailData?.totalCount ?? 0;

	const { data: folders = [] } = useFolders(mailboxId);

	const pageKeys = useMemo(() => emails.map((email) => email.id), [emails]);
	const {
		selectedKeys,
		count: selectedCount,
		isSelected: isRowSelected,
		allSelected,
		toggle,
		selectAll,
		clear,
	} = useEmailSelection(pageKeys);
	const bulkAction = useBulkEmailAction();
	// Keyboard-first triage: drives the existing selection state and the same
	// mutations the toolbar calls. Reply/compose shortcuts only open the composer.
	const keyboardTriage = useKeyboardTriage({
		emails,
		mailboxId,
		currentEmailId: selectedEmailId,
		selection: { selectedKeys, count: selectedCount, toggle, clear },
		isTrashFolder,
		isComposing,
	});

	const selectedEmails = useMemo(
		() => emails.filter((email) => selectedKeys.has(email.id)),
		[emails, selectedKeys],
	);

	/** Folders offered by the toolbar's move menu (system order first, no sent/drafts). */
	const moveFolders = useMemo(() => {
		const systemOrder = SYSTEM_FOLDER_IDS as readonly string[];
		return folders
			.filter(
				(f) =>
					f.id !== folder && f.id !== Folders.SENT && f.id !== Folders.DRAFT,
			)
			.sort((a, b) => {
				const ai = systemOrder.indexOf(a.id);
				const bi = systemOrder.indexOf(b.id);
				if (ai !== -1 && bi !== -1) return ai - bi;
				if (ai !== -1) return -1;
				if (bi !== -1) return 1;
				return a.name.localeCompare(b.name);
			})
			.map((f) => ({ id: f.id, name: f.name }));
	}, [folders, folder]);

	const runBulkAction = (
		action: BulkEmailAction,
		options?: { folderId?: string; confirm?: string },
	) => {
		if (!mailboxId || selectedEmails.length === 0) return;
		if (options?.confirm && !window.confirm(options.confirm)) return;

		bulkAction.mutate(
			{
				action,
				targets: selectedEmails.map((email) => ({
					mailboxId,
					id: email.id,
					threadId: email.thread_id,
					threadCount: email.thread_count,
				})),
				folderId: options?.folderId,
			},
			{
				onSuccess: (results) => {
					const counts = { trashed: 0, purged: 0, restored: 0 };
					for (const result of results ?? []) {
						counts.trashed += result.trashed ?? 0;
						counts.purged += result.purged ?? 0;
						counts.restored += result.restored ?? 0;
					}
					if (action === "trash") {
						toastManager.add({
							title: `Moved ${counts.trashed} email${counts.trashed === 1 ? "" : "s"} to Trash`,
						});
					} else if (action === "restore") {
						toastManager.add({
							title: `Restored ${counts.restored} email${counts.restored === 1 ? "" : "s"} to the inbox`,
						});
					} else if (action === "delete") {
						const parts: string[] = [];
						if (counts.trashed > 0) parts.push(`${counts.trashed} moved to Trash`);
						if (counts.purged > 0) parts.push(`${counts.purged} deleted forever`);
						toastManager.add({ title: parts.join(" · ") || "Nothing to delete" });
					}
					if (
						(action === "trash" || action === "delete" || action === "restore") &&
						selectedEmails.some((email) => email.id === selectedEmailId)
					) {
						closePanel();
					}
					clear();
				},
			},
		);
	};

	const folderName = useMemo(() => {
		const found = folders.find((f) => f.id === folder);
		if (found) return found.name;
		return folder ? folder.charAt(0).toUpperCase() + folder.slice(1) : "Inbox";
	}, [folders, folder]);

	const isPanelOpen = selectedEmailId !== null || isComposing;

	// Track folder identity to detect folder changes vs page changes
	const prevFolderRef = useRef<string | undefined>(undefined);

	useEffect(() => {
		const folderChanged = prevFolderRef.current !== `${mailboxId}/${folder}`;
		prevFolderRef.current = `${mailboxId}/${folder}`;

		if (folderChanged) {
			closePanel();
			setPage(1);
			setCategoryFilter("");
			clear();
		}
	}, [mailboxId, folder, closePanel, clear]);

	const toggleStar = (e: React.MouseEvent, email: Email) => {
		e.preventDefault();
		e.stopPropagation();
		if (mailboxId)
			updateEmail.mutate({
				mailboxId,
				id: email.id,
				data: { starred: !email.starred },
			});
	};

	const handleDelete = (e: React.MouseEvent, emailId: string) => {
		e.preventDefault();
		e.stopPropagation();
		if (mailboxId) {
			const confirmed = window.confirm(
				isTrashFolder
					? "Delete this email forever? This cannot be undone."
					: "Move this email to Trash?",
			);
			if (!confirmed) return;
			deleteEmail.mutate({ mailboxId, id: emailId, permanent: isTrashFolder });
			if (selectedEmailId === emailId) closePanel();
		}
	};


	const handleEmptyTrash = () => {
		if (!mailboxId) return;
		if (
			!window.confirm(
				"Permanently delete every email in Trash? This cannot be undone.",
			)
		) {
			return;
		}
		emptyTrash.mutate(
			{ mailboxId },
			{
				onSuccess: ({ purged }) => {
					toastManager.add({
						title:
							purged > 0
								? `Trash emptied — ${purged} email${purged === 1 ? "" : "s"} deleted forever`
								: "Trash is already empty",
					});
					closePanel();
					clear();
				},
			},
		);
	};


	const handleRefresh = () => {
		if (mailboxId) {
			queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] });
			queryClient.invalidateQueries({
				queryKey: queryKeys.folders.list(mailboxId),
			});
		}
	};

	// Thread-aware helpers
	const hasUnread = (email: Email): boolean => {
		if (email.thread_unread_count !== undefined) {
			return email.thread_unread_count > 0;
		}
		return !email.read;
	};

	const handleRowClick = (email: Email) => {
		// While a selection is active, clicking a row toggles it instead of
		// opening the email, matching common mail-client behavior.
		if (selectedCount > 0) {
			toggle(email.id);
			return;
		}
		selectEmail(email.id, mailboxId);
		if (mailboxId && hasUnread(email)) {
			if (email.thread_id && email.thread_count && email.thread_count > 1) {
				markThreadRead.mutate({
					mailboxId,
					threadId: email.thread_id,
				});
			} else {
				updateEmail.mutate({
					mailboxId,
					id: email.id,
					data: { read: true },
				});
			}
		}
	};

	const formatParticipants = (email: Email): string => {
		if (email.participants) {
			const names = email.participants
				.split(",")
				.map((p) => p.trim().split("@")[0])
				.filter((name, idx, arr) => arr.indexOf(name) === idx);
			if (names.length <= 3) return names.join(", ");
			return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
		}
		return email.sender.split("@")[0];
	};

	return (
		<MailboxSplitView
			selectedEmailId={selectedEmailId}
			isComposing={isComposing}
		>
				{/* Folder header */}
				<div className="flex items-center gap-2 px-4 py-3.5 border-b border-kumo-line shrink-0 md:px-5">
					<Checkbox
						checked={allSelected}
						indeterminate={selectedCount > 0 && !allSelected}
						onCheckedChange={(checked) => (checked ? selectAll() : clear())}
						aria-label="Select all conversations on this page"
						className="shrink-0"
					/>
					{selectedCount > 0 ? (
						<BulkActionBar
							count={selectedCount}
							isPending={bulkAction.isPending}
							folders={moveFolders}
							inTrash={isTrashFolder}
							onMarkRead={() => runBulkAction("mark_read")}
							onMarkUnread={() => runBulkAction("mark_unread")}
							onStar={() => runBulkAction("star")}
							onUnstar={() => runBulkAction("unstar")}
							onArchive={() =>
								runBulkAction("move", { folderId: Folders.ARCHIVE })
							}
							onSpam={() => runBulkAction("move", { folderId: Folders.SPAM })}
							onMove={(folderId) => runBulkAction("move", { folderId })}
							onTrash={() =>
								runBulkAction("trash", {
									confirm: `Move ${selectedCount} email${selectedCount === 1 ? "" : "s"} to Trash?`,
								})
							}
							onRestore={() => runBulkAction("restore")}
							onDelete={() =>
								runBulkAction("delete", {
									confirm: `Permanently delete ${selectedCount} email${selectedCount === 1 ? "" : "s"}? This cannot be undone.`,
								})
							}
							onClear={clear}
						/>
					) : (
						<>
							<h1 className="truncate text-lg font-semibold text-kumo-default">
								{folderName}
							</h1>
							<div className="ml-auto flex items-center gap-1">
								{categories.length > 0 && (
									<Select
										aria-label="Filter by category"
										size="sm"
										value={categoryFilter || CATEGORY_FILTER_ALL}
										onValueChange={(value) => {
											const next =
												value && value !== CATEGORY_FILTER_ALL
													? String(value)
													: "";
											setCategoryFilter(next);
											setPage(1);
										}}
									>
										<Select.Option value={CATEGORY_FILTER_ALL}>All categories</Select.Option>
										{categories.map((category) => (
											<Select.Option key={category.id} value={category.id}>
												{category.name}
											</Select.Option>
										))}
									</Select>
								)}
								{totalCount > 0 && (
									<span className="text-sm text-kumo-subtle mr-2 hidden sm:inline">
										{totalCount} conversation{totalCount !== 1 ? "s" : ""}
									</span>
								)}
								{isTrashFolder && (
									<Tooltip content="Empty trash" side="bottom" asChild>
										<Button
											variant="ghost"
											size="sm"
											icon={<TrashIcon size={16} />}
											onClick={handleEmptyTrash}
											disabled={emptyTrash.isPending}
											aria-label="Empty trash"
										>
											Empty trash
										</Button>
									</Tooltip>
								)}
								<KeyboardCheatsheetButton onClick={keyboardTriage.openCheatsheet} />
								<Tooltip
									content={isRefreshing ? "Refreshing..." : "Refresh"}
									side="bottom"
									asChild
								>
									<Button
										variant="ghost"
										shape="square"
										size="sm"
										icon={
											<ArrowsClockwiseIcon
												size={18}
												className={isRefreshing ? "animate-spin" : ""}
											/>
										}
										onClick={handleRefresh}
										disabled={isRefreshing}
										aria-label="Refresh"
									/>
								</Tooltip>
							</div>
						</>
					)}
				</div>

				{/* Email rows */}
				<div className="flex-1 overflow-y-auto">
				{isRefreshing && emails.length === 0 ? (
					<EmailListSkeleton />
				) : emails.length > 0 ? (
						<div>
							{emails.map((email) => {
								const isSelected = selectedEmailId === email.id;
								const isRowChecked = isRowSelected(email.id);
								const snippet = getSnippetText(email.snippet);
								return (
									<div
										key={email.id}
										role="button"
										tabIndex={0}
										onClick={() => handleRowClick(email)}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												handleRowClick(email);
											}
										}}
										className={`group flex items-center gap-3 w-full text-left cursor-pointer transition-colors border-b border-kumo-line px-4 py-2.5 md:px-6 md:py-3 ${
											isPanelOpen ? "md:px-4 md:py-2.5" : ""
										} ${isSelected || isRowChecked ? "bg-kumo-tint" : "hover:bg-kumo-tint"}`}
									>
										{/* Selection checkbox (always visible in selection mode) */}
										<div
											className={`shrink-0 ${
												selectedCount > 0
													? ""
													: "invisible group-hover:visible group-focus-within:visible"
											}`}
										>
											<SelectionCheckbox
												checked={isRowChecked}
												onToggle={(shiftKey) => toggle(email.id, shiftKey)}
												label={`${isRowChecked ? "Deselect" : "Select"} ${email.subject}`}
											/>
										</div>

										{/* Unread dot */}
										<div className="w-2.5 shrink-0 flex justify-center">
											{hasUnread(email) && (
												<div className="h-2 w-2 rounded-full bg-kumo-brand" />
											)}
										</div>

										{/* Star */}
										<button
											type="button"
											className="shrink-0 p-0.5 bg-transparent border-0 cursor-pointer"
											onClick={(e) => {
												e.stopPropagation();
												toggleStar(e, email);
											}}
										>
											<StarIcon
												size={16}
												weight={email.starred ? "fill" : "regular"}
												className={
													email.starred
														? "text-kumo-warning"
														: "text-kumo-subtle hover:text-kumo-warning"
												}
											/>
										</button>

										{/* Content */}
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span
													className={`truncate text-sm ${hasUnread(email) ? "font-semibold text-kumo-default" : "text-kumo-strong"}`}
												>
													{formatParticipants(email)}
												</span>
												{(email.thread_count ?? 1) > 1 && (
													<span className="shrink-0 text-xs text-kumo-subtle bg-kumo-fill rounded-full px-1.5 py-0.5 font-medium">
														{email.thread_count}
													</span>
												)}
												{email.has_draft && (
													<span className="shrink-0 text-xs text-kumo-destructive font-medium">
														Draft
													</span>
												)}
												<CategoryBadge
													category={email.category}
													categories={categories}
												/>
												{email.needs_reply && !email.has_draft && (
													<Tooltip content="Needs reply" asChild>
														<span className="shrink-0 text-kumo-warning">
															<ArrowBendUpLeftIcon size={14} weight="bold" />
														</span>
													</Tooltip>
												)}
												<span className="text-sm text-kumo-subtle shrink-0 ml-auto">
													{formatListDate(email.date)}
												</span>
											</div>
											<div className="truncate text-sm mt-0.5">
												<span
													className={hasUnread(email) ? "font-medium text-kumo-default" : "text-kumo-subtle"}
												>
													{email.subject}
												</span>
											{snippet && (
												<span className="text-kumo-subtle font-normal">
													{" "}&mdash; {snippet}
												</span>
											)}
										</div>
									</div>

										{/* Hover actions */}
										<div className="hidden group-hover:flex items-center shrink-0">
											<Tooltip content={email.read ? "Mark unread" : "Mark read"} asChild>
												<Button
													variant="ghost"
													shape="square"
													size="sm"
													icon={email.read ? <EnvelopeSimpleIcon size={14} /> : <EnvelopeOpenIcon size={14} />}
													onClick={(e) => {
														e.stopPropagation();
														if (mailboxId)
															updateEmail.mutate({
																mailboxId,
																id: email.id,
																data: { read: !email.read },
															});
													}}
													aria-label={email.read ? "Mark unread" : "Mark read"}
												/>
											</Tooltip>
											<Tooltip
												content={isTrashFolder ? "Delete forever" : "Move to Trash"}
												asChild
										>
											<Button
												variant="ghost"
												shape="square"
												size="sm"
												icon={<TrashIcon size={14} />}
												onClick={(e) => handleDelete(e, email.id)}
												aria-label={isTrashFolder ? "Delete forever" : "Move to Trash"}
											/>
										</Tooltip>
										</div>
									</div>
								);
							})}
						</div>
					) : (
						<FolderEmptyState
							folder={folder}
							onCompose={() => startCompose()}
						/>
					)}
				</div>

				{/* Pagination */}
				{totalCount > PAGE_SIZE && (
					<div className="flex justify-center py-3 border-t border-kumo-line shrink-0">
						<Pagination
							page={page}
							setPage={(next) => {
								clear();
								setPage(next);
							}}
							perPage={PAGE_SIZE}
							totalCount={totalCount}
						/>
					</div>
				)}
			<KeyboardCheatsheet
				open={keyboardTriage.isCheatsheetOpen}
				onOpenChange={keyboardTriage.setCheatsheetOpen}
			/>
		</MailboxSplitView>
	);
}
