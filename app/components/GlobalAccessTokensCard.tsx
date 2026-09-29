// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Badge,
	Button,
	Checkbox,
	Dialog,
	Input,
	Loader,
	useKumoToastManager,
} from "@cloudflare/kumo";
import { CheckIcon, CopyIcon, KeyIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { formatDetailDate } from "shared/dates";
import {
	useAppTokens,
	useCreateAppToken,
	useRevokeAppToken,
} from "~/queries/app-tokens";
import type { AppAccessToken } from "~/services/api";

/** The scopes a token can carry, in the order the create dialog lists them. */
const SCOPES = [
	{ value: "read", label: "Read mail, threads, search and attachments" },
	{ value: "draft", label: "Create, update and discard drafts" },
	{
		value: "send",
		label: "Send mail and replies (the operator's send guards still apply)",
	},
] as const;

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
 * App-level access tokens: bearer credentials for automation that runs
 * outside Cloudflare Access and must reach EVERY mailbox in the deployment.
 *
 * Minting and revoking are immediate actions — each one calls the API on the
 * spot and is deliberately independent of the page's Save Global Settings
 * button, which never touches these tokens. The plaintext is shown exactly
 * once, right after creation; the server stores only a hash. Tokens that
 * should reach a single mailbox are minted in that mailbox's own Settings
 * instead, never here.
 */
export default function GlobalAccessTokensCard() {
	const toastManager = useKumoToastManager();
	const { data, isError } = useAppTokens();
	const createToken = useCreateAppToken();
	const revokeToken = useRevokeAppToken();

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
		if (!canCreate) return;
		const trimmedName = name.trim();
		setCreateError(null);
		createToken.mutate(
			{ name: trimmedName, scopes },
			{
				onSuccess: (result) => {
					setCreatedToken(result.token);
					toastManager.add({
						title: `App token "${trimmedName}" created`,
					});
				},
				onError: (error) => {
					setCreateError(
						error instanceof Error
							? error.message
							: "Could not create the app token.",
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

	const handleRevoke = (token: AppAccessToken) => {
		if (revokeToken.isPending) return;
		setRevokeError(null);
		revokeToken.mutate(token.id, {
			onSuccess: () => {
				setConfirmingId(null);
				toastManager.add({
					title: `Revoked app token "${token.name}"`,
				});
			},
			onError: (error) => {
				setRevokeError(
					error instanceof Error
						? error.message
						: "Could not revoke the app token.",
				);
			},
		});
	};

	const tokens = data?.tokens ?? [];

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center justify-between gap-3 mb-3">
				<div className="flex items-center gap-2">
					<KeyIcon size={16} weight="duotone" className="text-kumo-subtle" />
					<span className="text-sm font-medium text-kumo-default">
						App access tokens
					</span>
				</div>
				<Button variant="secondary" size="sm" onClick={openCreateDialog}>
					Create token
				</Button>
			</div>
			<p className="text-xs text-kumo-subtle mb-4">
				Bearer credentials for automation outside Cloudflare Access. Each app
				token reaches every mailbox in this deployment, carrying read, draft
				and send exactly as scoped when it is minted. To reach one mailbox
				only, mint the token in that mailbox's Settings instead.
			</p>

			{isError ? (
				<p className="text-xs text-kumo-subtle">
					Could not load app tokens. Reload the page to try again.
				</p>
			) : !data ? (
				<div className="flex justify-center py-4">
					<Loader size="sm" aria-label="Loading app tokens" />
				</div>
			) : tokens.length === 0 ? (
				<p className="text-xs text-kumo-subtle">
					No app tokens yet. Create one and hand it to the automation that
					should reach every mailbox.
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
										Any automation using this token, in any mailbox,
										stops working immediately.
									</p>
									<div className="mt-1.5 flex items-center gap-1.5">
										<Button
											type="button"
											variant="destructive"
											size="sm"
											disabled={revokeToken.isPending}
											onClick={() => handleRevoke(token)}
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
								App token created
							</Dialog.Title>
							<p className="text-xs text-kumo-danger mb-3">
								Copy this now - it will not be shown again. Anyone
								holding it can act on every mailbox.
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
								Create app token
							</Dialog.Title>
							<Input
								label="Name"
								placeholder="e.g. Global alerting pipeline"
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
							{/* The server caps app tokens at 20; no shared constant for it yet. */}
							<p className="mt-3 text-xs text-kumo-subtle">
								Scopes are fixed when the token is minted — revoke it to
								change what the client may do. Up to 20 app tokens can
								exist at once.
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
