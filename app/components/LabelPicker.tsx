// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, Loader } from "@cloudflare/kumo";
import {
	CheckSquareIcon,
	PlusIcon,
	SquareIcon,
	TagIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Label } from "~/services/api";
import { useCreateLabel, useLabels } from "~/queries/labels";

/** Swatches offered for a new label — the app theme's Tailwind palette. */
const LABEL_COLOR_SWATCHES = [
	{ name: "Blue", value: "#2563eb" },
	{ name: "Green", value: "#16a34a" },
	{ name: "Amber", value: "#d97706" },
	{ name: "Red", value: "#dc2626" },
	{ name: "Violet", value: "#7c3aed" },
	{ name: "Teal", value: "#0d9488" },
] as const;

interface LabelPickerProps {
	/** Mailbox whose labels are listed; undefined disables the trigger. */
	mailboxId: string | undefined;
	/** The message's current labels, which drive each row's checked state. */
	attached: Label[];
	/** Attach (true) or detach (false) one label. The panel runs it. */
	onToggle: (label: Label, attached: boolean) => void;
	/** The label id with an attach/detach in flight, if any. */
	pendingLabelId?: string | null | undefined;
	/** Disables the trigger, e.g. while the panel has no mailbox. */
	disabled?: boolean | undefined;
}

/**
 * The message panel's label picker: a dropdown listing the mailbox's labels
 * with a toggle per label and a small create field (name plus an optional
 * colour from the palette). Toggling a label never sends mail and never
 * touches the message itself.
 *
 * The list is fetched once the picker opens, so an untouched panel never
 * calls the labels API; until the labels routes exist on this branch the
 * fetch answers 404 and the popover shows an error line with a retry
 * instead of the list.
 */
export default function LabelPicker({
	mailboxId,
	attached,
	onToggle,
	pendingLabelId,
	disabled,
}: LabelPickerProps) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [color, setColor] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const nameRef = useRef<HTMLInputElement>(null);
	const firstRowRef = useRef<HTMLButtonElement>(null);

	const labels = useLabels(mailboxId, { enabled: open });
	const createLabel = useCreateLabel();

	const all = labels.data?.labels ?? [];
	const attachedIds = new Set(attached.map((label) => label.id));
	const canCreate = name.trim().length > 0 && !createLabel.isPending;

	// Outside click closes, like the composer's other dropdowns.
	useEffect(() => {
		if (!open) return;
		const handler = (event: MouseEvent) => {
			if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	// The name field takes focus as the list opens, so a label can be typed
	// and created without touching the mouse.
	useEffect(() => {
		if (open) requestAnimationFrame(() => nameRef.current?.focus());
	}, [open]);

	const close = () => {
		setOpen(false);
		setName("");
		setColor(null);
		setFailure(null);
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			// Closes the picker only, not the message panel around it.
			event.preventDefault();
			event.stopPropagation();
			close();
		}
	};

	const handleCreate = async () => {
		const trimmed = name.trim();
		if (!mailboxId || !trimmed || createLabel.isPending) return;
		setFailure(null);
		try {
			await createLabel.mutateAsync({
				mailboxId,
				label: { name: trimmed, ...(color ? { color } : {}) },
			});
			setName("");
			setColor(null);
		} catch (err) {
			setFailure(
				(err instanceof Error ? err.message : null) ||
					"Could not create the label.",
			);
		}
	};

	const handleNameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			void handleCreate();
			return;
		}
		if (event.key === "ArrowDown") {
			event.preventDefault();
			firstRowRef.current?.focus();
		}
	};

	return (
		<div ref={containerRef} className="relative" onKeyDown={handleKeyDown}>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				icon={<TagIcon size={16} />}
				onClick={() => {
					if (open) close();
					else setOpen(true);
				}}
				disabled={disabled}
				aria-expanded={open}
				aria-label="Labels"
			>
				Labels
			</Button>
			{open && (
				<div className="absolute top-full left-0 z-50 mt-1 w-64 rounded-lg border border-kumo-line bg-kumo-elevated shadow-lg">
					<div className="px-3 py-2 text-xs font-medium text-kumo-subtle">
						Labels
					</div>
					<div
						role="group"
						aria-label="Labels"
						className="max-h-64 overflow-y-auto border-t border-kumo-line"
					>
						{labels.isLoading ? (
							<div className="flex items-center justify-center py-4">
								<Loader size="sm" />
							</div>
						) : labels.isError ? (
							<div className="px-3 py-3">
								<p className="text-xs text-kumo-danger">
									Could not load labels.
								</p>
								<Button
									variant="secondary"
									size="sm"
									className="mt-2"
									onClick={() => {
										void labels.refetch();
									}}
								>
									Retry
								</Button>
							</div>
						) : all.length === 0 ? (
							<p className="px-3 py-3 text-xs text-kumo-subtle">
								No labels yet — create one below.
							</p>
						) : (
							all.map((label, index) => {
								const isAttached = attachedIds.has(label.id);
								return (
									<button
										key={label.id}
										ref={index === 0 ? firstRowRef : undefined}
										type="button"
										aria-pressed={isAttached}
										disabled={pendingLabelId === label.id}
										className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-kumo-default transition-colors hover:bg-kumo-overlay disabled:opacity-40"
										onClick={() => onToggle(label, isAttached)}
									>
										{isAttached ? (
											<CheckSquareIcon size={14} weight="bold" className="shrink-0 text-kumo-brand" />
										) : (
											<SquareIcon size={14} className="shrink-0 text-kumo-subtle" />
										)}
										{label.color && (
											<span
												aria-hidden="true"
												className="h-2.5 w-2.5 shrink-0 rounded-full"
												style={{ backgroundColor: label.color }}
											/>
										)}
										<span className="min-w-0 flex-1 truncate">{label.name}</span>
									</button>
								);
							})
						)}
					</div>
					{failure && (
						<p className="border-t border-kumo-line px-3 py-2 text-xs text-kumo-danger">
							{failure}
						</p>
					)}
					<div className="border-t border-kumo-line p-2">
						<Input
							ref={nameRef}
							type="text"
							size="sm"
							placeholder="New label name"
							aria-label="New label name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							onKeyDown={handleNameKeyDown}
						/>
						<div className="mt-2 flex items-center justify-between gap-2">
							<div className="flex items-center gap-1.5" role="group" aria-label="Label colour">
								{LABEL_COLOR_SWATCHES.map((swatch) => (
									<button
										key={swatch.value}
										type="button"
										aria-label={`Colour ${swatch.name}`}
										aria-pressed={color === swatch.value}
										className={`h-4 w-4 rounded-full border transition-colors ${
											color === swatch.value
												? "border-kumo-brand ring-1 ring-kumo-brand"
												: "border-kumo-line"
										}`}
										style={{ backgroundColor: swatch.value }}
										onClick={() =>
											setColor(color === swatch.value ? null : swatch.value)
										}
									/>
								))}
							</div>
							<Button
								type="button"
								variant="secondary"
								size="sm"
								icon={<PlusIcon size={14} />}
								disabled={!canCreate}
								onClick={() => {
									void handleCreate();
								}}
							>
								{createLabel.isPending ? "Adding..." : "Add"}
							</Button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
