// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, Tooltip } from "@cloudflare/kumo";
import { GearSixIcon, ListIcon, MagnifyingGlassIcon, RobotIcon, XIcon } from "@phosphor-icons/react";
import { type KeyboardEvent, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import SemanticSearchToggle, { isSemanticMode, SEMANTIC_MODE_PARAM, SEMANTIC_MODE_VALUE } from "~/components/SemanticSearchToggle";
import { useUIStore } from "~/hooks/useUIStore";
import { useConfig } from "~/queries/config";

export default function Header() {
	const [searchQuery, setSearchQuery] = useState("");
	const [isSearchExpanded, setIsSearchExpanded] = useState(false);
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const navigate = useNavigate();
	const location = useLocation();
	const [searchParams] = useSearchParams();
	const { toggleSidebar, toggleAgentPanel, isAgentPanelOpen } = useUIStore();
	const { data: config } = useConfig();
	// The panel holds the agent chat and the MCP panel, so the toggle is only
	// pointless once both surfaces are off. While config loads (undefined) the
	// button keeps today's always-visible behaviour.
	const showAgentPanel = config === undefined || config.agentEnabled || config.mcpEnabled;

	// Sync search input with URL query param so it stays populated. The
	// adjustment happens during render (the same place React recommends for
	// resetting state from props) so the input never paints behind the URL.
	const urlQuery = searchParams.get("q") || "";
	const semanticMode = isSemanticMode(searchParams);
	const searchRouteKey = `${location.pathname}|${urlQuery}`;
	const [syncedSearchRoute, setSyncedSearchRoute] = useState(searchRouteKey);
	if (syncedSearchRoute !== searchRouteKey) {
		setSyncedSearchRoute(searchRouteKey);
		if (location.pathname.includes("/search") && urlQuery) {
			setSearchQuery(urlQuery);
		}
	}

	const performSearch = () => {
		const q = searchQuery.trim();
		if (!q) return;
		// Without a mailbox in scope (All Accounts), search every mailbox.
		// Semantic mode is per mailbox, so it rides along only where one is
		// in scope.
		const params = new URLSearchParams({ q });
		if (mailboxId && semanticMode) {
			params.set(SEMANTIC_MODE_PARAM, SEMANTIC_MODE_VALUE);
		}
		void navigate(
			mailboxId ? `/mailbox/${mailboxId}/search?${params}` : `/search?${params}`,
		);
		setIsSearchExpanded(false);
	};

	const clearSearch = () => {
		setSearchQuery("");
		if (location.pathname.includes("/search")) {
			void navigate(mailboxId ? `/mailbox/${mailboxId}/emails/inbox` : "/all");
		}
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Enter") {
			performSearch();
		}
		if (e.key === "Escape") {
			if (searchQuery) {
				clearSearch();
			} else {
				setIsSearchExpanded(false);
			}
		}
	};

	const isSettingsActive = location.pathname.includes("/settings");

	return (
		<header className="flex items-center gap-2 px-3 py-2 bg-kumo-base border-b border-kumo-line sticky top-0 z-10 md:px-4">
			{/* Hamburger menu - mobile only */}
			<Button
				variant="ghost"
				shape="square"
				size="sm"
				icon={<ListIcon size={20} />}
				onClick={toggleSidebar}
				aria-label="Toggle sidebar"
				className="md:hidden shrink-0"
			/>

			{/* Search pill - full on desktop, collapsible on mobile. The
			    rounded-full tinted container is the pill; the Kumo Input
			    inside is made borderless/transparent so the tint shows. */}
			<div
				className={`flex-1 max-w-lg mx-auto transition-all flex items-center ${
					isSearchExpanded ? "flex" : "hidden md:flex"
				}`}
			>
				<div className="flex-1 flex items-center gap-2 rounded-full bg-kumo-tint pl-3 pr-1 py-1 transition-shadow focus-within:ring-1 focus-within:ring-kumo-ring">
					<button
						type="button"
						onClick={performSearch}
						aria-label="Search"
						className="shrink-0 rounded-full p-1 text-kumo-subtle hover:text-kumo-default transition-colors"
					>
						<MagnifyingGlassIcon size={18} />
					</button>
					<Input
						className="w-full rounded-full bg-transparent border-0 ring-0 shadow-none"
						aria-label="Search emails"
						placeholder="Search emails... (try from:name, is:unread, has:attachment)"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						onKeyDown={handleKeyDown}
					/>
					{searchQuery && (
						<button
							type="button"
							onClick={clearSearch}
							className="shrink-0 p-1 rounded-full text-kumo-subtle hover:text-kumo-default transition-colors"
							aria-label="Clear search"
						>
							<XIcon size={14} />
						</button>
					)}
				</div>
				{mailboxId && (
					<span className="ml-2 shrink-0">
						<SemanticSearchToggle />
					</span>
				)}
			</div>

			{/* Search toggle button - mobile only, hidden when search is expanded */}
			{!isSearchExpanded && (
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={<MagnifyingGlassIcon size={20} />}
					onClick={() => setIsSearchExpanded(true)}
					aria-label="Search"
					className="md:hidden shrink-0"
				/>
			)}

			<div className="flex items-center gap-0.5 ml-auto shrink-0">
				<span aria-hidden="true" className="mx-1.5 h-5 w-px bg-kumo-line hidden md:block" />
				{showAgentPanel && (
					<Tooltip content={isAgentPanelOpen ? "Hide agent panel" : "Show agent panel"} side="bottom" asChild>
						<Button
							variant={isAgentPanelOpen ? "secondary" : "ghost"}
							shape="square"
							icon={<RobotIcon size={20} />}
							onClick={toggleAgentPanel}
							aria-label="Toggle agent panel"
							className="hidden lg:inline-flex"
						/>
					</Tooltip>
				)}
				<Tooltip content="Settings" side="bottom" asChild>
					<Button
						variant={isSettingsActive ? "secondary" : "ghost"}
						shape="square"
						icon={<GearSixIcon size={20} />}
						onClick={() => {
							void navigate(
								isSettingsActive
									? `/mailbox/${mailboxId}/emails/inbox`
									: `/mailbox/${mailboxId}/settings`,
							);
						}}
						aria-label="Settings"
					/>
				</Tooltip>
			</div>
		</header>
	);
}
