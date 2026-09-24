// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { create } from "zustand";
import type { Email } from "~/types";

export type ComposeMode = "new" | "reply" | "reply-all" | "forward";

export interface ComposeOptions {
	mode: ComposeMode;
	originalEmail?: Email | null;
	/** When editing a draft, this holds the draft email to pre-fill the composer */
	draftEmail?: Email | null;
	/** Recipient and subject pre-filled on a fresh compose, e.g. an unsubscribe mailto. */
	to?: string | null;
	subject?: string | null;
	/**
	 * Mailbox that owns this compose session. The All Accounts view has no
	 * :mailboxId route param, so agent-created drafts pass their mailbox here.
	 */
	mailboxId?: string | null;
}

interface UIState {
	// Side panel state
	selectedEmailId: string | null;
	/** Mailbox that owns the selected email (set by the All Accounts view). */
	selectedMailboxId: string | null;
	isComposing: boolean;
	_previousEmailId: string | null;
	selectEmail: (id: string | null, mailboxId?: string | null) => void;
	startCompose: (options?: ComposeOptions) => void;
	closePanel: () => void;
	closeCompose: () => void;

	// Compose options
	composeOptions: ComposeOptions;

	// Mobile sidebar
	isSidebarOpen: boolean;
	openSidebar: () => void;
	closeSidebar: () => void;
	toggleSidebar: () => void;

	// Agent panel
	isAgentPanelOpen: boolean;
	toggleAgentPanel: () => void;

	// Legacy dialog support (kept for non-split views)
	isComposeModalOpen: boolean;
	openComposeModal: (options?: ComposeOptions) => void;
	/** Replace/attach the draft representing the current compose session. */
	setComposeDraft: (draft: Email | null) => void;
	closeComposeModal: () => void;
}

export const useUIStore = create<UIState>((set, get) => ({
	selectedEmailId: null,
	selectedMailboxId: null,
	isComposing: false,
	_previousEmailId: null,
	composeOptions: { mode: "new", originalEmail: null },
	isComposeModalOpen: false,
	isSidebarOpen: false,
	isAgentPanelOpen: true,

	selectEmail: (id, mailboxId) =>
		set((state) => ({
			selectedEmailId: id,
			// Keep the previously selected mailbox when callers only pass an
			// email id (mailbox routes); All Accounts passes the mailbox explicitly.
			selectedMailboxId: id ? (mailboxId ?? state.selectedMailboxId) : null,
			isComposing: false,
		})),

	startCompose: (options) =>
		set((state) => {
			const mode = options?.mode || "new";
			const isReplyOrForward = mode === "reply" || mode === "reply-all" || mode === "forward";
			// Prefer an explicitly supplied mailbox; otherwise derive it from the
			// original/draft email, then from whatever is already selected.
			const composeMailboxId =
				options?.mailboxId ??
				options?.originalEmail?.mailboxId ??
				options?.draftEmail?.mailboxId ??
				state.selectedMailboxId;
			// Draft editing in the All Accounts view needs the owning mailbox just
			// like a reply does, because there is no route param to fall back to.
			// An explicit mailboxId means the caller knows the owning mailbox
			// (the unsubscribe banner, whose panel has no route param there).
			const keepsSelection =
				isReplyOrForward ||
				Boolean(options?.draftEmail) ||
				Boolean(options?.mailboxId);
			return {
				isComposing: true,
				_previousEmailId: state.selectedEmailId,
				// Keep selectedEmailId when replying/forwarding so the thread stays visible
				selectedEmailId: isReplyOrForward ? state.selectedEmailId : null,
				selectedMailboxId: keepsSelection ? composeMailboxId : null,
				composeOptions: options || { mode: "new", originalEmail: null },
				isSidebarOpen: false,
			};
		}),

	closePanel: () => set({ selectedEmailId: null, selectedMailboxId: null, isComposing: false, _previousEmailId: null, composeOptions: { mode: "new" as const, originalEmail: null } }),

	closeCompose: () =>
		set((state) => ({
			isComposing: false,
			selectedEmailId: state._previousEmailId,
			_previousEmailId: null,
			composeOptions: { mode: "new" as const, originalEmail: null },
		})),

	openSidebar: () => set({ isSidebarOpen: true }),
	closeSidebar: () => set({ isSidebarOpen: false }),
	toggleSidebar: () => set({ isSidebarOpen: !get().isSidebarOpen }),

	toggleAgentPanel: () => set({ isAgentPanelOpen: !get().isAgentPanelOpen }),

	setComposeDraft: (draft) =>
		set((state) => ({
			composeOptions: { ...state.composeOptions, draftEmail: draft },
		})),

	openComposeModal: (options) =>
		set({
			composeOptions: options || { mode: "new", originalEmail: null },
			isComposeModalOpen: true,
		}),

	closeComposeModal: () =>
		set({
			isComposeModalOpen: false,
			composeOptions: { mode: "new", originalEmail: null },
		}),
}));
