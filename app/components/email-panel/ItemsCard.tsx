// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import {
	BellRingingIcon,
	CheckIcon,
	ListChecksIcon,
	ProhibitIcon,
	ArrowCounterClockwiseIcon,
} from "@phosphor-icons/react";
import { formatDetailDate } from "shared/dates";
import { itemReminderInstant, useEmailItems, useUpdateItemStatus } from "~/queries/items";
import { useSetReminder } from "~/queries/emails";
import type { Email, ExtractedItem } from "~/types";

interface ItemsCardProps {
	email: Email;
	mailboxId?: string | undefined;
}

/**
 * The tasks and deadlines the extractor found in the open message, as a strip
 * under its header: the same Done / Dismiss / Reopen actions as the Tasks
 * page, plus Remind on an open item with a due date. Remind schedules the
 * message's own follow-up reminder (the existing setReminder path) for the
 * item's due date — an explicit click only, never automatic — so the message
 * comes back to the inbox when the deadline arrives.
 *
 * Renders nothing while the list is loading or empty, so a message with no
 * items looks exactly like one that predates the feature.
 */
export default function ItemsCard({ email, mailboxId }: ItemsCardProps) {
	const { data, isLoading } = useEmailItems(mailboxId, email.id);
	const updateStatus = useUpdateItemStatus();
	const setReminder = useSetReminder();
	const toastManager = useKumoToastManager();

	const items = data?.items ?? [];
	if (isLoading || items.length === 0) return null;

	const closeItem = (item: ExtractedItem, status: ExtractedItem["status"]) => {
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

	const remind = (item: ExtractedItem) => {
		if (!mailboxId || !item.due_at) return;
		setReminder.mutate(
			{ mailboxId, id: email.id, at: itemReminderInstant(item.due_at) },
			{
				onSuccess: () =>
					toastManager.add({ title: "Reminder set for this message" }),
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

	return (
		<div className="px-4 py-2 border-b border-kumo-line md:px-6">
			<div className="flex items-center gap-2 text-xs text-kumo-subtle">
				<ListChecksIcon size={14} className="shrink-0" />
				<span>
					{items.length === 1
						? "1 task or deadline in this message"
						: `${items.length} tasks and deadlines in this message`}
				</span>
			</div>
			<ul className="mt-2 space-y-1.5">
				{items.map((item) => (
					<li key={item.id} className="flex flex-wrap items-center gap-2">
						<Badge variant={item.kind === "deadline" ? "blue" : "secondary"}>
							{item.kind}
						</Badge>
						<span className="min-w-0 flex-1 truncate text-xs text-kumo-default">
							{item.title}
						</span>
						{item.due_at && (
							<Tooltip content={formatDetailDate(item.due_at)} side="top" asChild>
								<span className="shrink-0 text-xs text-kumo-subtle">
									Due {formatDetailDate(item.due_at)}
								</span>
							</Tooltip>
						)}
						{item.status === "open" ? (
							<>
								<Button
									variant="secondary"
									size="xs"
									icon={<CheckIcon size={14} />}
									disabled={!mailboxId}
									loading={
										updateStatus.isPending &&
										updateStatus.variables?.itemId === item.id
									}
									onClick={() => closeItem(item, "done")}
								>
									Done
								</Button>
								<Button
									variant="ghost"
									size="xs"
									icon={<ProhibitIcon size={14} />}
									disabled={!mailboxId}
									onClick={() => closeItem(item, "dismissed")}
								>
									Dismiss
								</Button>
								{item.due_at && (
									<Button
										variant="secondary"
										size="xs"
										icon={<BellRingingIcon size={14} />}
										disabled={!mailboxId}
										loading={setReminder.isPending}
										onClick={() => remind(item)}
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
								disabled={!mailboxId}
								loading={
									updateStatus.isPending &&
									updateStatus.variables?.itemId === item.id
								}
								onClick={() => closeItem(item, "open")}
							>
								Reopen
							</Button>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}
