// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Loader, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import {
	ArrowClockwiseIcon,
	ArrowsClockwiseIcon,
	CheckIcon,
	HourglassIcon,
	ProhibitIcon,
	WarningCircleIcon,
} from "@phosphor-icons/react";
import { useMemo } from "react";
import { useParams } from "react-router";
import { formatDetailDate } from "shared/dates";
import { formatActionTime } from "~/lib/agent-actions";
import { formatSnoozeTime } from "~/lib/snooze";
import {
	useCancelScheduledSend,
	useRetryScheduledSend,
	useScheduledSends,
} from "~/queries/scheduled-sends";
import type { ScheduledSend } from "~/types";

/** Rows per fetch. The server keeps a bounded history, so one page is enough. */
const SEND_PAGE_SIZE = 50;

/** Newest first; rows with an unusable timestamp keep their relative order. */
function byCreatedAtDesc(a: ScheduledSend, b: ScheduledSend): number {
	const left = Date.parse(a.created_at);
	const right = Date.parse(b.created_at);
	if (!Number.isFinite(left) || !Number.isFinite(right)) return 0;
	return right - left;
}

const STATUS_BADGE: Record<ScheduledSend["status"], "blue" | "green" | "red" | "secondary"> = {
	pending: "blue",
	sent: "green",
	failed: "red",
	cancelled: "secondary",
};

const STATUS_LABEL: Record<ScheduledSend["status"], string> = {
	pending: "Scheduled",
	sent: "Sent",
	failed: "Failed",
	cancelled: "Cancelled",
};

interface SendRowProps {
	send: ScheduledSend;
	mailboxId: string | undefined;
}

/**
 * One queued or past send. Pending rows offer Cancel and failed rows offer
 * Try again — both fire on an explicit click only, show their pending state,
 * then settle into the server's answer. Sent and cancelled rows show their
 * outcome instead of an action.
 */
function SendRow({ send, mailboxId }: SendRowProps) {
	const cancel = useCancelScheduledSend();
	const retry = useRetryScheduledSend();
	const toastManager = useKumoToastManager();

	// Cancelling is one-way, so the mutation also covers the moment between
	// the DELETE landing and the refetched row arriving.
	const cancelled =
		send.status === "cancelled" ||
		(cancel.isSuccess && cancel.variables?.id === send.id);
	const queued = send.status === "pending" && !cancelled;
	const failed = send.status === "failed";
	const cancelPending = cancel.isPending && cancel.variables?.id === send.id;
	const retryPending = retry.isPending && retry.variables?.id === send.id;

	const headline =
		send.status === "sent"
			? `Sent ${formatSnoozeTime(send.sent_at ?? send.send_at)}`
			: send.status === "cancelled"
				? "Cancelled before sending"
				: send.status === "failed"
					? `Failed to send ${formatSnoozeTime(send.send_at)}`
					: `Scheduled to send ${formatSnoozeTime(send.send_at)}`;

	const handleCancel = () => {
		if (!mailboxId) return;
		cancel.mutate(
			{ mailboxId, id: send.id },
			{
				onSuccess: () => {
					toastManager.add({ title: "Scheduled send cancelled" });
				},
				onError: (error) => {
					toastManager.add({
						title: "Could not cancel the scheduled send",
						description:
							error instanceof Error ? error.message : "Something went wrong",
						variant: "error",
					});
				},
			},
		);
	};

	const handleRetry = () => {
		if (!mailboxId) return;
		retry.mutate(
			{ mailboxId, id: send.id },
			{
				onSuccess: () => {
					toastManager.add({ title: "Send queued again" });
				},
				onError: (error) => {
					toastManager.add({
						title: "Could not retry the send",
						description:
							error instanceof Error ? error.message : "Something went wrong",
						variant: "error",
					});
				},
			},
		);
	};

	return (
		<li className="rounded-lg border border-kumo-line bg-kumo-base px-4 py-3">
			<div className="flex items-start gap-3">
				<div className="pt-0.5">
					<Badge variant={STATUS_BADGE[send.status]}>
						{STATUS_LABEL[send.status]}
					</Badge>
				</div>

				<div className="min-w-0 flex-1">
					<Tooltip content={formatDetailDate(send.sent_at ?? send.send_at)} asChild>
						<div className="truncate text-sm font-medium text-kumo-default">
							{headline}
						</div>
					</Tooltip>
					{failed && send.last_error && (
						<div className="mt-0.5 truncate text-xs text-kumo-danger">
							{send.last_error}
						</div>
					)}
					{failed && send.attempts > 1 && (
						<div className="mt-0.5 text-xs text-kumo-subtle">
							{send.attempts} attempts made.
						</div>
					)}
				</div>

				<div className="flex shrink-0 items-center gap-2">
					<Tooltip content={formatDetailDate(send.created_at)} asChild>
						<span className="text-xs text-kumo-subtle">
							{formatActionTime(send.created_at)}
						</span>
					</Tooltip>
					{queued ? (
						<Button
							variant="secondary"
							size="xs"
							icon={<ProhibitIcon size={14} />}
							loading={cancelPending}
							disabled={!mailboxId}
							onClick={handleCancel}
						>
							Cancel
						</Button>
					) : failed ? (
						<Button
							variant="secondary"
							size="xs"
							icon={<ArrowClockwiseIcon size={14} />}
							loading={retryPending}
							disabled={!mailboxId}
							onClick={handleRetry}
						>
							Try again
						</Button>
					) : (
						<span className="inline-flex items-center gap-1 text-xs text-kumo-subtle">
							{cancelled ? (
								<>
									<ProhibitIcon size={14} weight="bold" />
									Cancelled
								</>
							) : (
								<>
									<CheckIcon size={14} weight="bold" />
									Sent
								</>
							)}
						</span>
					)}
				</div>
			</div>
		</li>
	);
}

