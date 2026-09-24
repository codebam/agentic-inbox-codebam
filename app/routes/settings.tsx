// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, Switch, useKumoToastManager } from "@cloudflare/kumo";
import {
	RobotIcon,
	ArrowCounterClockwiseIcon,
	SignatureIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useParams } from "react-router";
import AiCategorizationCard from "~/components/AiCategorizationCard";
import AiModelsCard from "~/components/AiModelsCard";
import EmailViewCard from "~/components/EmailViewCard";
import WebhookCard from "~/components/WebhookCard";
import SenderPolicyCard from "~/components/SenderPolicyCard";
import DigestCard from "~/components/DigestCard";
import { normalizeAutoDraft } from "shared/auto-draft";
import {
	defaultCategorizationSettings,
	normalizeCategorizationSettings,
	type CategorizationSettings,
} from "shared/categories";
import {
	modelConfigErrors,
	normalizeModelConfig,
	type ModelConfig,
} from "shared/models";
import {
	normalizeEmailViewMode,
	resolveDefaultEmailView,
	type EmailViewMode,
} from "shared/email-view";
import {
	normalizeSignatureSettings,
	type SignatureSettings,
} from "shared/signature";
import {
	DEFAULT_TRASH_RETENTION_DAYS,
	MAX_TRASH_RETENTION_DAYS,
	normalizeTrashRetentionDays,
} from "shared/trash-retention";
import { validateWebhookUrl } from "shared/webhook";
import { getSignatureBlock } from "~/lib/utils";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";
import { useGlobalModels } from "~/queries/models";
import { useGlobalEmailView } from "~/queries/email-view";
import type { Mailbox } from "~/types";

