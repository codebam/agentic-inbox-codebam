// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { lazy, Suspense, type ReactNode } from "react";
import EmailPanel from "~/components/EmailPanel";

const ComposePanel = lazy(() => import("~/components/ComposePanel"));

function ComposePanelFallback() {
	return (
		<div className="flex h-full min-h-[240px] items-center justify-center p-4 text-xs text-kumo-subtle">
			Loading composer…
		</div>
	);
}

interface MailboxSplitViewProps {
	selectedEmailId: string | null;
	isComposing: boolean;
	/** Mailbox that owns the selected email. Defaults to the route param. */
	mailboxId?: string | undefined;
	children: ReactNode;
}

export default function MailboxSplitView({
	selectedEmailId,
	isComposing,
	mailboxId,
	children,
}: MailboxSplitViewProps) {
	const isPanelOpen = selectedEmailId !== null || isComposing;

	return (
		<div className="flex h-full">
			<div
				className={`flex flex-col min-w-0 shrink-0 ${
					isPanelOpen
						? "hidden md:flex md:w-[380px] md:border-r md:border-kumo-line"
						: "w-full"
				}`}
			>
				{children}
			</div>
			{isPanelOpen && (
				<div className="flex-1 flex flex-col min-w-0 overflow-hidden w-full md:w-auto">
					{isComposing && !selectedEmailId ? (
						<Suspense fallback={<ComposePanelFallback />}>
							<ComposePanel mailboxId={mailboxId} />
						</Suspense>
					) : isComposing && selectedEmailId ? (
						<div className="flex flex-col h-full overflow-y-auto">
							<Suspense fallback={<ComposePanelFallback />}>
								<ComposePanel mailboxId={mailboxId} />
							</Suspense>
							<div className="border-t border-kumo-line">
								<EmailPanel emailId={selectedEmailId} mailboxId={mailboxId} />
							</div>
						</div>
					) : selectedEmailId ? (
						<EmailPanel emailId={selectedEmailId} mailboxId={mailboxId} />
					) : null}
				</div>
			)}
		</div>
	);
}
