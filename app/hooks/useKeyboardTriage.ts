// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { useKumoToastManager } from "@cloudflare/kumo";
import { useCallback, useEffect, useRef, useState } from "react";
import { Folders } from "shared/folders";
import {
	SEARCH_INPUT_SELECTOR,
	SEARCH_TOGGLE_SELECTOR,
	resolveKeyAction,
	type TriageActionId,
} from "shared/keyboard";
import type { EmailSelection } from "~/hooks/useEmailSelection";
import { useUIStore } from "~/hooks/useUIStore";
import { snoozePresets } from "~/lib/snooze";
import {
	useBulkEmailAction,
	useDeleteEmail,
	useMoveEmail,
	useSnoozeEmail,
	useUpdateEmail,
} from "~/queries/emails";
import type { BulkEmailTarget, Email } from "~/types";


/** The slice of `useEmailSelection` the hook drives. */
export type KeyboardTriageSelection = Pick<
	EmailSelection,
	"selectedKeys" | "count" | "toggle" | "clear"
>;


export interface KeyboardTriageOptions {
	/** Rows of the current page, in display order. */
	emails: Email[];
	/** Mailbox that owns the rows; without it no mutation runs. */
	mailboxId?: string | undefined;
	/** Row the panel is showing — the "current" row for j/k, Enter/o, x, s, u. */
	currentEmailId: string | null;
	/** Selection state from `useEmailSelection`. */
	selection: KeyboardTriageSelection;
	/** Viewing Trash: the destructive action purges for good, as its button does. */
	isTrashFolder?: boolean;
	/** Compose session open: the composer owns the keyboard. */
	isComposing?: boolean;
	/**
	 * Owning mailbox for one row (All Accounts rows span mailboxes).
	 * Defaults to `mailboxId` for every row.
	 */
	mailboxIdForEmail?: ((email: Email) => string | undefined) | undefined;
	/**
	 * Selection key for one row (All Accounts keys are mailbox-scoped).
	 * Defaults to the row id.
	 */
	selectionKeyForEmail?: ((email: Email) => string) | undefined;
}


export interface KeyboardTriage {
	isCheatsheetOpen: boolean;
	openCheatsheet: () => void;
	closeCheatsheet: () => void;
	setCheatsheetOpen: (open: boolean) => void;
}


/**
 * Focus the list header's search input. On narrow layouts the input only
 * renders after the search toggle is pressed, so press it and retry for a
 * couple of frames.
 */
function focusSearchInput(): boolean {
	const input = document.querySelector<HTMLInputElement>(SEARCH_INPUT_SELECTOR);
	if (input) {
		input.focus();
		input.select();
		return true;
	}
	const toggles = document.querySelectorAll<HTMLElement>(SEARCH_TOGGLE_SELECTOR);
	const toggle = toggles[toggles.length - 1];
	if (!toggle) return false;
	toggle.click();
	let attempts = 3;
	const tryFocus = () => {
		const next = document.querySelector<HTMLInputElement>(SEARCH_INPUT_SELECTOR);
		if (next) {
			next.focus();
			return;
		}
		if (attempts-- > 0) requestAnimationFrame(tryFocus);
	};
	requestAnimationFrame(tryFocus);
	return true;
}


/**
 * Keyboard-first triage for the email list.
 *
 * The listener only decides *what* the key means (`shared/keyboard.ts`); every
 * action then goes through the same state and mutations the list UI already
 * uses: `useEmailSelection` for selection, `useBulkEmailAction` for a
 * multi-row action, and the single-row update/move/delete mutations behind the
 * row buttons. Reply, reply-all, forward and compose only open the composer —
 * a shortcut never sends.
 *
 * Wired into both list routes: the mailbox list (app/routes/email-list.tsx)
 * with one owning mailbox, and All Accounts (app/routes/all-accounts.tsx)
 * with per-row mailboxes via `mailboxIdForEmail` / `selectionKeyForEmail`.
 */
