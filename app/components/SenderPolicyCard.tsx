// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { Badge, Button, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { ShieldCheckIcon, XIcon } from "@phosphor-icons/react";
import type { SenderPolicyEntry } from "workers/lib/sender-policy";
import { useRemoveSenderPolicy, useSenderPolicy } from "~/queries/sender-policy";


/**
 * Per-mailbox sender allow/block list.
 *
 * Entries are added from the message panel ('Not spam' / 'Block sender') and
 * removed here. The policy is applied on arrival, before the AI classifier:
 * blocked senders are filed straight into Spam (still stored, never
 * auto-drafted), allowed senders skip spam classification.
 */
export default function SenderPolicyCard({ mailboxId }: { mailboxId?: string | undefined }) {
	const toastManager = useKumoToastManager();
	const { data: entries = [], isLoading } = useSenderPolicy(mailboxId);
	const removePolicy = useRemoveSenderPolicy();

	const handleRemove = (entry: SenderPolicyEntry) => {
		if (!mailboxId) return;
		removePolicy.mutate(
			{ mailboxId, address: entry.address },
			{
				onSuccess: () =>
					toastManager.add({
						title: `Removed the ${entry.policy} policy for ${entry.address}`,
					}),
				onError: () => {
					toastManager.add({
						title: "Failed to remove the sender policy",
						variant: "error",
					});
				},
			},
		);
	};

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-3">
				<ShieldCheckIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">
					Sender policy
				</span>
				{entries.length > 0 && (
					<Badge variant="secondary">{entries.length}</Badge>
				)}
			</div>
			<p className="text-xs text-kumo-subtle mb-4">
				Applied before the AI classifier. Mail from a blocked sender is filed
				straight into Spam — still stored, never deleted — and is never
				auto-drafted; mail from an allowed sender skips spam classification but
				can still be categorized. Add entries with 'Not spam' or 'Block
				sender' in the message panel.
			</p>
			{isLoading ? (
				<div className="flex justify-center py-4">
					<Loader size="sm" aria-label="Loading sender policy" />
				</div>
			) : entries.length === 0 ? (
				<p className="text-xs text-kumo-subtle">
					No allow or block entries yet.
				</p>
			) : (
				<ul className="space-y-2">
					{entries.map((entry) => (
						<li
							key={entry.address}
							className="flex items-center gap-2 rounded-md border border-kumo-line bg-kumo-recessed px-3 py-2"
						>
							<Badge variant={entry.policy === "block" ? "red" : "primary"}>
								{entry.policy === "block" ? "Blocked" : "Allowed"}
							</Badge>
							<span className="text-sm text-kumo-default truncate">
								{entry.address}
							</span>
							<Button
								variant="ghost"
								shape="square"
								size="xs"
								icon={<XIcon size={14} />}
								onClick={() => handleRemove(entry)}
								aria-label={`Remove the ${entry.policy} policy for ${entry.address}`}
								className="ml-auto shrink-0"
							/>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
