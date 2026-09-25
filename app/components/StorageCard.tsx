// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { Loader } from "@cloudflare/kumo";
import { HardDrivesIcon } from "@phosphor-icons/react";
import { useStorageUsage } from "~/queries/storage";


/**
 * Per-mailbox storage footprint: what the mailbox's SQLite database, its
 * stored attachments and its settings JSON currently occupy. Read-only and
 * informational — no limit is applied and nothing is cleaned up here.
 *
 * Every byte figure is rendered through formatBytes, so the card keeps one
 * unit convention throughout.
 */
export default function StorageCard({ mailboxId }: { mailboxId?: string | undefined }) {
	const { data: usage, isError } = useStorageUsage(mailboxId);

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-3">
				<HardDrivesIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">Storage</span>
			</div>
			<p className="text-xs text-kumo-subtle mb-4">
				What this mailbox currently occupies: its message database, stored
				attachments and settings. Reported for information only — nothing
				here is capped or deleted automatically.
			</p>
			{isError ? (
				<p className="text-xs text-kumo-subtle">
					Could not load storage usage. Reload the page to try again.
				</p>
			) : !usage ? (
				<div className="flex justify-center py-4">
					<Loader size="sm" aria-label="Loading storage usage" />
				</div>
			) : (
				<dl className="space-y-2">
					<StorageRow label="Messages" value={String(usage.email_count)} />
					<StorageRow
						label="Attachments"
						value={`${usage.attachment_count} · ${formatBytes(usage.attachment_bytes)}`}
					/>
					<StorageRow
						label="Mailbox settings"
						value={formatBytes(usage.mailbox_json_bytes)}
					/>
					<StorageRow
						label="Message database"
						value={formatBytes(usage.database_bytes)}
					/>
					<StorageRow
						label="Total"
						value={formatBytes(
							usage.database_bytes + usage.attachment_bytes + usage.mailbox_json_bytes,
						)}
						emphasis
					/>
				</dl>
			)}
		</div>
	);
}


/** One label/value line of the card; `emphasis` marks the Total line. */
function StorageRow({
	label,
	value,
	emphasis = false,
}: {
	label: string;
	value: string;
	emphasis?: boolean;
}) {
	return (
		<div
			className={`flex items-baseline justify-between gap-4 ${emphasis ? "border-t border-kumo-line pt-2" : ""}`}
		>
			<dt
				className={`text-sm ${emphasis ? "font-medium text-kumo-default" : "text-kumo-subtle"}`}
			>
				{label}
			</dt>
			<dd className="text-sm text-kumo-default">{value}</dd>
		</div>
	);
}


/**
 * The card's byte-formatting convention: binary units (1 KB = 1024 B), one
 * decimal place from KB up. Sub-kilobyte values stay whole bytes, so a
 * 47-byte settings file reads "47 B" rather than "47.0 B".
 */
function formatBytes(bytes: number): string {
	const units = ["B", "KB", "MB", "GB"] as const;
	let value = Math.max(0, bytes);
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const suffix = units[unit]!;
	return unit === 0 ? `${Math.round(value)} ${suffix}` : `${value.toFixed(1)} ${suffix}`;
}
