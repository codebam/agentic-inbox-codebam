// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, Loader } from "@cloudflare/kumo";
import { PlusIcon, QuotesIcon, TrashIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Template } from "workers/lib/templates";
import { useDeleteTemplate, useTemplates } from "~/queries/templates";

interface TemplatePickerProps {
	/** Mailbox whose snippets are listed. */
	mailboxId: string | undefined;
	/** Insert the picked template's body into the composer. */
	onInsert: (template: Template) => void;
	/** Store the composer's current body as a new snippet. */
	onSave: () => void;
	/** False while the composer holds nothing worth saving. */
	canSave: boolean;
	/** True while a save is in flight. */
	isSaving: boolean;
	/** Disables the trigger, e.g. while the composer is already sending. */
	disabled?: boolean | undefined;
}

/** The subject line shown under the name, or a quiet placeholder. */
function subjectPreview(template: Template): string {
	return template.subject?.trim() || "No subject";
}

/**
 * The composer's snippet picker: a dropdown listing the mailbox's templates
 * with a filter box, a per-row delete, and "Save current draft as template".
 *
 * Picking a template only inserts its body — it never sends, never clears a
 * typed subject, and touches nothing else in the message. Every action is a
 * real button behind a keyboard-focusable trigger, so the affordance works
 * without a mouse: the filter takes focus when the list opens, Escape closes
 * it, and Tab/Enter reach and pick a row.
 */
export default function TemplatePicker({
	mailboxId,
	onInsert,
	onSave,
	canSave,
	isSaving,
	disabled,
}: TemplatePickerProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [failure, setFailure] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const filterRef = useRef<HTMLInputElement>(null);
	const firstRowRef = useRef<HTMLButtonElement>(null);

	// The list is only fetched once the picker opens, so an untouched
	// composer never calls the templates API.
	const templates = useTemplates(mailboxId, { enabled: open });
	const deleteTemplate = useDeleteTemplate();

	const all = templates.data?.templates ?? [];
	const term = query.trim().toLowerCase();
	const matches = term
		? all.filter(
				(template) =>
					template.name.toLowerCase().includes(term) ||
					(template.subject ?? "").toLowerCase().includes(term),
			)
		: all;

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

	// The filter takes focus as the list opens so it can be searched — and a
	// row reached with ArrowDown — without touching the mouse.
	useEffect(() => {
		if (open) requestAnimationFrame(() => filterRef.current?.focus());
	}, [open]);

	const close = () => {
		setOpen(false);
		setQuery("");
		setFailure(null);
	};

	const insert = (template: Template) => {
		onInsert(template);
		close();
	};

	const handleFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape") {
			// Closes the picker only, not the composer around it.
			event.preventDefault();
			event.stopPropagation();
			close();
			return;
		}
		if (event.key === "ArrowDown") {
			event.preventDefault();
			firstRowRef.current?.focus();
		}
	};

	const handleDelete = async (template: Template) => {
		if (!mailboxId) return;
		if (!window.confirm(`Delete the template "${template.name}"?`)) return;
		setFailure(null);
		try {
			await deleteTemplate.mutateAsync({ mailboxId, templateId: template.id });
		} catch (err: unknown) {
			setFailure(
				(err instanceof Error ? err.message : null) ||
					"Could not delete the template.",
			);
		}
	};

	return (
		<div ref={containerRef} className="relative">
			<Button
				type="button"
				variant="ghost"
				size="sm"
				icon={<QuotesIcon size={16} />}
				onClick={() => {
					if (open) close();
					else setOpen(true);
				}}
				disabled={disabled}
				aria-expanded={open}
				aria-label="Templates"
			>
				Templates
			</Button>
			{open && (
				<div className="absolute top-full right-0 z-50 mt-1 w-80 rounded-lg border border-kumo-line bg-kumo-elevated shadow-lg">
					<div className="px-3 py-2 text-xs font-medium text-kumo-subtle">
						Templates
					</div>
					<div className="border-t border-kumo-line px-3 py-2">
						<Input
							ref={filterRef}
							type="text"
							size="sm"
							label="Filter templates"
							placeholder="Filter by name or subject"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={handleFilterKeyDown}
						/>
					</div>
					<div
						role="list"
						aria-label="Templates"
						className="max-h-64 overflow-y-auto border-t border-kumo-line"
					>
						{templates.isLoading ? (
							<div className="flex items-center justify-center py-4">
								<Loader size="sm" />
							</div>
						) : matches.length === 0 ? (
							<p className="px-3 py-3 text-xs text-kumo-subtle">
								{all.length === 0
									? "No templates yet — save this draft to create one."
									: "No template matches that filter."}
							</p>
						) : (
							matches.map((template, index) => (
								<div
									key={template.id}
									role="listitem"
									className="flex items-stretch border-b border-kumo-line last:border-b-0 hover:bg-kumo-tint"
								>
									<button
										ref={index === 0 ? firstRowRef : undefined}
										type="button"
										className="min-w-0 flex-1 px-3 py-2 text-left"
										onClick={() => insert(template)}
									>
										<span className="block truncate text-sm text-kumo-default">
											{template.name}
										</span>
										<span className="block truncate text-xs text-kumo-subtle">
											{subjectPreview(template)}
										</span>
									</button>
									<button
										type="button"
										title="Delete this template"
										aria-label={`Delete template ${template.name}`}
										className="shrink-0 px-2 text-kumo-subtle transition-colors hover:text-kumo-danger disabled:opacity-40"
										onClick={() => {
											void handleDelete(template);
										}}
										disabled={deleteTemplate.isPending}
									>
										<TrashIcon size={14} />
									</button>
								</div>
							))
						)}
					</div>
					{failure && (
						<p className="border-t border-kumo-line px-3 py-2 text-xs text-kumo-danger">
							{failure}
						</p>
					)}
					<div className="border-t border-kumo-line p-2">
						<Button
							type="button"
							variant="secondary"
							size="sm"
							className="w-full"
							icon={<PlusIcon size={14} />}
							disabled={!canSave || isSaving}
							onClick={onSave}
						>
							{isSaving ? "Saving..." : "Save current draft as template"}
						</Button>
						{!canSave && (
							<p className="pt-1.5 text-xs text-kumo-subtle">
								Write something first — an empty draft has nothing to save.
							</p>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
