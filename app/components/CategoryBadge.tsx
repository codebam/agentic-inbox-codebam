// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge } from "@cloudflare/kumo";
import {
	SPAM_CATEGORY_ID,
	categoryLabel,
	type EmailCategory,
} from "shared/categories";

interface CategoryBadgeProps {
	/** Category ID stored on the email (`spam` or a configured category). */
	category?: string | null | undefined;
	/** Mailbox categories, used to resolve IDs to display names. */
	categories?: EmailCategory[] | undefined;
	className?: string;
}

/**
 * Small Jev category label used in email lists and panels. Falls back to a
 * readable form of the stored ID when the category was removed or is not
 * available in the current settings.
 */
export default function CategoryBadge({
	category,
	categories,
	className = "shrink-0",
}: CategoryBadgeProps) {
	if (!category) return null;

	return (
		<Badge
			variant={category === SPAM_CATEGORY_ID ? "red" : "secondary"}
			className={className}
		>
			{categoryLabel(category, categories)}
		</Badge>
	);
}
