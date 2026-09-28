// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Checkbox, Dialog, Input, Loader } from "@cloudflare/kumo";
import { CheckIcon, CopyIcon, KeyIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { formatDetailDate } from "shared/dates";
import {
	useAccessTokens,
	useCreateAccessToken,
	useRevokeAccessToken,
} from "~/queries/access-tokens";

/** The scopes a token can carry, in the order the create dialog lists them. */
const SCOPES = [
	{ value: "read", label: "Read mail, threads, search and attachments" },
	{ value: "draft", label: "Create, update and discard drafts" },
	{
		value: "send",
		label: "Send mail and replies (the operator's send guards still apply)",
	},
] as const;

/** The request shown alongside a freshly minted token; TOKEN stays literal. */
const CURL_EXAMPLE =
	'curl -H "Authorization: Bearer TOKEN" -X POST https://YOUR-DEPLOYMENT/api/v1/scoped/list_emails -H "content-type: application/json" -d \'{"folder":"inbox"}\'';

/**
 * Copy text to the clipboard. The async Clipboard API is the normal path;
 * the hidden-textarea selection copy is the fallback for browsers that do
 * not expose it (e.g. an insecure origin).
 */
async function copyText(text: string): Promise<void> {
	if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.style.position = "fixed";
	area.style.opacity = "0";
	document.body.appendChild(area);
	area.select();
	document.execCommand("copy");
	document.body.removeChild(area);
}

/**
 * Per-mailbox access tokens: bearer credentials for external automation.
 *
 * The operator mints a token with a fixed set of scopes and hands the
 * plaintext to one client; the server stores only a hash, so the plaintext
 * is shown exactly once, right after creation. Each token reaches this
 * mailbox alone. Revoking one is immediate and lives behind an inline
 * confirmation — any automation holding the token stops working with it.
 */
export default function AccessTokensCard({
	mailboxId,
}: {
	mailboxId?: string | undefined;
}) {
	const { data, isError } = useAccessTokens(mailboxId);
	const createToken = useCreateAccessToken();
	const revokeToken = useRevokeAccessToken();

	const [dialogOpen, setDialogOpen] = useState(false);
	const [name, setName] = useState("");
	const [scopes, setScopes] = useState<string[]>(["read"]);
	const [createdToken, setCreatedToken] = useState<string | null>(null);
	const [createError, setCreateError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [confirmingId, setConfirmingId] = useState<string | null>(null);
	const [revokeError, setRevokeError] = useState<string | null>(null);

	// Each open starts from a clean form; the previous plaintext and failure
	// never carry over.
	const openCreateDialog = () => {
		setName("");
		setScopes(["read"]);
		setCreatedToken(null);
		setCreateError(null);
		setCopied(false);
		setDialogOpen(true);
	};

	const handleOpenChange = (open: boolean) => {
		setDialogOpen(open);
		if (!open) {
			// Drop the plaintext (and any stale failure) the moment the
			// dialog closes, however it closed.
			setCreatedToken(null);
			setCreateError(null);
			setCopied(false);
		}
	};

	const canCreate =
		name.trim().length > 0 && scopes.length > 0 && !createToken.isPending;

	const handleCreate = () => {
		if (!mailboxId || !canCreate) return;
		setCreateError(null);
		createToken.mutate(
			{ mailboxId, input: { name: name.trim(), scopes } },
			{
				onSuccess: (result) => {
					setCreatedToken(result.token);
				},
				onError: (error) => {
					setCreateError(
						error instanceof Error
							? error.message
							: "Could not create the token.",
					);
				},
			},
		);
	};

	const handleCopy = () => {
		if (!createdToken) return;
		copyText(createdToken)
			.then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			})
			.catch(() => {
				// The token is on screen, so it can still be selected by hand.
			});
	};

	const handleDone = () => {
		handleOpenChange(false);
	};

	const handleRevoke = (tokenId: string) => {
		if (!mailboxId || revokeToken.isPending) return;
		setRevokeError(null);
		revokeToken.mutate(
			{ mailboxId, tokenId },
			{
				onSuccess: () => {
					setConfirmingId(null);
				},
				onError: (error) => {
					setRevokeError(
						error instanceof Error
							? error.message
							: "Could not revoke the token.",
					);
				},
			},
		);
	};

	const tokens = data?.tokens ?? [];

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center justify-between gap-3 mb-3">
				<div className="flex items-center gap-2">
					<KeyIcon size={16} weight="duotone" className="text-kumo-subtle" />
					<span className="text-sm font-medium text-kumo-default">
						Access tokens
					</span>
				</div>
				<Button
					variant="secondary"
					size="sm"
					disabled={!mailboxId}
					onClick={openCreateDialog}
				>
					Create token
				</Button>
			</div>
			<p className="text-xs text-kumo-subtle mb-4">
				Bearer credentials for external automation. Each token reaches this
				mailbox only and carries exactly the scopes it was minted with.
			</p>

			{isError ? (
				<p className="text-xs text-kumo-subtle">
					Could not load access tokens. Reload the page to try again.
				</p>
			) : !data ? (
				<div className="flex justify-center py-4">
					<Loader size="sm" aria-label="Loading access tokens" />
				</div>
			) : tokens.length === 0 ? (
				<p className="text-xs text-kumo-subtle">
					No access tokens yet. Create one and hand it to the automation
					that should reach this mailbox.
				</p>
			) : (
				<ul className="space-y-2">
					{tokens.map((token) => (
						<li
							key={token.id}
							className="rounded-md border border-kumo-line px-3 py-2"
						>
							{confirmingId === token.id ? (
								<div className="py-0.5">
									<p className="text-xs text-kumo-default">
										Revoke "{token.name}"?
									</p>
									<p className="mt-0.5 text-[11px] leading-snug text-kumo-subtle">
										Any automation using this token stops working
										immediately.
									</p>
									<div className="mt-1.5 flex items-center gap-1.5">
										<Button
											type="button"
											variant="destructive"
											size="sm"
											disabled={revokeToken.isPending}
											onClick={() => handleRevoke(token.id)}
										>
											{revokeToken.isPending ? "Revoking..." : "Revoke"}
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onClick={() => setConfirmingId(null)}
										>
											Cancel
										</Button>
									</div>
								</div>
							) : (
								<div className="flex items-center justify-between gap-3">
									<div className="min-w-0">
										<div className="flex flex-wrap items-center gap-1.5">
											<span className="truncate text-sm text-kumo-default">
												{token.name}
											</span>
											{token.scopes.map((scope) => (
												<Badge key={scope} variant="secondary">
													{scope}
												</Badge>
											))}
										</div>
										<p className="mt-0.5 text-[11px] text-kumo-subtle">
											Created {formatDetailDate(token.created_at)} · Last used{" "}
											{token.last_used_at
												? formatDetailDate(token.last_used_at)
												: "never"}
										</p>
									</div>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={() => setConfirmingId(token.id)}
									>
										Revoke
									</Button>
								</div>
							)}
						</li>
					))}
				</ul>
			)}

			{revokeError && (
				<p className="mt-3 text-xs text-kumo-danger">{revokeError}</p>
			)}

			<Dialog.Root open={dialogOpen} onOpenChange={handleOpenChange}>
				<Dialog size="sm" className="p-6">
					{createdToken ? (
						<>
							<Dialog.Title className="text-base font-semibold mb-4">
								Token created
							</Dialog.Title>
							<p className="text-xs text-kumo-danger mb-3">
								Copy this now - it will not be shown again.
							</p>
							<div className="rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 font-mono text-[11px] break-all text-kumo-default">
								{createdToken}
							</div>
							<div className="mt-3">
								<Button
									type="button"
									variant="secondary"
									size="sm"
									icon={
										copied ? (
											<CheckIcon
												size={14}
												weight="bold"
												className="text-kumo-success"
											/>
										) : (
											<CopyIcon size={14} />
										)
									}
									onClick={handleCopy}
								>
									{copied ? "Copied" : "Copy"}
								</Button>
							</div>
							<p className="mt-4 text-xs text-kumo-subtle">
								Call the scoped API with it like this:
							</p>
							<pre className="mt-1.5 overflow-x-auto rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 font-mono text-[10px] leading-relaxed text-kumo-default">
								{CURL_EXAMPLE}
							</pre>
							<div className="mt-4 flex justify-end">
								<Button
									type="button"
									variant="primary"
									size="sm"
									onClick={handleDone}
								>
									Done
								</Button>
							</div>
						</>
					) : (
						<form
							onSubmit={(event) => {
								event.preventDefault();
								handleCreate();
							}}
						>
							<Dialog.Title className="text-base font-semibold mb-4">
								Create access token
							</Dialog.Title>
							<Input
								label="Name"
								placeholder="e.g. Alerting pipeline"
								value={name}
								onChange={(event) => setName(event.target.value)}
								required
							/>
							<div className="mt-4">
								<span className="block text-xs font-medium text-kumo-strong mb-1.5">
									Scopes
								</span>
								<div className="space-y-2">
									{SCOPES.map((scope) => (
										<Checkbox
											key={scope.value}
											label={scope.label}
											checked={scopes.includes(scope.value)}
											onCheckedChange={(checked) => {
												setScopes((current) =>
													checked
														? current.includes(scope.value)
															? current
															: [...current, scope.value]
														: current.filter(
																(entry) => entry !== scope.value,
															),
												);
											}}
										/>
									))}
								</div>
							</div>
							<p className="mt-3 text-xs text-kumo-subtle">
								Scopes are fixed when the token is minted — revoke it to
								change what the client may do.
							</p>
							{createError && (
								<p className="mt-3 text-xs text-kumo-danger">{createError}</p>
							)}
							<div className="mt-4 flex justify-end gap-2">
								<Dialog.Close
									render={({ className, ...props }) => (
										<Button
											{...props}
											{...(className ? { className } : {})}
											variant="secondary"
										>
											Cancel
										</Button>
									)}
								/>
								<Button
									type="submit"
									variant="primary"
									disabled={!canCreate}
									loading={createToken.isPending}
								>
									Create
								</Button>
							</div>
						</form>
					)}
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
