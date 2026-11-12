// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Checkbox, Dialog, Pagination, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import {
	ArchiveIcon,
	ArrowLeftIcon,
	ArrowsClockwiseIcon,
	EnvelopeOpenIcon,
	EnvelopeSimpleIcon,
	FileIcon,
	MagnifyingGlassIcon,
	PaperPlaneTiltIcon,
	PaperclipIcon,
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
import KeyboardCheatsheet, { KeyboardCheatsheetButton } from "~/components/KeyboardCheatsheet";
import MailboxSplitView from "~/components/MailboxSplitView";
import SelectionCheckbox from "~/components/SelectionCheckbox";
import { getSnippetText } from "~/lib/utils";
import { useAllEmails } from "~/queries/all-emails";
import {
	useBulkEmailAction,
	useDeleteEmail,
	useMarkThreadRead,
	useMoveEmail,
	useUpdateEmail,
} from "~/queries/emails";
import { useMailboxes } from "~/queries/mailboxes";
import { useGlobalCategorization } from "~/queries/categorization";
import { useConfig } from "~/queries/config";
import { useEmailSelection } from "~/hooks/useEmailSelection";
import { useKeyboardTriage } from "~/hooks/useKeyboardTriage";
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

/**
 * Muted deterministic avatar colours (Tailwind classes only — no index.css).
 * The hash of the sender address picks one entry, so the same sender always
 * renders the same muted circle in every row.
 */
const AVATAR_COLOR_CLASSES = [
	"bg-slate-200 text-slate-700",
	"bg-red-100 text-red-800",
	"bg-amber-100 text-amber-800",
	"bg-emerald-100 text-emerald-800",
	"bg-sky-100 text-sky-800",
	"bg-violet-100 text-violet-800",
	"bg-stone-200 text-stone-700",
	"bg-teal-100 text-teal-800",
] as const;

function avatarColorClass(seed: string): string {
	let hash = 0;
	for (let i = 0; i < seed.length; i += 1) {
		hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
	}
	return AVATAR_COLOR_CLASSES[hash % AVATAR_COLOR_CLASSES.length] ?? AVATAR_COLOR_CLASSES[0];
}

/** First letter of the display name, used as the avatar initial. */
function senderInitial(displayName: string): string {
	const trimmed = displayName.trim();
	return trimmed ? trimmed.charAt(0).toUpperCase() : "?";
}

/**
 * List rows carry no attachment payload — accept either the full-message
 * `attachments` array or a `has_attachment` flag defensively.
 */
function hasAttachment(email: Email): boolean {
	if ((email.attachments?.length ?? 0) > 0) return true;
	const maybeFlag = (email as Email & { has_attachment?: boolean | number | null }).has_attachment;
	return maybeFlag === true || maybeFlag === 1;
}

