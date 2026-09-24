// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Badge,
	Button,
	Loader,
	Switch,
	Tooltip,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	ArrowCounterClockwiseIcon,
	ArrowsClockwiseIcon,
	BellRingingIcon,
	CalendarBlankIcon,
	CheckIcon,
	ProhibitIcon,
} from "@phosphor-icons/react";
import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { formatDetailDate } from "shared/dates";
import { useUIStore } from "~/hooks/useUIStore";
import api from "~/services/api";
import { useSetReminder } from "~/queries/emails";
import {
	itemReminderInstant,
	useItems,
	useUpdateItemStatus,
} from "~/queries/items";
import { queryKeys } from "~/queries/keys";
import type { ExtractedItem } from "~/types";

/** Rows per bucket; the server caps one page at 50. */
const PAGE_SIZE = 50;

interface ItemRowProps {
	item: ExtractedItem;
	mailboxId: string | undefined;
	/** Sender + subject of the source message, once its detail has loaded. */
	source: { sender: string; subject: string } | undefined;
	onOpenSource: (emailId: string) => void;
}

/**
 * One extracted item: title, kind, due date, the message it came from and the
 * actions its status allows. Done and Dismiss close an open item, Reopen
 * brings a closed one back, and Remind — open items with a due date only —
 * schedules the source message's own follow-up reminder for that date through
 * the existing setReminder path. Every action is an explicit click; nothing
 * here sends mail.
 */
function ItemRow({ item, mailboxId, source, onOpenSource }: ItemRowProps) {
	const updateStatus = useUpdateItemStatus();
	const setReminder = useSetReminder();
	const toastManager = useKumoToastManager();

	const statusPending =
		updateStatus.isPending && updateStatus.variables?.itemId === item.id;

	const closeItem = (status: ExtractedItem["status"]) => {
		if (!mailboxId) return;
		updateStatus.mutate(
			{ mailboxId, itemId: item.id, status },
			{
				onSuccess: () =>
					toastManager.add({
						title:
							status === "done"
								? "Task marked done"
								: status === "dismissed"
									? "Task dismissed"
									: "Task reopened",
					}),
				onError: (error) => {
					toastManager.add({
						title: "Could not update the task",
						description:
							error instanceof Error ? error.message : "Something went wrong",
						variant: "error",
					});
				},
			},
		);
	};

	const remind = () => {
		if (!mailboxId || !item.due_at) return;
		setReminder.mutate(
			{ mailboxId, id: item.email_id, at: itemReminderInstant(item.due_at) },
			{
				onSuccess: () =>
					toastManager.add({ title: "Reminder set for the source message" }),
				onError: (error) => {
					toastManager.add({
						title: "Could not set the reminder",
						description:
							error instanceof Error ? error.message : "Something went wrong",
						variant: "error",
					});
				},
			},
		);
	};

	const sourceLabel = source
		? `${source.sender} — ${source.subject}`
		: "Open the source message";

	return (
		<li className="rounded-lg border border-kumo-line bg-kumo-base px-4 py-3">
			<div className="flex items-start gap-3">
				<div className="pt-0.5">
					<Badge variant={item.kind === "deadline" ? "blue" : "secondary"}>
						{item.kind}
					</Badge>
				</div>

				<div className="min-w-0 flex-1">
					<div className="text-sm font-medium text-kumo-default">
						{item.title}
					</div>
					{item.details && (
						<div className="mt-0.5 text-xs text-kumo-subtle">
							{item.details}
						</div>
					)}
					<button
						type="button"
						onClick={() => onOpenSource(item.email_id)}
						title={sourceLabel}
						className="mt-1 block max-w-full truncate text-left text-xs text-kumo-link hover:text-kumo-link-hover"
					>
						{sourceLabel}
					</button>
				</div>

				<div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
					{item.due_at && (
						<Tooltip content={formatDetailDate(item.due_at)} side="top" asChild>
							<span className="text-xs text-kumo-subtle">
								{formatDetailDate(item.due_at)}
							</span>
						</Tooltip>
					)}
					{item.status === "open" ? (
						<>
							<Button
								variant="secondary"
								size="xs"
								icon={<CheckIcon size={14} />}
								loading={statusPending}
								disabled={!mailboxId}
								onClick={() => closeItem("done")}
							>
								Done
							</Button>
							<Button
								variant="ghost"
								size="xs"
								icon={<ProhibitIcon size={14} />}
								disabled={!mailboxId}
								onClick={() => closeItem("dismissed")}
							>
								Dismiss
							</Button>
							{item.due_at && (
								<Button
									variant="secondary"
									size="xs"
									icon={<BellRingingIcon size={14} />}
									loading={setReminder.isPending}
									disabled={!mailboxId}
									onClick={remind}
								>
									Remind
								</Button>
							)}
						</>
					) : (
						<Button
							variant="ghost"
							size="xs"
							icon={<ArrowCounterClockwiseIcon size={14} />}
							loading={statusPending}
							disabled={!mailboxId}
							onClick={() => closeItem("open")}
						>
							Reopen
						</Button>
					)}
				</div>
			</div>
		</li>
	);
}

