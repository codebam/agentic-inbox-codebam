// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Loader, Tooltip } from "@cloudflare/kumo";
import {
	ArrowsClockwiseIcon,
	ChatCircleTextIcon,
	EnvelopeSimpleIcon,
	StarIcon,
	SunHorizonIcon,
	TrayIcon,
	WarningCircleIcon,
	WarningOctagonIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useParams } from "react-router";
import { formatDetailDate } from "shared/dates";
import MailboxSplitView from "~/components/MailboxSplitView";
import { useUIStore } from "~/hooks/useUIStore";
import { formatActionTime } from "~/lib/agent-actions";
import { digestQueryKey, useDigest } from "~/queries/digest";
import type { DigestCounts, DigestEmailRef, DigestItemRef } from "~/types";

/**
 * The server caps the needs-reply list at ten rows; this only formats the
 * "showing N of M" note under it.
 */
const NEEDS_REPLY_CAP = 10;

/** One stat tile: an icon and label over the count they summarize. */
function StatTile({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base px-4 py-3">
			<div className="flex items-center gap-1.5 text-xs text-kumo-subtle">
				{icon}
				{label}
			</div>
			<div className="mt-1 text-xl font-semibold text-kumo-default">{value}</div>
		</div>
	);
}

/**
 * One message reference in the digest. Clicking it (or Enter/Space) opens the
 * message in the side panel, the same way a search result does.
 */
function DigestRow({
	item,
	onOpen,
}: {
	item: DigestEmailRef;
	onOpen: (item: DigestEmailRef) => void;
}) {
	return (
		<li>
			<div
				role="button"
				tabIndex={0}
				onClick={() => onOpen(item)}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onOpen(item);
					}
				}}
				className="flex cursor-pointer items-center gap-3 rounded-lg border border-kumo-line bg-kumo-base px-4 py-2.5 transition-colors hover:bg-kumo-tint"
			>
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-medium text-kumo-default">
						{item.sender}
					</div>
					<div className="mt-0.5 truncate text-sm text-kumo-subtle">
						{item.subject}
					</div>
				</div>
				<Tooltip content={formatDetailDate(item.date)} asChild>
					<span className="shrink-0 text-xs text-kumo-subtle">
						{formatActionTime(item.date)}
					</span>
				</Tooltip>
			</div>
		</li>
	);
}

/**
 * One open task/deadline row: the item's title, its due date, and a link
 * back to the message it came from. Items carry only their source email id,
 * so the row opens that message directly.
 */
function DigestItemRow({
	item,
	onOpen,
}: {
	item: DigestItemRef;
	onOpen: (emailId: string) => void;
}) {
	return (
		<li>
			<div
				role="button"
				tabIndex={0}
				onClick={() => onOpen(item.email_id)}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onOpen(item.email_id);
					}
				}}
				className="flex cursor-pointer items-center gap-3 rounded-lg border border-kumo-line bg-kumo-base px-4 py-2.5 transition-colors hover:bg-kumo-tint"
			>
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-medium text-kumo-default">
						{item.title}
					</div>
					<div className="mt-0.5 text-xs text-kumo-subtle">
						Due {formatDetailDate(item.due_at)}
					</div>
				</div>
				<Tooltip content={formatDetailDate(item.due_at)} asChild>
					<span className="shrink-0 text-xs text-kumo-subtle">
						{formatActionTime(item.due_at)}
					</span>
				</Tooltip>
			</div>
		</li>
	);
}

/** The window line under the heading: the exact trailing-24-hour span. */
function windowLabel(window: { from: string; to: string }): string {
	return `${formatDetailDate(window.from)} → ${formatDetailDate(window.to)}`;
}

/**
 * The mailbox's morning brief: the trailing 24 hours of arrivals, what still
 * needs a reply, the category breakdown and fired reminders. Read-only — the
 * server builds it on demand, and the same brief is what the daily cron POSTs
 * to the mailbox's notification webhook when the digest is enabled in
 * Settings.
 */
