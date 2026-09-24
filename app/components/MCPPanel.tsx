// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip } from "@cloudflare/kumo";
import { CheckIcon, CopyIcon, KeyIcon, PlugsIcon, WrenchIcon } from "@phosphor-icons/react";
import { useState } from "react";

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// Clipboard API unavailable or permission denied — ignore silently
		}
	};

	return (
		<Tooltip content={copied ? "Copied!" : "Copy"} asChild>
			<Button
				variant="ghost"
				shape="square"
				size="sm"
				icon={
					copied ? (
						<CheckIcon size={12} weight="bold" className="text-kumo-success" />
					) : (
						<CopyIcon size={12} />
					)
				}
				onClick={handleCopy}
				aria-label="Copy to clipboard"
			/>
		</Tooltip>
	);
}

const TOOLS = [
	{ name: "list_mailboxes", desc: "List mailboxes" },
	{ name: "list_emails", desc: "List folder messages" },
	{ name: "get_email", desc: "Read one email" },
	{ name: "get_thread", desc: "Read a conversation" },
	{ name: "search_emails", desc: "Search subject and body" },
	{ name: "draft_reply", desc: "Draft a reply" },
	{ name: "create_draft", desc: "Create a new draft" },
	{ name: "update_draft", desc: "Update a draft" },
	{ name: "send_reply", desc: "Send a reply" },
	{ name: "send_email", desc: "Send a new email" },
	{ name: "mark_email_read", desc: "Toggle read state" },
	{ name: "move_email", desc: "Move to a folder" },
	{ name: "delete_email", desc: "Delete an email" },
];

const BRIDGE_PATH = "/path/to/agentic-inbox-codebam/scripts/mcp-bridge.mjs";

export default function MCPPanel() {
	const baseUrl =
		typeof window !== "undefined" ? window.location.origin : "https://your-app.workers.dev";
	const mcpUrl = `${baseUrl}/mcp`;
	const bridgeConfig = JSON.stringify(
		{
			mcpServers: {
				"agentic-inbox-codebam": {
					command: "node",
					args: [BRIDGE_PATH, "--url", mcpUrl],
				},
			},
		},
		null,
		2,
	);

	return (
		<div className="flex flex-col h-full">
			{/* Content */}
			<div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
				{/* Intro */}
				<div className="space-y-2">
					<div className="flex items-center gap-2">
						<div className="flex h-10 w-10 items-center justify-center rounded-xl bg-kumo-brand/10">
							<PlugsIcon size={20} weight="duotone" className="text-kumo-brand" />
						</div>
						<div>
							<h3 className="text-sm font-semibold text-kumo-default">
								Connect via MCP
							</h3>
							<p className="text-xs text-kumo-subtle">Model Context Protocol</p>
						</div>
					</div>
					<p className="text-xs text-kumo-subtle leading-relaxed">
						This email agent exposes an MCP server so AI coding assistants can manage
						your inbox directly — read emails, search, draft replies, and send messages
						using natural language.
					</p>
				</div>

				{/* MCP URL */}
				<div className="space-y-1.5">
					<label className="text-xs font-medium text-kumo-strong block">Server URL</label>
					<div className="relative group">
						<div className="absolute right-1.5 top-1/2 -translate-y-1/2">
							<CopyButton text={mcpUrl} />
						</div>
						<div className="bg-kumo-recessed text-kumo-default font-mono text-[11px] px-3 py-2.5 pr-10 rounded-lg border border-kumo-line break-all leading-relaxed">
							{mcpUrl}
						</div>
					</div>
				</div>

				{/* Agent authentication */}
				<div className="space-y-2 border-t border-kumo-line pt-4">
					<div className="flex items-center gap-2">
						<KeyIcon size={14} weight="duotone" className="text-kumo-brand" />
						<h4 className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle">
							Wrangler login
						</h4>
					</div>
					<p className="text-xs text-kumo-subtle leading-relaxed">
						Agents authenticate with the Cloudflare credential already on your machine.
						Use the bundled stdio bridge and it will read{" "}
						<code className="font-mono text-[11px]">npx wrangler auth token</code>{" "}
						automatically. Nothing is written to disk.
					</p>
					<div className="relative group">
						<div className="absolute right-1.5 top-1.5">
							<CopyButton text={bridgeConfig} />
						</div>
						<pre className="bg-kumo-recessed text-kumo-default font-mono text-[10px] p-3 pr-10 rounded-lg border border-kumo-line overflow-x-auto leading-relaxed">
							{bridgeConfig}
						</pre>
					</div>
					<p className="text-[11px] text-kumo-subtle leading-relaxed">
						Replace <code className="font-mono">{BRIDGE_PATH}</code> with the absolute
						path to this repository. Clients that support remote MCP servers can run{" "}
						<code className="font-mono">npx wrangler auth token</code> themselves and
						send the result as{" "}
						<code className="font-mono">Authorization: Bearer &lt;token&gt;</code>.
					</p>
				</div>

				{/* Available tools */}
				<div className="space-y-2 border-t border-kumo-line pt-4">
					<h4 className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle px-0.5">
						Available Tools
					</h4>
					<div className="border border-kumo-line rounded-lg divide-y divide-kumo-line">
						{TOOLS.map((tool) => (
							<div key={tool.name} className="flex items-center gap-2.5 px-3 py-2">
								<WrenchIcon
									size={12}
									weight="bold"
									className="text-kumo-brand shrink-0"
								/>
								<div className="min-w-0 flex-1">
									<span className="text-xs font-mono font-medium text-kumo-default">
										{tool.name}
									</span>
								</div>
								<span className="text-[11px] text-kumo-subtle shrink-0">
									{tool.desc}
								</span>
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
