// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button } from "@cloudflare/kumo";
import { ArchiveIcon, EnvelopeSimpleIcon, XIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import { create } from "zustand";
import { Folders } from "shared/folders";
import { useUIStore } from "~/hooks/useUIStore";
import { resolveUnsubscribeTarget } from "~/lib/unsubscribe";
import { useMoveEmail, useUnsubscribeEmail } from "~/queries/emails";
import type { Email } from "~/types";

/**
 * Session-only memory of the unsubscribe banners the user dismissed. Kept in
 * memory like the remote-images opt-in: a dismissal should survive switching
 * messages and closing the panel, but not a reload.
 */
interface DismissedBannersState {
	dismissedEmailIds: Set<string>;
	dismiss: (emailId: string) => void;
}

const useDismissedBanners = create<DismissedBannersState>((set) => ({
	dismissedEmailIds: new Set<string>(),
	dismiss: (emailId) =>
		set((state) => {
			const next = new Set(state.dismissedEmailIds);
			next.add(emailId);
			return { dismissedEmailIds: next };
		}),
}));

interface UnsubscribeBannerProps {
	email: Email;
	mailboxId?: string | undefined;
}

/**
 * List-Unsubscribe affordance for the open message, driven by the stored
 * headers. `resolveUnsubscribeTarget` picks one of three cases:
 *  - one-click (https URL + RFC 8058 marker): an Unsubscribe button that
 *    POSTs — from an explicit click only, never on render or mount — then
 *    shows the unsubscribed state, or the failure and a manual link;
 *  - mailto only: opens the composer prefilled, the user presses Send;
 *  - https URL without the marker: a manual link in a new tab.
 *
 * Once `unsubscribed_at` is set the banner shows the unsubscribed state and
 * offers Archive instead. Dismissals last for the session.
 */
export default function UnsubscribeBanner({ email, mailboxId }: UnsubscribeBannerProps) {
	const unsubscribe = useUnsubscribeEmail();
	const moveEmail = useMoveEmail();
	const { startCompose } = useUIStore();
	const dismissed = useDismissedBanners((state) => state.dismissedEmailIds.has(email.id));
	const dismissBanner = useDismissedBanners((state) => state.dismiss);

	const target = useMemo(
		() => resolveUnsubscribeTarget(email.list_unsubscribe, email.list_unsubscribe_post),
		[email.list_unsubscribe, email.list_unsubscribe_post],
	);
	// A resolved POST means the message is unsubscribed, and the mutation also
	// carries the row the server returned. Trust both for this message until
	// the invalidation refetch lands so a successful POST never flashes the
	// button again; variables and data are checked against the message id
	// because the panel reuses this component across messages.
	const forThisEmail = unsubscribe.variables?.id === email.id;
	const freshRow = unsubscribe.data?.id === email.id ? unsubscribe.data : null;
	const unsubscribed =
		Boolean(email.unsubscribed_at ?? freshRow?.unsubscribed_at) ||
		(unsubscribe.isSuccess && forThisEmail);
	const pending = unsubscribe.isPending && forThisEmail;
	const failed = unsubscribe.isError && forThisEmail;

	if (dismissed) return null;
	if (!target && !unsubscribed) return null;

	const dismissButton = (
		<Button
			variant="ghost"
			shape="square"
			size="sm"
			icon={<XIcon size={14} />}
			aria-label="Dismiss unsubscribe notice"
			onClick={() => dismissBanner(email.id)}
			className="ml-auto shrink-0"
		/>
	);

	if (unsubscribed) {
		return (
			<div className="flex flex-wrap items-center gap-2 px-4 py-1.5 border-b border-kumo-line text-xs text-kumo-subtle md:px-6">
				<EnvelopeSimpleIcon size={14} className="shrink-0" />
				<span>Unsubscribed from this mailing list.</span>
				<Button
					variant="secondary"
					size="xs"
					icon={<ArchiveIcon size={14} />}
					loading={moveEmail.isPending}
					disabled={!mailboxId}
					onClick={() => {
						if (!mailboxId) return;
						moveEmail.mutate({ mailboxId, id: email.id, folderId: Folders.ARCHIVE });
					}}
				>
					Archive
				</Button>
				{dismissButton}
			</div>
		);
	}

	if (!target) return null;

	// A sender-controlled URL is never opened automatically — the user has to
	// click this link, which is why it opens in a new tab with no referrer.
	const manualLink = target.url ? (
		<a
			href={target.url}
			target="_blank"
			rel="noreferrer noopener"
			className="break-all text-kumo-link hover:text-kumo-link-hover"
		>
			{target.url}
		</a>
	) : null;

	if (target.method === "one_click") {
		return (
			<div className="flex flex-wrap items-center gap-2 px-4 py-1.5 border-b border-kumo-line text-xs text-kumo-subtle md:px-6">
				<EnvelopeSimpleIcon size={14} className="shrink-0" />
				{failed ? (
					<>
						<span className="text-kumo-danger">
							{unsubscribe.error instanceof Error
								? unsubscribe.error.message
								: "Could not unsubscribe."}
						</span>
						<span>Unsubscribe manually:</span>
						{manualLink}
					</>
				) : (
					<>
						<span>This mailing list supports one-click unsubscribe.</span>
						<Button
							variant="secondary"
							size="xs"
							loading={pending}
							disabled={!mailboxId}
							onClick={() => {
								if (!mailboxId) return;
								unsubscribe.mutate({ mailboxId, id: email.id });
							}}
						>
							Unsubscribe
						</Button>
					</>
				)}
				{dismissButton}
			</div>
		);
	}

	if (target.method === "mailto") {
		const address = target.address;
		return (
			<div className="flex flex-wrap items-center gap-2 px-4 py-1.5 border-b border-kumo-line text-xs text-kumo-subtle md:px-6">
				<EnvelopeSimpleIcon size={14} className="shrink-0" />
				<span>Unsubscribe by email — opens a pre-filled message for you to send.</span>
				<Button
					variant="secondary"
					size="xs"
					disabled={!mailboxId || !address}
					onClick={() => {
						if (!mailboxId || !address) return;
						startCompose({
							mode: "new",
							mailboxId,
							to: address,
							subject: "unsubscribe",
						});
					}}
				>
					Unsubscribe
				</Button>
				{dismissButton}
			</div>
		);
	}

	return (
		<div className="flex flex-wrap items-center gap-2 px-4 py-1.5 border-b border-kumo-line text-xs text-kumo-subtle md:px-6">
			<EnvelopeSimpleIcon size={14} className="shrink-0" />
			<span>Unsubscribe from this mailing list:</span>
			{manualLink}
			{dismissButton}
		</div>
	);
}
