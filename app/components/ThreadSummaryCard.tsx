// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button } from "@cloudflare/kumo";
import { SparkleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useThreadSummary } from "~/queries/emails";

interface ThreadSummaryCardProps {
	mailboxId?: string | undefined;
	/** The open message's thread; null/undefined while it is unknown. */
	threadId?: string | null | undefined;
	/** Total messages in the thread, from the replies already loaded. */
	messageCount: number;
}

/**
 * On-demand AI summary of the open thread, sitting above its replies.
 *
 * Nothing is requested until the button is clicked, and the answer is never
 * stored or sent: the server recomputes the summary per request
 * (workers/lib/thread-summary.ts). The card is only offered for a thread with
 * two or more messages, derived from the replies EmailPanel has already
 * loaded — with the replies still unknown there is nothing to offer.
 *
 * The summary is model output, so it renders as plain text only, never as
 * HTML, and an error shows the server's own message verbatim.
 */
export default function ThreadSummaryCard({
	mailboxId,
	threadId,
	messageCount,
}: ThreadSummaryCardProps) {
	// The request is keyed by thread id, so switching threads derives the
	// button back instead of being reset from an effect.
	const [requestedThreadId, setRequestedThreadId] = useState<string | null>(null);
	const requested = requestedThreadId !== null && requestedThreadId === threadId;
	const {
		data: summary,
		error,
		isFetching,
		refetch,
	} = useThreadSummary(mailboxId, threadId, { enabled: requested });

	// A single message is not a thread, and an unknown thread has nothing to
	// summarize: both hide the card entirely.
	if (!mailboxId || !threadId || messageCount < 2) return null;

	const handleSummarize = () => {
		if (isFetching) return;
		if (requested) {
			void refetch();
		} else {
			setRequestedThreadId(threadId);
		}
	};

	return (
		<div className="border-b border-kumo-line bg-kumo-base px-4 py-3 md:px-6">
			<div className="flex flex-wrap items-center gap-2">
				<SparkleIcon size={14} weight="duotone" className="shrink-0 text-kumo-subtle" />
				<span className="text-xs font-medium text-kumo-default">Thread summary</span>
				<Button
					variant="secondary"
					size="xs"
					loading={isFetching}
					onClick={handleSummarize}
				>
					{isFetching ? "Summarizing…" : summary ? "Summarize again" : "Summarize thread"}
				</Button>
			</div>
			{error && (
				<p className="mt-2 text-xs text-kumo-danger">
					{error instanceof Error ? error.message : "Something went wrong."}
				</p>
			)}
			{summary && (
				<div className="mt-2">
					<p className="whitespace-pre-wrap text-sm text-kumo-default">{summary.text}</p>
					<p className="mt-1.5 text-xs text-kumo-subtle">
						Based on {summary.message_count} message
						{summary.message_count === 1 ? "" : "s"}
						{summary.truncated ? " — older messages were trimmed to fit" : ""}
					</p>
				</div>
			)}
		</div>
	);
}