function AllAccountsSkeleton() {
	return (
		<div className="animate-pulse space-y-1 p-2">
			{Array.from({ length: 8 }).map((_, i) => (
				<div key={i} className="flex items-center gap-2.5 px-3 py-1.5">
					<div className="w-2.5 shrink-0" />
					<div className="w-4 shrink-0 rounded-full bg-kumo-fill h-4" />
					<div className="h-7 w-7 shrink-0 rounded-full bg-kumo-fill" />
					<div className="flex-1 space-y-1.5">
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
	const { data: config } = useConfig();
	// The all-mailbox agent toggle is useless when the deployment disabled the
	// agent; while config loads it stays visible, like the header button.
	const agentEnabled = config?.agentEnabled ?? true;
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
		if (folder !== "all") next["folder"] = folder;
		return next;
	}, [folder, page]);

	const { data, isLoading, isFetching, refetch } = useAllEmails(params, {
		refetchInterval: 30_000,
	});
	// Stable reference: a fresh array here would invalidate every memo below.
	const emails = useMemo(() => data?.emails ?? [], [data]);
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
	const moveEmail = useMoveEmail();
	const toastManager = useKumoToastManager();
	const [focusedRowId, setFocusedRowId] = useState<string | null>(null);
	const [confirmState, setConfirmState] = useState<{
		message: string;
		confirmLabel: string;
		onConfirm: () => void;
	} | null>(null);
	const confirm = (message: string, confirmLabel: string, onConfirm: () => void) =>
		setConfirmState({ message, confirmLabel, onConfirm });

	// Keyboard-first triage with per-row mailboxes (selection keys are
	// mailbox-scoped, matching `selectionKey` above).
	const keyboardTriage = useKeyboardTriage({
		emails,
		currentEmailId: selectedEmailId,
		selection: { selectedKeys, count: selectedCount, toggle, clear },
		isComposing,
		mailboxIdForEmail: (email) => email.mailboxId,
		selectionKeyForEmail: selectionKey,
	});

	// A success toast with an Undo action (the composer's scheduled-send pattern).
	const toastWithUndo = (title: string, undo: () => void) => {
		const toastId = toastManager.add({
			title,
			actions: [
				{
					children: "Undo",
					variant: "secondary",
					size: "sm",
					onClick: () => {
						undo();
						toastManager.close(toastId);
					},
				},
			],
		}) as string;
	};

	const selectedEmails = useMemo(
		() => emails.filter((email) => selectedKeys.has(selectionKey(email))),
		[emails, selectedKeys],
	);

	// The tabbable listbox row: the focused row, else the open row, else the first.
	const tabbableRowKey = useMemo(() => {
		if (focusedRowId && emails.some((email) => selectionKey(email) === focusedRowId)) {
			return focusedRowId;
		}
		const open = emails.find(
			(email) => email.id === selectedEmailId && email.mailboxId === selectedMailboxId,
		);
		if (open) return selectionKey(open);
		return emails[0] ? selectionKey(emails[0]) : null;
	}, [emails, focusedRowId, selectedEmailId, selectedMailboxId]);

	/** Only shared system folders can be batch move targets across mailboxes. */
	const moveFolders = useMemo(
		() =>
			MOVE_FOLDER_IDS.filter((id) => id !== folder).map((id) => ({
				id,
				name: getFolderDisplayName(id),
			})),
		[folder],
	);

	const executeBulkAction = (
		action: BulkEmailAction,
		options?: { folderId?: string },
	) => {
		if (selectedEmails.length === 0) return;
		const inverse = selectedEmails.flatMap((email) =>
			email.mailboxId
				? [{ mailboxId: email.mailboxId, id: email.id, folderId: email.folder_id ?? Folders.INBOX }]
				: [],
		);

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
					if (action === "trash" || action === "move") {
						toastWithUndo(
							action === "trash" ? "Moved selected emails to Trash" : "Moved selected emails",
							() => {
								for (const row of inverse) {
									moveEmail.mutate({ mailboxId: row.mailboxId, id: row.id, folderId: row.folderId });
								}
							},
						);
					}
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

	const runBulkAction = (
		action: BulkEmailAction,
		options?: { folderId?: string; confirm?: string; confirmLabel?: string },
	) => {
		if (selectedEmails.length === 0) return;
		if (options?.confirm) {
			confirm(options.confirm, options.confirmLabel ?? "Confirm", () =>
				executeBulkAction(action, options),
			);
			return;
		}
		executeBulkAction(action, options);
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
		const mailboxId = email.mailboxId;
		const originFolder = email.folder_id ?? Folders.INBOX;
		confirm(
			"Are you sure you want to delete this email?",
			"Delete",
			() => {
				deleteEmail.mutate(
					{ mailboxId, id: email.id },
					{
						onSuccess: () =>
							toastWithUndo("Moved to Trash", () =>
								moveEmail.mutate({ mailboxId, id: email.id, folderId: originFolder }),
							),
					},
				);
				if (selectedEmailId === email.id && selectedMailboxId === email.mailboxId) {
					closePanel();
				}
			},
		);
	};

	return (
		<div className="flex h-screen overflow-hidden">
			<div id="main" tabIndex={-1} className="flex-1 flex flex-col min-w-0 bg-kumo-base">
				{/* Header — sticky white toolbar (select-all, refresh,
				    archive/trash/spam via BulkActionBar, count) */}
				<div className="sticky top-0 z-10 flex items-center gap-3 border-b border-kumo-line bg-kumo-base px-3 py-2 shrink-0">
					<Tooltip content="Back to mailboxes" side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<ArrowLeftIcon size={18} />}
							onClick={() => void navigate("/")}
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
									confirmLabel: "Delete",
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
							<KeyboardCheatsheetButton onClick={keyboardTriage.openCheatsheet} />
							<Tooltip content="Search all accounts" side="bottom" asChild>
								<Button
									variant="ghost"
									shape="square"
									size="sm"
									icon={<MagnifyingGlassIcon size={18} />}
									onClick={() => void navigate("/search")}
									aria-label="Search all accounts"
								/>
							</Tooltip>
							{/* Only while the deployment keeps the agent enabled. */}
							{agentEnabled && (
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
							)}
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
								<div role="listbox" aria-label="All accounts conversations">
									{emails.map((email) => {
										const isSelected = selectedEmailId === email.id && selectedMailboxId === email.mailboxId;
										const isRowChecked = isRowSelected(selectionKey(email));
										const unread = hasUnread(email);
										const snippet = getSnippetText(email.snippet);
										const accountLabel = email.mailboxId?.split("@")[0] || "unknown";
										const displayName = email.sender.split("@")[0] ?? email.sender;
										return (
											<div
												key={`${email.mailboxId ?? "mailbox"}-${email.id}`}
												data-row-id={selectionKey(email)}
												role="option"
												aria-selected={isSelected}
												tabIndex={selectionKey(email) === tabbableRowKey ? 0 : -1}
												onFocus={() => setFocusedRowId(selectionKey(email))}
												onClick={() => handleRowClick(email)}
												onKeyDown={(e) => {
													if (e.key === "Enter" || e.key === " ") {
														e.preventDefault();
														handleRowClick(email);
													}
												}}
												className={`group flex min-h-[48px] items-center gap-2 w-full cursor-pointer border-b border-kumo-line px-3 py-1.5 text-left transition-colors ${
													isPanelOpen ? "md:px-3" : ""
												} ${isSelected || isRowChecked ? "bg-kumo-tint" : "hover:bg-kumo-tint"}`}
											>
												{/* Selection checkbox (always visible in selection mode) */}
												<div
													className={`row-select shrink-0 ${
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

												{/* Unread dot — small blue, left of the sender, decorative */}
												<div aria-hidden="true" className="w-2.5 shrink-0 flex justify-center">
													{unread && <div className="h-2 w-2 rounded-full bg-blue-500" />}
												</div>

												{/* Star — filled amber when starred */}
												<button
													type="button"
													className="row-star shrink-0 cursor-pointer rounded border-0 bg-transparent p-0.5 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500"
													onClick={(e) => toggleStar(e, email)}
													aria-label={email.starred ? "Unstar email" : "Star email"}
													aria-pressed={email.starred}
												>
													<StarIcon
														size={16}
														weight={email.starred ? "fill" : "regular"}
														className={email.starred ? "text-amber-500" : "text-kumo-subtle hover:text-amber-500"}
													/>
												</button>

												{/* Sender avatar — initial circle, muted deterministic colour */}
												<span
													aria-hidden="true"
													className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${avatarColorClass(email.sender)}`}
												>
													{senderInitial(displayName)}
												</span>

												{/* Content */}
												<div className="min-w-0 flex-1">
													<div className="flex items-center gap-1.5">
														<Badge variant="secondary" className="shrink-0 !px-1 !py-px !text-[10px] !leading-tight">
															{accountLabel}
														</Badge>
														{folder === "all" && email.folder_id && (
															<Badge variant="outline" className="shrink-0 !px-1 !py-px !text-[10px] !leading-tight">
																{getFolderDisplayName(email.folder_id)}
															</Badge>
														)}
														<CategoryBadge
															category={email.category}
															categories={globalCategorization?.categories}
														/>
														<span
															className={`truncate text-[13px] leading-tight ${
																unread ? "font-semibold text-kumo-default" : "text-kumo-strong"
															}`}
														>
															{displayName}
														</span>
														{(email.thread_count ?? 1) > 1 && (
															<span className="shrink-0 rounded-full bg-kumo-fill px-1 py-px text-[10px] font-medium text-kumo-subtle">
																{email.thread_count}
															</span>
														)}
														<span className="ml-auto flex shrink-0 items-center gap-1.5">
															{hasAttachment(email) && (
																<PaperclipIcon
																	size={13}
																	aria-hidden="true"
																	className="shrink-0 text-kumo-subtle"
																/>
															)}
															<span className="whitespace-nowrap text-xs tabular-nums text-kumo-subtle">
																{formatListDate(email.date)}
															</span>
														</span>
													</div>
													<div className="mt-px truncate text-[13px] leading-tight">
														<span className={unread ? "font-medium text-kumo-default" : "text-kumo-subtle"}>
															{email.subject}
														</span>
														{snippet && <span className="font-normal text-kumo-subtle"> &mdash; {snippet}</span>}
													</div>
												</div>

												{/* Hover actions */}
												<div className="row-actions hidden group-hover:flex items-center shrink-0">
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
			<KeyboardCheatsheet
				open={keyboardTriage.isCheatsheetOpen}
				onOpenChange={keyboardTriage.setCheatsheetOpen}
			/>
			{/* Destructive confirmations (Kumo dialog, never window.confirm) */}
			<Dialog.Root
				open={confirmState !== null}
				onOpenChange={(open) => {
					if (!open) setConfirmState(null);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="mb-2 text-base font-semibold">
						Confirm
					</Dialog.Title>
					<Dialog.Description className="mb-4 text-sm text-kumo-subtle">
						{confirmState?.message}
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
							onClick={() => {
								confirmState?.onConfirm();
								setConfirmState(null);
							}}
						>
							{confirmState?.confirmLabel ?? "Confirm"}
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
