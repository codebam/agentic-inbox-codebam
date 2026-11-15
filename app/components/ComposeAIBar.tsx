// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, Loader } from "@cloudflare/kumo";
import { SparkleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import api from "~/services/api";

interface ComposeAIBarProps {
	mailboxId: string;
	/** The current draft body (HTML); the rewrite reads and replaces it. */
	body: string;
	onRewrite: (newBody: string) => void;
}

const QUICK_ACTIONS = [
	{ action: "polish", label: "Polish" },
	{ action: "formalize", label: "Formalize" },
	{ action: "friendly", label: "Friendly" },
	{ action: "shorten", label: "Shorten" },
] as const;

/**
 * AI compose bar (upstream #55): a custom-instruction field plus quick
 * rewrite actions. A deliberate user action on the draft they are writing —
 * the rewritten body replaces the draft only when they click, and nothing
 * here sends mail. Sits under the body editor in the compose panel.
 */
export function ComposeAIBar({ mailboxId, body, onRewrite }: ComposeAIBarProps) {
	const [instruction, setInstruction] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [activeAction, setActiveAction] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const handleRewrite = async (action: string, customInstruction?: string) => {
		if (!body.trim() || isLoading) return;
		setIsLoading(true);
		setActiveAction(action);
		setError(null);
		try {
			const result = await api.rewriteEmailBody(mailboxId, body, action, customInstruction);
			onRewrite(result.body);
			if (action === "custom") setInstruction("");
		} catch (e) {
			setError(e instanceof Error ? e.message : "AI rewrite failed");
		} finally {
			setIsLoading(false);
			setActiveAction(null);
		}
	};

	const handleCustomSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!instruction.trim()) return;
		void handleRewrite("custom", instruction.trim());
	};

	return (
		<div className="border-t border-kumo-line bg-kumo-fill/30 px-3 py-2">
			<div className="flex items-center gap-2">
				<SparkleIcon size={14} className="shrink-0 text-kumo-subtle" />
				<form onSubmit={handleCustomSubmit} className="flex min-w-0 flex-1 items-center gap-2">
					<div className="min-w-0 flex-1">
						<Input
							size="sm"
							placeholder="Describe your change..."
							value={instruction}
							onChange={(e) => setInstruction(e.target.value)}
							disabled={isLoading}
							aria-label="Custom rewrite instruction"
						/>
					</div>
					{QUICK_ACTIONS.map(({ action, label }) => (
						<Button
							key={action}
							type="button"
							variant="ghost"
							size="sm"
							disabled={isLoading || !body.trim()}
							onClick={() => void handleRewrite(action)}
						>
							{isLoading && activeAction === action ? <Loader size="sm" /> : label}
						</Button>
					))}
				</form>
			</div>
			{error && <p className="mt-1 text-xs text-kumo-warning">{error}</p>}
		</div>
	);
}
