// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useKumoToastManager } from "@cloudflare/kumo";
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { formatSnoozeTime, isPastOrInvalid } from "~/lib/snooze";
import {
	buildQuotedReplyBlock,
	escapeHtml,
	formatComposeDate,
	getSignatureBlock,
	htmlToPlainText,
	splitEmailList,
	stripHtml,
	toEmailListValue,
} from "~/lib/utils";
import {
	blobToBase64,
	createPendingAttachment,
	describeAttachmentSummary,
	pendingAttachmentFromStored,
	toAttachmentPayloads,
	validateAttachmentSelection,
	type PendingAttachment,
} from "~/lib/attachments";
import { useSaveDraft } from "~/queries/emails";
import { useMailbox } from "~/queries/mailboxes";
import { invalidateScheduledSends, useScheduleSend } from "~/queries/scheduled-sends";
import { useUIStore } from "~/hooks/useUIStore";
import api from "~/services/api";
import type { Attachment } from "~/types";

function appendUniqueAddress(
	addresses: string[],
	seen: Set<string>,
	address: string,
	exclude?: string,
) {
	const trimmed = address.trim();
	if (!trimmed) return;

	const normalized = trimmed.toLowerCase();
	if (normalized === exclude || seen.has(normalized)) return;

	seen.add(normalized);
	addresses.push(trimmed);
}

/**
 * How far ahead the composer queues a send. The gap is the Undo window: the
 * toast's Undo action cancels the queued row before the queue fires it.
 */
const SEND_QUEUE_DELAY_MS = 10_000;

interface ComposeFormFields {
	to: string;
	cc: string;
	bcc: string;
	showCcBcc: boolean;
	subject: string;
	body: string;
}

const EMPTY_FIELDS: ComposeFormFields = {
	to: "",
	cc: "",
	bcc: "",
	showCcBcc: false,
	subject: "",
	body: "",
};

function getPrefixedSubject(subject: string, prefix: "Re" | "Fwd") {
	const expectedPrefix = `${prefix}: `;
	return subject.startsWith(expectedPrefix)
		? subject
		: `${expectedPrefix}${subject}`;
}

function buildForwardBody(
	original: NonNullable<ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]>,
	sigBlock: string,
) {
	const safeSender = escapeHtml(original.sender);
	const safeSubject = escapeHtml(original.subject);
	const safeBody = escapeHtml(stripHtml(original.body || "")).replace(/\n/g, "<br>");

	return `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}<div style="border: 1px solid #ddd; padding: 1em; background-color: #f9f9f9; margin: 1em 0;"><strong>Forwarded message:</strong><br><strong>From:</strong> ${safeSender}<br><strong>Date:</strong> ${formatComposeDate(original.date)}<br><strong>Subject:</strong> ${safeSubject}<br><br>${safeBody}</div>`;
}

function buildReplyAllFields(
	original: NonNullable<ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]>,
	selfAddress?: string,
) {
	const toRecipients: string[] = [];
	const toSeen = new Set<string>();
	// Reply-To replaces the sender as the reply target when the message
	// sets it (mailing lists, ticketing systems); it may name several
	// addresses, so every one of them is added.
	for (const recipient of splitEmailList(original.reply_to?.trim() || original.sender)) {
		appendUniqueAddress(toRecipients, toSeen, recipient, selfAddress);
	}

	for (const recipient of splitEmailList(original.recipient)) {
		appendUniqueAddress(toRecipients, toSeen, recipient, selfAddress);
	}

	const ccRecipients: string[] = [];
	const ccSeen = new Set<string>();
	for (const recipient of splitEmailList(original.cc)) {
		const normalized = recipient.toLowerCase();
		if (
			normalized === selfAddress ||
			toSeen.has(normalized) ||
			ccSeen.has(normalized)
		) {
			continue;
		}
		ccSeen.add(normalized);
		ccRecipients.push(recipient);
	}

	return {
		to: toRecipients.join(", "),
		cc: ccRecipients.join(", "),
		showCcBcc: ccRecipients.length > 0,
	};
}

