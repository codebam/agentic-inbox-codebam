// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Loader, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import {
	ArrowUUpLeftIcon,
	ArrowsClockwiseIcon,
	CheckIcon,
	PulseIcon,
	WarningCircleIcon,
} from "@phosphor-icons/react";
import { useMemo } from "react";
import { useParams } from "react-router";
import { formatDetailDate } from "shared/dates";
import { describeAgentAction, formatActionTime } from "~/lib/agent-actions";
import { useAgentActions, useUndoAgentAction } from "~/queries/agent-actions";
import { useFolders } from "~/queries/folders";
import type { AgentAction } from "~/types";

/** Rows per fetch. The server keeps the newest 500, so one page is enough. */
const ACTION_PAGE_SIZE = 50;

/** Newest first; rows with an unusable timestamp keep their relative order. */
function byCreatedAtDesc(a: AgentAction, b: AgentAction): number {
	const left = Date.parse(a.created_at);
	const right = Date.parse(b.created_at);
	if (!Number.isFinite(left) || !Number.isFinite(right)) return 0;
	return right - left;
}

interface ActionRowProps {
	action: AgentAction;
	mailboxId: string | undefined;
	folderNames: Map<string, string>;
}

/**
 * One recorded action. The summary is derived from the tool name plus the
 * stored metadata — the raw payloads are never rendered. Undo fires on an
 * explicit click only, shows its pending state, then settles into an
 * "Undone" marker; a failed undo surfaces a toast and leaves the row alone.
 */
function ActionRow({ action, mailboxId, folderNames }: ActionRowProps) {
	const undo = useUndoAgentAction();
	const toastManager = useKumoToastManager();
	const summary = describeAgentAction(action, folderNames);

	// The refetched row carries `undone_at`, but checking the mutation too
	// keeps the button from flashing back before the invalidation lands.
	const undone =
		action.undone_at != null ||
		(undo.isSuccess && undo.variables?.actionId === action.id);
	const pending = undo.isPending && undo.variables?.actionId === action.id;
	const canUndo = action.undoable === 1 && !undone;

	const handleUndo = () => {
		if (!mailboxId) return;
		undo.mutate(
			{ mailboxId, actionId: action.id },
			{
				onSuccess: () => {
					toastManager.add({ title: "Action undone", description: summary });
				},
				onError: (error) => {
					toastManager.add({
						title: "Could not undo this action",
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
					<Badge variant={action.source === "mcp" ? "purple" : "blue"}>
						{action.source === "mcp" ? "MCP" : "agent"}
					</Badge>
				</div>

				<div className="min-w-0 flex-1">
					<Tooltip content={`Tool: ${action.tool}`} asChild>
						<div className="truncate text-sm font-medium text-kumo-default">
							{summary}
						</div>
					</Tooltip>
					{action.email_subject && (
						<div className="mt-0.5 truncate text-xs text-kumo-subtle">
							{action.email_subject}
						</div>
					)}
				</div>

				<div className="flex shrink-0 items-center gap-2">
					<Tooltip content={formatDetailDate(action.created_at)} asChild>
						<span className="text-xs text-kumo-subtle">
							{formatActionTime(action.created_at)}
						</span>
					</Tooltip>
					{undone ? (
						<span className="inline-flex items-center gap-1 text-xs text-kumo-subtle">
							<CheckIcon size={14} weight="bold" />
							Undone
						</span>
					) : canUndo ? (
						<Button
							variant="secondary"
							size="xs"
							icon={<ArrowUUpLeftIcon size={14} />}
							loading={pending}
							disabled={!mailboxId}
							onClick={handleUndo}
						>
							Undo
						</Button>
					) : (
						<span className="text-xs text-kumo-subtle">Not undoable</span>
					)}
				</div>
			</div>
		</li>
	);
}

/**
 * The mailbox's agent/MCP action log: what the built-in agent and MCP
 * clients did to stored mail, newest first, with an explicit-click Undo for
 * the reversible actions.
 */
export default function ActivityRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const { data, isLoading, isFetching, isError, error, refetch } = useAgentActions(
		mailboxId,
		ACTION_PAGE_SIZE,
	);
	const { data: folders = [] } = useFolders(mailboxId);
	const folderNames = useMemo(
		() => new Map(folders.map((folder) => [folder.id, folder.name])),
		[folders],
	);

	// The endpoint already returns newest first; re-sorting keeps that order
	// even if a row ever arrives out of sequence.
	const actions = useMemo(
		() => [...(data?.actions ?? [])].sort(byCreatedAtDesc),
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
				<h1 className="mb-6 text-lg font-semibold text-kumo-default">Activity</h1>
				<div className="flex flex-col items-center rounded-lg border border-kumo-line bg-kumo-base p-6 text-center">
					<WarningCircleIcon size={40} weight="thin" className="mb-3 text-kumo-danger" />
					<h3 className="mb-1.5 text-base font-semibold text-kumo-default">
						Couldn't load activity
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
				<h1 className="text-lg font-semibold text-kumo-default">Activity</h1>
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
				Actions the AI agent and MCP clients have taken on this mailbox, newest
				first. Reversible actions offer Undo; the rest are recorded here but
				cannot be undone automatically.
			</p>

			{actions.length === 0 ? (
				<div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-kumo-line px-6 py-20 text-center">
					<PulseIcon size={48} weight="thin" className="mb-4 text-kumo-subtle" />
					<h3 className="mb-1.5 text-base font-semibold text-kumo-default">
						No agent or MCP actions yet
					</h3>
					<p className="mb-5 max-w-sm text-sm text-kumo-subtle">
						When the AI agent or an MCP client moves, stars, reads or deletes a
						message, the action shows up here — with an Undo button when it can
						be reversed.
					</p>
				</div>
			) : (
				<>
					<ul className="space-y-2">
						{actions.map((action) => (
							<ActionRow
								key={action.id}
								action={action}
								mailboxId={mailboxId}
								folderNames={folderNames}
							/>
						))}
					</ul>
					{totalCount > actions.length && (
						<p className="mt-4 text-xs text-kumo-subtle">
							Showing the {actions.length} most recent of {totalCount} recorded
							actions.
						</p>
					)}
				</>
			)}
		</div>
	);
}
