// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useKumoToastManager } from "@cloudflare/kumo";
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { Folders } from "shared/folders";
import {
	SPAM_CATEGORY_ID,
	categoryLabel,
	mergeCategorizationCategories,
} from "shared/categories";
import { resolveDefaultEmailView } from "shared/email-view";
import ExplainPanel from "~/components/ExplainPanel";
import EmailPanelDialogs from "~/components/email-panel/EmailPanelDialogs";
import EmailPanelHeader from "~/components/email-panel/EmailPanelHeader";
import EmailPanelToolbar from "~/components/email-panel/EmailPanelToolbar";
import RemoteImagesNotice from "~/components/email-panel/RemoteImagesNotice";
import SingleMessageView from "~/components/email-panel/SingleMessageView";
import ThreadMessage from "~/components/email-panel/ThreadMessage";
import EmailViewToggle from "~/components/EmailViewToggle";
import SenderPolicyActions from "~/components/SenderPolicyActions";
import {
	blobToBase64,
	pendingAttachmentFromStored,
	toAttachmentPayloads,
} from "~/lib/attachments";
import { getNonInlineAttachments, splitEmailList, toEmailListValue } from "~/lib/utils";
import { useSessionEmailViewMode, setSessionEmailViewMode } from "~/lib/email-view-mode";
import { formatSnoozeTime, SNOOZE_FOLDER_ID } from "~/lib/snooze";
import api from "~/services/api";
import { useClearReminder, useDeleteEmail, useEmail, useMoveEmail, useReplyToEmail, useRestoreEmail, useSendEmail, useSetReminder, useSnoozeEmail, useThreadReplies, useUnsnoozeEmail, useUpdateEmail } from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import { useMailbox } from "~/queries/mailboxes";
import { useGlobalCategorization } from "~/queries/categorization";
import { useGlobalEmailView } from "~/queries/email-view";
import { useUIStore } from "~/hooks/useUIStore";
import type { Email, Folder, Mailbox } from "~/types";

function EmailPanelSkeleton() {
	return (
		<div className="animate-pulse p-5 space-y-4">
			<div className="h-5 w-2/3 rounded bg-kumo-fill" />
			<div className="flex items-center gap-3"><div className="w-10 h-10 rounded-full bg-kumo-fill" /><div className="space-y-2 flex-1"><div className="h-3 w-40 rounded bg-kumo-fill" /><div className="h-2.5 w-24 rounded bg-kumo-fill" /></div></div>
			<div className="space-y-2 pt-4"><div className="h-2.5 w-full rounded bg-kumo-fill" /><div className="h-2.5 w-5/6 rounded bg-kumo-fill" /><div className="h-2.5 w-4/6 rounded bg-kumo-fill" /><div className="h-2.5 w-3/4 rounded bg-kumo-fill" /></div>
		</div>
	);
}

