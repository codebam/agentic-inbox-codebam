// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import {
	Button,
	Dialog,
	Input,
	Loader,
	Select,
	Text,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	CaretRightIcon,
	CheckCircleIcon,
	CircleIcon,
	EnvelopeIcon,
	EnvelopeOpenIcon,
	GearSixIcon,
	PlusIcon,
	TrashIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link as RouterLink } from "react-router";
import { isCatchAllAddress } from "shared/mailboxes";
import api from "~/services/api";
import {
	useCreateMailbox,
	useDeleteMailbox,
	useMailboxes,
} from "~/queries/mailboxes";
import { queryKeys } from "~/queries/keys";


const CHECKLIST_DISMISSED_KEY = "agentic-inbox:get-started-dismissed";

export function meta() {
	return [{ title: "Agentic Inbox Codebam" }];
}


export default function HomeRoute() {
	const toastManager = useKumoToastManager();
	const { data: mailboxes = [], refetch: refetchMailboxes, isFetched: mailboxesFetched } = useMailboxes();
	const createMailbox = useCreateMailbox();
	const deleteMailbox = useDeleteMailbox();


	const { data: configData } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity, // config rarely changes
	});


	// Memoised so the dependency lists below see a stable array per config load.
	const domains = useMemo(() => configData?.domains ?? [], [configData]);
	const emailAddresses = useMemo(() => configData?.emailAddresses ?? [], [configData]);
	const catchAllMailboxes = useMemo(() => configData?.catchAllMailboxes ?? [], [configData]);
	const configuredMailboxAddresses = useMemo(
		() => [...new Set([...emailAddresses, ...catchAllMailboxes])],
		[emailAddresses, catchAllMailboxes],
	);
	const catchAllAddresses = useMemo(
		() => new Set(catchAllMailboxes.map((address) => address.toLowerCase())),
		[catchAllMailboxes],
	);


	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [newPrefix, setNewPrefix] = useState("");
	const [domainChoice, setDomainChoice] = useState("");
	const [newName, setNewName] = useState("");
	const [isCreating, setIsCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [mailboxToDelete, setMailboxToDelete] = useState<{
		id: string;
		email: string;
	} | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);


	// The first configured domain stands in until the user picks one, so the
	// default is derived during render rather than seeded from an effect.
	const selectedDomain = domainChoice || domains[0] || "";


	// Auto-create configured mailboxes, including the per-domain catch-all
	// mailboxes, once both config and the current mailbox list are ready.
	const autoCreateDone = useRef(false);
	useEffect(() => {
		if (autoCreateDone.current) return;
		if (!configData || !mailboxesFetched) return;
		if (configuredMailboxAddresses.length === 0) {
			autoCreateDone.current = true;
			return;
		}
		const existingEmails = new Set(
			mailboxes.map((m) => m.email.toLowerCase()),
		);
		const toCreate = configuredMailboxAddresses.filter(
			(addr) => !existingEmails.has(addr.toLowerCase()),
		);
		if (toCreate.length === 0) {
			autoCreateDone.current = true;
			return;
		}
		autoCreateDone.current = true;
		let cancelled = false;
		void Promise.allSettled(
			toCreate.map((addr) => {
				const localPart = addr.split("@")[0] || addr;
				const name = isCatchAllAddress(addr) ? "Catch-all" : localPart;
				return api.createMailbox(addr, name);
			}),
		).then((results) => {
			if (cancelled) return;
			// Surface auto-create failures instead of swallowing them: log each
			// failure and toast the count so a missing mailbox is obvious.
			const failures = results
				.map((result, index) => ({ result, addr: toCreate[index] }))
				.filter(
					(x): x is { result: PromiseRejectedResult; addr: string } =>
						x.result.status === "rejected",
				);
			if (failures.length > 0) {
				for (const { result, addr } of failures) {
					console.error(`Auto-create mailbox failed for ${addr}:`, result.reason);
				}
				const firstReason: unknown = failures[0]?.result.reason;
				const detail =
					firstReason instanceof Error
						? firstReason.message
						: typeof firstReason === "string"
							? firstReason
							: "unknown error";
				toastManager.add({
					title: `Failed to create ${failures.length} mailbox${
						failures.length === 1 ? "" : "es"
					}: ${detail}`,
					variant: "error",
				});
			}
			void refetchMailboxes();
		});
		return () => { cancelled = true; };
	}, [configData, configuredMailboxAddresses, mailboxes, mailboxesFetched, refetchMailboxes, toastManager]);


	const handleCreate = async (e: FormEvent) => {
		e.preventDefault();
		setCreateError(null);
		if (!newPrefix || !selectedDomain) {
			setCreateError("Please fill in all fields");
			return;
		}
		const email = `${newPrefix}@${selectedDomain}`;
		const name = newName || newPrefix;
		setIsCreating(true);
		try {
			await createMailbox.mutateAsync({ email, name });
			toastManager.add({ title: "Mailbox created successfully!" });
			setIsCreateOpen(false);
			setNewPrefix("");
			setNewName("");
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to create mailbox";
			setCreateError(message);
		} finally {
			setIsCreating(false);
		}
	};


	const handleDelete = async () => {
		if (!mailboxToDelete) return;
		setIsDeleting(true);
		try {
			await deleteMailbox.mutateAsync(mailboxToDelete.id);
			toastManager.add({ title: "Mailbox deleted" });
			setIsDeleteOpen(false);
			setMailboxToDelete(null);
		} catch {
			toastManager.add({ title: "Failed to delete mailbox", variant: "error" });
		} finally {
			setIsDeleting(false);
		}
	};


	const isConfigured = emailAddresses.length > 0;
	const accounts = isConfigured
		? configuredMailboxAddresses.map((addr) => ({
				id: addr,
				email: addr,
				name: isCatchAllAddress(addr) ? "Catch-all" : addr.split("@")[0] || addr,
			}))
		: mailboxes;


	const isLoading = !configData;

	// First-run checklist: every step reads from /config or the mailbox list
	// (plus a Sent-folder probe and the push-config endpoint), so it needs no
	// new server state. The card disappears once all five steps are done.
	const firstMailbox = mailboxes[0];
	const { data: pushConfig } = useQuery({
		queryKey: ["push-config-check"],
		queryFn: () => api.getPushConfig(),
		staleTime: 60_000,
		retry: false,
	});
	const { data: sentCount } = useQuery({
		queryKey: ["sent-check", firstMailbox?.id ?? "none"],
		queryFn: async () => {
			const data = await api.listEmails(firstMailbox!.id, {
				folder: "sent",
				limit: "1",
			});
			if (data && typeof data === "object" && "totalCount" in data) {
				return (data as { totalCount: number | undefined }).totalCount ?? 0;
			}
			return Array.isArray(data) ? data.length : 0;
		},
		enabled: !!firstMailbox?.id,
		staleTime: 30_000,
		retry: false,
	});
	const routingDone =
		domains.length > 0 || emailAddresses.length > 0;
	const mailboxDone = mailboxes.length > 0;
	const sendTestDone = (sentCount ?? 0) > 0;
	const signatureDone = mailboxes.some((m) => {
		const s = m.settings?.signature;
		return (
			!!s?.enabled && (!!s.text?.trim() || !!s.html?.trim())
		);
	});
	const pushDone = pushConfig?.enabled === true;
	const checklistSteps = [
		{
			label: "Email routing",
			description:
				routingDone && domains.length > 0
					? `Domains configured: ${domains.join(", ")}`
					: routingDone
						? "Email addresses configured"
						: "Ask the operator to set DOMAINS / EMAIL_ADDRESSES, or create a mailbox below.",
			done: routingDone,
			href: "/settings",
			linkLabel: "Global settings",
		},
		{
			label: "Create a mailbox",
			description: mailboxDone
				? `${mailboxes.length} mailbox${mailboxes.length === 1 ? "" : "es"} ready`
				: "Create your first mailbox to send and receive email.",
			done: mailboxDone,
			href: undefined,
			linkLabel: undefined,
		},
		{
			label: "Send a test message",
			description: sendTestDone
				? "Test message found in Sent"
				: "Open a mailbox and send yourself a test email.",
			done: sendTestDone,
			href: firstMailbox ? `/mailbox/${firstMailbox.id}` : undefined,
			linkLabel: firstMailbox ? "Open mailbox" : undefined,
		},
		{
			label: "Add a signature",
			description: signatureDone
				? "Signature is on"
				: "Set your display name and signature in mailbox settings.",
			done: signatureDone,
			href: firstMailbox
				? `/mailbox/${firstMailbox.id}/settings`
				: undefined,
			linkLabel: firstMailbox ? "Mailbox settings" : undefined,
		},
		{
			label: "Enable push notifications",
			description: pushDone
				? "Server push is configured — enable it per mailbox"
				: "Push needs a VAPID key on the server, then enable it in mailbox settings.",
			done: pushDone,
			href: firstMailbox
				? `/mailbox/${firstMailbox.id}/settings`
				: undefined,
			linkLabel: firstMailbox ? "Mailbox settings" : undefined,
		},
	] as const;
	// Dismissed checklist: pinned in localStorage so opting out (e.g. no
	// signature, no test email needed) survives reloads. Guarded for SSR,
	// where localStorage does not exist — first paint shows the card, and
	// the real value is read in the lazy initializer on the client.
	const [checklistDismissed, setChecklistDismissed] = useState(
		() =>
			typeof window !== "undefined" &&
			window.localStorage.getItem(CHECKLIST_DISMISSED_KEY) === "1",
	);
	const dismissChecklist = () => {
		setChecklistDismissed(true);
		window.localStorage.setItem(CHECKLIST_DISMISSED_KEY, "1");
	};
	const checklistDoneCount = checklistSteps.filter((s) => s.done).length;
	const showChecklist =
		!isLoading &&
		!checklistDismissed &&
		checklistDoneCount < checklistSteps.length;

	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
				<div className="mb-8">
					<div className="flex items-center justify-between">
						<h1 className="text-2xl font-bold text-kumo-default">Mailboxes</h1>
						<div className="flex items-center gap-3">
							<RouterLink
								to="/settings"
								className="inline-flex items-center gap-1.5 text-sm text-kumo-subtle hover:text-kumo-default no-underline transition-colors"
							>
								<GearSixIcon size={16} />
								<span>Global settings</span>
							</RouterLink>
							{!isConfigured && (
								<Button
									variant="primary"
									icon={<PlusIcon size={16} />}
									onClick={() => setIsCreateOpen(true)}
								>
									New Mailbox
								</Button>
							)}
						</div>
					</div>
					{domains.length > 0 && (
						<p className="text-sm text-kumo-subtle mt-1">
							{domains.join(", ")}
						</p>
					)}
				</div>

				{showChecklist && (
					<div className="rounded-xl border border-kumo-line bg-kumo-base p-5 mb-8">
						<div className="flex items-center justify-between mb-2">
							<h2 className="text-base font-semibold text-kumo-default">
								Get started
							</h2>
							<div className="flex items-center gap-2">
								<span className="text-xs text-kumo-subtle">
									{checklistDoneCount} of {checklistSteps.length} complete
								</span>
								<Button
									variant="ghost"
									size="sm"
									shape="square"
									icon={<XIcon size={16} />}
									aria-label="Dismiss get started checklist"
									onClick={dismissChecklist}
								/>
							</div>
						</div>
						<div
							className="h-1.5 rounded-full bg-kumo-fill overflow-hidden mb-4"
							role="progressbar"
							aria-valuemin={0}
							aria-valuemax={checklistSteps.length}
							aria-valuenow={checklistDoneCount}
						>
							<div
								className="h-full bg-kumo-fill-strong"
								style={{
									width: `${(checklistDoneCount / checklistSteps.length) * 100}%`,
								}}
							/>
						</div>
						<ul className="space-y-3">
							{checklistSteps.map((step) => (
								<li key={step.label} className="flex items-start gap-3">
									{step.done ? (
										<CheckCircleIcon
											size={18}
											weight="fill"
											className="mt-0.5 shrink-0 text-kumo-subtle"
											aria-label="done"
										/>
									) : (
										<CircleIcon
											size={18}
											className="mt-0.5 shrink-0 text-kumo-subtle"
											aria-label="todo"
										/>
									)}
									<div className="min-w-0 flex-1">
										<div className="text-sm font-medium text-kumo-default">
											{step.label}
										</div>
										<div className="text-sm text-kumo-subtle">
											{step.description}
										</div>
									</div>
									{!step.done && step.href && step.linkLabel && (
										<RouterLink
											to={step.href}
											className="shrink-0 text-xs text-kumo-subtle hover:text-kumo-default no-underline"
										>
											{step.linkLabel} →
										</RouterLink>
									)}
									{!step.done &&
										!step.href &&
										step.label === "Create a mailbox" &&
										!isConfigured && (
											<Button
												variant="secondary"
												size="xs"
												onClick={() => setIsCreateOpen(true)}
											>
												Create
											</Button>
										)}
								</li>
							))}
						</ul>
						<div className="mt-4 flex justify-end">
							<Button
								variant="ghost"
								size="sm"
								onClick={dismissChecklist}
							>
								Don&apos;t show again
							</Button>
						</div>
					</div>
				)}

				{isLoading ? (
					<div className="flex justify-center py-20">
						<Loader size="lg" />
					</div>
				) : accounts.length > 0 ? (
					<div className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden">
						<RouterLink
							to="/all"
							className="group flex items-center gap-4 px-5 py-4 no-underline transition-colors hover:bg-kumo-tint"
						>
							<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-kumo-default">
								<EnvelopeOpenIcon size={20} />
							</div>
							<div className="min-w-0 flex-1">
								<div className="text-sm font-medium text-kumo-default">
									All Accounts
								</div>
								<div className="text-sm text-kumo-subtle truncate">
									See emails from all {accounts.length} mailbox
									{accounts.length === 1 ? "" : "es"} in one place
								</div>
							</div>
							<CaretRightIcon
								size={16}
								className="shrink-0 text-kumo-subtle"
							/>
						</RouterLink>
						{accounts.map((account) => (
							<RouterLink
								key={account.id}
								to={`/mailbox/${account.id}`}
								className="group flex items-center gap-4 px-5 py-4 no-underline transition-colors hover:bg-kumo-tint border-t border-kumo-line"
							>
								<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-sm font-bold text-kumo-default">
									{account.name.charAt(0).toUpperCase()}
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<div className="text-sm font-medium text-kumo-default truncate">
											{account.name}
										</div>
										{(isCatchAllAddress(account.email) ||
											catchAllAddresses.has(account.email.toLowerCase())) && (
											<span className="shrink-0 rounded-full bg-kumo-fill px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-kumo-subtle">
												Catch-all
											</span>
										)}
									</div>
									<div className="text-sm text-kumo-subtle">
										{account.email}
									</div>
								</div>
								{!isConfigured &&
									!isCatchAllAddress(account.email) &&
									!catchAllAddresses.has(account.email.toLowerCase()) && (
									<Button
										variant="ghost"
										size="sm"
										shape="square"
										icon={<TrashIcon size={16} />}
										aria-label={`Delete mailbox ${account.email}`}
										onClick={(e) => {
											e.preventDefault();
											e.stopPropagation();
											setMailboxToDelete({
												id: account.id,
												email: account.email,
											});
											setIsDeleteOpen(true);
										}}
									/>
								)}
							</RouterLink>
						))}
					</div>
				) : (
					<div className="rounded-xl border border-kumo-line bg-kumo-base py-16 px-6">
						<div className="flex flex-col items-center text-center">
							<div className="mb-4">
								<EnvelopeIcon
									size={48}
									weight="thin"
									className="text-kumo-subtle"
								/>
							</div>
							<h3 className="text-base font-semibold text-kumo-default mb-1.5">
								No mailboxes yet
							</h3>
							<p className="text-sm text-kumo-subtle max-w-sm mb-5">
								{isConfigured
									? "Your email routing is configured but no mailboxes have been created yet. They will appear here automatically."
									: "Create a mailbox to start sending and receiving emails with your domain."}
							</p>
							{!isConfigured && (
								<Button
									variant="primary"
									icon={<PlusIcon size={16} />}
									onClick={() => setIsCreateOpen(true)}
								>
									Create Mailbox
								</Button>
							)}
						</div>
					</div>
				)}
			</div>


			{/* Create Dialog */}
			<Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-5">
						Create New Mailbox
					</Dialog.Title>
					<form onSubmit={(e) => void handleCreate(e)} className="space-y-4">
						{createError && (
							<Text variant="error" size="sm">
								{createError}
							</Text>
						)}
						<div>
							<span className="text-sm font-medium text-kumo-default mb-1.5 block">
								Email Address
							</span>
							<div className="flex items-center gap-2">
								<div className="flex-1">
									<Input
										aria-label="Address prefix"
										placeholder="info"
										size="sm"
										value={newPrefix}
										onChange={(e) => setNewPrefix(e.target.value)}
										required
									/>
								</div>
								<span className="text-sm text-kumo-subtle">@</span>
								{domains.length > 1 ? (
									<div className="flex-1">
							<Select
								aria-label="Domain"
								value={selectedDomain}
								onValueChange={(value) => {
									if (value) setDomainChoice(value);
								}}
							>
											{domains.map((d) => (
												<Select.Option key={d} value={d}>
													{d}
												</Select.Option>
											))}
										</Select>
									</div>
								) : (
									<span className="text-sm text-kumo-subtle">
										{selectedDomain || "no domain"}
									</span>
								)}
							</div>
						</div>
						<Input
							label="Display Name (optional)"
							placeholder="Info"
							size="sm"
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
						/>
						<div className="flex justify-end gap-2 pt-2">
							<Dialog.Close
								render={({ className, ...props }) => (
									<Button {...props} {...(className ? { className } : {})} variant="secondary" size="sm">
										Cancel
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								size="sm"
								loading={isCreating}
								disabled={!selectedDomain}
							>
								Create
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>


			{/* Delete Dialog */}
			<Dialog.Root
				open={isDeleteOpen}
				onOpenChange={(open) => {
					setIsDeleteOpen(open);
					if (!open) setMailboxToDelete(null);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-2">
						Delete Mailbox
					</Dialog.Title>
					<Dialog.Description className="text-kumo-subtle text-sm mb-5">
						Are you sure you want to delete{" "}
						<strong className="text-kumo-default">
							{mailboxToDelete?.email}
						</strong>
						? This action cannot be undone.
					</Dialog.Description>
					<div className="flex justify-end gap-2">
						<Dialog.Close
							render={({ className, ...props }) => (
								<Button {...props} {...(className ? { className } : {})} variant="secondary" size="sm">
									Cancel
								</Button>
							)}
						/>
						<Button
							variant="destructive"
							size="sm"
							loading={isDeleting}
							onClick={() => void handleDelete()}
						>
							Delete
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}