function buildInitialComposeFields(
	composeOptions: ReturnType<typeof useUIStore.getState>["composeOptions"],
	mailboxEmail: string | undefined,
	sigBlock: string,
): ComposeFormFields {
	const { draftEmail: draft, originalEmail: original, mode } = composeOptions;

	if (draft) {
		return {
			to: draft.recipient || "",
			cc: draft.cc || "",
			bcc: draft.bcc || "",
			showCcBcc: Boolean(draft.cc || draft.bcc),
			subject: draft.subject || "",
			body: draft.body || "",
		};
	}

	if (!original) {
		return {
			...EMPTY_FIELDS,
			// A fresh compose can arrive with its recipient and subject already
			// decided, e.g. the unsubscribe banner's mailto fallback.
			to: composeOptions.to ?? "",
			subject: composeOptions.subject ?? "",
			body: sigBlock ? `<p><br></p>${sigBlock}` : "",
		};
	}

	if (mode === "reply") {
		return {
			...EMPTY_FIELDS,
			to: original.reply_to?.trim() || original.sender,
			subject: getPrefixedSubject(original.subject, "Re"),
			body: `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}${buildQuotedReplyBlock(original.date, original.sender, original.body || "")}`,
		};
	}

	if (mode === "reply-all") {
		const recipients = buildReplyAllFields(original, mailboxEmail?.toLowerCase());
		return {
			...EMPTY_FIELDS,
			...recipients,
			subject: getPrefixedSubject(original.subject, "Re"),
			body: `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}${buildQuotedReplyBlock(original.date, original.sender, original.body || "")}`,
		};
	}

	if (mode === "forward") {
		return {
			...EMPTY_FIELDS,
			subject: getPrefixedSubject(original.subject, "Fwd"),
			body: buildForwardBody(original, sigBlock),
		};
	}

	return {
		...EMPTY_FIELDS,
		body: sigBlock ? `<p><br></p>${sigBlock}` : "",
	};
}

