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
import { ensureMessageBody } from "shared/compose-body";
import {
	blobToBase64,
	createPendingAttachment,
	DEFAULT_ATTACHMENT_TYPE,
	describeAttachmentSummary,
	describeLinkedAttachmentSummary,
	isLinkableAttachment,
	pendingAttachmentFromStored,
	toAttachmentPayloads,
	toLinkedAttachmentPayloads,
	validateAttachmentSelection,
	validateLinkedAttachmentSelection,
	type PendingAttachment,
} from "~/lib/attachments";
import { useDeleteEmail, useInvalidateEmailData, useSaveDraft, useSendEmail } from "~/queries/emails";
import { useMailbox } from "~/queries/mailboxes";
import { invalidateScheduledSends, useScheduleSend } from "~/queries/scheduled-sends";
import { useCreateTemplate } from "~/queries/templates";
import { useUIStore } from "~/hooks/useUIStore";
import api from "~/services/api";
import type { Attachment } from "~/types";
import type { Template } from "workers/lib/templates";

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

/** The blank paragraph every prefilled composer body starts with. */
const COMPOSE_LEAD_PARAGRAPH = "<p><br></p>";

/**
 * Insert a template's body into the composer's body: the snippet first,
 * then a blank paragraph, then whatever the composer already held. That is
 * the same join the signature and quoted-reply prefill uses; the composer's
 * own leading blank paragraph (its typing area) folds into the seam, so a
 * snippet lands above the signature — never below it.
 */
function insertTemplateIntoBody(current: string, templateBody: string): string {
	const snippet = templateBody.trim();
	if (!snippet) return current;
	const rest = current.trim().replace(/^<p><br><\/p>/, "");
	return rest ? `${snippet}${COMPOSE_LEAD_PARAGRAPH}${rest}` : snippet;
}

