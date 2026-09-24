// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { Badge, Switch, useKumoToastManager } from "@cloudflare/kumo";
import { ListChecksIcon } from "@phosphor-icons/react";
import { normalizeItemsSettings } from "shared/items";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";


/**
 * Per-mailbox switch for task and deadline extraction.
 *
 * The card saves on its own instead of riding the settings form's Save
 * button: flipping the switch writes `items.enabled` through the mailbox
 * settings PUT immediately, so turning extraction off cannot be forgotten
 * behind an unsaved form. The rest of the stored settings are sent back
 * unchanged, so the write never clobbers a sibling card's values.
 */
export default function ItemsCard({ mailboxId }: { mailboxId?: string | undefined }) {
	const toastManager = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailbox = useUpdateMailbox();

	// Only an explicit false turns extraction off, so a mailbox whose stored
	// settings predate the switch reads as on — the same rule the receive
	// path applies (shared/items.ts).
	const enabled = normalizeItemsSettings(mailbox?.settings?.items).enabled;

	const handleToggle = (next: boolean) => {
		if (!mailboxId || !mailbox) return;
		updateMailbox.mutate(
			{
				mailboxId,
				settings: { ...mailbox.settings, items: { enabled: next } },
			},
			{
				onSuccess: () =>
					toastManager.add({
						title: next
							? "Extracting tasks and deadlines"
							: "Task extraction turned off",
					}),
				onError: (error) => {
					toastManager.add({
						title: "Could not save the extraction setting",
						description:
							error instanceof Error ? error.message : "Something went wrong",
						variant: "error",
					});
				},
			},
		);
	};

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-3">
				<ListChecksIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">
					Tasks & deadlines
				</span>
				{enabled ? (
					<Badge variant="primary">On</Badge>
				) : (
					<Badge variant="secondary">Off</Badge>
				)}
			</div>
			<p className="text-xs text-kumo-subtle mb-4">
				Reads each new non-spam message once (with the items extractor model
				above) and lists the concrete tasks and deadlines it states on the
				Tasks page and in the message panel. Spam is never read for items,
				extraction never blocks delivery, and items already stored stay put
				when this is off.
			</p>
			<Switch
				checked={enabled}
				disabled={!mailbox || updateMailbox.isPending}
				onCheckedChange={handleToggle}
				label="Extract tasks and deadlines"
			/>
		</div>
	);
}
