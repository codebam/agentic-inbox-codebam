// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Switch } from "@cloudflare/kumo";
import { PlusIcon, SparkleIcon, TrashIcon } from "@phosphor-icons/react";
import {
	MAX_EMAIL_CATEGORIES,
	slugifyCategoryId,
	type CategorizationSettings,
	type EmailCategory,
} from "shared/categories";

interface AiCategorizationCardProps {
	settings: CategorizationSettings;
	onChange: (settings: CategorizationSettings) => void;
}

/**
 * Per-mailbox controls for Jev inbound classification: a master switch,
 * spam-detection threshold/behavior, and the custom category editor.
 */
export default function AiCategorizationCard({
	settings,
	onChange,
}: AiCategorizationCardProps) {
	const updateSpam = (patch: Partial<CategorizationSettings["spam"]>) => {
		onChange({ ...settings, spam: { ...settings.spam, ...patch } });
	};

	const addCategory = () => {
		if (settings.categories.length >= MAX_EMAIL_CATEGORIES) return;
		onChange({
			...settings,
			categories: [
				...settings.categories,
				{ id: "", name: "", description: "" },
			],
		});
	};

	const updateCategory = (index: number, patch: Partial<EmailCategory>) => {
		onChange({
			...settings,
			categories: settings.categories.map((category, i) =>
				i === index ? { ...category, ...patch } : category,
			),
		});
	};

	/**
	 * Freeze a human-readable, URL-safe ID once the user finishes naming a
	 * new category. Keeping the ID stable across later renames means already
	 * classified emails keep referring to the same category.
	 */
	const handleCategoryNameBlur = (index: number) => {
		const category = settings.categories[index];
		if (!category || category.id || !category.name.trim()) return;
		onChange({
			...settings,
			categories: settings.categories.map((item, i) =>
				i === index
					? {
							...item,
							id: slugifyCategoryId(item.name) || `category-${index + 1}`,
						}
					: item,
			),
		});
	};

	const removeCategory = (index: number) => {
		onChange({
			...settings,
			categories: settings.categories.filter((_, i) => i !== index),
		});
	};

	const { spam, categories } = settings;

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center justify-between mb-3">
				<div className="flex items-center gap-2">
					<SparkleIcon
						size={16}
						weight="duotone"
						className="text-kumo-subtle"
					/>
					<span className="text-sm font-medium text-kumo-default">
						AI Categorization
					</span>
					<Badge variant="secondary">Jev</Badge>
				</div>
			</div>
			<p className="text-xs text-kumo-subtle mb-4">
				Classify incoming email as it arrives using TypeSafe's Jev model (
				<code>typesafe/jev</code>). Email content is sent to Workers AI for
				classification. Spam can be filed automatically; custom categories are
				applied as labels.
			</p>

			<div className="space-y-5">
				<div>
					<Switch
						checked={settings.enabled}
						onCheckedChange={(enabled) => onChange({ ...settings, enabled })}
						label="Categorize incoming email"
					/>
					<p className="text-xs text-kumo-subtle mt-1">
						Turn off to leave every incoming email uncategorized.
					</p>
				</div>

				{settings.enabled && (
					<>
						{/* Spam */}
						<div className="rounded-md border border-kumo-line bg-kumo-recessed p-4 space-y-3">
							<Switch
								checked={spam.enabled}
								onCheckedChange={(enabled) => updateSpam({ enabled })}
								label="Detect spam"
								size="sm"
							/>
							{spam.enabled && (
								<>
									<div className="flex flex-wrap items-center gap-3">
										<span className="text-xs font-medium text-kumo-strong">
											Spam threshold
										</span>
										<Input
											aria-label="Spam threshold"
											type="number"
											min={0.5}
											max={1}
											step={0.05}
											value={String(spam.threshold)}
											onChange={(e) => {
												const value = Number(e.target.value);
												if (Number.isFinite(value)) {
													updateSpam({
														threshold: Math.min(1, Math.max(0.5, value)),
													});
												}
											}}
											className="w-24"
											size="sm"
										/>
										<span className="text-xs text-kumo-subtle">
											Jev probability at or above which an email is spam
											(0.5–1).
										</span>
									</div>
									<Switch
										checked={spam.moveToSpam}
										onCheckedChange={(moveToSpam) => updateSpam({ moveToSpam })}
										label="Move detected spam to the Spam folder"
										size="sm"
									/>
								</>
							)}
						</div>

						{/* Custom categories */}
						<div className="space-y-3">
							<div className="flex items-start justify-between gap-3">
								<div>
									<div className="text-sm font-medium text-kumo-default">
										Categories
									</div>
									<p className="text-xs text-kumo-subtle mt-0.5">
										Optional labels beyond spam/not-spam. Jev picks the best
										match for each incoming email.
									</p>
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
								<p className="text-xs text-kumo-subtle">
									No categories yet. Add one or more (for example
									&quot;Work&quot; or &quot;Newsletters&quot;) and Jev will
									label each email.
								</p>
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
					</>
				)}
			</div>
		</div>
	);
}
