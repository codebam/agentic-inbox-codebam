// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, Loader } from "@cloudflare/kumo";
import {
	CheckSquareIcon,
	PencilSimpleIcon,
	PlusIcon,
	SquareIcon,
	TagIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Label } from "~/services/api";
import {
	useCreateLabel,
	useDeleteLabel,
	useLabels,
	useUpdateLabel,
} from "~/queries/labels";

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
 * with a toggle per label, managing actions on every row and a small create
 * field (name plus an optional colour from the palette).
 *
 * A rename turns the row into an input (Enter or Save commits, Escape backs
 * out of the edit only) and a delete asks for an inline confirmation first —
 * never a browser confirm — naming the fact that the label leaves every
 * message that carries it. Both are explicit row clicks, so neither can
 * toggle the label by accident. Toggling a label never sends mail and never
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
	/** The row being renamed, with the draft name its input holds. */
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editingName, setEditingName] = useState("");
	/** The row whose inline delete confirmation is showing, if any. */
	const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const nameRef = useRef<HTMLInputElement>(null);
	const editRef = useRef<HTMLInputElement>(null);
	const firstRowRef = useRef<HTMLButtonElement>(null);

	const labels = useLabels(mailboxId, { enabled: open });
	const createLabel = useCreateLabel();
	const updateLabel = useUpdateLabel();
	const deleteLabel = useDeleteLabel();

	const all = labels.data?.labels ?? [];
	const attachedIds = new Set(attached.map((label) => label.id));
	const canCreate = name.trim().length > 0 && !createLabel.isPending;

	const close = useCallback(() => {
		setOpen(false);
		setName("");
		setColor(null);
		setFailure(null);
		setEditingId(null);
		setEditingName("");
		setConfirmingDeleteId(null);
	}, []);

	// Outside click closes, like the composer's other dropdowns; a rename or
	// delete confirmation left open is dropped with it.
	useEffect(() => {
		if (!open) return;
		const handler = (event: MouseEvent) => {
			if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
				close();
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open, close]);

	// The name field takes focus as the list opens, so a label can be typed
	// and created without touching the mouse.
	useEffect(() => {
		if (open) requestAnimationFrame(() => nameRef.current?.focus());
	}, [open]);

	// The rename field takes focus the moment its row turns into an input.
	useEffect(() => {
		if (editingId) requestAnimationFrame(() => editRef.current?.focus());
	}, [editingId]);

	const startEdit = (label: Label) => {
		setEditingId(label.id);
		setEditingName(label.name);
		setConfirmingDeleteId(null);
	};

	const cancelEdit = () => {
		setEditingId(null);
		setEditingName("");
	};

	/** Enter or Save: an unchanged or whitespace-only name just cancels. */
	const handleRename = async (label: Label) => {
		const trimmed = editingName.trim();
		// A second Enter or Save while the first update is in flight is
		// ignored — the row leaves edit mode when the answer lands.
		if (updateLabel.isPending) return;
		if (!mailboxId || !trimmed || trimmed === label.name) {
			cancelEdit();
			return;
		}
		setFailure(null);
		try {
			await updateLabel.mutateAsync({
				mailboxId,
				labelId: label.id,
				patch: { name: trimmed },
			});
			cancelEdit();
		} catch (err) {
			// The row stays editable so a colliding name can be corrected
			// without reopening the picker.
			setFailure(
				(err instanceof Error ? err.message : null) ||
					"Could not rename the label.",
			);
		}
	};

	const handleEditKeyDown = (
		event: KeyboardEvent<HTMLInputElement>,
		label: Label,
	) => {
		if (event.key === "Enter") {
			event.preventDefault();
			void handleRename(label);
			return;
		}
		if (event.key === "Escape") {
			// Cancels the edit only: stopPropagation keeps the picker's own
			// Escape handler from closing the popover behind it.
			event.preventDefault();
			event.stopPropagation();
			cancelEdit();
		}
	};

	const handleDelete = async (label: Label) => {
		if (!mailboxId || deleteLabel.isPending) return;
		setFailure(null);
		try {
			await deleteLabel.mutateAsync({ mailboxId, labelId: label.id });
			setConfirmingDeleteId(null);
		} catch (err) {
			setFailure(
				(err instanceof Error ? err.message : null) ||
					"Could not delete the label.",
			);
		}
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Escape") return;
		// A rename in progress or an open delete confirmation consumes Escape
		// first, so one press never both backs out of that step and closes
		// the picker. (The edit input stops propagation itself; this is the
		// fallback for any other focus inside the row.)
		if (editingId !== null) {
			event.preventDefault();
			event.stopPropagation();
			cancelEdit();
			return;
		}
		if (confirmingDeleteId !== null) {
			event.preventDefault();
			event.stopPropagation();
			setConfirmingDeleteId(null);
			return;
		}
		// Closes the picker only, not the message panel around it.
		event.preventDefault();
		event.stopPropagation();
		close();
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
								const isEditing = editingId === label.id;
								const isConfirmingDelete = confirmingDeleteId === label.id;
								return (
									<div
										key={label.id}
										className="flex items-center gap-1 py-1.5 pr-1 pl-3 hover:bg-kumo-overlay"
									>
										{isConfirmingDelete ? (
											// Delete lives behind an inline confirmation, never a
											// browser dialog: the route drops the label from
											// every message that carries it.
											<div className="min-w-0 flex-1 py-0.5">
												<p className="text-xs text-kumo-default">
													Delete this label?
												</p>
												<p className="mt-0.5 text-[11px] leading-snug text-kumo-subtle">
													It will be removed from every message that
													carries it.
												</p>
												<div className="mt-1.5 flex items-center gap-1.5">
													<Button
														type="button"
														variant="destructive"
														size="sm"
														disabled={deleteLabel.isPending}
														onClick={() => {
															void handleDelete(label);
														}}
													>
														{deleteLabel.isPending
															? "Deleting..."
															: "Delete"}
													</Button>
													<Button
														type="button"
														variant="ghost"
														size="sm"
														onClick={() =>
															setConfirmingDeleteId(null)
														}
													>
														Cancel
													</Button>
												</div>
											</div>
										) : isEditing ? (
											<>
												<Input
													ref={editRef}
													type="text"
													size="sm"
													className="min-w-0 flex-1"
													aria-label={`Rename ${label.name}`}
													value={editingName}
													onChange={(event) =>
														setEditingName(event.target.value)
													}
													onKeyDown={(event) => {
														handleEditKeyDown(event, label);
													}}
												/>
												<Button
													type="button"
													variant="secondary"
													size="sm"
													disabled={updateLabel.isPending}
													onClick={() => {
														void handleRename(label);
													}}
												>
													{updateLabel.isPending ? "Saving..." : "Save"}
												</Button>
												<Button
													type="button"
													variant="ghost"
													size="sm"
													onClick={cancelEdit}
												>
													Cancel
												</Button>
											</>
										) : (
											<>
												<button
													ref={index === 0 ? firstRowRef : undefined}
													type="button"
													aria-pressed={isAttached}
													disabled={pendingLabelId === label.id}
													className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm text-kumo-default disabled:opacity-40"
													onClick={() => onToggle(label, isAttached)}
												>
													{isAttached ? (
														<CheckSquareIcon
															size={14}
															weight="bold"
															className="shrink-0 text-kumo-brand"
														/>
													) : (
														<SquareIcon
															size={14}
															className="shrink-0 text-kumo-subtle"
														/>
													)}
													{label.color && (
														<span
															aria-hidden="true"
															className="h-2.5 w-2.5 shrink-0 rounded-full"
															style={{ backgroundColor: label.color }}
														/>
													)}
													<span className="min-w-0 flex-1 truncate">
														{label.name}
													</span>
												</button>
												<Button
													type="button"
													variant="ghost"
													shape="square"
													size="sm"
													icon={<PencilSimpleIcon size={14} />}
													aria-label={`Rename label ${label.name}`}
													onClick={() => startEdit(label)}
												/>
												<Button
													type="button"
													variant="ghost"
													shape="square"
													size="sm"
													icon={<TrashIcon size={14} />}
													aria-label={`Delete label ${label.name}`}
													onClick={() => setConfirmingDeleteId(label.id)}
												/>
											</>
										)}
									</div>
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
