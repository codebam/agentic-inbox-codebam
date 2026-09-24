// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { Button } from "@cloudflare/kumo";
import {
	EMAIL_VIEW_LABELS,
	EMAIL_VIEW_MODES,
	type EmailViewMode,
} from "shared/email-view";


interface EmailViewToggleProps {
	value: EmailViewMode;
	onChange: (mode: EmailViewMode) => void;
	className?: string;
}


/** HTML | Plain text switch for the message view. */
export default function EmailViewToggle({
	value,
	onChange,
	className,
}: EmailViewToggleProps) {
	return (
		<div
			role="group"
			aria-label="Message view"
			className={`inline-flex items-center gap-0.5 rounded-md border border-kumo-line p-0.5 ${className ?? ""}`}
		>
			{EMAIL_VIEW_MODES.map((mode) => (
				<Button
					key={mode}
					variant={value === mode ? "secondary" : "ghost"}
					size="xs"
					aria-pressed={value === mode}
					onClick={() => onChange(mode)}
				>
					{EMAIL_VIEW_LABELS[mode]}
				</Button>
			))}
		</div>
	);
}