interface ItemGroupProps {
	title: string;
	hint: string;
	items: ExtractedItem[];
	totalCount: number;
	mailboxId: string | undefined;
	sources: Map<string, { sender: string; subject: string }>;
	onOpenSource: (emailId: string) => void;
}

/** One bucket of items (Overdue / Due today / Upcoming / No due date / Closed). */
function ItemGroup({
	title,
	hint,
	items,
	totalCount,
	mailboxId,
	sources,
	onOpenSource,
}: ItemGroupProps) {
	return (
		<section className="mt-6 first:mt-0">
			<div className="mb-2 flex items-center gap-2">
				<h2 className="text-sm font-semibold text-kumo-default">{title}</h2>
				<Badge variant="secondary">{items.length}</Badge>
				<span className="text-xs text-kumo-subtle">{hint}</span>
			</div>
			{items.length === 0 ? (
				<p className="rounded-lg border border-dashed border-kumo-line px-4 py-3 text-xs text-kumo-subtle">
					Nothing here.
				</p>
			) : (
				<>
					<ul className="space-y-2">
						{items.map((item) => (
							<ItemRow
								key={item.id}
								item={item}
								mailboxId={mailboxId}
								source={sources.get(item.email_id)}
								onOpenSource={onOpenSource}
							/>
						))}
					</ul>
					{totalCount > items.length && (
						<p className="mt-2 text-xs text-kumo-subtle">
							Showing the {items.length} most recent of {totalCount}.
						</p>
					)}
				</>
			)}
		</section>
	);
}

/**
 * The mailbox's extracted tasks and deadlines.
 *
 * The extractor writes one row per concrete task or deadline a message states
 * (workers/lib/items.ts), and this page groups the open ones by due bucket.
 * The buckets come from the server's own `due` filter — overdue, today,
 * upcoming, no due date — so the boundaries are the mailbox's, not the
 * browser's, and the page never reads the clock while rendering. Closed items
 * (done or dismissed) hide behind the toggle until asked for.
 */
