// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { Button, Dialog, Tooltip } from "@cloudflare/kumo";
import { QuestionIcon } from "@phosphor-icons/react";
import {
	TRIAGE_SECTIONS,
	bindingsForSection,
	formatKeyToken,
} from "shared/keyboard";


/** One key cap. Plain <kbd> so the dialog needs no extra dependency. */
function KeyCap({ token }: { token: string }) {
	return (
		<kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded border border-kumo-line bg-kumo-fill px-1.5 py-0.5 font-mono text-[11px] leading-4 text-kumo-strong">
			{formatKeyToken(token)}
		</kbd>
	);
}


/** The list toolbar's subtle "?" affordance. */
export function KeyboardCheatsheetButton({ onClick }: { onClick: () => void }) {
	return (
		<Tooltip content="Keyboard shortcuts (?)" side="bottom" asChild>
			<Button
				variant="ghost"
				shape="square"
				size="sm"
				icon={<QuestionIcon size={16} />}
				onClick={onClick}
				aria-label="Keyboard shortcuts"
			/>
		</Tooltip>
	);
}


/**
 * Shortcut cheatsheet, rendered from the same table the triage hook resolves
 * keys with, so the dialog can never drift from the real bindings.
 */
export default function KeyboardCheatsheet({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog size="lg">
				<Dialog.Title>Keyboard shortcuts</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
					Shortcuts are ignored while you are typing, while the composer is
					open, and while a button, link or form field has focus.
				</Dialog.Description>
				<div className="mt-4 grid max-h-[60vh] gap-5 overflow-y-auto sm:grid-cols-2">
					{TRIAGE_SECTIONS.map((section) => {
						const bindings = bindingsForSection(section.id);
						if (bindings.length === 0) return null;
						return (
							<section key={section.id}>
								<h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-kumo-subtle">
									{section.title}
								</h3>
								<ul className="space-y-1.5">
									{bindings.map((binding) => (
										<li
											key={binding.action}
											className="flex items-center justify-between gap-3 text-sm"
										>
											<span className="text-kumo-default">{binding.label}</span>
											<span className="flex shrink-0 items-center gap-1">
												{binding.keys.map((key) => (
													<KeyCap key={key} token={key} />
												))}
											</span>
										</li>
									))}
								</ul>
							</section>
						);
					})}
				</div>
				<p className="mt-4 text-xs text-kumo-subtle">
					Reply, reply all, forward and compose only open the composer — a
					shortcut never sends. In Trash, <KeyCap token="#" /> deletes the
					message forever.
				</p>
				<div className="mt-4 flex justify-end">
					{/* render= keeps Dialog.Close and the Button one element: nesting two
					    buttons is invalid HTML and trips React hydration warnings. */}
					<Dialog.Close
						render={(closeProps) => (
							<Button variant="secondary" size="sm" {...closeProps}>
								Close
							</Button>
						)}
					/>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
