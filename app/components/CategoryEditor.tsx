// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input } from "@cloudflare/kumo";
import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import {
	MAX_EMAIL_CATEGORIES,
	slugifyCategoryId,
	type EmailCategory,
} from "shared/categories";

interface CategoryEditorProps {
	categories: EmailCategory[];
	onChange: (categories: EmailCategory[]) => void;
	title: string;
	description: string;
	emptyText: string;
}

/**
 * Reusable category list editor for mailbox-specific settings and the
 * app-wide Global Settings page.
 */
export default function CategoryEditor({
	categories,
	onChange,
	title,
	description,
	emptyText,
}: CategoryEditorProps) {
	const addCategory = () => {
		if (categories.length >= MAX_EMAIL_CATEGORIES) return;
		onChange([...categories, { id: "", name: "", description: "" }]);
	};

	const updateCategory = (index: number, patch: Partial<EmailCategory>) => {
		onChange(
			categories.map((category, i) =>
				i === index ? { ...category, ...patch } : category,
			),
		);
	};

	/**
	 * Freeze a human-readable, URL-safe ID once the user finishes naming a
	 * new category. Keeping the ID stable across later renames means already
	 * classified emails keep referring to the same category.
	 */
	const handleCategoryNameBlur = (index: number) => {
		const category = categories[index];
		if (!category || category.id || !category.name.trim()) return;
		onChange(
			categories.map((item, i) =>
				i === index
					? {
							...item,
							id: slugifyCategoryId(item.name) || `category-${index + 1}`,
						}
					: item,
			),
		);
	};

	const removeCategory = (index: number) => {
		onChange(categories.filter((_, i) => i !== index));
	};

	return (
		<div className="space-y-3">
			<div className="flex items-start justify-between gap-3">
				<div>
					<div className="text-sm font-medium text-kumo-default">{title}</div>
					<p className="text-xs text-kumo-subtle mt-0.5">{description}</p>
				</div>
				<Button
					variant="secondary"
					size="sm"
					icon={<PlusIcon size={14} />}
					onClick={addCategory}
					disabled={categories.length >= MAX_EMAIL_CATEGORIES}
				>
					Add
				</Button>
			</div>

			{categories.length === 0 ? (
				<p className="text-xs text-kumo-subtle">{emptyText}</p>
			) : (
				<div className="space-y-2">
					{categories.map((category, index) => (
						<div
							key={index}
							className="flex flex-col gap-2 rounded-md border border-kumo-line bg-kumo-recessed p-3 md:flex-row md:items-center"
						>
							<Input
								aria-label={`Category ${index + 1} name`}
								placeholder="Category name"
								value={category.name}
								onChange={(e) =>
									updateCategory(index, { name: e.target.value })
								}
								onBlur={() => handleCategoryNameBlur(index)}
								className="md:w-44"
								size="sm"
							/>
							<Input
								aria-label={`Category ${index + 1} description`}
								placeholder="What belongs in this category?"
								value={category.description}
								onChange={(e) =>
									updateCategory(index, {
										description: e.target.value,
									})
								}
								className="flex-1"
								size="sm"
							/>
							<Button
								variant="ghost"
								shape="square"
								size="sm"
								icon={<TrashIcon size={14} />}
								onClick={() => removeCategory(index)}
								aria-label={`Remove category ${category.name || index + 1}`}
							/>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
