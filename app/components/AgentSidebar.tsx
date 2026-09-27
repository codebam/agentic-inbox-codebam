// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Loader } from "@cloudflare/kumo";
import { PlugsIcon, RobotIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useConfig } from "~/queries/config";
import MCPPanel from "./MCPPanel";

function LazyAgentPanel() {
	const [AgentChat, setAgentChat] = useState<React.ComponentType | null>(
		null,
	);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		import("~/components/AgentPanel").then((mod) => {
			setAgentChat(() => mod.default);
		}).catch((err) => {
			console.error("Failed to load AgentPanel:", err);
			setLoadError("Failed to load agent panel");
		});
	}, []);

	if (loadError) {
		return (
			<div className="flex items-center justify-center h-full">
				<span className="text-xs text-kumo-error">{loadError}</span>
			</div>
		);
	}
	if (!AgentChat) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-2">
				<Loader size="base" />
				<span className="text-xs text-kumo-subtle">Loading agent...</span>
			</div>
		);
	}
	return <AgentChat />;
}

export default function AgentSidebar() {
	const { data: config } = useConfig();
	// Default to enabled while config loads, so the first paint matches
	// today's behaviour and nothing flashes in or out.
	const agentEnabled = config?.agentEnabled ?? true;
	const mcpEnabled = config?.mcpEnabled ?? true;
	const [requestedTab, setRequestedTab] = useState<"agent" | "mcp">("agent");

	// Derived during render rather than stored: a requested tab whose flag is
	// off falls back to the other enabled tab, and with exactly one surface
	// enabled that surface is the active tab.
	const activeTab =
		requestedTab === "agent" && !agentEnabled
			? "mcp"
			: requestedTab === "mcp" && !mcpEnabled
				? "agent"
				: requestedTab;

	// With neither surface available the route still mounts the panel; render
	// nothing rather than an empty tab bar.
	if (!agentEnabled && !mcpEnabled) return null;

	return (
		<div className="flex flex-col h-full">
			{/* Tab bar — only the surfaces this deployment enabled */}
			<div className="flex items-center border-b border-kumo-line shrink-0">
				{agentEnabled && (
					<button
						type="button"
						onClick={() => setRequestedTab("agent")}
						className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 bg-transparent cursor-pointer ${
							activeTab === "agent"
								? "border-kumo-brand text-kumo-default"
								: "border-transparent text-kumo-subtle hover:text-kumo-default"
						}`}
					>
						<RobotIcon size={14} weight={activeTab === "agent" ? "fill" : "regular"} />
						Agent
					</button>
				)}
				{mcpEnabled && (
					<button
						type="button"
						onClick={() => setRequestedTab("mcp")}
						className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 bg-transparent cursor-pointer ${
							activeTab === "mcp"
								? "border-kumo-brand text-kumo-default"
								: "border-transparent text-kumo-subtle hover:text-kumo-default"
						}`}
					>
						<PlugsIcon size={14} weight={activeTab === "mcp" ? "fill" : "regular"} />
						MCP
					</button>
				)}
			</div>

			{/* Tab content — keep agent mounted so chat isn't lost */}
			<div className="flex-1 min-h-0 overflow-hidden">
				{agentEnabled && (
					<div className={activeTab === "agent" ? "h-full" : "hidden"}>
						<LazyAgentPanel />
					</div>
				)}
				{activeTab === "mcp" && <MCPPanel />}
			</div>
		</div>
	);
}
