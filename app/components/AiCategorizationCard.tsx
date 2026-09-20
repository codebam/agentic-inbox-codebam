// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Input, Switch } from "@cloudflare/kumo";
import { SparkleIcon } from "@phosphor-icons/react";
import { Link } from "react-router";
import type { CategorizationSettings } from "shared/categories";
import CategoryEditor from "~/components/CategoryEditor";
import { useGlobalCategorization } from "~/queries/categorization";

interface AiCategorizationCardProps {
	settings: CategorizationSettings;
	onChange: (settings: CategorizationSettings) => void;
}

/**
 * Per-mailbox controls for Jev inbound classification: a master switch,
 * spam-detection threshold/behavior, app-wide global category opt-in, and
 * mailbox-specific categories.
 */
export default function AiCategorizationCard({
	settings,
	onChange,
}: AiCategorizationCardProps) {
	const { data: globalCategorization } = useGlobalCategorization();
	const globalCategories = globalCategorization?.categories ?? [];
	const useGlobalCategories = settings.useGlobalCategories !== false;

	const updateSpam = (patch: Partial<CategorizationSettings["spam"]>) => {
		onChange({ ...settings, spam: { ...settings.spam, ...patch } });
	};

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
								checked={settings.spam.enabled}
								onCheckedChange={(enabled) => updateSpam({ enabled })}
								label="Detect spam"
								size="sm"
							/>
							{settings.spam.enabled && (
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
											value={String(settings.spam.threshold)}
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
										checked={settings.spam.moveToSpam}
										onCheckedChange={(moveToSpam) => updateSpam({ moveToSpam })}
										label="Move detected spam to the Spam folder"
										size="sm"
									/>
								</>
							)}
						</div>

						{/* Global categories */}
						<div className="rounded-md border border-kumo-line bg-kumo-recessed p-4 space-y-3">
							<div className="flex items-start justify-between gap-3">
								<div>
									<div className="text-sm font-medium text-kumo-default">
										Global categories
									</div>
									<p className="text-xs text-kumo-subtle mt-0.5">
										Shared by every mailbox. Managed once in Global Settings.
									</p>
								</div>
								<Link
									to="/settings"
									className="shrink-0 text-xs font-medium text-kumo-link hover:underline"
								>
									Manage
								</Link>
							</div>

							<Switch
								checked={useGlobalCategories}
								onCheckedChange={(checked) =>
									onChange({ ...settings, useGlobalCategories: checked })
								}
								label="Apply global categories to this mailbox"
								size="sm"
							/>

							{useGlobalCategories &&
								(globalCategories.length > 0 ? (
									<ul className="space-y-1.5">
										{globalCategories.map((category) => (
											<li
												key={category.id}
												className="flex flex-wrap items-baseline gap-2 text-xs"
											>
												<Badge variant="secondary">{category.name}</Badge>
												{category.description && (
													<span className="text-kumo-subtle">
														{category.description}
													</span>
												)}
											</li>
										))}
									</ul>
								) : (
									<p className="text-xs text-kumo-subtle">
										No global categories defined yet.
									</p>
								))}
						</div>

						{/* Mailbox-specific categories */}
						<CategoryEditor
							title="Mailbox-specific categories"
							description="Optional categories only for this mailbox. Applied in addition to global categories."
							emptyText='No mailbox-specific categories yet. Add one (for example "Invoices") to label only this mailbox.'
							categories={settings.categories}
							onChange={(categories) => onChange({ ...settings, categories })}
						/>
					</>
				)}
			</div>
		</div>
	);
}
