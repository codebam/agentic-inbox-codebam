// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Checkbox, Pagination, Tooltip } from "@cloudflare/kumo";
import {
	ArchiveIcon,
	ArrowLeftIcon,
	ArrowsClockwiseIcon,
	EnvelopeOpenIcon,
	EnvelopeSimpleIcon,
	FileIcon,
	PaperPlaneTiltIcon,
	ProhibitIcon,
	RobotIcon,
	StackIcon,
	StarIcon,
	TrashIcon,
	TrayIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { formatListDate } from "shared/dates";
import { Folders, getFolderDisplayName } from "shared/folders";
import AgentSidebar from "~/components/AgentSidebar";
import BulkActionBar from "~/components/BulkActionBar";
import CategoryBadge from "~/components/CategoryBadge";
import MailboxSplitView from "~/components/MailboxSplitView";
import SelectionCheckbox from "~/components/SelectionCheckbox";
import { getSnippetText } from "~/lib/utils";
import { useAllEmails } from "~/queries/all-emails";
import {
	useBulkEmailAction,
	useDeleteEmail,
	useMarkThreadRead,
	useUpdateEmail,
} from "~/queries/emails";
import { useMailboxes } from "~/queries/mailboxes";
import { useGlobalCategorization } from "~/queries/categorization";
import { useEmailSelection } from "~/hooks/useEmailSelection";
import { useUIStore } from "~/hooks/useUIStore";
import type { BulkEmailAction, Email } from "~/types";

const PAGE_SIZE = 25;

/** Folders every mailbox shares, so they are safe batch move targets here. */
const MOVE_FOLDER_IDS: readonly string[] = [
	Folders.INBOX,
	Folders.ARCHIVE,
	Folders.SPAM,
	Folders.TRASH,
];

/** Selection keys are mailbox-scoped because ids repeat across mailboxes. */
function selectionKey(email: Email): string {
	return `${email.mailboxId ?? "unknown"}::${email.id}`;
}

const FOLDER_TABS = [
	{ id: "all", label: "All Mail", icon: <StackIcon size={15} weight="bold" /> },
	{ id: Folders.INBOX, label: "Inbox", icon: <TrayIcon size={15} weight="bold" /> },
	{ id: Folders.SENT, label: "Sent", icon: <PaperPlaneTiltIcon size={15} weight="bold" /> },
	{ id: Folders.DRAFT, label: "Drafts", icon: <FileIcon size={15} weight="bold" /> },
	{ id: Folders.ARCHIVE, label: "Archive", icon: <ArchiveIcon size={15} weight="bold" /> },
	{ id: Folders.SPAM, label: "Spam", icon: <ProhibitIcon size={15} weight="bold" /> },
	{ id: Folders.TRASH, label: "Trash", icon: <TrashIcon size={15} weight="bold" /> },
] as const;

function hasUnread(email: Email): boolean {
	if (email.thread_unread_count !== undefined) {
		return email.thread_unread_count > 0;
	}
	return !email.read;
}

function AllAccountsSkeleton() {
	return (
		<div className="animate-pulse space-y-1 p-2">
			{Array.from({ length: 8 }).map((_, i) => (
				<div key={i} className="flex items-center gap-3 px-3 py-3">
					<div className="w-2.5" />
					<div className="flex-1 space-y-2">
						<div className="flex items-center gap-2">
							<div className="h-3 w-20 rounded bg-kumo-fill" />
							<div className="h-3 w-24 rounded bg-kumo-fill" />
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

export default function AllAccountsRoute() {
	const navigate = useNavigate();
	const [searchParams, setSearchParams] = useSearchParams();
	const requestedFolder = searchParams.get("folder") || "all";
	const folder = FOLDER_TABS.some((tab) => tab.id === requestedFolder) ? requestedFolder : "all";
	const activeTab = FOLDER_TABS.find((tab) => tab.id === folder) ?? FOLDER_TABS[0];

	const [page, setPage] = useState(1);
	const {
		selectedEmailId,
		selectedMailboxId,
		isComposing,
		selectEmail,
		closePanel,
		isAgentPanelOpen,
		toggleAgentPanel,
	} = useUIStore();
	const { data: mailboxes = [] } = useMailboxes();
	const { data: globalCategorization } = useGlobalCategorization();
	const updateEmail = useUpdateEmail();
	const markThreadRead = useMarkThreadRead();
	const deleteEmail = useDeleteEmail();

	// Selection may have been left over from a mailbox route; start clean.
	useEffect(() => {
		closePanel();
	}, [closePanel]);

	const prevFolderRef = useRef(folder);

	const params = useMemo(() => {
		const next: Record<string, string> = {
			page: String(page),
			limit: String(PAGE_SIZE),
		};
		if (folder !== "all") next.folder = folder;
		return next;
	}, [folder, page]);

	const { data, isLoading, isFetching, refetch } = useAllEmails(params, {
		refetchInterval: 30_000,
	});
	const emails = data?.emails ?? [];
	const totalCount = data?.totalCount ?? 0;
	const isPanelOpen = selectedEmailId !== null || isComposing;
	const accountCountLabel = `${mailboxes.length} account${mailboxes.length === 1 ? "" : "s"}`;

	const pageKeys = useMemo(() => emails.map(selectionKey), [emails]);
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

	const selectedEmails = useMemo(
		() => emails.filter((email) => selectedKeys.has(selectionKey(email))),
		[emails, selectedKeys],
	);

	/** Only shared system folders can be batch move targets across mailboxes. */
	const moveFolders = useMemo(
		() =>
			MOVE_FOLDER_IDS.filter((id) => id !== folder).map((id) => ({
				id,
				name: getFolderDisplayName(id),
			})),
		[folder],
	);

	const runBulkAction = (
		action: BulkEmailAction,
		options?: { folderId?: string; confirm?: string },
	) => {
		if (selectedEmails.length === 0) return;
		if (options?.confirm && !window.confirm(options.confirm)) return;

		bulkAction.mutate(
			{
				action,
				targets: selectedEmails.flatMap((email) =>
					email.mailboxId
						? [
								{
									mailboxId: email.mailboxId,
									id: email.id,
									threadId: email.thread_id,
									threadCount: email.thread_count,
								},
							]
						: [],
				),
				folderId: options?.folderId,
			},
			{
				onSuccess: () => {
					if (
						action === "delete" &&
						selectedEmails.some(
							(email) =>
								email.id === selectedEmailId &&
								email.mailboxId === selectedMailboxId,
						)
					) {
						closePanel();
					}
					clear();
				},
			},
		);
	};

	// Changing folders resets paging and any in-progress selection.
	useEffect(() => {
		if (prevFolderRef.current !== folder) {
			prevFolderRef.current = folder;
			setPage(1);
			closePanel();
			clear();
		}
	}, [folder, closePanel, clear]);

	const handleFolderChange = (id: string) => {
		setSearchParams(id === "all" ? {} : { folder: id }, { replace: true });
	};

	const handleRefresh = () => {
		void refetch();
	};

	const handleRowClick = (email: Email) => {
		// While a selection is active, clicking a row toggles it instead of
		// opening the email, matching common mail-client behavior.
		if (selectedCount > 0) {
			toggle(selectionKey(email));
			return;
		}
		selectEmail(email.id, email.mailboxId);
		if (email.mailboxId && hasUnread(email)) {
			if (email.thread_id && (email.thread_count ?? 1) > 1) {
				markThreadRead.mutate({
					mailboxId: email.mailboxId,
					threadId: email.thread_id,
				});
			} else {
				updateEmail.mutate({
					mailboxId: email.mailboxId,
					id: email.id,
					data: { read: true },
				});
			}
		}
	};

	const toggleStar = (e: React.MouseEvent, email: Email) => {
		e.stopPropagation();
		if (!email.mailboxId) return;
		updateEmail.mutate({
			mailboxId: email.mailboxId,
			id: email.id,
			data: { starred: !email.starred },
		});
	};

	const toggleRead = (e: React.MouseEvent, email: Email) => {
		e.stopPropagation();
		if (!email.mailboxId) return;
		updateEmail.mutate({
			mailboxId: email.mailboxId,
			id: email.id,
			data: { read: !email.read },
		});
	};

	const handleDelete = (e: React.MouseEvent, email: Email) => {
		e.stopPropagation();
		if (!email.mailboxId) return;
		if (!window.confirm("Are you sure you want to delete this email?")) return;
		deleteEmail.mutate({ mailboxId: email.mailboxId, id: email.id });
		if (selectedEmailId === email.id && selectedMailboxId === email.mailboxId) {
			closePanel();
		}
	};

	return (
		<div className="flex h-screen overflow-hidden">
			<div className="flex-1 flex flex-col min-w-0 bg-kumo-base">
				{/* Header */}
				<div className="flex items-center gap-3 px-4 py-3.5 border-b border-kumo-line shrink-0 md:px-5">
					<Tooltip content="Back to mailboxes" side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<ArrowLeftIcon size={18} />}
							onClick={() => navigate("/")}
							aria-label="Back to mailboxes"
						/>
					</Tooltip>
					<Checkbox
						checked={allSelected}
						indeterminate={selectedCount > 0 && !allSelected}
						onCheckedChange={(checked) => (checked ? selectAll() : clear())}
						aria-label="Select all emails on this page"
						className="shrink-0"
					/>
					{selectedCount > 0 ? (
						<BulkActionBar
							count={selectedCount}
							isPending={bulkAction.isPending}
							folders={moveFolders}
							onMarkRead={() => runBulkAction("mark_read")}
							onMarkUnread={() => runBulkAction("mark_unread")}
							onStar={() => runBulkAction("star")}
							onUnstar={() => runBulkAction("unstar")}
							onArchive={() =>
								runBulkAction("move", { folderId: Folders.ARCHIVE })
							}
							onSpam={() => runBulkAction("move", { folderId: Folders.SPAM })}
							onMove={(folderId) => runBulkAction("move", { folderId })}
							onDelete={() =>
								runBulkAction("delete", {
									confirm: `Delete ${selectedCount} email${selectedCount === 1 ? "" : "s"}? Messages already in Trash are deleted forever; everything else moves to Trash.`,
								})
							}
							onClear={clear}
						/>
					) : (
						<>
							<div className="min-w-0 flex-1">
								<h1 className="text-lg font-semibold text-kumo-default truncate">All Accounts</h1>
								<p className="text-sm text-kumo-subtle truncate">
									{accountCountLabel}
									{!isLoading &&
										` · ${totalCount} ${folder === "all" ? "email" : "conversation"}${totalCount === 1 ? "" : "s"}`}
								</p>
							</div>
							<Tooltip content={isFetching ? "Refreshing..." : "Refresh"} side="bottom" asChild>
								<Button
									variant="ghost"
									shape="square"
									size="sm"
									icon={<ArrowsClockwiseIcon size={18} className={isFetching ? "animate-spin" : ""} />}
									onClick={handleRefresh}
									disabled={isFetching}
									aria-label="Refresh"
								/>
							</Tooltip>
							<Tooltip
								content={isAgentPanelOpen ? "Hide agent panel" : "Show all-mailbox agent"}
								side="bottom"
								asChild
							>
								<Button
									variant={isAgentPanelOpen ? "secondary" : "ghost"}
									shape="square"
									size="sm"
									icon={<RobotIcon size={18} />}
									onClick={toggleAgentPanel}
									aria-label="Toggle all-mailbox agent panel"
									className="hidden lg:inline-flex"
								/>
							</Tooltip>
						</>
					)}
				</div>

				{/* Folder filter */}
				<div className="flex items-center gap-1 px-3 py-2 border-b border-kumo-line overflow-x-auto shrink-0 md:px-4">
					{FOLDER_TABS.map((tab) => {
						const isActive = tab.id === folder;
						return (
							<button
								key={tab.id}
								type="button"
								onClick={() => handleFolderChange(tab.id)}
								aria-current={isActive ? "page" : undefined}
								className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors cursor-pointer border-0 ${
									isActive
										? "bg-kumo-fill font-semibold text-kumo-default"
										: "bg-transparent text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
								}`}
							>
								{tab.icon}
								{tab.label}
							</button>
						);
					})}
				</div>

				<div className="flex-1 min-h-0">
					<MailboxSplitView
						selectedEmailId={selectedEmailId}
						isComposing={isComposing}
						mailboxId={selectedMailboxId ?? undefined}
					>
						<div className="flex-1 overflow-y-auto">
							{isLoading && emails.length === 0 ? (
								<AllAccountsSkeleton />
							) : emails.length > 0 ? (
								<div>
									{emails.map((email) => {
										const isSelected = selectedEmailId === email.id && selectedMailboxId === email.mailboxId;
										const isRowChecked = isRowSelected(selectionKey(email));
										const snippet = getSnippetText(email.snippet);
										const accountLabel = email.mailboxId?.split("@")[0] || "unknown";
										return (
											<div
												key={`${email.mailboxId ?? "mailbox"}-${email.id}`}
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
														onToggle={(shiftKey) =>
															toggle(selectionKey(email), shiftKey)
														}
														label={`${isRowChecked ? "Deselect" : "Select"} ${email.subject}`}
													/>
												</div>

												{/* Unread dot */}
												<div className="w-2.5 shrink-0 flex justify-center">
													{hasUnread(email) && <div className="h-2 w-2 rounded-full bg-kumo-brand" />}
												</div>

												{/* Star */}
												<button
													type="button"
													className="shrink-0 p-0.5 bg-transparent border-0 cursor-pointer"
													onClick={(e) => toggleStar(e, email)}
													aria-label={email.starred ? "Unstar email" : "Star email"}
												>
													<StarIcon
														size={16}
														weight={email.starred ? "fill" : "regular"}
														className={email.starred ? "text-kumo-warning" : "text-kumo-subtle hover:text-kumo-warning"}
													/>
												</button>

												{/* Content */}
												<div className="min-w-0 flex-1">
													<div className="flex items-center gap-2">
														<Badge variant="secondary" className="shrink-0">
															{accountLabel}
														</Badge>
														{folder === "all" && email.folder_id && (
															<Badge variant="outline" className="shrink-0">
																{getFolderDisplayName(email.folder_id)}
															</Badge>
														)}
														<CategoryBadge
															category={email.category}
															categories={globalCategorization?.categories}
														/>
														<span
															className={`truncate text-sm ${
																hasUnread(email) ? "font-semibold text-kumo-default" : "text-kumo-strong"
															}`}
														>
															{email.sender.split("@")[0]}
														</span>
														{(email.thread_count ?? 1) > 1 && (
															<span className="shrink-0 text-xs text-kumo-subtle bg-kumo-fill rounded-full px-1.5 py-0.5 font-medium">
																{email.thread_count}
															</span>
														)}
														<span className="text-sm text-kumo-subtle shrink-0 ml-auto">
															{formatListDate(email.date)}
														</span>
													</div>
													<div className="truncate text-sm mt-0.5">
														<span className={hasUnread(email) ? "font-medium text-kumo-default" : "text-kumo-subtle"}>
															{email.subject}
														</span>
														{snippet && <span className="text-kumo-subtle font-normal"> &mdash; {snippet}</span>}
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
															onClick={(e) => toggleRead(e, email)}
															aria-label={email.read ? "Mark unread" : "Mark read"}
														/>
													</Tooltip>
													<Tooltip content="Delete" asChild>
														<Button
															variant="ghost"
															shape="square"
															size="sm"
															icon={<TrashIcon size={14} />}
															onClick={(e) => handleDelete(e, email)}
															aria-label="Delete"
														/>
													</Tooltip>
												</div>
											</div>
										);
									})}
								</div>
							) : (
								<div className="flex flex-col items-center justify-center py-24 px-6 text-center">
									<div className="mb-4">
										<EnvelopeSimpleIcon size={48} weight="thin" className="text-kumo-subtle" />
									</div>
									<h3 className="text-base font-semibold text-kumo-default mb-1.5">No emails</h3>
									<p className="text-sm text-kumo-subtle max-w-xs">
										{folder === "all"
											? "Emails from all of your accounts will appear here."
											: `No emails in ${activeTab.label.toLowerCase()} across your accounts.`}
									</p>
								</div>
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
					</MailboxSplitView>
				</div>
			</div>

			{/* All-mailbox agent + MCP sidebar (desktop) */}
			{isAgentPanelOpen && (
				<div className="hidden lg:flex w-[380px] shrink-0 border-l border-kumo-line flex-col bg-kumo-base overflow-hidden">
					<AgentSidebar />
				</div>
			)}
		</div>
	);
}
