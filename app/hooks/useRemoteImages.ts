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
	/**
	 * First-party image loads, by message id. A body's images are fetched by
	 * the page (see app/lib/body-images.ts) and the notice above the body
	 * reads this to say what is still loading and what failed.
	 */
	imageStates: Map<string, BodyImageState>;
	showImages: (emailId: string) => void;
	hideImages: (emailId: string) => void;
	setImageState: (emailId: string, state: BodyImageState) => void;
}

/** Loading progress of one message's body images. */
export interface BodyImageState {
	/** Images still being fetched first-party. */
	pending: number;
	/** Images that could not be loaded (refused, oversize, not an image). */
	failed: number;
}

export const useRemoteImagesStore = create<RemoteImagesState>((set) => ({
	shownMessageIds: new Set<string>(),
	imageStates: new Map<string, BodyImageState>(),
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
	setImageState: (emailId, imageState) =>
		set((state) => {
			const next = new Map(state.imageStates);
			next.set(emailId, imageState);
			return { imageStates: next };
		}),
}));

/** Stable empty state, so a selector never returns a fresh object per render. */
const NO_IMAGE_STATE: BodyImageState = { pending: 0, failed: 0 };

/** Loading progress of one message's body images; zeroed when nothing ran. */
export function useBodyImageState(
	emailId: string | null | undefined,
): BodyImageState {
	return (
		useRemoteImagesStore((state) =>
			emailId ? state.imageStates.get(emailId) : undefined,
		) ?? NO_IMAGE_STATE
	);
}

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
