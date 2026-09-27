// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Switch, useKumoToastManager } from "@cloudflare/kumo";
import { BrainIcon, DatabaseIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { normalizeSemanticSearchSettings } from "shared/semantic";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";
import { useSemanticReindex } from "~/queries/search";

/** Safety stop for the build loop: 200 batches of 20 is 4000 messages a click. */
const REINDEX_MAX_BATCHES = 200;

/**
 * Per-mailbox semantic search switch and index builder.
 *
 * The switch saves on its own, like the tasks card: flipping it writes
 * `semanticSearch.enabled` through the mailbox settings PUT immediately and
 * sends the rest of the stored settings back unchanged, so the write never
 * clobbers a sibling card's values. Off is the default because ingest spends
 * one embedding call per new message while it is on.
 *
 * Building the index loops the reindex route — one bounded batch per call,
 * the same idempotent shape as the retroactive rule apply — until the answer
 * reports nothing remaining, so mail stored before the switch was turned on
 * becomes searchable without re-ingesting it. The loop also stops when a
 * batch processes nothing (nothing left to do) or after REINDEX_MAX_BATCHES.
 * A deployment without the AI + Vectorize bindings answers the not-configured
 * message, which the toast surfaces as-is.
 */
export default function SemanticSearchCard({ mailboxId }: { mailboxId?: string | undefined }) {
	const toastManager = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailbox = useUpdateMailbox();
	const reindex = useSemanticReindex();
	const [isBuilding, setIsBuilding] = useState(false);
	const [progress, setProgress] = useState<{
		embedded: number;
		total: number;
		remaining: number;
	} | null>(null);

	const enabled = normalizeSemanticSearchSettings(mailbox?.settings?.semanticSearch).enabled;

	const handleToggle = (next: boolean) => {
		if (!mailboxId || !mailbox) return;
		updateMailbox.mutate(
			{
				mailboxId,
				settings: { ...mailbox.settings, semanticSearch: { enabled: next } },
			},
			{
				onSuccess: () =>
					toastManager.add({
						title: next
							? "Indexing new mail for semantic search"
							: "Semantic search turned off",
					}),
				onError: (error) => {
					toastManager.add({
						title: "Could not save the semantic search setting",
						description:
							error instanceof Error ? error.message : "Something went wrong",
						variant: "error",
					});
				},
			},
		);
	};

	const handleBuild = async () => {
		if (!mailboxId || isBuilding) return;
		setIsBuilding(true);
		try {
			let result = await reindex.mutateAsync(mailboxId);
			setProgress({
				embedded: result.embedded,
				total: result.total,
				remaining: result.remaining,
			});
			for (
				let batch = 1;
				batch < REINDEX_MAX_BATCHES && result.remaining > 0 && result.processed > 0;
				batch += 1
			) {
				result = await reindex.mutateAsync(mailboxId);
				setProgress({
					embedded: result.embedded,
					total: result.total,
					remaining: result.remaining,
				});
			}
			const summary = `Indexed ${result.embedded} of ${result.total} message${result.total === 1 ? "" : "s"}.`;
			toastManager.add({
				title: result.remaining === 0 ? "Semantic index built" : "Semantic index partly built",
				description:
					result.remaining === 0
						? summary
						: `${summary} ${result.remaining} still to index — run it again to continue.`,
			});
		} catch (error) {
			toastManager.add({
				title: "Building the semantic index failed",
				description: error instanceof Error ? error.message : "Something went wrong",
				variant: "error",
			});
		} finally {
			setIsBuilding(false);
		}
	};

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-3">
				<BrainIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">Semantic search</span>
				{enabled ? (
					<Badge variant="primary">On</Badge>
				) : (
					<Badge variant="secondary">Off</Badge>
				)}
			</div>
			<p className="text-xs text-kumo-subtle mb-4">
				Embeds each new non-spam message once and stores the vector in this
				mailbox&apos;s index, so the search box can find messages by meaning
				instead of exact words. Off by default: while it is on, every new
				message spends one embedding call. Turning it off leaves the index and
				the stored mail untouched.
			</p>
			<div className="flex flex-wrap items-center gap-3">
				<Switch
					checked={enabled}
					disabled={!mailbox || updateMailbox.isPending}
					onCheckedChange={handleToggle}
					label="Index new mail for semantic search"
				/>
				<Button
					variant="secondary"
					size="sm"
					icon={<DatabaseIcon size={16} />}
					disabled={!mailboxId || isBuilding}
					onClick={() => void handleBuild()}
				>
					{isBuilding ? "Building…" : "Build the index"}
				</Button>
				{progress && (
					<span className="text-xs text-kumo-subtle">
						{progress.embedded} of {progress.total} indexed
						{progress.remaining > 0 ? ` — ${progress.remaining} to go` : ""}
					</span>
				)}
			</div>
		</div>
	);
}