export default function DigestRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const { selectedEmailId, isComposing, selectEmail } = useUIStore();
	const qc = useQueryClient();
	const { data: digest, isLoading, isFetching, isError, error } = useDigest(mailboxId);

	// Refresh re-runs the query; the digest is computed on demand, so
	// invalidating it is enough to get a freshly built brief.
	const handleRefresh = () => {
		void qc.invalidateQueries({ queryKey: digestQueryKey(mailboxId) });
	};

	const handleOpen = (item: DigestEmailRef) => {
		selectEmail(item.id, mailboxId);
	};

	if (isLoading) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	if (isError || !digest) {
		return (
			<div className="h-full overflow-y-auto px-4 py-4 md:px-8 md:py-6">
				<h1 className="mb-6 text-lg font-semibold text-kumo-default">Morning brief</h1>
				<div className="flex flex-col items-center rounded-lg border border-kumo-line bg-kumo-base p-6 text-center">
					<WarningCircleIcon size={40} weight="thin" className="mb-3 text-kumo-danger" />
					<h3 className="mb-1.5 text-base font-semibold text-kumo-default">
						Couldn't load the morning brief
					</h3>
					<p className="mb-4 max-w-sm text-sm text-kumo-subtle">
						{error instanceof Error ? error.message : "Something went wrong"}
					</p>
					<Button variant="secondary" size="sm" onClick={handleRefresh}>
						Try again
					</Button>
				</div>
			</div>
		);
	}

	const counts: DigestCounts = digest.counts;

	return (
		<MailboxSplitView selectedEmailId={selectedEmailId} isComposing={isComposing}>
			<div className="h-full max-w-3xl overflow-y-auto px-4 py-4 md:px-8 md:py-6">
				<div className="mb-2 flex items-start justify-between gap-4">
					<h1 className="text-lg font-semibold text-kumo-default">Morning brief</h1>
					<Tooltip content={isFetching ? "Refreshing..." : "Refresh"} side="bottom" asChild>
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
							onClick={handleRefresh}
							disabled={isFetching}
							aria-label="Refresh"
						/>
					</Tooltip>
				</div>
				<p className="mb-6 max-w-xl text-sm text-kumo-subtle">
					Trailing 24 hours — {windowLabel(digest.window)}. Built from stored
					mail when the page loads; spam is counted but kept out of the lists.
				</p>

				{counts.received === 0 && digest.needs_reply.length === 0 ? (
					<div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-kumo-line px-6 py-20 text-center">
						<SunHorizonIcon size={48} weight="thin" className="mb-4 text-kumo-subtle" />
						<h3 className="mb-1.5 text-base font-semibold text-kumo-default">
							Nothing arrived
						</h3>
						<p className="mb-5 max-w-sm text-sm text-kumo-subtle">
							No mail arrived in the last 24 hours, so there is nothing to
							brief you on yet. Refresh later in the day.
						</p>
					</div>
				) : (
					<>
						<div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-5">
							<StatTile
								icon={<TrayIcon size={14} />}
								label="Received"
								value={counts.received}
							/>
							<StatTile
								icon={<EnvelopeSimpleIcon size={14} />}
								label="Unread"
								value={counts.unread}
							/>
							<StatTile
								icon={<ChatCircleTextIcon size={14} />}
								label="Needs reply"
								value={counts.needs_reply}
							/>
							<StatTile
								icon={<StarIcon size={14} />}
								label="Starred"
								value={counts.starred}
							/>
							<StatTile
								icon={<WarningOctagonIcon size={14} />}
								label="Spam"
								value={counts.spam}
							/>
						</div>

						<section className="mb-8">
							<h2 className="mb-2 text-sm font-semibold text-kumo-default">
								Needs a reply
							</h2>
							{digest.needs_reply.length === 0 ? (
								<p className="text-xs text-kumo-subtle">
									Nothing needs a reply right now.
								</p>
							) : (
								<>
									<ul className="space-y-2">
										{digest.needs_reply.map((item) => (
											<DigestRow key={item.id} item={item} onOpen={handleOpen} />
										))}
									</ul>
									{counts.needs_reply > NEEDS_REPLY_CAP && (
										<p className="mt-3 text-xs text-kumo-subtle">
											Showing the {digest.needs_reply.length} newest of{" "}
											{counts.needs_reply} conversations that need a reply.
										</p>
									)}
								</>
							)}
						</section>

						{digest.items.open > 0 && (
							<section className="mb-8">
								<h2 className="mb-2 text-sm font-semibold text-kumo-default">
									Tasks due
								</h2>
								<p className="mb-3 text-xs text-kumo-subtle">
									{digest.items.overdue} overdue · {digest.items.due_today} due
									today · {digest.items.open} open
								</p>
								{digest.items.due.length > 0 ? (
									<ul className="space-y-1.5">
										{digest.items.due.map((item) => (
											<DigestItemRow
												key={item.id}
												item={item}
												onOpen={(emailId) => selectEmail(emailId, mailboxId)}
											/>
										))}
									</ul>
								) : (
									<p className="text-xs text-kumo-subtle">
										No dated items yet — undated tasks live on the Tasks
										page.
									</p>
								)}
							</section>
						)}

						<section className="mb-8">
							<h2 className="mb-2 text-sm font-semibold text-kumo-default">
								Recent arrivals
							</h2>
							{digest.recent.length === 0 ? (
								<p className="text-xs text-kumo-subtle">
									No non-spam arrivals in this window.
								</p>
							) : (
								<ul className="space-y-2">
									{digest.recent.map((item) => (
										<DigestRow key={item.id} item={item} onOpen={handleOpen} />
									))}
								</ul>
							)}
						</section>

						<section>
							<h2 className="mb-2 text-sm font-semibold text-kumo-default">
								By category
							</h2>
							{digest.by_category.length === 0 ? (
								<p className="text-xs text-kumo-subtle">
									No categorized arrivals in this window.
								</p>
							) : (
								<div className="flex flex-wrap gap-2">
									{digest.by_category.map((row) => (
										<span
											key={row.category}
											className="inline-flex items-center gap-1.5 rounded-full border border-kumo-line bg-kumo-base px-3 py-1 text-xs text-kumo-default"
										>
											{row.category}
											<Badge variant="secondary">{row.count}</Badge>
										</span>
									))}
								</div>
							)}
						</section>
					</>
				)}
			</div>
		</MailboxSplitView>
	);
}
