// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { ArrowLeftIcon, SparkleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
	normalizeGlobalCategorizationSettings,
	type EmailCategory,
} from "shared/categories";
import {
	modelConfigErrors,
	normalizeModelConfig,
	type ModelConfig,
} from "shared/models";
import { DEFAULT_EMAIL_VIEW, type EmailViewMode } from "shared/email-view";
import AiModelsCard from "~/components/AiModelsCard";
import CategoryEditor from "~/components/CategoryEditor";
import EmailViewCard from "~/components/EmailViewCard";
import {
	useGlobalCategorization,
	useUpdateGlobalCategorization,
} from "~/queries/categorization";
import { useGlobalModels, useUpdateGlobalModels } from "~/queries/models";
import { useGlobalEmailView, useUpdateGlobalEmailView } from "~/queries/email-view";

export function meta() {
	return [{ title: "Global Settings · Agentic Inbox Codebam" }];
}

export default function GlobalSettingsRoute() {
	const toastManager = useKumoToastManager();
	const { data, isLoading } = useGlobalCategorization();
	const { data: modelData } = useGlobalModels();
	const { data: emailViewData } = useGlobalEmailView();
	const updateGlobalCategorization = useUpdateGlobalCategorization();
	const updateGlobalModels = useUpdateGlobalModels();
	const updateGlobalEmailView = useUpdateGlobalEmailView();

	const [categories, setCategories] = useState<EmailCategory[]>([]);
	const [models, setModels] = useState<ModelConfig>({});
	const [defaultEmailView, setDefaultEmailView] = useState<EmailViewMode | undefined>(undefined);
	const [isSaving, setIsSaving] = useState(false);

	useEffect(() => {
		if (data) setCategories(data.categories);
	}, [data]);

	useEffect(() => {
		if (modelData) setModels(modelData.models ?? {});
	}, [modelData]);

	useEffect(() => {
		setDefaultEmailView(emailViewData?.defaultEmailView);
	}, [emailViewData]);

	const modelErrors = modelConfigErrors({ models });


	const handleSave = async () => {
		if (Object.keys(modelErrors).length > 0) {
			toastManager.add({
				title: "Fix the highlighted model IDs before saving.",
				variant: "error",
			});
			return;
		}
		setIsSaving(true);
		try {
			// Normalize on the client too so the saved state matches exactly
			// what the server will store (IDs, trimming, duplicates).
			const settings = normalizeGlobalCategorizationSettings({ categories });
			await updateGlobalCategorization.mutateAsync(settings);
			setCategories(settings.categories);
			await updateGlobalModels.mutateAsync({
				models: normalizeModelConfig(models),
			});
			await updateGlobalEmailView.mutateAsync({ defaultEmailView });
			toastManager.add({ title: "Global settings saved!" });
		} catch {
			toastManager.add({
				title: "Failed to save global settings",
				variant: "error",
			});
		} finally {
			setIsSaving(false);
		}
	};

	if (isLoading) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-12">
				<Link
					to="/"
					className="inline-flex items-center gap-1.5 text-sm text-kumo-subtle hover:text-kumo-default transition-colors no-underline mb-6"
				>
					<ArrowLeftIcon size={14} />
					<span>Mailboxes</span>
				</Link>

				<div className="flex items-center gap-2 mb-2">
					<SparkleIcon
						size={20}
						weight="duotone"
						className="text-kumo-subtle"
					/>
					<h1 className="text-2xl font-bold text-kumo-default">
						Global Settings
					</h1>
				</div>
				<p className="text-sm text-kumo-subtle mb-8">
					Categories defined here can be applied to every mailbox. Each mailbox
					can opt out in its own Settings, or add mailbox-specific categories on
					top.
				</p>

				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<CategoryEditor
						title="Global categories"
						description="Jev considers these categories for every mailbox that has global categories enabled."
						emptyText='No global categories yet. Add one (for example "Work" or "Newsletters") to share it across every mailbox.'
						categories={categories}
						onChange={setCategories}
					/>
				</div>

				<div className="mt-6">
					<AiModelsCard
						title="AI Models"
						description="App-wide model choice for every mailbox that has no override of its own. Leave a field empty to use the built-in default (shown as the placeholder)."
						models={models}
						onChange={setModels}
					/>
				</div>

				<div className="mt-6">
					<EmailViewCard
						title="Message view"
						description="How messages open for every mailbox that has no override of its own. Leave it blank to use the built-in HTML default."
						value={defaultEmailView}
						onChange={setDefaultEmailView}
						inherited={DEFAULT_EMAIL_VIEW}
					/>
				</div>

				<div className="flex justify-end mt-6">
					<Button variant="primary" onClick={handleSave} loading={isSaving}>
						Save Global Settings
					</Button>
				</div>
			</div>
		</div>
	);
}
