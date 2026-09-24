// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { Badge, Button, Input } from "@cloudflare/kumo";
import { PaperPlaneTiltIcon, WebhooksLogoIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { validateWebhookUrl } from "shared/webhook";
import type { WebhookDeliveryResult } from "workers/lib/webhook";
import { useTestWebhook } from "~/queries/webhook";


interface WebhookCardProps {
	mailboxId: string;
	/** Current form value; saved with the rest of the mailbox settings. */
	url: string;
	/** Current form value; saved with the rest of the mailbox settings. */
	secret: string;
	onChange: (next: { url: string; secret: string }) => void;
}


/**
 * Outbound webhook settings for one mailbox: the https endpoint notified for
 * every new non-spam message, plus an optional signing secret. "Send test"
 * posts a sample payload through the server so the endpoint's answer can be
 * checked before saving.
 */
export default function WebhookCard({
	mailboxId,
	url,
	secret,
	onChange,
}: WebhookCardProps) {
	const testWebhook = useTestWebhook();
	const [testResult, setTestResult] = useState<WebhookDeliveryResult | null>(null);

	const urlError = url.trim() ? validateWebhookUrl(url) : null;
	const configured = Boolean(url.trim()) && !urlError;

	const handleTest = async () => {
		setTestResult(null);
		try {
			setTestResult(
				await testWebhook.mutateAsync({
					mailboxId,
					url: url.trim(),
					secret: secret.trim(),
				}),
			);
		} catch (error) {
			setTestResult({
				ok: false,
				status: null,
				error: error instanceof Error ? error.message : "Test request failed",
			});
		}
	};

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-3">
				<WebhooksLogoIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">
					Outbound Webhook
				</span>
				{configured ? (
					<Badge variant="primary">On</Badge>
				) : (
					<Badge variant="secondary">Off</Badge>
				)}
			</div>
			<p className="text-xs text-kumo-subtle mb-4">
				POSTs a JSON notification to this URL for every new non-spam message
				(mailbox, id, subject, sender, recipient, date, folder, category,
				snippet). Spam is never notified and a failing webhook never affects
				mail delivery. With a secret set, the exact request body is signed in
				the <code>X-Agentic-Inbox-Signature: sha256=&lt;hmac&gt;</code> header.
			</p>
			<div className="space-y-3">
				<Input
					label="Webhook URL"
					placeholder="https://example.com/hooks/inbound"
					value={url}
					{...(urlError ? { error: urlError } : {})}
					onChange={(e) => onChange({ url: e.target.value, secret })}
				/>
				<Input
					label="Signing secret (optional)"
					placeholder="Shared secret used to sign the payload"
					value={secret}
					autoComplete="off"
					onChange={(e) => onChange({ url, secret: e.target.value })}
				/>
			</div>
			<div className="flex items-center gap-3 mt-4">
				<Button
					variant="secondary"
					size="sm"
					icon={<PaperPlaneTiltIcon size={14} />}
					disabled={!configured}
					loading={testWebhook.isPending}
					onClick={handleTest}
				>
					Send test
				</Button>
				{testResult && (
					<p
						className={`text-xs ${
							testResult.ok ? "text-kumo-success" : "text-kumo-danger"
						}`}
					>
						{testResult.ok
							? `Delivered — endpoint answered ${testResult.status}`
							: `Failed — ${testResult.error ?? "no response from endpoint"}`}
					</p>
				)}
			</div>
		</div>
	);
}
