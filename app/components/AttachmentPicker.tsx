// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { Button } from "@cloudflare/kumo";
import {
	FileIcon,
	ImageIcon,
	PaperclipIcon,
	XIcon,
} from "@phosphor-icons/react";
import {
	type ChangeEvent,
	type DragEvent,
	type ReactNode,
	useRef,
	useState,
} from "react";
import {
	formatFileSize,
	MAX_FILES,
	MAX_TOTAL_BYTES,
	type PendingAttachment,
} from "~/lib/attachments";


interface AttachmentPickerProps {
	attachments: PendingAttachment[];
	/** Inline messages for files that were rejected by the size/count limits. */
	errors: string[];
	/** True while files are being read — the composer disables Send meanwhile. */
	isBusy: boolean;
	disabled?: boolean;
	onAddFiles: (files: File[]) => void;
	onRemove: (id: string) => void;
	className?: string;
	children?: ReactNode;
}


const MAX_TOTAL_LABEL = formatFileSize(MAX_TOTAL_BYTES);


/**
 * Compose-surface attachment picker: an "Attach files" button, drag-and-drop
 * anywhere over `children`, the list of pending files and inline errors.
 *
 * Pending files live in `useComposeForm`; this component only renders them and
 * reports picks/removals, so the same state feeds the send and draft payloads.
 */
export default function AttachmentPicker({
	attachments,
	errors,
	isBusy,
	disabled = false,
	onAddFiles,
	onRemove,
	className,
	children,
}: AttachmentPickerProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const dragDepthRef = useRef(0);
	const [isDragging, setIsDragging] = useState(false);


	const carriesFiles = (event: DragEvent<HTMLDivElement>) =>
		Array.from(event.dataTransfer?.types ?? []).includes("Files");


	const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
		if (disabled || !carriesFiles(event)) return;
		event.preventDefault();
		dragDepthRef.current += 1;
		setIsDragging(true);
	};


	const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
		if (disabled || !carriesFiles(event)) return;
		// Required: without it the browser never fires the drop event.
		event.preventDefault();
	};


	const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
		if (disabled) return;
		event.preventDefault();
		// dragenter/dragleave fire for every nested element, so only clear the
		// highlight once the pointer has left the surface entirely.
		dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
		if (dragDepthRef.current === 0) setIsDragging(false);
	};


	const handleDrop = (event: DragEvent<HTMLDivElement>) => {
		if (disabled) return;
		event.preventDefault();
		dragDepthRef.current = 0;
		setIsDragging(false);
		const files = Array.from(event.dataTransfer?.files ?? []);
		if (files.length > 0) onAddFiles(files);
	};


	const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.target.files ?? []);
		// Reset so picking the same file twice still fires a change event.
		event.target.value = "";
		if (files.length > 0) onAddFiles(files);
	};


	return (
		<div
			className={[
				className ?? "",
				isDragging ? "ring-2 ring-kumo-brand ring-inset rounded-md" : "",
			].filter(Boolean).join(" ")}
			onDragEnter={handleDragEnter}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{children}


			<div className="space-y-2 pt-4">
				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="secondary"
						size="sm"
						loading={isBusy}
						disabled={disabled || isBusy}
						icon={<PaperclipIcon size={14} />}
						onClick={() => inputRef.current?.click()}
					>
						{isBusy ? "Attaching..." : "Attach files"}
					</Button>
					<span className="text-xs text-kumo-subtle">
						or drop files here · up to {MAX_FILES} files, {MAX_TOTAL_LABEL} total
					</span>
				</div>
				<input
					ref={inputRef}
					type="file"
					multiple
					className="hidden"
					onChange={handleInputChange}
					disabled={disabled}
					aria-label="Attach files"
				/>


				{attachments.length > 0 && (
					<div className="flex flex-wrap gap-2">
						{attachments.map((attachment) => (
							<div
								key={attachment.id}
								className="flex items-center gap-2 rounded-md border border-kumo-line px-3 py-2 text-sm"
							>
								{attachment.type.startsWith("image/") ? (
									<ImageIcon size={16} className="text-kumo-subtle shrink-0" />
								) : (
									<FileIcon size={16} className="text-kumo-subtle shrink-0" />
								)}
								<span className="text-kumo-default font-medium truncate max-w-[140px]">
									{attachment.filename}
								</span>
								<span className="text-kumo-subtle">
									{formatFileSize(attachment.size)}
								</span>
								<button
									type="button"
									onClick={() => onRemove(attachment.id)}
									disabled={disabled}
									aria-label={`Remove ${attachment.filename}`}
									className="text-kumo-subtle hover:text-kumo-default disabled:opacity-50"
								>
									<XIcon size={14} />
								</button>
							</div>
						))}
					</div>
				)}


				{errors.length > 0 && (
					<ul className="space-y-1">
						{errors.map((message) => (
							<li key={message} className="text-xs text-kumo-error">
								{message}
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