export function useKeyboardTriage(options: KeyboardTriageOptions): KeyboardTriage {
	const { selectEmail, startCompose, closePanel } = useUIStore();
	const updateEmail = useUpdateEmail();
	const moveEmail = useMoveEmail();
	const deleteEmail = useDeleteEmail();
	const snoozeEmail = useSnoozeEmail();
	const bulkAction = useBulkEmailAction();
	const toastManager = useKumoToastManager();
	const [isCheatsheetOpen, setCheatsheetOpen] = useState(false);


	// The window listener is attached once; refs carry the latest render values
	// into it so it never reads stale rows, selection or mutations. They are
	// refreshed after every commit — reading or writing a ref during render is
	// what React forbids, and the listener only ever runs after a commit.
	const latest = useRef(options);
	const actions = useRef({ selectEmail, startCompose, closePanel, updateEmail, moveEmail, deleteEmail, snoozeEmail, bulkAction, toastManager });
	useEffect(() => {
		latest.current = options;
		actions.current = { selectEmail, startCompose, closePanel, updateEmail, moveEmail, deleteEmail, snoozeEmail, bulkAction, toastManager };
	});


	const runAction = useCallback((action: TriageActionId): boolean => {
		const state = latest.current;
		const ui = actions.current;
		const { emails, mailboxId, currentEmailId, selection, isTrashFolder = false, mailboxIdForEmail, selectionKeyForEmail } = state;
		const currentEmail = emails.find((email) => email.id === currentEmailId) ?? null;
		const keyFor = (email: Email) => selectionKeyForEmail?.(email) ?? email.id;
		const mailboxFor = (email: Email) => mailboxIdForEmail?.(email) ?? mailboxId;
		const selectedEmails = emails.filter((email) => selection.selectedKeys.has(keyFor(email)));
		const targetsFor = (rows: Email[]): BulkEmailTarget[] =>
			rows.flatMap((email) => {
				const owner = mailboxFor(email);
				return owner
					? [{ mailboxId: owner, id: email.id, threadId: email.thread_id, threadCount: email.thread_count }]
					: [];
			});


		switch (action) {
			case "help": {
				setCheatsheetOpen(true);
				return true;
			}
			case "search": {
				return focusSearchInput();
			}
			case "compose": {
				ui.startCompose();
				return true;
			}
			case "next":
			case "previous": {
				if (emails.length === 0) return false;
				const delta = action === "next" ? 1 : -1;
				const currentIndex = emails.findIndex((email) => email.id === currentEmailId);
				// With nothing open, j starts at the top and k at the bottom.
				const nextIndex =
					currentIndex === -1
						? delta > 0
							? 0
							: emails.length - 1
						: Math.min(Math.max(currentIndex + delta, 0), emails.length - 1);
				const next = emails[nextIndex];
				if (!next || next.id === currentEmailId) return false;
				// Opening for reading only: j/k never marks mail read, `u` does.
				ui.selectEmail(next.id, mailboxFor(next));
				return true;
			}
			case "open": {
				if (!currentEmail) return false;
				ui.selectEmail(currentEmail.id, mailboxFor(currentEmail));
				return true;
			}
			case "select": {
				if (!currentEmail) return false;
				selection.toggle(keyFor(currentEmail));
				return true;
			}
			case "clear-selection": {
				if (selection.count === 0) return false;
				selection.clear();
				return true;
			}
			case "reply":
			case "reply-all":
			case "forward": {
				if (!currentEmail) return false;
				const mode = action === "reply" ? "reply" : action === "reply-all" ? "reply-all" : "forward";
				// Opens the composer only; nothing is sent from a shortcut.
				ui.startCompose({ mode, originalEmail: currentEmail });
				return true;
			}
			case "star": {
				if (selectedEmails.length > 0) {
					ui.bulkAction.mutate({ action: "star", targets: targetsFor(selectedEmails) });
					return true;
				}
				if (!currentEmail || !mailboxFor(currentEmail)) return false;
				ui.updateEmail.mutate({ mailboxId: mailboxFor(currentEmail) as string, id: currentEmail.id, data: { starred: !currentEmail.starred } });
				return true;
			}
			case "unread": {
				if (selectedEmails.length > 0) {
					ui.bulkAction.mutate({ action: "mark_unread", targets: targetsFor(selectedEmails) });
					return true;
				}
				if (!currentEmail || !mailboxFor(currentEmail)) return false;
				ui.updateEmail.mutate({ mailboxId: mailboxFor(currentEmail) as string, id: currentEmail.id, data: { read: !currentEmail.read } });
				return true;
			}
			case "archive": {
				if (selectedEmails.length > 0) {
					ui.bulkAction.mutate({
						action: "move",
						targets: targetsFor(selectedEmails),
						folderId: Folders.ARCHIVE,
					});
					return true;
				}
				if (!currentEmail || !mailboxFor(currentEmail)) return false;
				ui.moveEmail.mutate({ mailboxId: mailboxFor(currentEmail) as string, id: currentEmail.id, folderId: Folders.ARCHIVE });
				ui.closePanel();
				return true;
			}
			case "snooze": {
				// 'b' snoozes until tomorrow's canned wake time (the same
				// presets the row/panel Snooze menus offer) — a shortcut
				// never waits on a date picker.
				const until = snoozePresets()[1]?.until.toISOString();
				if (!until) return false;
				if (selectedEmails.length > 0) {
					for (const email of selectedEmails) {
						const owner = mailboxFor(email);
						if (owner) ui.snoozeEmail.mutate({ mailboxId: owner, id: email.id, until });
					}
					selection.clear();
					return true;
				}
				if (!currentEmail || !mailboxFor(currentEmail)) return false;
				ui.snoozeEmail.mutate({ mailboxId: mailboxFor(currentEmail) as string, id: currentEmail.id, until });
				ui.closePanel();
				return true;
			}
			case "trash": {
				if (!mailboxId && selectedEmails.length === 0 && (!currentEmail || !mailboxFor(currentEmail))) return false;
				// Same semantics as the buttons: a selection uses the toolbar's
				// trash-aware batch action, a single row uses the row's delete
				// (which purges for good when the row already lives in Trash).
				if (selectedEmails.length > 0) {
					const count = selectedEmails.length;
					const plural = count === 1 ? "" : "s";
					if (isTrashFolder) {
						if (!window.confirm(`Permanently delete ${count} email${plural}? This cannot be undone.`)) {
							return true;
						}
						ui.bulkAction.mutate(
							{ action: "delete", targets: targetsFor(selectedEmails) },
							{
								onSuccess: (results) => {
									const purged = (results ?? []).reduce((sum, result) => sum + (result?.purged ?? 0), 0);
									ui.toastManager.add({
										title: `Deleted ${purged} email${purged === 1 ? "" : "s"} forever`,
									});
									selection.clear();
								},
							},
						);
					} else {
						if (!window.confirm(`Move ${count} email${plural} to Trash?`)) return true;
						ui.bulkAction.mutate(
							{ action: "trash", targets: targetsFor(selectedEmails) },
							{
								onSuccess: (results) => {
									const trashed = (results ?? []).reduce((sum, result) => sum + (result?.trashed ?? 0), 0);
									ui.toastManager.add({
										title: `Moved ${trashed} email${trashed === 1 ? "" : "s"} to Trash`,
									});
									selection.clear();
								},
							},
						);
					}
					return true;
				}
				if (!currentEmail || !mailboxFor(currentEmail)) return false;
				const owner = mailboxFor(currentEmail) as string;
				const confirmed = window.confirm(
					isTrashFolder
						? "Delete this email forever? This cannot be undone."
						: "Move this email to Trash?",
				);
				if (!confirmed) return true;
				ui.deleteEmail.mutate(
					{ mailboxId: owner, id: currentEmail.id, permanent: isTrashFolder },
					{
						onSuccess: () =>
							ui.toastManager.add({
								title: isTrashFolder ? "Deleted forever" : "Moved to Trash",
							}),
					},
				);
				ui.closePanel();
				return true;
			}
			default:
				return false;
		}
	}, []);


	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const resolution = resolveKeyAction(event, {
				overlayOpen: isCheatsheetOpen,
				composerOpen: latest.current.isComposing ?? false,
			});
			if (resolution.type !== "action") return;
			// Only consume the key when the action actually ran; an unhandled
			// Enter/Escape keeps its existing meaning.
			if (runAction(resolution.action)) event.preventDefault();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [isCheatsheetOpen, runAction]);


	const openCheatsheet = useCallback(() => setCheatsheetOpen(true), []);
	const closeCheatsheet = useCallback(() => setCheatsheetOpen(false), []);


	return { isCheatsheetOpen, openCheatsheet, closeCheatsheet, setCheatsheetOpen };
}
