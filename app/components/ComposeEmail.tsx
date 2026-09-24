// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Banner, Button, Dialog, Input, Text } from "@cloudflare/kumo";
import { FloppyDiskIcon, PaperPlaneTiltIcon, PaperclipIcon } from "@phosphor-icons/react";
import { lazy, Suspense } from "react";
import { useParams } from "react-router";
import { useComposeForm } from "~/hooks/useComposeForm";
import { useUIStore } from "~/hooks/useUIStore";
import AttachmentPicker from "./AttachmentPicker";

const ComposeBodyEditor = lazy(() => import("./ComposeBodyEditor"));

export default function ComposeEmail() {
	const { mailboxId, folder } = useParams<{
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
		isSending,
		formTitle,
		handleSaveDraft,
		handleSend,
		attachments,
		attachmentErrors,
		attachmentSummary,
		isEncodingAttachments,
		handleAddAttachments,
		handleRemoveAttachment,
	} = useComposeForm(mailboxId, folder);

	return (
		<Dialog.Root
			open={isComposeModalOpen}
			onOpenChange={(open) => !open && !isSending && closeComposeModal()}
		>
			<Dialog size="lg" className="p-6 max-h-[85vh] overflow-y-auto">
				<Dialog.Title className="text-lg font-semibold mb-5">{formTitle}</Dialog.Title>
				<form onSubmit={(e) => handleSend(e, closeComposeModal)} className="space-y-4">
					<AttachmentPicker
						className="space-y-4"
						attachments={attachments}
						errors={attachmentErrors}
						isBusy={isEncodingAttachments}
						disabled={isSending || isSavingDraft}
						onAddFiles={handleAddAttachments}
						onRemove={handleRemoveAttachment}
					>
					{error && <Banner variant="error" text={error} />}
					<div className="flex items-center gap-2">
						<div className="flex-1">
							<Input
								label="To"
								type="text"
								placeholder="recipient@example.com, another@example.com"
								size="sm"
								value={to}
								onChange={(e) => setTo(e.target.value)}
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
						<Input
							label="CC"
							type="text"
							size="sm"
							value={cc}
							onChange={(e) => setCc(e.target.value)}
							placeholder="Separate multiple addresses with commas"
						/>
					)}
					{showCcBcc && (
						<Input
							label="BCC"
							type="text"
							size="sm"
							value={bcc}
							onChange={(e) => setBcc(e.target.value)}
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
					<div className="flex justify-between items-center gap-3 pt-2">
						<div className="flex items-center gap-3 min-w-0">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={closeComposeModal}
								disabled={isSending}
							>
								Discard
							</Button>
							{attachmentSummary && (
								<span className="flex items-center gap-1.5 text-xs text-kumo-subtle truncate">
									<PaperclipIcon size={14} className="shrink-0" />
									{attachmentSummary}
								</span>
							)}
						</div>
						<div className="flex items-center gap-2">
							<Button
								type="button"
								variant="secondary"
								size="sm"
								loading={isSavingDraft}
								disabled={isSending || isEncodingAttachments}
								icon={<FloppyDiskIcon size={14} />}
								onClick={handleSaveDraft}
							>
								{isSavingDraft ? "Saving..." : "Save as Draft"}
							</Button>
							<Button
								type="submit"
								variant="primary"
								size="sm"
								loading={isSending}
								disabled={isSavingDraft || isSending || isEncodingAttachments}
								icon={<PaperPlaneTiltIcon size={14} />}
							>
								{isSending ? "Sending..." : "Send"}
							</Button>
						</div>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}
