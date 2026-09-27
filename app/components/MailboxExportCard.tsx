// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { Button } from "@cloudflare/kumo";
import { DownloadSimpleIcon } from "@phosphor-icons/react";
import { downloadFile } from "~/lib/utils";
import { useStorageUsage } from "~/queries/storage";


/**
 * Per-mailbox export: the whole mailbox as one mbox file. The export is
 * reconstructed from the fields this mailbox stores — the original wire
 * source is never kept — so it is a faithful rebuild of the stored
 * messages, not a byte-exact copy of what was delivered. The message count
 * comes from the same storage query the Storage card reads, so it costs
 * nothing extra here.
 */
export default function MailboxExportCard({ mailboxId }: { mailboxId?: string | undefined }) {
	const { data: usage } = useStorageUsage(mailboxId);
	const messageCount = usage?.email_count;

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-3">
				<DownloadSimpleIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">Export</span>
			</div>
			<p className="text-xs text-kumo-subtle mb-4">
				Download every stored message as one mbox file, rebuilt from the
				fields this mailbox stores — not a byte-exact copy of the original
				mail.
				{messageCount !== undefined &&
					` ${messageCount} message${messageCount === 1 ? "" : "s"} stored.`}
			</p>
			<Button
				variant="secondary"
				size="sm"
				icon={<DownloadSimpleIcon size={16} />}
				disabled={!mailboxId}
				onClick={() => {
					if (mailboxId) {
						downloadFile(`/api/v1/mailboxes/${mailboxId}/export`, `${mailboxId}.mbox`);
					}
				}}
			>
				Download .mbox
			</Button>
		</div>
	);
}