export default function TasksRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const [showClosed, setShowClosed] = useState(false);
	const navigate = useNavigate();
	const { selectEmail } = useUIStore();

	// One query per bucket, so each group can be read, refreshed and counted on
	// its own. All four share the "items" key prefix.
	const overdue = useItems(mailboxId, {
		status: "open",
		due: "overdue",
		limit: PAGE_SIZE,
	});
	const today = useItems(mailboxId, {
		status: "open",
		due: "today",
		limit: PAGE_SIZE,
	});
	const upcoming = useItems(mailboxId, {
		status: "open",
		due: "upcoming",
		limit: PAGE_SIZE,
	});
	const undated = useItems(mailboxId, {
		status: "open",
		due: "none",
		limit: PAGE_SIZE,
	});
	const done = useItems(
		mailboxId,
		{ status: "done", limit: PAGE_SIZE },
		{ enabled: showClosed },
	);
	const dismissed = useItems(
		mailboxId,
		{ status: "dismissed", limit: PAGE_SIZE },
		{ enabled: showClosed },
	);

	const groups = [
		{
			key: "overdue",
			title: "Overdue",
			hint: "Past their due date.",
			query: overdue,
		},
		{
			key: "today",
			title: "Due today",
			hint: "Due before the end of today (UTC).",
			query: today,
		},
		{
			key: "upcoming",
			title: "Upcoming",
			hint: "Due after today.",
			query: upcoming,
		},
		{
			key: "none",
			title: "No due date",
			hint: "Tasks with no stated deadline.",
			query: undated,
		},
	];

	const closedItems = showClosed
		? [...(done.data?.items ?? []), ...(dismissed.data?.items ?? [])]
		: [];

	// The frozen item row carries only the source message's id, so the sender
	// and subject shown on each row come from the same cached email-detail
	// query the message panel uses — one query per distinct message, and a
	// message whose detail fails to load still gets a working link.
	const sourceIds = [
		...new Set(
			[
				...groups.flatMap((group) => group.query.data?.items ?? []),
				...closedItems,
			].map((item) => item.email_id),
		),
	];

	const sourceQueries = useQueries({
		queries: sourceIds.map((emailId) => ({
			queryKey: mailboxId
				? queryKeys.emails.detail(mailboxId, emailId)
				: ["emails", "_disabled_detail"],
			queryFn: () => api.getEmail(mailboxId!, emailId),
			enabled: !!mailboxId,
			staleTime: 60_000,
		})),
	});
	const sources = new Map<string, { sender: string; subject: string }>();
	sourceIds.forEach((emailId, index) => {
		const email = sourceQueries[index]?.data;
		if (email) sources.set(emailId, { sender: email.sender, subject: email.subject });
	});

	const isLoading = groups.every((group) => group.query.isLoading);
	const isFetching =
		groups.some((group) => group.query.isFetching) ||
		(showClosed && (done.isFetching || dismissed.isFetching));
	const failed = groups.find((group) => group.query.isError)?.query;

	const refetchAll = () => {
		for (const group of groups) void group.query.refetch();
		void done.refetch();
		void dismissed.refetch();
	};

	// Opening the source message: select it in the shared UI store, then show
	// the mailbox's message list, whose reading pane loads the selected
	// message by id (the same path search results use).
	const openSource = (emailId: string) => {
		if (!mailboxId) return;
		selectEmail(emailId, mailboxId);
		void navigate(`/mailbox/${mailboxId}/emails/inbox`);
	};

	if (isLoading) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	if (failed) {
		return (
			<div className="h-full overflow-y-auto px-4 py-4 md:px-8 md:py-6">
				<h1 className="mb-6 text-lg font-semibold text-kumo-default">Tasks</h1>
				<div className="flex flex-col items-center rounded-lg border border-kumo-line bg-kumo-base p-6 text-center">
					<CalendarBlankIcon size={40} weight="thin" className="mb-3 text-kumo-danger" />
					<h3 className="mb-1.5 text-base font-semibold text-kumo-default">
						Couldn't load tasks
					</h3>
					<p className="mb-4 max-w-sm text-sm text-kumo-subtle">
						{failed.error instanceof Error
							? failed.error.message
							: "Something went wrong"}
					</p>
					<Button variant="secondary" size="sm" onClick={refetchAll}>
						Try again
					</Button>
				</div>
			</div>
		);
	}

	const openCount = groups.reduce(
		(total, group) => total + (group.query.data?.items.length ?? 0),
		0,
	);
	const nothingAtAll = openCount === 0 && closedItems.length === 0;

	return (
		<div className="h-full max-w-3xl overflow-y-auto px-4 py-4 md:px-8 md:py-6">
			<div className="mb-2 flex items-start justify-between gap-4">
				<h1 className="text-lg font-semibold text-kumo-default">Tasks</h1>
				<Tooltip
					content={isFetching ? "Refreshing..." : "Refresh"}
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
								className={isFetching ? "animate-spin" : ""}
							/>
						}
						onClick={refetchAll}
						disabled={isFetching}
						aria-label="Refresh"
					/>
				</Tooltip>
			</div>
			<p className="mb-4 max-w-xl text-sm text-kumo-subtle">
				Concrete tasks and deadlines the extractor found in this mailbox's
				incoming mail, grouped by when they are due. Remind schedules a
				follow-up reminder for the message an item came from.
			</p>

			<Switch
				checked={showClosed}
				onCheckedChange={setShowClosed}
				label="Show closed items"
			/>

			{nothingAtAll ? (
				<div className="mt-6 flex flex-col items-center justify-center rounded-lg border border-dashed border-kumo-line px-6 py-20 text-center">
					<CalendarBlankIcon size={48} weight="thin" className="mb-4 text-kumo-subtle" />
					<h3 className="mb-1.5 text-base font-semibold text-kumo-default">
						No tasks yet
					</h3>
					<p className="max-w-sm text-sm text-kumo-subtle">
						New mail is read once for concrete tasks and deadlines — with the
						mailbox's items extractor model — and anything found shows up here
						and in the message panel. Turn extraction off in Settings.
					</p>
				</div>
			) : (
				<>
					{groups.map((group) => (
						<ItemGroup
							key={group.key}
							title={group.title}
							hint={group.hint}
							items={group.query.data?.items ?? []}
							totalCount={group.query.data?.totalCount ?? 0}
							mailboxId={mailboxId}
							sources={sources}
							onOpenSource={openSource}
						/>
					))}
					{showClosed && (
						<ItemGroup
							title="Closed"
							hint="Done and dismissed items."
							items={closedItems}
							totalCount={
								(done.data?.totalCount ?? 0) +
								(dismissed.data?.totalCount ?? 0)
							}
							mailboxId={mailboxId}
							sources={sources}
							onOpenSource={openSource}
						/>
					)}
				</>
			)}
		</div>
	);
}
