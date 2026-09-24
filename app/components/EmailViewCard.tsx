// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { Badge, Radio } from "@cloudflare/kumo";
import { EyeIcon } from "@phosphor-icons/react";
import {
	EMAIL_VIEW_LABELS,
	normalizeEmailViewMode,
	type EmailViewMode,
} from "shared/email-view";


interface EmailViewCardProps {
	/** Configured value for this scope. Blank/undefined means inherit. */
	value?: EmailViewMode | null;
	onChange: (value: EmailViewMode | undefined) => void;
	/**
	 * Effective mode this scope inherits when nothing is configured: the
	 * app-wide default for a mailbox card, or the built-in default in
	 * Global Settings.
	 */
	inherited: EmailViewMode;
	title?: string;
	description?: string;
}


/**
 * Default message view for one scope (app-wide or a single mailbox).
 *
 * The blank option inherits the next level up, so clearing the choice is
 * always safe. Readers can still switch HTML | plain text per message.
 */
export default function EmailViewCard({
	value,
	onChange,
	inherited,
	title = "Message view",
	description,
}: EmailViewCardProps) {
	const selected: EmailViewMode | "" = normalizeEmailViewMode(value) ?? "";

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-3">
				<EyeIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">{title}</span>
				<Badge variant="secondary">
					{selected
						? EMAIL_VIEW_LABELS[selected]
						: `Inherited: ${EMAIL_VIEW_LABELS[inherited]}`}
				</Badge>
			</div>
			<p className="text-xs text-kumo-subtle mb-4">
				{description ??
					"How messages open by default. Leaving it blank inherits the next level up."}
			</p>
			<Radio.Group
				legend={`Default message view (inherits ${EMAIL_VIEW_LABELS[inherited]})`}
				orientation="horizontal"
				value={selected}
				onValueChange={(next) => onChange(normalizeEmailViewMode(next))}
			>
				<Radio.Item
					label={`Inherited (${EMAIL_VIEW_LABELS[inherited]})`}
					value=""
				/>
				<Radio.Item label={EMAIL_VIEW_LABELS.html} value="html" />
				<Radio.Item label={EMAIL_VIEW_LABELS.text} value="text" />
			</Radio.Group>
		</div>
	);
}
