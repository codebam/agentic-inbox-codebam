// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Banner, Button, Dialog, Input, Text } from "@cloudflare/kumo";
import { ClockIcon, FloppyDiskIcon, LinkIcon, PaperPlaneTiltIcon, PaperclipIcon } from "@phosphor-icons/react";
import { lazy, Suspense } from "react";
import { useParams } from "react-router";
import { useComposeForm } from "~/hooks/useComposeForm";
import { useUIStore } from "~/hooks/useUIStore";
import AttachmentPicker from "./AttachmentPicker";
import SnoozeMenu from "./email-panel/SnoozeMenu";
import RecipientField from "./RecipientField";

const ComposeBodyEditor = lazy(() => import("./ComposeBodyEditor"));

export default function ComposeEmail() {
	const { mailboxId } = useParams<{
		mailboxId: string;
		folder: string;
	}>();

	const { isComposeModalOpen, closeComposeModal } = useUIStore();

	const {
		to,
		setTo,
		cc,
		setCc,
		bcc,
		setBcc,
		showCcBcc,
		setShowCcBcc,
		subject,
		setSubject,
		body,
		setBody,
		error,
		isSavingDraft,
		isScheduling,
		formTitle,
		handleSaveDraft,
		handleSend,
		handleSendLater,
		scheduleBlockReason,
		attachments,
		attachmentErrors,
		attachmentSummary,
		linkedAttachments,
		linkedAttachmentErrors,
		linkedAttachmentSummary,
		handleRemoveLinkedAttachment,
		isEncodingAttachments,
		handleAddAttachments,
		handleRemoveAttachment,
	} = useComposeForm(mailboxId);

	return (
		<Dialog.Root
			open={isComposeModalOpen}
			onOpenChange={(open) => !open && !isScheduling && closeComposeModal()}
		>
			<Dialog size="lg" className="p-6 max-h-[85vh] overflow-y-auto">
				<Dialog.Title className="text-lg font-semibold mb-5">{formTitle}</Dialog.Title>
				<form onSubmit={(e) => { void handleSend(e, closeComposeModal); }} className="space-y-4">
					<AttachmentPicker
						className="space-y-4"
						attachments={attachments}
						errors={attachmentErrors}
						isBusy={isEncodingAttachments}
						disabled={isScheduling || isSavingDraft}
						onAddFiles={(files) => { void handleAddAttachments(files); }}
						onRemove={handleRemoveAttachment}
						linkedAttachments={linkedAttachments}
						linkedErrors={linkedAttachmentErrors}
						linkedSummary={linkedAttachmentSummary}
						onRemoveLinked={handleRemoveLinkedAttachment}
					>
					{error && <Banner variant="error" text={error} />}
					<div className="flex items-center gap-2">
						<div className="flex-1">
							<RecipientField
								label="To"
								mailboxId={mailboxId}
								value={to}
								onChange={setTo}
								placeholder="recipient@example.com, another@example.com"
								required
							/>
						</div>
						{!showCcBcc && (
							<button
								type="button"
								onClick={() => setShowCcBcc(true)}
								className="shrink-0 text-xs text-kumo-link hover:text-kumo-link-hover font-medium mt-5"
							>
								CC / BCC
							</button>
						)}
					</div>
					{showCcBcc && (
						<RecipientField
							label="CC"
							mailboxId={mailboxId}
							value={cc}
							onChange={setCc}
							placeholder="Separate multiple addresses with commas"
						/>
					)}
					{showCcBcc && (
						<RecipientField
							label="BCC"
							mailboxId={mailboxId}
							value={bcc}
							onChange={setBcc}
							placeholder="Separate multiple addresses with commas"
						/>
					)}
					<Input
						label="Subject"
						type="text"
						placeholder="Email subject"
						size="sm"
						value={subject}
						onChange={(e) => setSubject(e.target.value)}
						required
					/>
					<div>
						<Text size="sm" DANGEROUS_className="font-medium mb-1.5 block">
							Message
						</Text>
						<Suspense
							fallback={
								<div className="min-h-[180px] rounded-lg border border-kumo-line bg-kumo-recessed p-3 text-xs text-kumo-subtle">
									Loading editor…
								</div>
							}
						>
							<ComposeBodyEditor value={body} onChange={setBody} />
						</Suspense>
					</div>
					</AttachmentPicker>
					{scheduleBlockReason && (
						<p className="pt-2 text-xs text-kumo-subtle">{scheduleBlockReason}</p>
					)}
					<div className="flex justify-between items-center gap-3 pt-2">
						<div className="flex items-center gap-3 min-w-0">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={closeComposeModal}
								disabled={isScheduling}
							>
								Discard
							</Button>
							{attachmentSummary && (
								<span className="flex items-center gap-1.5 text-xs text-kumo-subtle truncate">
									<PaperclipIcon size={14} className="shrink-0" />
									{attachmentSummary}
								</span>
							)}
							{linkedAttachmentSummary && (
								<span className="flex items-center gap-1.5 text-xs text-kumo-subtle truncate">
									<LinkIcon size={14} className="shrink-0" />
									{linkedAttachmentSummary}
								</span>
							)}
						</div>
						<div className="flex items-center gap-2">
							<Button
								type="button"
								variant="secondary"
								size="sm"
								loading={isSavingDraft}
								disabled={isScheduling || isEncodingAttachments}
								icon={<FloppyDiskIcon size={14} />}
								onClick={() => { void handleSaveDraft(); }}
							>
								{isSavingDraft ? "Saving..." : "Save as Draft"}
							</Button>
							{/* Presets and a custom time, in local time; queued sends carry no
							    attachments, so the trigger is disabled with a visible reason. */}
							<SnoozeMenu
								label="Send later"
								header="Send later"
								icon={<ClockIcon size={14} />}
								triggerLabel="Send later"
								placement="up"
								disabled={
									isSavingDraft ||
									isScheduling ||
									isEncodingAttachments ||
									scheduleBlockReason !== null
								}
								onPick={(iso) => { void handleSendLater(iso, closeComposeModal); }}
							/>
							<Button
								type="submit"
								variant="primary"
								size="sm"
								loading={isScheduling}
								disabled={
									isSavingDraft ||
									isScheduling ||
									isEncodingAttachments ||
									scheduleBlockReason !== null
								}
								icon={<PaperPlaneTiltIcon size={14} />}
							>
								{isScheduling ? "Scheduling..." : "Send"}
							</Button>
						</div>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}