export function useComposeForm(mailboxId?: string) {
	const toastManager = useKumoToastManager();
	const { composeOptions, closePanel, closeCompose, setComposeDraft } = useUIStore();
	const { data: currentMailbox } = useMailbox(mailboxId);
	const saveDraftMutation = useSaveDraft();
	const scheduleSendMutation = useScheduleSend();
	const queryClient = useQueryClient();

	const [to, setTo] = useState("");
	const [cc, setCc] = useState("");
	const [bcc, setBcc] = useState("");
	const [showCcBcc, setShowCcBcc] = useState(false);
	const [subject, setSubject] = useState("");
	const [body, setBody] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSavingDraft, setIsSavingDraft] = useState(false);
	const [isScheduling, setIsScheduling] = useState(false);
	const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
	const [attachmentErrors, setAttachmentErrors] = useState<string[]>([]);
	const [isEncodingAttachments, setIsEncodingAttachments] = useState(false);
	const lastInitializedOptionsRef = useRef<typeof composeOptions | null>(null);
	// Id of the message whose stored attachments are already in `attachments`.
	// Guards the reload below so saving a draft does not re-download its files.
	const loadedAttachmentsForRef = useRef<string | null>(null);
	const isDraftEdit = !!composeOptions.draftEmail;

	const formTitle = useMemo(() => {
		if (isDraftEdit) return "Edit Draft";
		switch (composeOptions.mode) { case "reply": return "Reply"; case "reply-all": return "Reply All"; case "forward": return "Forward"; default: return "New Message"; }
	}, [composeOptions.mode, isDraftEdit]);

	const sigBlock = useMemo(() => getSignatureBlock(currentMailbox?.settings), [currentMailbox]);

	/**
	 * Why the scheduling affordances are unavailable, or null when they are
	 * usable. Rendered next to the buttons so the reason stays visible —
	 * queued sends never carry attachments, and a recipient and subject are
	 * required.
	 */
	const scheduleBlockReason = useMemo(() => {
		if (attachments.length > 0) {
			return "Scheduled sends don't support attachments — remove them to schedule this message.";
		}
		const missing: string[] = [];
		if (splitEmailList(to).length === 0) missing.push("a recipient");
		if (!subject.trim()) missing.push("a subject");
		if (missing.length === 0) return null;
		return `Add ${missing.join(" and ")} to schedule this send.`;
	}, [attachments, to, subject]);

	useEffect(() => {
		if (lastInitializedOptionsRef.current === composeOptions) return;
		lastInitializedOptionsRef.current = composeOptions;

		const initialFields = buildInitialComposeFields(
			composeOptions,
			currentMailbox?.email,
			sigBlock,
		);
		setError(null);
		setTo(initialFields.to);
		setCc(initialFields.cc);
		setBcc(initialFields.bcc);
		setShowCcBcc(initialFields.showCcBcc);
		setSubject(initialFields.subject);
		setBody(initialFields.body);
	}, [composeOptions, currentMailbox?.email, sigBlock]);


	/**
	 * Attachments the composer loads from the server: the draft's own files
	 * when editing a draft, or the original message's files when forwarding —
	 * so a re-opened draft, or a forward, keeps the files it was created with.
	 */
	const attachmentSource = useMemo(() => {
		const draft = composeOptions.draftEmail;
		if (draft) {
			return { key: draft.id, ownerId: draft.id, stored: draft.attachments ?? [] };
		}
		const original = composeOptions.originalEmail;
		if (composeOptions.mode === "forward" && original) {
			return { key: original.id, ownerId: original.id, stored: original.attachments ?? [] };
		}
		return { key: null, ownerId: null, stored: [] as Attachment[] };
	}, [composeOptions]);


	useEffect(() => {
		if (loadedAttachmentsForRef.current === attachmentSource.key) return;
		loadedAttachmentsForRef.current = attachmentSource.key;
		// A different compose session starts with a clean slate.
		setAttachments([]);
		setAttachmentErrors([]);
		const { ownerId, stored } = attachmentSource;
		// Inline parts belong to the body (cid: references), not to the file list.
		const files = stored.filter((attachment) => attachment.disposition !== "inline");
		if (!mailboxId || !ownerId || files.length === 0) return;


		let cancelled = false;
		void (async () => {
			setIsEncodingAttachments(true);
			const loaded: PendingAttachment[] = [];
			const failures: string[] = [];
			for (const file of files) {
				try {
					const blob = await api.getAttachment(mailboxId, ownerId, file.id);
					loaded.push(pendingAttachmentFromStored(file, await blobToBase64(blob)));
				} catch {
					failures.push(`Could not load "${file.filename}" — re-attach it before sending.`);
				}
			}
			if (cancelled) return;
			setAttachments(loaded);
			setAttachmentErrors(failures);
			setIsEncodingAttachments(false);
		})();
		return () => { cancelled = true; };
	}, [attachmentSource, mailboxId]);

	const handleAddAttachments = async (files: File[]) => {
		if (files.length === 0 || isEncodingAttachments) return;
		const picked = files.map((file) => ({
			file,
			candidate: {
				filename: file.name,
				type: file.type || "application/octet-stream",
				size: file.size,
			},
		}));
		const { accepted, errors } = validateAttachmentSelection(
			picked.map((entry) => entry.candidate),
			attachments,
		);
		setAttachmentErrors(errors);
		if (accepted.length === 0) return;


		setIsEncodingAttachments(true);
		try {
			const encoded: PendingAttachment[] = [];
			for (const entry of picked) {
				if (!accepted.includes(entry.candidate)) continue;
				const content = await blobToBase64(entry.file);
				encoded.push(
					createPendingAttachment(entry.candidate, content, crypto.randomUUID()),
				);
			}
			setAttachments((previous) => [...previous, ...encoded]);
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Could not read the selected file.";
			setAttachmentErrors((previous) => [...previous, message]);
		} finally {
			setIsEncodingAttachments(false);
		}
	};


	const handleRemoveAttachment = (id: string) => {
		setAttachments((previous) => previous.filter((attachment) => attachment.id !== id));
	};


	const handleSaveDraft = async () => {
		if (!mailboxId || isScheduling || isEncodingAttachments) return; setIsSavingDraft(true); setError(null);
		try {
			const inReplyTo =
				composeOptions.originalEmail?.id ||
				composeOptions.draftEmail?.in_reply_to ||
				null;
			const threadId =
				composeOptions.originalEmail?.thread_id ||
				composeOptions.draftEmail?.thread_id ||
				null;
			const saved = await saveDraftMutation.mutateAsync({ mailboxId, draft: {
				to,
				cc: cc || undefined,
				bcc: bcc || undefined,
				subject,
				body,
				attachments: toAttachmentPayloads(attachments),
				in_reply_to: inReplyTo || undefined,
				thread_id: threadId || undefined,
				draft_id: composeOptions.draftEmail?.id || undefined,
			} });
			// The pending files are already in memory and were just stored under
			// the new draft id, so mark it loaded instead of re-downloading them.
			loadedAttachmentsForRef.current = saved.id;
			// Remember the id returned by the server. Without this, a second
			// "Save as Draft" would send the id of the now-deleted draft and
			// fail validation.
			setComposeDraft({
				id: saved.id,
				subject,
				sender: mailboxId,
				recipient: to,
				date: new Date().toISOString(),
				read: true,
				starred: false,
				body,
				cc: cc || undefined,
				bcc: bcc || undefined,
				in_reply_to: inReplyTo,
				thread_id: threadId || saved.id,
				attachments: composeOptions.draftEmail?.attachments,
			});
			toastManager.add({ title: "Draft saved!" });
		}
		catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to save draft.";
			setError(message);
			toastManager.add({ title: message, variant: "error" });
		}
		finally { setIsSavingDraft(false); }
	};

	/**
	 * The message the queue will send, in the same shape a direct send used.
	 * Built when a handler runs, so the form state and the clock are read at
	 * click time — never during render.
	 */
	const buildOutgoingPayload = () => {
		const toRecipients = splitEmailList(to);
		const ccRecipients = splitEmailList(cc);
		const bccRecipients = splitEmailList(bcc);
		const fromName = currentMailbox?.settings?.fromName || currentMailbox?.name;
		const from =
			fromName && fromName !== currentMailbox?.email
				? { email: currentMailbox?.email, name: fromName }
				: currentMailbox?.email;
		const attachmentPayloads = toAttachmentPayloads(attachments);
		const inReplyTo =
			composeOptions.originalEmail?.id ||
			composeOptions.draftEmail?.in_reply_to ||
			undefined;
		const threadId =
			composeOptions.originalEmail?.thread_id ||
			composeOptions.draftEmail?.thread_id ||
			undefined;
		return {
			to: toEmailListValue(toRecipients),
			cc: toEmailListValue(ccRecipients),
			bcc: toEmailListValue(bccRecipients),
			from,
			subject,
			html: body,
			text: htmlToPlainText(body),
			...(attachmentPayloads.length > 0 ? { attachments: attachmentPayloads } : {}),
			// The queue owns the draft from here on, so its id travels with
			// the payload instead of the draft being deleted on send.
			...(composeOptions.draftEmail ? { draft_id: composeOptions.draftEmail.id } : {}),
			...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
			...(threadId ? { thread_id: threadId } : {}),
		};
	};

	/**
	 * Queue the composed message for `sendAt`. The composer no longer sends
	 * directly: the server's queue fires the message, and everything said
	 * about it says "scheduled" — never "sent" — until it actually has been.
	 *
	 * `toastTimeoutMs` keeps the Undo toast alive for the whole undo window
	 * when the queue is about to fire (the Send action); toasts otherwise
	 * dismiss at the provider's default.
	 */
	const queueMessage = async (
		sendAt: string,
		onClose: () => void,
		description: string,
		toastTimeoutMs?: number,
	) => {
		if (isScheduling) return;
		setError(null);
		if (isEncodingAttachments) { setError("Wait for the attachments to finish loading."); return; }
		if (!currentMailbox || !mailboxId) { setError("No mailbox selected."); return; }
		if (attachments.length > 0) {
			// Belt and braces: both affordances are already disabled, with a
			// visible reason, while the composer holds attachments.
			setError("Scheduled sends don't support attachments — remove them first.");
			return;
		}
		setIsScheduling(true);
		try {
			const scheduled = await scheduleSendMutation.mutateAsync({
				mailboxId,
				payload: buildOutgoingPayload(),
				sendAt,
			});
			// The manager's overloads widen the return to `any`; the id is a string.
			const toastId = toastManager.add({
				title: "Message scheduled",
				description,
				...(toastTimeoutMs !== undefined ? { timeout: toastTimeoutMs } : {}),
				actions: [
					{
						children: "Undo",
						variant: "secondary",
						size: "sm",
						// Cancels the queued send — from this explicit click only.
						onClick: () => {
							void api.cancelScheduledSend(mailboxId, scheduled.id)
								.then(() => {
									invalidateScheduledSends(queryClient, mailboxId);
									toastManager.close(toastId);
									toastManager.add({ title: "Scheduled send cancelled" });
								})
								.catch((err: unknown) => {
									toastManager.add({
										title: "Could not cancel the scheduled send",
										description: err instanceof Error ? err.message : "Something went wrong",
										variant: "error",
									});
								});
						},
					},
				],
			}) as string;
			onClose();
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to schedule the send.";
			setError(message);
			toastManager.add({ title: message, variant: "error" });
		}
		finally { setIsScheduling(false); }
	};

	/**
	 * The form's Send action. It no longer sends: the message is queued for
	 * ten seconds ahead, and the toast's Undo cancels it before it goes out.
	 */
	const handleSend = async (e: FormEvent, onClose: () => void) => {
		e.preventDefault();
		if (isScheduling) return;
		setError(null);
		if (!currentMailbox || !mailboxId) { setError("No mailbox selected."); return; }
		if (splitEmailList(to).length === 0) { setError("Add at least one recipient."); return; }
		const sendAt = new Date(Date.now() + SEND_QUEUE_DELAY_MS).toISOString();
		// The toast lives exactly as long as the undo window: once the queue
		// fires the send there is nothing left to cancel.
		await queueMessage(
			sendAt,
			onClose,
			"Sending in 10 seconds — Undo cancels it.",
			SEND_QUEUE_DELAY_MS,
		);
	};

	/** Queue the composed message for the instant picked in Send later. */
	const handleSendLater = async (iso: string, onClose: () => void) => {
		if (isScheduling) return;
		setError(null);
		if (isPastOrInvalid(iso)) { setError("Pick a time in the future."); return; }
		if (!currentMailbox || !mailboxId) { setError("No mailbox selected."); return; }
		if (splitEmailList(to).length === 0) { setError("Add at least one recipient."); return; }
		await queueMessage(iso, onClose, `Scheduled for ${formatSnoozeTime(iso)} — Undo cancels it.`);
	};

	return {
		to, setTo, cc, setCc, bcc, setBcc, showCcBcc, setShowCcBcc, subject, setSubject, body, setBody,
		error, setError, isSavingDraft, isScheduling, formTitle, handleSaveDraft, handleSend, handleSendLater,
		scheduleBlockReason, closeCompose, closePanel,
		attachments, attachmentErrors, attachmentSummary: describeAttachmentSummary(attachments),
		isEncodingAttachments, handleAddAttachments, handleRemoveAttachment,
	};
}
