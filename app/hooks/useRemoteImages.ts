// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { create } from "zustand";
import { isSenderAllowlisted } from "shared/remote-images";
import { useMailbox } from "~/queries/mailboxes";

/**
 * Session-only memory of the messages whose remote images the user chose to
 * show. Deliberately in-memory: "Show images" must not survive a reload, and
 * the durable opt-in is the mailbox's `imageAllowlist` (settings JSON in R2).
 */
interface RemoteImagesState {
	shownMessageIds: Set<string>;
	showImages: (emailId: string) => void;
	hideImages: (emailId: string) => void;
}

export const useRemoteImagesStore = create<RemoteImagesState>((set) => ({
	shownMessageIds: new Set<string>(),
	showImages: (emailId) =>
		set((state) => {
			const next = new Set(state.shownMessageIds);
			next.add(emailId);
			return { shownMessageIds: next };
		}),
	hideImages: (emailId) =>
		set((state) => {
			const next = new Set(state.shownMessageIds);
			next.delete(emailId);
			return { shownMessageIds: next };
		}),
}));

/** True when this message's remote images were shown for the session. */
export function useImagesShownForMessage(
	emailId: string | null | undefined,
): boolean {
	return useRemoteImagesStore((state) =>
		emailId ? state.shownMessageIds.has(emailId) : false,
	);
}

/**
 * True when remote images may load for `email`: the user opted in for this
 * message during the session, or the sender is on the mailbox's allowlist.
 * Every EmailIframe in the message view resolves through this hook, so the
 * opt-in and the allowlist both re-render the body without a refetch.
 */
export function useRemoteImagesAllowed(
	email: { id: string; sender: string } | null | undefined,
	mailboxId: string | undefined,
): boolean {
	const { data: mailbox } = useMailbox(mailboxId);
	const shown = useImagesShownForMessage(email?.id);
	if (!email) return false;
	if (isSenderAllowlisted(email.sender, mailbox?.settings?.imageAllowlist)) {
		return true;
	}
	return shown;
}
