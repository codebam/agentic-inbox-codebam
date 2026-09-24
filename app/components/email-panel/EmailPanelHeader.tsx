// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge } from "@cloudflare/kumo";

interface EmailPanelHeaderProps {
	subject: string;
	messageCount: number;
	showThreadCount: boolean;
	/** Jev-assigned category label, if this email has been classified. */
	categoryLabel?: string | null;
	categoryConfidence?: number | null | undefined;
	isSpam?: boolean;
}

export default function EmailPanelHeader({
	subject,
	messageCount,
	showThreadCount,
	categoryLabel,
	categoryConfidence,
	isSpam,
}: EmailPanelHeaderProps) {
	return (
		<div className="px-4 py-3 border-b border-kumo-line shrink-0 md:px-6">
			<div className="flex items-center gap-2">
				<h2 className="text-base font-semibold text-kumo-default">{subject}</h2>
				{categoryLabel && (
					<Badge variant={isSpam ? "red" : "secondary"} className="shrink-0">
						{categoryLabel}
					</Badge>
				)}
			</div>
			{showThreadCount && (
				<span className="text-xs text-kumo-subtle mt-0.5 block">
					{messageCount} messages in this thread
					{categoryConfidence != null &&
						` · categorized with ${Math.round(categoryConfidence * 100)}% confidence`}
				</span>
			)}
			{!showThreadCount && categoryConfidence != null && (
				<span className="text-xs text-kumo-subtle mt-0.5 block">
					Categorized with {Math.round(categoryConfidence * 100)}% confidence
				</span>
			)}
		</div>
	);
}
