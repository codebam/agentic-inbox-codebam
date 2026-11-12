// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { Badge, Loader } from "@cloudflare/kumo";
import { HardDrivesIcon } from "@phosphor-icons/react";
import { useStorageUsage } from "~/queries/storage";


/**
 * Soft-quota thresholds for one mailbox's message database, in bytes.
 * Mirrors workers/lib/quota.ts (MAX_DATABASE_BYTES /
 * QUOTA_WARN_BYTES); duplicated here because the app bundle cannot
 * import from workers/ — keep the values in sync (800 MiB = 80% of
 * the 1 GB Free-plan DO ceiling, with headroom for WAL growth).
 */
const MAX_DATABASE_BYTES = 800 * 1024 * 1024;
const QUOTA_WARN_BYTES = Math.floor(MAX_DATABASE_BYTES * 0.8);


/**
 * Per-mailbox storage footprint: what the mailbox's SQLite database, its
 * stored attachments and its settings JSON currently occupy. Read-only and
 * informational — nothing is cleaned up here.
 *
 * When the message database is at or over the soft quota (see
 * workers/lib/quota.ts), new mail is refused server-side (503 +
 * Retry-After), so the card surfaces a warning banner: over quota is an
 * alert, approaching (80%) sits alongside the totals as a caution. Every
 * byte figure is rendered through formatBytes, so the card keeps one
 * unit convention throughout.
 */
export default function StorageCard({ mailboxId }: { mailboxId?: string | undefined }) {
	const { data: usage, isError } = useStorageUsage(mailboxId);
	const overQuota = !!usage && usage.database_bytes >= MAX_DATABASE_BYTES;
	const approachingQuota =
		!!usage && !overQuota && usage.database_bytes >= QUOTA_WARN_BYTES;

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-3">
				<HardDrivesIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">Storage</span>
				{overQuota && <Badge variant="red">Quota exceeded</Badge>}
				{approachingQuota && <Badge variant="secondary">Approaching quota</Badge>}
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
				<>
					{overQuota && (
						<div
							role="alert"
							className="mb-3 rounded-md border border-kumo-line bg-kumo-recessed px-3 py-2"
						>
							<p className="text-xs text-kumo-danger">
								Message database ({formatBytes(usage.database_bytes)}) is over the{" "}
								{formatBytes(MAX_DATABASE_BYTES)} limit. New mail is rejected until you
								delete mail to make room. Reads and deletes still work.
							</p>
						</div>
					)}
					{approachingQuota && (
						<div className="mb-3 rounded-md border border-kumo-line bg-kumo-recessed px-3 py-2">
							<p className="text-xs text-kumo-warning">
								Message database ({formatBytes(usage.database_bytes)}) is approaching
								the {formatBytes(MAX_DATABASE_BYTES)} limit. Delete mail soon to keep
								receiving new mail.
							</p>
						</div>
					)}
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
				</>
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
