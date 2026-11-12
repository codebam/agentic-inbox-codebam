// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { formatDetailDate } from "~/lib/utils";

interface EmailPanelHeaderProps {
	subject: string;
	messageCount: number;
	showThreadCount: boolean;
	/** Classifier-assigned category label, if this email has been classified. */
	categoryLabel?: string | null;
	categoryConfidence?: number | null | undefined;
	isSpam?: boolean;
	/** Extra rows that belong inside the header block, e.g. the label chips. */
	children?: ReactNode;
	/**
	 * Sender block for the single-message view. Thread views render one
	 * sender block per message (ThreadMessage) and omit these, so the
	 * panel header stays the thread subject only there.
	 */
	sender?: string | undefined;
	/** Message date, rendered small next to the sender. */
	date?: string | undefined;
	/** Primary recipient shown as "To:". */
	recipient?: string | undefined;
	/** Cc recipients shown as "Cc:" when present. */
	cc?: string | undefined;
	/** Envelope recipient shown as "Delivered to:" when it differs. */
	envelopeRecipient?: string | null | undefined;
	/** Delivery outcome (Sent copies); rendered small when present. */
	deliveryStatus?: string | null | undefined;
	deliveryDetail?: string | null | undefined;
	/** Drafts show a "D" avatar instead of the sender initial. */
	isDraft?: boolean | undefined;
	/** The mailbox owner reads as "You" instead of the raw address. */
	isSelf?: boolean | undefined;
}

/** Split a `Name <addr>` sender into display name and address. */
function parseSender(sender: string): { name: string; address: string | null } {
	const match = sender.match(/^(.*?)\s*<([^>]+)>\s*$/);
	if (match?.[1]?.trim() && match[2]) {
		return { name: match[1].trim(), address: match[2].trim() };
	}
	return { name: sender.trim(), address: null };
}

export default function EmailPanelHeader({
	subject,
	messageCount,
	showThreadCount,
	categoryLabel,
	categoryConfidence,
	isSpam,
	children,
	sender,
	date,
	recipient,
	cc,
	envelopeRecipient,
	deliveryStatus,
	deliveryDetail,
	isDraft,
	isSelf,
}: EmailPanelHeaderProps) {
	const parsed = sender ? parseSender(sender) : null;
	const senderLabel = isDraft
		? "Draft"
		: isSelf
			? "You"
			: (parsed?.name ?? "");
	const senderAddress = parsed?.address ?? (parsed && parsed.name.includes("@") ? parsed.name : null);
	const initial = isDraft
		? "D"
		: ((senderLabel || sender || "?").charAt(0) || "?").toUpperCase();

	return (
		<div className="shrink-0 border-b border-kumo-line px-4 py-4 md:px-6">
			{parsed && (
				<div className="flex items-start gap-3">
					<div
						aria-hidden="true"
						className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-sm font-semibold text-kumo-default"
					>
						{initial}
					</div>
					<div className="min-w-0 flex-1">
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0">
								<div className="flex flex-wrap items-baseline gap-x-2">
									<span className="truncate text-[15px] font-medium leading-tight text-kumo-default">
										{senderLabel}
									</span>
									{senderAddress && senderAddress !== senderLabel && (
										<span className="truncate text-xs text-kumo-subtle">{senderAddress}</span>
									)}
								</div>
								{recipient && (
									<div className="mt-0.5 truncate text-xs text-kumo-subtle">
										To: {recipient}
										{cc ? ` · Cc: ${cc}` : ""}
									</div>
								)}
								{envelopeRecipient && envelopeRecipient !== recipient && (
									<div className="truncate text-xs text-kumo-subtle">
										Delivered to: {envelopeRecipient}
									</div>
								)}
								{deliveryStatus && (
									<div
										className={`truncate text-xs ${deliveryStatus === "failed" ? "text-kumo-danger" : "text-kumo-subtle"}`}
										title={deliveryDetail ?? undefined}
									>
										Delivery: {deliveryStatus}
										{deliveryDetail ? ` — ${deliveryDetail}` : ""}
									</div>
								)}
							</div>
							{date && (
								<time
									dateTime={date}
									className="shrink-0 text-xs text-kumo-subtle"
								>
									{formatDetailDate(date)}
								</time>
							)}
						</div>
					</div>
				</div>
			)}
			<div className={`flex flex-wrap items-center gap-2 ${parsed ? "mt-3" : ""}`}>
				<h2 className="text-[18px] font-semibold leading-snug text-kumo-default">{subject}</h2>
				{categoryLabel && (
					<Badge variant={isSpam ? "red" : "secondary"} className="shrink-0">
						{categoryLabel}
					</Badge>
				)}
			</div>
			{showThreadCount && (
				<span className="mt-1 block text-xs text-kumo-subtle">
					{messageCount} messages in this thread
					{categoryConfidence != null &&
						` · categorized with ${Math.round(categoryConfidence * 100)}% confidence`}
				</span>
			)}
			{!showThreadCount && categoryConfidence != null && (
				<span className="mt-1 block text-xs text-kumo-subtle">
					Categorized with {Math.round(categoryConfidence * 100)}% confidence
				</span>
			)}
			{children}
		</div>
	);
}