/**
 * The mailbox's send queue: messages the composer scheduled, newest first.
 * Pending rows can be cancelled before the queue fires them, failed rows can
 * be retried, and the rest show how they ended.
 */
export default function ScheduledRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const { data, isLoading, isFetching, isError, error, refetch } = useScheduledSends(
		mailboxId,
		SEND_PAGE_SIZE,
	);

	// The endpoint already returns newest first; re-sorting keeps that order
	// even if a row ever arrives out of sequence.
	const sends = useMemo(
		() => [...(data?.sends ?? [])].sort(byCreatedAtDesc),
		[data],
	);
	const totalCount = data?.totalCount ?? 0;

	if (isLoading) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	if (isError) {
		return (
			<div className="h-full overflow-y-auto px-4 py-4 md:px-8 md:py-6">
				<h1 className="mb-6 text-lg font-semibold text-kumo-default">Scheduled</h1>
				<div className="flex flex-col items-center rounded-lg border border-kumo-line bg-kumo-base p-6 text-center">
					<WarningCircleIcon size={40} weight="thin" className="mb-3 text-kumo-danger" />
					<h3 className="mb-1.5 text-base font-semibold text-kumo-default">
						Couldn't load scheduled sends
					</h3>
					<p className="mb-4 max-w-sm text-sm text-kumo-subtle">
						{error instanceof Error ? error.message : "Something went wrong"}
					</p>
					<Button variant="secondary" size="sm" onClick={() => void refetch()}>
						Try again
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="h-full max-w-3xl overflow-y-auto px-4 py-4 md:px-8 md:py-6">
			<div className="mb-2 flex items-start justify-between gap-4">
				<h1 className="text-lg font-semibold text-kumo-default">Scheduled</h1>
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
						onClick={() => void refetch()}
						disabled={isFetching}
						aria-label="Refresh"
					/>
				</Tooltip>
			</div>
			<p className="mb-6 max-w-xl text-sm text-kumo-subtle">
				Messages the composer has queued, newest first. A pending send waits
				for its time and can be cancelled until the queue fires it; a failed
				send keeps its error and can be tried again.
			</p>

			{sends.length === 0 ? (
				<div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-kumo-line px-6 py-20 text-center">
					<HourglassIcon size={48} weight="thin" className="mb-4 text-kumo-subtle" />
					<h3 className="mb-1.5 text-base font-semibold text-kumo-default">
						No scheduled sends
					</h3>
					<p className="mb-5 max-w-sm text-sm text-kumo-subtle">
						Send queues a message for ten seconds ahead — with an Undo in the
						toast — and Send later takes a time of your choosing. Both show up
						here until the queue sends them.
					</p>
				</div>
			) : (
				<>
					<ul className="space-y-2">
						{sends.map((send) => (
							<SendRow key={send.id} send={send} mailboxId={mailboxId} />
						))}
					</ul>
					{totalCount > sends.length && (
						<p className="mt-4 text-xs text-kumo-subtle">
							Showing the {sends.length} most recent of {totalCount} scheduled
							sends.
						</p>
					)}
				</>
			)}
		</div>
	);
}