// Placeholder shown in the textarea when no custom prompt is set.
// The authoritative default prompt lives in workers/agent/index.ts (DEFAULT_SYSTEM_PROMPT).
const PROMPT_PLACEHOLDER = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.\n\nWrite like a real person. Short, direct, flowing prose. Plain text only.\n\n(Leave empty to use the full built-in default prompt)`;

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const { data: globalModels } = useGlobalModels();
	const { data: globalEmailView } = useGlobalEmailView();
	const updateMailboxMutation = useUpdateMailbox();

	const [displayName, setDisplayName] = useState("");
	const [agentPrompt, setAgentPrompt] = useState("");
	const [autoDraft, setAutoDraft] = useState(true);
	const [categorization, setCategorization] = useState<CategorizationSettings>(
		defaultCategorizationSettings,
	);
	const [signature, setSignature] = useState<SignatureSettings>({
		enabled: false,
		text: "",
	});
	const [models, setModels] = useState<ModelConfig>({});
	const [defaultEmailView, setDefaultEmailView] = useState<EmailViewMode | undefined>(undefined);
	// Held as a string so the field can be cleared while typing; normalized
	// (default 30, 0 = off, capped) on save.
	const [trashRetentionDays, setTrashRetentionDays] = useState(
		String(DEFAULT_TRASH_RETENTION_DAYS),
	);
	const [webhook, setWebhook] = useState({ url: "", secret: "" });
	const [isSaving, setIsSaving] = useState(false);

	// Re-seed the editable copies whenever a freshly loaded mailbox arrives (its
	// identity changes on each refetch). Adjusting state during render instead of
	// in an effect avoids painting the stale values for a frame first.
	const [seededMailbox, setSeededMailbox] = useState<Mailbox | undefined>(undefined);
	if (mailbox && mailbox !== seededMailbox) {
		setSeededMailbox(mailbox);
		setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
		setAgentPrompt(mailbox.settings?.agentSystemPrompt || "");
		setAutoDraft(normalizeAutoDraft(mailbox.settings?.autoDraft));
		setCategorization(
			normalizeCategorizationSettings(mailbox.settings?.categorization),
		);
		setSignature(
			normalizeSignatureSettings(mailbox.settings?.signature) ?? {
				enabled: false,
				text: "",
			},
		);
		setModels(mailbox.settings?.models ?? {});
		setDefaultEmailView(normalizeEmailViewMode(mailbox.settings?.defaultEmailView));
		setTrashRetentionDays(
			String(normalizeTrashRetentionDays(mailbox.settings?.trashRetentionDays)),
		);
		setWebhook({
			url: mailbox.settings?.notifyWebhookUrl ?? "",
			secret: mailbox.settings?.notifyWebhookSecret ?? "",
		});
	}

	const modelErrors = modelConfigErrors({ models });
	const webhookUrlError = webhook.url.trim() ? validateWebhookUrl(webhook.url) : null;


	const handleSave = async () => {
		if (!mailbox || !mailboxId) return;
		if (Object.keys(modelErrors).length > 0) {
			toastManager.add({
				title: "Fix the highlighted model IDs before saving.",
				variant: "error",
			});
			return;
		}
		if (webhookUrlError) {
			toastManager.add({ title: webhookUrlError, variant: "error" });
			return;
		}
		setIsSaving(true);
		const settings = {
			...mailbox.settings,
			fromName: displayName,
			agentSystemPrompt: agentPrompt.trim() || undefined,
			autoDraft,
			categorization: normalizeCategorizationSettings(categorization),
			signature: normalizeSignatureSettings(signature),
			models: normalizeModelConfig(models),
			defaultEmailView: normalizeEmailViewMode(defaultEmailView) ?? null,
			trashRetentionDays: normalizeTrashRetentionDays(trashRetentionDays),
			notifyWebhookUrl: webhook.url.trim() || undefined,
			notifyWebhookSecret: webhook.secret.trim() || undefined,
		};
		try {
			await updateMailboxMutation.mutateAsync({ mailboxId, settings });
			toastManager.add({ title: "Settings saved!" });
		} catch {
			toastManager.add({
				title: "Failed to save settings",
				variant: "error",
			});
		} finally {
			setIsSaving(false);
		}
	};

	const handleResetPrompt = () => {
		setAgentPrompt("");
	};

	if (!mailbox) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	const isCustomPrompt = agentPrompt.trim().length > 0;
	const trashRetentionEnabled = normalizeTrashRetentionDays(trashRetentionDays) > 0;

	return (
		<div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<h1 className="text-lg font-semibold text-kumo-default mb-6">Settings</h1>

			<div className="space-y-6">
				{/* Account */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="text-sm font-medium text-kumo-default mb-4">
						Account
					</div>
					<div className="space-y-3">
						<Input
							label="Display Name"
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
						<Input label="Email" type="email" value={mailbox.email} disabled />
					</div>
				</div>

				<AiCategorizationCard
					settings={categorization}
					onChange={setCategorization}
				/>

				<SenderPolicyCard mailboxId={mailboxId} />

				{/* Agent System Prompt */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center justify-between mb-4">
						<div className="flex items-center gap-2">
							<RobotIcon size={16} weight="duotone" className="text-kumo-subtle" />
							<span className="text-sm font-medium text-kumo-default">
								AI Agent Prompt
							</span>
							{isCustomPrompt ? (
								<Badge variant="primary">Custom</Badge>
							) : (
								<Badge variant="secondary">Default</Badge>
							)}
						</div>
						{isCustomPrompt && (
							<Button
								variant="ghost"
								size="xs"
								icon={<ArrowCounterClockwiseIcon size={14} />}
								onClick={handleResetPrompt}
							>
								Reset to default
							</Button>
						)}
					</div>
					<p className="text-xs text-kumo-subtle mb-3">
						Customize how the AI agent behaves for this mailbox.
						Leave empty to use the built-in default prompt.
					</p>
					<Switch
						checked={autoDraft}
						onCheckedChange={setAutoDraft}
						label="Draft a reply automatically for each new message"
					/>
					<p className="text-xs text-kumo-subtle mt-2 mb-3">
						With this off, new mail no longer creates a draft on its own — the agent
						still drafts when asked in chat or over MCP.
					</p>
					<textarea
						value={agentPrompt}
						onChange={(e) => setAgentPrompt(e.target.value)}
						placeholder={PROMPT_PLACEHOLDER}
						rows={12}
						className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed"
					/>
					<p className="text-xs text-kumo-subtle mt-2">
						The prompt is sent as the system message to the AI model.
						It controls the agent's personality, writing style, and behavior rules.
					</p>
				</div>

				{/* Signature */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center gap-2 mb-3">
						<SignatureIcon size={16} weight="duotone" className="text-kumo-subtle" />
						<span className="text-sm font-medium text-kumo-default">Signature</span>
						{signature.enabled ? (
							<Badge variant="primary">On</Badge>
						) : (
							<Badge variant="secondary">Off</Badge>
						)}
					</div>
					<p className="text-xs text-kumo-subtle mb-4">
						Prefilled in the composer for new messages, and appended to drafts the
						AI agent or MCP creates. Plain text is escaped; HTML signatures keep
						their formatting with unsafe tags stripped.
					</p>
					<div className="space-y-4">
						<Switch
							checked={signature.enabled}
							onCheckedChange={(enabled) => setSignature({ ...signature, enabled })}
							label="Add signature to outgoing drafts"
						/>
						<label className="block">
							<span className="block text-xs font-medium text-kumo-strong mb-1">
								Plain-text signature
							</span>
							<textarea
								value={signature.text}
								onChange={(e) => setSignature({ ...signature, text: e.target.value })}
								placeholder={"Your name\nRole, Company\nhttps://example.com"}
								rows={4}
								className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring leading-relaxed"
							/>
						</label>
						<label className="block">
							<span className="block text-xs font-medium text-kumo-strong mb-1">
								HTML signature (optional — replaces the plain-text version)
							</span>
							<textarea
								value={signature.html ?? ""}
								onChange={(e) => setSignature({ ...signature, html: e.target.value })}
								placeholder={'<p><strong>Your name</strong><br>Role, Company</p>'}
								rows={4}
								className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed"
							/>
						</label>
						{Boolean(signature.text.trim() || signature.html?.trim()) && (
							<div>
								<div className="text-xs font-medium text-kumo-strong mb-1">Preview</div>
								<div
									className="rounded-md border border-kumo-line bg-kumo-recessed p-4 text-sm text-kumo-default overflow-x-auto"
									dangerouslySetInnerHTML={{
										__html: getSignatureBlock({
											signature: { ...signature, enabled: true },
										}),
									}}
								/>
								{!signature.enabled && (
									<p className="text-xs text-kumo-subtle mt-1">
										Signature is off — drafts won't include it until you turn it on.
									</p>
								)}
							</div>
						)}
					</div>
				</div>


				{/* Trash retention */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center gap-2 mb-3">
						<TrashIcon size={16} weight="duotone" className="text-kumo-subtle" />
						<span className="text-sm font-medium text-kumo-default">
							Trash retention
						</span>
						{trashRetentionEnabled ? (
							<Badge variant="primary">On</Badge>
						) : (
							<Badge variant="secondary">Off</Badge>
						)}
					</div>
					<p className="text-xs text-kumo-subtle mb-4">
						Emails are permanently deleted once they have been in Trash for this
						many days. The countdown starts when a message is moved to Trash, not
						on its Date header. Set to 0 to keep trashed emails until you empty
						Trash yourself.
					</p>
					<Input
						label="Days in Trash before automatic deletion"
						type="number"
						min={0}
						max={MAX_TRASH_RETENTION_DAYS}
						value={trashRetentionDays}
						onChange={(e) => setTrashRetentionDays(e.target.value)}
						description={`Default ${DEFAULT_TRASH_RETENTION_DAYS} days; values above ${MAX_TRASH_RETENTION_DAYS} are capped, 0 means never.`}
					/>
				</div>

				<AiModelsCard
					title="AI Models"
					description="Override the app-wide model choice for this mailbox. Leave a field empty to inherit the app-wide model (shown as the placeholder)."
					models={models}
					onChange={setModels}
					inherited={globalModels?.models}
				/>

				<EmailViewCard
					title="Message view"
					description="Override the app-wide default for this mailbox. Leave it blank to inherit it (shown in the badge)."
					value={defaultEmailView}
					onChange={setDefaultEmailView}
					inherited={resolveDefaultEmailView(undefined, globalEmailView)}
				/>


				<WebhookCard
					mailboxId={mailboxId!}
					url={webhook.url}
					secret={webhook.secret}
					onChange={setWebhook}
				/>
				<DigestCard mailboxId={mailboxId} />


				{/* Save */}
				<div className="flex justify-end">
					<Button variant="primary" onClick={() => void handleSave()} loading={isSaving}>
						Save Changes
					</Button>
				</div>
			</div>
		</div>
	);
}
