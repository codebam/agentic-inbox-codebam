// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { Badge, Switch, useKumoToastManager } from "@cloudflare/kumo";
import { SunHorizonIcon } from "@phosphor-icons/react";
import { normalizeDigestEnabled } from "shared/digest";
import { normalizeWebhookUrl } from "shared/webhook";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";


/**
 * Per-mailbox morning-digest switch, sitting next to the outbound-webhook
 * card it depends on: with it on, the daily digest cron (11:00 UTC, see
 * workers/lib/digest-sweep.ts) POSTs the trailing-24-hour brief to this
 * mailbox's notification webhook. The same brief is always readable under
 * "Morning brief" in the sidebar.
 *
 * The switch saves itself through the mailbox settings PUT — the whole
 * settings object is written back with `digestEnabled` flipped, the same way
 * the settings form saves on Save — so it needs nothing but the mailbox id
 * and does not take part in the form's unsaved state.
 */
export default function DigestCard({ mailboxId }: { mailboxId?: string | undefined }) {
	const toastManager = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailbox = useUpdateMailbox();

	const enabled = normalizeDigestEnabled(mailbox?.settings?.digestEnabled);
	const hasWebhook = Boolean(normalizeWebhookUrl(mailbox?.settings?.notifyWebhookUrl));

	const handleCheckedChange = (checked: boolean) => {
		if (!mailboxId || !mailbox) return;
		updateMailbox.mutate(
			{ mailboxId, settings: { ...mailbox.settings, digestEnabled: checked } },
			{
				onSuccess: () => {
					toastManager.add({
						title: checked ? "Morning digest enabled" : "Morning digest disabled",
					});
				},
				onError: () => {
					toastManager.add({
						title: "Failed to save the morning-digest setting",
						variant: "error",
					});
				},
			},
		);
	};

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-3">
				<SunHorizonIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">
					Morning digest
				</span>
				{enabled ? (
					<Badge variant="primary">On</Badge>
				) : (
					<Badge variant="secondary">Off</Badge>
				)}
			</div>
			<p className="text-xs text-kumo-subtle mb-4">
				POSTs a JSON summary of the trailing 24 hours — arrivals, what still
				needs a reply, the category breakdown and fired reminders — to this
				mailbox's notification webhook once a day. The digest itself is always
				readable under "Morning brief" in the sidebar; the daily POST needs a
				webhook URL.
			</p>
			<Switch
				checked={enabled}
				onCheckedChange={handleCheckedChange}
				disabled={!mailboxId || !mailbox || updateMailbox.isPending}
				label="Deliver a daily morning digest"
			/>
			{!hasWebhook && (
				<p className="text-xs text-kumo-subtle mt-2">
					No webhook URL is configured for this mailbox yet, so nothing would
					be delivered — set one under Outbound Webhook above.
				</p>
			)}
		</div>
	);
}