export function useComposeForm(mailboxId?: string) {
	const toastManager = useKumoToastManager();
	const { composeOptions, closePanel, closeCompose, setComposeDraft } = useUIStore();
	const { data: currentMailbox } = useMailbox(mailboxId);
	const saveDraftMutation = useSaveDraft();
	const scheduleSendMutation = useScheduleSend();
	const sendEmailMutation = useSendEmail();
	const deleteEmailMutation = useDeleteEmail();
	const createTemplateMutation = useCreateTemplate();
	const queryClient = useQueryClient();
	const invalidateEmails = useInvalidateEmailData();

	const [to, setTo] = useState("");
	const [cc, setCc] = useState("");
	const [bcc, setBcc] = useState("");
	const [showCcBcc, setShowCcBcc] = useState(false);
	const [subject, setSubject] = useState("");
	const [body, setBody] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSavingDraft, setIsSavingDraft] = useState(false);
	const [isScheduling, setIsScheduling] = useState(false);
	const [isSending, setIsSending] = useState(false);
	const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
	const [attachmentErrors, setAttachmentErrors] = useState<string[]>([]);
	const [linkedAttachments, setLinkedAttachments] = useState<PendingAttachment[]>([]);
	const [linkedAttachmentErrors, setLinkedAttachmentErrors] = useState<string[]>([]);
	const [isEncodingAttachments, setIsEncodingAttachments] = useState(false);
	const lastInitializedOptionsRef = useRef<typeof composeOptions | null>(null);
	// Id of the message whose stored attachments are already in `attachments`.
	// Guards the reload below so saving a draft does not re-download its files.
	const loadedAttachmentsForRef = useRef<string | null>(null);
	const isDraftEdit = !!composeOptions.draftEmail;
	// Files at or above LINK_THRESHOLD_BYTES are shared as download links —
	// only in a new message: the reply, forward and draft routes refuse
	// linked_attachments (workers/index.ts), so those surfaces keep every
	// file inside the message or refuse it.
	const canLinkAttachments = composeOptions.mode === "new" && !isDraftEdit;

	const formTitle = useMemo(() => {
		if (isDraftEdit) return "Edit Draft";
		switch (composeOptions.mode) { case "reply": return "Reply"; case "reply-all": return "Reply All"; case "forward": return "Forward"; default: return "New Message"; }
	}, [composeOptions.mode, isDraftEdit]);

	const sigBlock = useMemo(() => getSignatureBlock(currentMailbox?.settings), [currentMailbox]);

	/**
	 * Whether the message body carries any text. The send API requires a body
	 * (the Email Service binding builds the message from html/text), and an
	 * empty one is legitimate but rarely intended — so the first Send of an
	 * empty message warns and the second goes through.
	 */
	const bodyHasContent = useMemo(() => htmlToPlainText(body).trim().length > 0, [body]);

	/**
	 * The body the warning was shown for, or null. Comparing it against the
	 * live body is what clears the warning — writing a body is a different
	 * string — so no effect has to reset it.
	 */
	const [warnedBody, setWarnedBody] = useState<string | null>(null);

	/** The warning shown under the composer, or null when there is nothing to say. */
	const emptyBodyWarning = warnedBody !== null && warnedBody === body
		? "This message has no body — send it again to send it anyway."
		: null;

	/**
	 * Why the Send action is unavailable, or null when it can go ahead: a
	 * recipient and a subject are required. Files are not a blocker — the
	 * composer uploads them first and the queue carries them by id.
	 */
	const sendBlockReason = useMemo(() => {
		const missing: string[] = [];
		if (splitEmailList(to).length === 0) missing.push("a recipient");
		if (!subject.trim()) missing.push("a subject");
		if (missing.length === 0) return null;
		return `Add ${missing.join(" and ")} to send this message.`;
	}, [to, subject]);

	/**
	 * Why the scheduling affordances are unavailable, or null when they are
	 * usable. Rendered next to the buttons so the reason stays visible — a
	 * recipient and a subject are required. Files are not a blocker either:
	 * the composer uploads them first and the queue carries them by id.
	 */
	const scheduleBlockReason = useMemo(() => {
		const missing: string[] = [];
		if (splitEmailList(to).length === 0) missing.push("a recipient");
		if (!subject.trim()) missing.push("a subject");
		if (missing.length === 0) return null;
		return `Add ${missing.join(" and ")} to schedule this send.`;
	}, [to, subject]);

	useEffect(() => {
		if (lastInitializedOptionsRef.current === composeOptions) return;
		lastInitializedOptionsRef.current = composeOptions;

		const initialFields = buildInitialComposeFields(
			composeOptions,
			currentMailbox?.email,
			sigBlock,
		);
		setError(null);
		setWarnedBody(null);
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
		// Files at or above the threshold cannot travel in the message, so in a
		// new message they go to the linked list (stored in R2, shared as a
		// public download link). In a reply, a forward or a draft edit the
		// server refuses the field, so such a file is refused here — with the
		// usual over-the-cap message — rather than silently dropped.
		const linkable = canLinkAttachments
			? picked.filter((entry) => isLinkableAttachment(entry.candidate))
			: [];
		const inlinePicked = picked.filter((entry) => !linkable.includes(entry));
		const { accepted, errors } = validateAttachmentSelection(
			inlinePicked.map((entry) => entry.candidate),
			attachments,
		);
		const linkedResult = validateLinkedAttachmentSelection(
			linkable.map((entry) => entry.candidate),
			linkedAttachments,
		);
		setAttachmentErrors(errors);
		setLinkedAttachmentErrors(linkedResult.errors);
		if (accepted.length === 0 && linkedResult.accepted.length === 0) return;


		setIsEncodingAttachments(true);
		try {
			const encoded: PendingAttachment[] = [];
			const linkedEncoded: PendingAttachment[] = [];
			for (const entry of picked) {
				const isLinked = linkedResult.accepted.includes(entry.candidate);
				if (!accepted.includes(entry.candidate) && !isLinked) continue;
				const content = await blobToBase64(entry.file);
				const pending = createPendingAttachment(
					entry.candidate,
					content,
					crypto.randomUUID(),
				);
				if (isLinked) linkedEncoded.push(pending);
				else encoded.push(pending);
			}
			if (encoded.length > 0) {
				setAttachments((previous) => [...previous, ...encoded]);
			}
			if (linkedEncoded.length > 0) {
				setLinkedAttachments((previous) => [...previous, ...linkedEncoded]);
			}
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


	const handleRemoveLinkedAttachment = (id: string) => {
		setLinkedAttachments((previous) => previous.filter((attachment) => attachment.id !== id));
	};

	/**
	 * Insert a picked template into the draft. The body goes in at the top of
	 * the message (above the signature or the quoted reply); the template's
	 * subject is applied only when the composer's subject field is still
	 * empty, so an existing subject is never overwritten.
	 */
	const handleInsertTemplate = (template: Template) => {
		setBody((current) => insertTemplateIntoBody(current, template.body));
		const templateSubject = template.subject?.trim();
		if (templateSubject && !subject.trim()) setSubject(templateSubject);
	};

	/**
	 * Store the composer's current body as a new template. The name comes
	 * from a prompt; a cancelled prompt (or an empty name) saves nothing. The
	 * subject travels with the body so the snippet can set it on a later
	 * insert, and a failed write reports why instead of failing silently.
	 */
	const handleSaveTemplate = async () => {
		if (!mailboxId) {
			setError("No mailbox selected.");
			return;
		}
		const name = window.prompt("Name this template", subject.trim())?.trim();
		if (!name) return;
		try {
			await createTemplateMutation.mutateAsync({
				mailboxId,
				template: { name, subject: subject.trim() || undefined, body },
			});
			toastManager.add({ title: "Template saved" });
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to save the template.";
			setError(message);
			toastManager.add({ title: message, variant: "error" });
		}
	};

	/** True when the editor holds body text worth reusing as a template. */
	const canSaveTemplate = htmlToPlainText(body).trim().length > 0;


	const handleSaveDraft = async () => {
		if (!mailboxId || isScheduling || isEncodingAttachments) return;
		if (linkedAttachments.length > 0) {
			// Drafts refuse linked_attachments — a draft can be edited into a
			// reply or a forward, where links are not offered — so a draft save
			// would silently lose the links. Say so instead.
			setError("Linked files can't be saved in a draft — send this message instead.");
			return;
		}
		setIsSavingDraft(true); setError(null);
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
	const buildOutgoingPayload = (uploadIds: string[] = []) => {
		const toRecipients = splitEmailList(to);
		const ccRecipients = splitEmailList(cc);
		const bccRecipients = splitEmailList(bcc);
		const fromName = currentMailbox?.settings?.fromName || currentMailbox?.name;
		const from =
			fromName && fromName !== currentMailbox?.email
				? { email: currentMailbox?.email, name: fromName }
				: currentMailbox?.email;
		// Files ride the queue by id when they were uploaded first: their
		// bytes are already in R2 and the fire path resolves them from
		// `upload_ids`, so the queued payload must NOT carry them inline as
		// well. The queue route refuses a request with `attachments` outright
		// (it stores parameters, never bytes) and a payload carrying both
		// would deliver each file twice. The direct send path passes no ids,
		// so it keeps the inline payloads.
		const filesRideTheQueue = uploadIds.length > 0;
		const attachmentPayloads = filesRideTheQueue ? [] : toAttachmentPayloads(attachments);
		const linkedAttachmentPayloads = filesRideTheQueue
			? []
			: toLinkedAttachmentPayloads(linkedAttachments);
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
			...ensureMessageBody(body),
			...(attachmentPayloads.length > 0 ? { attachments: attachmentPayloads } : {}),
			// The linked bytes never travel in the message: the server stores
			// them in R2 and appends the download links to the body.
			...(linkedAttachmentPayloads.length > 0
				? { linked_attachments: linkedAttachmentPayloads }
				: {}),
			// The files themselves are already in R2 (uploadPendingFiles);
			// their ids travel here so the fire path can resolve them.
			...(uploadIds.length > 0 ? { upload_ids: uploadIds } : {}),
			// The queue owns the draft from here on, so its id travels with
			// the payload instead of the draft being deleted on send.
			...(composeOptions.draftEmail ? { draft_id: composeOptions.draftEmail.id } : {}),
			...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
			...(threadId ? { thread_id: threadId } : {}),
		};
	};

	/**
	 * Upload the composer's files so a queued send can carry them by id: the
	 * bytes go to R2 (POST .../uploads) and the queued payload stores only
	 * the ids. Returns the ids in file order, or null when an upload failed —
	 * the caller then falls back to the direct send path, and the ids already
	 * stored are dropped again. Each file is capped exactly like a direct
	 * send's, so a file the send route would refuse is refused here too.
	 */
	const uploadPendingFiles = async (): Promise<string[] | null> => {
		if (!mailboxId) return null;
		const files = [...attachments, ...linkedAttachments].filter(
			(file) => file.content.length > 0,
		);
		const ids: string[] = [];
		for (const file of files) {
			try {
				const uploaded = await api.uploadPendingFile(mailboxId, {
					content: file.content,
					filename: file.filename,
					type: file.type || DEFAULT_ATTACHMENT_TYPE,
				});
				ids.push(uploaded.id);
			} catch (err: unknown) {
				// Best-effort cleanup: uploads already stored are of no use
				// to a send that will not be queued from them.
				await Promise.allSettled(
					ids.map((id) => api.deletePendingUpload(mailboxId, id)),
				);
				const message = (err instanceof Error ? err.message : null) || "Could not upload the attachments.";
				setError(message);
				toastManager.add({ title: message, variant: "error" });
				return null;
			}
		}
		return ids;
	};

	/**
	 * Queue the composed message for `sendAt`. The composer no longer sends
	 * directly: the server's queue fires the message, and everything said
	 * about it says "scheduled" — never "sent" — until it actually has been.
	 *
	 * `uploadIds` are the composer's files, already uploaded; the stored
	 * payload carries their ids and the server resolves them to bytes when
	 * the send fires. `toastTimeoutMs` keeps the Undo toast alive for the
	 * whole undo window when the queue is about to fire (the Send action);
	 * toasts otherwise dismiss at the provider's default.
	 */
	const queueMessage = async (
		sendAt: string,
		onClose: () => void,
		description: string,
		toastTimeoutMs?: number,
		uploadIds: string[] = [],
	): Promise<boolean> => {
		if (isScheduling) return false;
		setError(null);
		if (isEncodingAttachments) { setError("Wait for the attachments to finish loading."); return false; }
		if (!currentMailbox || !mailboxId) { setError("No mailbox selected."); return false; }
		if ((attachments.length > 0 || linkedAttachments.length > 0) && uploadIds.length === 0) {
			// Belt and braces: the caller uploads the files first and passes
			// their ids — a queued payload without them would lose the files.
			setError("The attachments could not be uploaded — try sending again.");
			return false;
		}
		setIsScheduling(true);
		try {
			const scheduled = await scheduleSendMutation.mutateAsync({
				mailboxId,
				payload: buildOutgoingPayload(uploadIds),
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
						// The server saves the message back as a draft, so Undo
						// returns the message to Drafts instead of losing it.
						onClick: () => {
							void api.cancelScheduledSend(mailboxId, scheduled.id)
								.then(({ send }) => {
									invalidateScheduledSends(queryClient, mailboxId);
									// The Drafts folder just gained the cancelled
									// message, so refresh the email lists too.
									invalidateEmails(mailboxId);
									toastManager.close(toastId);
									toastManager.add({
										title: "Scheduled send cancelled",
										description: send.draft_id
											? "Saved to Drafts."
											: "The message could not be saved as a draft.",
									});
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
			return true;
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to schedule the send.";
			setError(message);
			toastManager.add({ title: message, variant: "error" });
			return false;
		}
		finally { setIsScheduling(false); }
	};

	/**
	 * The direct send path: the fallback for a message whose files could not
	 * be uploaded for the queue. The queue now carries files by id, so this
	 * path is only reached when an upload failed — and it stays exactly as it
	 * was, so a send is never blocked. There is no undo window here.
	 */
	const sendWithFiles = async (onClose: () => void) => {
		if (isSending) return;
		setError(null);
		if (isEncodingAttachments) { setError("Wait for the attachments to finish loading."); return; }
		if (!currentMailbox || !mailboxId) { setError("No mailbox selected."); return; }
		if (splitEmailList(to).length === 0) { setError("Add at least one recipient."); return; }
		setIsSending(true);
		toastManager.add({ title: "Sending email..." });
		try {
			await sendEmailMutation.mutateAsync({ mailboxId, email: buildOutgoingPayload() });
			// The sent draft is removed for good, not parked in Trash.
			const draftId = composeOptions.draftEmail?.id;
			if (draftId) deleteEmailMutation.mutate({ mailboxId, id: draftId, permanent: true });
			toastManager.add({ title: "Email sent!" });
			onClose();
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to send email.";
			setError(message);
			toastManager.add({ title: message, variant: "error" });
		}
		finally { setIsSending(false); }
	};

	/**
	 * The form's Send action. A message with no files is queued for ten
	 * seconds ahead and the toast's Undo cancels it before it goes out. A
	 * message carrying files uploads them first and then rides the same
	 * queue; an upload that fails falls back to the direct send path, so a
	 * send is never blocked.
	 */
	const handleSend = async (e: FormEvent, onClose: () => void) => {
		e.preventDefault();
		if (isScheduling || isSending) return;
		setError(null);
		if (!currentMailbox || !mailboxId) { setError("No mailbox selected."); return; }
		if (splitEmailList(to).length === 0) { setError("Add at least one recipient."); return; }
		if (!bodyHasContent && warnedBody !== body) { setWarnedBody(body); return; }
		const sendAt = new Date(Date.now() + SEND_QUEUE_DELAY_MS).toISOString();
		if (attachments.length > 0 || linkedAttachments.length > 0) {
			setIsSending(true);
			try {
				const uploadIds = await uploadPendingFiles();
				if (uploadIds !== null) {
					// The toast lives exactly as long as the undo window:
					// once the queue fires the send there is nothing left to
					// cancel.
					const queued = await queueMessage(
						sendAt,
						onClose,
						"Sending in 10 seconds — Undo cancels it.",
						SEND_QUEUE_DELAY_MS,
						uploadIds,
					);
					if (queued) return;
				}
			} finally {
				setIsSending(false);
			}
			// The files could not ride the queue (an upload or the queue
			// itself failed): fall back to the direct send path.
			await sendWithFiles(onClose);
			return;
		}
		// The toast lives exactly as long as the undo window: once the queue
		// fires the send there is nothing left to cancel.
		await queueMessage(
			sendAt,
			onClose,
			"Sending in 10 seconds — Undo cancels it.",
			SEND_QUEUE_DELAY_MS,
		);
	};

	/**
	 * Queue the composed message for the instant picked in Send later. Files
	 * are uploaded first, exactly like the Send action; an upload that fails
	 * reports the failure and queues nothing, because sending now would be
	 * the wrong message.
	 */
	const handleSendLater = async (iso: string, onClose: () => void) => {
		if (isScheduling) return;
		setError(null);
		if (isPastOrInvalid(iso)) { setError("Pick a time in the future."); return; }
		if (!currentMailbox || !mailboxId) { setError("No mailbox selected."); return; }
		if (splitEmailList(to).length === 0) { setError("Add at least one recipient."); return; }
		if (!bodyHasContent && warnedBody !== body) { setWarnedBody(body); return; }
		const description = `Scheduled for ${formatSnoozeTime(iso)} — Undo cancels it.`;
		if (attachments.length > 0 || linkedAttachments.length > 0) {
			setIsScheduling(true);
			try {
				const uploadIds = await uploadPendingFiles();
				if (uploadIds === null) return;
				await queueMessage(iso, onClose, description, undefined, uploadIds);
			} finally {
				setIsScheduling(false);
			}
			return;
		}
		await queueMessage(iso, onClose, description);
	};

	return {
		to, setTo, cc, setCc, bcc, setBcc, showCcBcc, setShowCcBcc, subject, setSubject, body, setBody,
		error, setError, isSavingDraft, isScheduling, isSending, formTitle, handleSaveDraft, handleSend, handleSendLater,
		sendBlockReason, scheduleBlockReason, emptyBodyWarning, closeCompose, closePanel,
		attachments, attachmentErrors, attachmentSummary: describeAttachmentSummary(attachments),
		linkedAttachments, linkedAttachmentErrors,
		linkedAttachmentSummary: describeLinkedAttachmentSummary(linkedAttachments),
		canLinkAttachments, handleRemoveLinkedAttachment,
		isEncodingAttachments, handleAddAttachments, handleRemoveAttachment,
		handleInsertTemplate, handleSaveTemplate, canSaveTemplate,
		isSavingTemplate: createTemplateMutation.isPending,
	};
}
