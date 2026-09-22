// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Checkbox } from "@cloudflare/kumo";
import { useRef } from "react";

interface SelectionCheckboxProps {
	checked: boolean;
	/** Receives the Shift state of the click so callers can extend to a range. */
	onToggle: (shiftKey: boolean) => void;
	/** Accessible name, e.g. "Select <subject>". */
	label: string;
	className?: string;
}

/**
 * Row checkbox for the email list. Stops click propagation so selecting a row
 * never opens the email, and reports Shift-clicks for range selection.
 */
export default function SelectionCheckbox({
	checked,
	onToggle,
	label,
	className,
}: SelectionCheckboxProps) {
	const shiftRef = useRef(false);

	return (
		<div
			className={className}
			onClickCapture={(event) => {
				shiftRef.current = event.shiftKey;
			}}
			onClick={(event) => event.stopPropagation()}
		>
			<Checkbox
				checked={checked}
				aria-label={label}
				onCheckedChange={() => {
					const shiftKey = shiftRef.current;
					shiftRef.current = false;
					onToggle(shiftKey);
				}}
			/>
		</div>
	);
}
