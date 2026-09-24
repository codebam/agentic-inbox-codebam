// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { Badge, Button, useKumoToastManager } from "@cloudflare/kumo";
import { ProhibitIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Folders } from "shared/folders";
import { isSpamMarkedEmail } from "shared/spam";
import { useSenderPolicy, useSenderPolicyFeedback } from "~/queries/sender-policy";
import type { Email } from "~/types";


/**
 * One-click sender feedback for the open message:
 *   - 'Not spam' records an allow entry, moves the message back to the Inbox,
 *     and clears its spam category/classification for that message.
 *   - 'Block sender' records a block entry and moves the message to Spam —
 *     still stored there, never dropped, and never auto-drafted.
 *
 * Both actions go through the single feedback endpoint so the policy entry
 * and the message move are one request. Hidden for drafts/sent mail, where
 * the "sender" is the mailbox itself.
 */
export default function SenderPolicyActions({
	email,
	mailboxId,
}: {
	email: Email;
	mailboxId?: string;
}) {
	const toastManager = useKumoToastManager();
	const feedback = useSenderPolicyFeedback();
	const { data: entries = [] } = useSenderPolicy(mailboxId);
	const [busy, setBusy] = useState<"allow" | "block" | null>(null);

	const spamMarked = isSpamMarkedEmail(email);
	const sender = (email.sender || "").trim().toLowerCase();
	const currentPolicy =
		entries.find((entry) => entry.address === sender)?.policy ?? null;
	const isOwnMail =
		email.folder_id === Folders.DRAFT || email.folder_id === Folders.SENT;

	const run = async (action: "allow" | "block") => {
		if (!mailboxId || busy) return;
		setBusy(action);
		try {
			await feedback.mutateAsync({ mailboxId, emailId: email.id, action });
			toastManager.add({
				title:
					action === "allow"
						? "Marked as not spam — this sender now skips spam checks"
						: "Sender blocked — their mail now goes straight to Spam",
			});
		} catch (error) {
			toastManager.add({
				title:
					(error as Error).message || "Failed to update the sender policy",
				variant: "error",
			});
		} finally {
			setBusy(null);
		}
	};

	if (!mailboxId || isOwnMail) return null;

	return (
		<div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-kumo-line shrink-0 md:px-6">
			{spamMarked && (
				<Button
					variant="secondary"
					size="xs"
					icon={<ShieldCheckIcon size={14} />}
					onClick={() => run("allow")}
					loading={busy === "allow"}
				>
					Not spam
				</Button>
			)}
			<Button
				variant="ghost"
				size="xs"
				icon={<ProhibitIcon size={14} />}
				onClick={() => run("block")}
				loading={busy === "block"}
			>
				Block sender
			</Button>
			{currentPolicy === "block" && <Badge variant="red">Sender blocked</Badge>}
			{currentPolicy === "allow" && (
				<Badge variant="secondary">Sender allowed</Badge>
			)}
		</div>
	);
}
