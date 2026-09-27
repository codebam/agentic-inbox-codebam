// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge } from "@cloudflare/kumo";
import { XIcon } from "@phosphor-icons/react";
import type { Label } from "~/services/api";

interface LabelChipsProps {
	/** The labels currently on the message. */
	labels: Label[];
	/** Detach one label from the message. */
	onRemove: (label: Label) => void;
	/** The label id with a detach in flight, if any. */
	removingId?: string | null | undefined;
}

/**
 * A message's labels as small chips, each with an X that detaches it. Pure
 * presentation: the panel owns the mutation and the error toast, and an
 * empty list renders nothing (the picker trigger beside it stays).
 */
export default function LabelChips({
	labels,
	onRemove,
	removingId,
}: LabelChipsProps) {
	if (labels.length === 0) return null;

	return (
		<>
			{labels.map((label) => (
				<Badge key={label.id} variant="secondary" className="gap-1 pr-1">
					{label.color && (
						<span
							aria-hidden="true"
							className="h-2 w-2 shrink-0 rounded-full"
							style={{ backgroundColor: label.color }}
						/>
					)}
					<span className="max-w-40 truncate">{label.name}</span>
					<button
						type="button"
						className="shrink-0 rounded-full p-0.5 text-kumo-subtle transition-colors hover:text-kumo-danger disabled:opacity-40"
						aria-label={`Remove label ${label.name}`}
						disabled={removingId === label.id}
						onClick={() => onRemove(label)}
					>
						<XIcon size={10} />
					</button>
				</Badge>
			))}
		</>
	);
}