export default function EmailPanel({
	emailId,
	mailboxId: mailboxIdProp,
}: {
	emailId: string;
	/** Optional override used by the All Accounts view. Falls back to the route param. */
	mailboxId?: string | undefined;
}) {
	const params = useParams<{ mailboxId: string; folder: string }>();
	const mailboxId = mailboxIdProp ?? params.mailboxId;
	const folder = params.folder;
	const { data: email } = useEmail(mailboxId, emailId) as { data?: Email };
	const { data: threadRepliesRaw } = useThreadReplies(mailboxId, email?.thread_id) as {
		data?: Email[];
	};
	const updateEmail = useUpdateEmail();
	const deleteEmailMut = useDeleteEmail();
	const restoreEmailMut = useRestoreEmail();
	const moveEmailMut = useMoveEmail();
	const snoozeEmailMut = useSnoozeEmail();
	const unsnoozeEmailMut = useUnsnoozeEmail();
	const setReminderMut = useSetReminder();
	const clearReminderMut = useClearReminder();
	const sendEmailMut = useSendEmail();
	const replyMut = useReplyToEmail();
	const { data: folders = [] } = useFolders(mailboxId) as { data?: Folder[] };
	const { data: currentMailbox } = useMailbox(mailboxId) as {
		data?: Mailbox;
	};
	const { data: globalCategorization } = useGlobalCategorization();
	const { data: globalEmailView } = useGlobalEmailView();
	const sessionViewMode = useSessionEmailViewMode();
	const { closePanel, startCompose } = useUIStore();
	const toastManager = useKumoToastManager();
	const [isSending, setIsSending] = useState(false);
	const [sourceViewEmail, setSourceViewEmail] = useState<Email | null>(null);
	const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());
	const [previewImage, setPreviewImage] = useState<{ url: string; filename: string } | null>(null);
	// In the All Accounts view there is no folder route param, so fall back to
	// the selected email's own folder when deciding draft behaviour.
	const isDraftFolder =
		folder === Folders.DRAFT || email?.folder_id === Folders.DRAFT;
	// Same fallback for Trash: the panel is showing a trashed message, so
	// delete purges for good and Restore is offered instead.
	const isTrash =
		folder === Folders.TRASH || email?.folder_id === Folders.TRASH;
	// Snoozed messages live in their own folder; the panel closes when the
	// message moves out of the folder currently on screen.
	const isSnoozedFolder =
		folder === SNOOZE_FOLDER_ID || email?.folder_id === SNOOZE_FOLDER_ID;

	const threadReplies = useMemo(() => {
		if (!threadRepliesRaw || !email) return [];
		return threadRepliesRaw.filter((e) => e.id !== email.id);
	}, [threadRepliesRaw, email]);

	const allMessages = useMemo(() => {
		if (!email) return [];
		return [email, ...threadReplies].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
	}, [email, threadReplies]);

	// Reset expanded state only when the selected email changes, not on every refetch.
	// Using allMessages as a dependency would reset user expand/collapse state on background refetches.
	const currentEmailId = email?.id;
	const [expansionEmailId, setExpansionEmailId] = useState(currentEmailId);
	if (expansionEmailId !== currentEmailId) {
		setExpansionEmailId(currentEmailId);
		const first = allMessages[0];
		if (allMessages.length > 1 && first) setExpandedMessages(new Set([first.id]));
	}

	const toggleExpand = (msgId: string) => { setExpandedMessages((prev) => { const next = new Set(prev); if (next.has(msgId)) next.delete(msgId); else next.add(msgId); return next; }); };

	const draftMessageIds = useMemo(() => {
		const ids = new Set<string>();
		for (const msg of allMessages) { if (msg.folder_id === Folders.DRAFT) ids.add(msg.id); else if (isDraftFolder && msg.id === emailId) ids.add(msg.id); }
		return ids;
	}, [allMessages, isDraftFolder, emailId]);

	const lastReceivedMessage = useMemo(() => {
		const ce = currentMailbox?.email;
		const received = allMessages.filter((msg) => !draftMessageIds.has(msg.id) && msg.sender !== ce);
		if (received.length > 0) return received[0];
		const nonDrafts = allMessages.filter((msg) => !draftMessageIds.has(msg.id));
		return nonDrafts.length > 0 ? nonDrafts[0] : email;
	}, [allMessages, draftMessageIds, currentMailbox?.email, email]);

	const moveToFolders = useMemo(() => { const cur = folder || email?.folder_id; return folders.filter((f) => f.id !== cur && f.id !== SNOOZE_FOLDER_ID); }, [folders, folder, email?.folder_id]);

	const categoryNames = useMemo(
		() =>
			mergeCategorizationCategories(
				globalCategorization?.categories ?? [],
				currentMailbox?.settings?.categorization?.categories ?? [],
				currentMailbox?.settings?.categorization?.useGlobalCategories !== false,
			),
		[globalCategorization, currentMailbox?.settings?.categorization],
	);
	const category = email?.category
		? categoryLabel(email.category, categoryNames)
		: null;
	// The manual toggle wins for the session; otherwise the mailbox override,
	// then the app-wide default, then HTML.
	const viewMode =
		sessionViewMode ??
		resolveDefaultEmailView(currentMailbox?.settings, globalEmailView);

	if (!email) return <EmailPanelSkeleton />;

	const toggleStar = () => { if (mailboxId) updateEmail.mutate({ mailboxId, id: email.id, data: { starred: !email.starred } }); };
	const handleMove = (folderId: string) => { if (mailboxId) { moveEmailMut.mutate({ mailboxId, id: email.id, folderId }); closePanel(); } };
	const handleDelete = () => {
		if (!mailboxId) return;
		const confirmed = isTrash
			? window.confirm("Delete this email forever? This cannot be undone.")
			: window.confirm("Move this email to Trash?");
		if (!confirmed) return;
		deleteEmailMut.mutate(
			{ mailboxId, id: email.id, permanent: isTrash },
			{
				onSuccess: () =>
					toastManager.add({
						title: isTrash ? "Deleted forever" : "Moved to Trash",
					}),
			},
		);
		closePanel();
	};
	const handleRestore = () => {
		if (!mailboxId) return;
		restoreEmailMut.mutate(
			{ mailboxId, id: email.id },
			{
				onSuccess: () => toastManager.add({ title: "Restored to inbox" }),
			},
		);
		closePanel();
	};

	const handleSnooze = (untilIso: string) => {
		if (!mailboxId) return;
		snoozeEmailMut.mutate(
			{ mailboxId, id: email.id, until: untilIso },
			{
				onSuccess: () => {
					toastManager.add({
						title: `Snoozed until ${formatSnoozeTime(untilIso)}`,
					});
					// The message leaves the folder on screen unless that folder
					// is the snoozed list itself.
					if (!isSnoozedFolder) closePanel();
				},
				onError: (err) => {
					toastManager.add({
						title: err.message || "Could not snooze this message.",
						variant: "error",
					});
				},
			},
		);
	};

	const handleUnsnooze = () => {
		if (!mailboxId) return;
		unsnoozeEmailMut.mutate(
			{ mailboxId, id: email.id },
			{
				onSuccess: () => {
					toastManager.add({ title: "Unsnoozed" });
					// It wakes into its original folder, so leave the snoozed list.
					if (isSnoozedFolder) closePanel();
				},
				onError: (err) => {
					toastManager.add({
						title: err.message || "Could not unsnooze this message.",
						variant: "error",
					});
				},
			},
		);
	};

	const handleRemind = (atIso: string) => {
		if (!mailboxId) return;
		setReminderMut.mutate(
			{ mailboxId, id: email.id, at: atIso },
			{
				onSuccess: () =>
					toastManager.add({
						title: `Reminder set for ${formatSnoozeTime(atIso)}`,
					}),
				onError: (err) => {
					toastManager.add({
						title: err.message || "Could not set the reminder.",
						variant: "error",
					});
				},
			},
		);
	};

	/** Dismiss a fired nudge, or cancel a reminder that has not fired yet. */
	const handleDismissReminder = () => {
		if (!mailboxId) return;
		const wasFired = Boolean(email.reminded_at);
		clearReminderMut.mutate(
			{ mailboxId, id: email.id },
			{
				onSuccess: () =>
					toastManager.add({
						title: wasFired ? "Reminder dismissed" : "Reminder cleared",
					}),
				onError: (err) => {
					toastManager.add({
						title: err.message || "Could not clear the reminder.",
						variant: "error",
					});
				},
			},
		);
	};

	const handleEditDraft = (draftMsg?: Email) => {
		const target = draftMsg || email;
		if (target.in_reply_to) { startCompose({ mode: "reply", originalEmail: allMessages.find((msg) => msg.id === target.in_reply_to) ?? null, draftEmail: target }); }
		else { startCompose({ mode: "new", draftEmail: target }); }
	};

	const handleDeleteDraft = (draftMsg?: Email) => {
		const target = draftMsg || email;
		if (!mailboxId) return;
		if (!window.confirm("Discard this draft?")) return;
		// Discarding a draft is permanent — drafts are not moved to Trash.
		deleteEmailMut.mutate({ mailboxId, id: target.id, permanent: true });
		toastManager.add({ title: "Draft discarded" });
		if (target.id === emailId) closePanel();
	};

	const handleSendDraft = async (draftMsg?: Email) => {
		let target = draftMsg || email;
		if (!mailboxId || !currentMailbox) return;
		setIsSending(true);
		try {
			if (!target.recipient || !target.subject) {
				try {
					const fresh = await api.getEmail(mailboxId, target.id);
					if (fresh) target = fresh;
				} catch {
					// Keep the draft we already have when the refetch fails.
				}
			}
			if (!target.recipient) { toastManager.add({ title: "Cannot send: no recipient set on this draft.", variant: "error" }); return; }
			const toRecipients = splitEmailList(target.recipient);
			if (toRecipients.length === 0) { toastManager.add({ title: "Cannot send: no valid recipient set on this draft.", variant: "error" }); return; }
			const fromName = currentMailbox.settings?.fromName || currentMailbox.name;
			const from = fromName && fromName !== currentMailbox.email ? { email: currentMailbox.email, name: fromName } : currentMailbox.email;
			const originalEmail = target.in_reply_to ? allMessages.find((msg) => msg.id === target.in_reply_to) : undefined;
			// The draft's files live in R2; read them back so sending from here
			// keeps the attachments the composer saved with it.
			const storedAttachments = getNonInlineAttachments(target.attachments);
			const attachments = storedAttachments.length > 0
				? toAttachmentPayloads(await Promise.all(storedAttachments.map(async (attachment) =>
					pendingAttachmentFromStored(
						attachment,
						await blobToBase64(await api.getAttachment(mailboxId, target.id, attachment.id)),
					))))
				: [];
			const emailData = {
				to: toEmailListValue(toRecipients),
				cc: toEmailListValue(splitEmailList(target.cc)),
				bcc: toEmailListValue(splitEmailList(target.bcc)),
				from,
				subject: target.subject || "(no subject)",
				html: target.body || "",
				text: target.body ? target.body.replace(/<[^>]*>/g, "").trim() : "",
				attachments: attachments.length > 0 ? attachments : undefined,
			};
			if (originalEmail) await replyMut.mutateAsync({ mailboxId, emailId: originalEmail.id, email: emailData }); else await sendEmailMut.mutateAsync({ mailboxId, email: emailData });
			// The sent draft is removed for good, not parked in Trash.
			await deleteEmailMut.mutateAsync({ mailboxId, id: target.id, permanent: true });
			toastManager.add({ title: "Email sent!" });
			if (isDraftFolder) closePanel();
		} catch (err) {
			const message = (err instanceof Error ? err.message : null) || "Failed to send email.";
			toastManager.add({ title: message, variant: "error" });
		} finally { setIsSending(false); }
	};

	const hasThread = allMessages.length > 1;

	return (
		<div className="flex flex-col h-full">
			<EmailPanelToolbar
				email={email}
				mailboxId={mailboxId}
				isDraftFolder={isDraftFolder}
				isTrash={isTrash}
				isSending={isSending}
				moveToFolders={moveToFolders}
				onBack={closePanel}
				onSendDraft={() => { void handleSendDraft(); }}
				onEditDraft={() => handleEditDraft()}
				onReply={() =>
					startCompose({ mode: "reply", originalEmail: lastReceivedMessage ?? null })
				}
				onReplyAll={() =>
					startCompose({
						mode: "reply-all",
						originalEmail: lastReceivedMessage ?? null,
					})
				}
				onForward={() => startCompose({ mode: "forward", originalEmail: email })}
				onToggleStar={toggleStar}
				onToggleRead={() => {
					if (mailboxId) {
						updateEmail.mutate({
							mailboxId,
							id: email.id,
							data: { read: !email.read },
						});
					}
				}}
				onMove={handleMove}
				onViewSource={() => setSourceViewEmail(email)}
				onDelete={handleDelete}
				onRestore={handleRestore}
				onSnooze={handleSnooze}
				onUnsnooze={handleUnsnooze}
				onRemind={handleRemind}
				onDismissReminder={handleDismissReminder}
			/>

			<EmailPanelHeader
				subject={email.subject}
				messageCount={allMessages.length}
				showThreadCount={hasThread}
				categoryLabel={category}
				categoryConfidence={email.category_confidence}
				isSpam={email.category === SPAM_CATEGORY_ID}
			/>

			<div className="flex justify-end px-4 pt-3 md:px-6"><EmailViewToggle value={viewMode} onChange={setSessionEmailViewMode} /></div>


			<ExplainPanel email={email} categories={categoryNames} />
			{/* Remote images (tracking pixels) are blocked by default; this
			    notice is the opt-in. In a thread each message renders its own
			    notice, so the panel-level one would be a duplicate. */}
			{!hasThread && <RemoteImagesNotice email={email} mailboxId={mailboxId} />}
			<SenderPolicyActions email={email} mailboxId={mailboxId} />

			<div className="flex-1 overflow-y-auto">
				{hasThread ? (
					allMessages.map((msg, idx) => {
						const isDraft = draftMessageIds.has(msg.id);
						return (
							<ThreadMessage
								key={msg.id}
								email={msg}
								mailboxId={mailboxId}
								mailboxEmail={currentMailbox?.email}
								viewMode={viewMode}
								isLast={idx === allMessages.length - 1}
								isDraft={isDraft}
								isSending={isDraft ? isSending : false}
								isExpanded={expandedMessages.has(msg.id)}
								onToggleExpand={() => toggleExpand(msg.id)}
								onSendDraft={isDraft ? () => { void handleSendDraft(msg); } : undefined}
								onEditDraft={isDraft ? () => handleEditDraft(msg) : undefined}
								onDeleteDraft={isDraft ? () => handleDeleteDraft(msg) : undefined}
								onViewSource={() => setSourceViewEmail(msg)}
								onPreviewImage={(url, filename) =>
									setPreviewImage({ url, filename })
								}
							/>
						);
					})
				) : (
					<SingleMessageView
						email={email}
						mailboxId={mailboxId}
						viewMode={viewMode}
						onPreviewImage={(url, filename) =>
							setPreviewImage({ url, filename })
						}
					/>
				)}
			</div>

			<EmailPanelDialogs
				sourceViewEmail={sourceViewEmail}
				previewImage={previewImage}
				onCloseSource={() => setSourceViewEmail(null)}
				onClosePreview={() => setPreviewImage(null)}
			/>
		</div>
	);
}
