// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip } from "@cloudflare/kumo";
import { BrainIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useSearchParams } from "react-router";

/** URL param (and value) that switches a mailbox search to the semantic route. */
export const SEMANTIC_MODE_PARAM = "mode";
export const SEMANTIC_MODE_VALUE = "semantic";

/** Whether the current search URL asks for semantic mode. */
export function isSemanticMode(searchParams: URLSearchParams): boolean {
	return searchParams.get(SEMANTIC_MODE_PARAM) === SEMANTIC_MODE_VALUE;
}

/**
 * Keyword / Semantic switch for a mailbox search.
 *
 * Semantic mode is carried in the URL (`?mode=semantic`) rather than in
 * component state, so the Header's search box and the results page always
 * agree on it, a search URL can be shared, and switching back restores the
 * keyword search of the same query. The switch only appears where a mailbox
 * is in scope: the vector index is per mailbox, so the All Accounts search
 * has no semantic mode.
 */
export default function SemanticSearchToggle() {
	const [searchParams, setSearchParams] = useSearchParams();
	const semantic = isSemanticMode(searchParams);

	const setMode = (next: boolean) => {
		setSearchParams(
			(prev) => {
				const params = new URLSearchParams(prev);
				if (next) params.set(SEMANTIC_MODE_PARAM, SEMANTIC_MODE_VALUE);
				else params.delete(SEMANTIC_MODE_PARAM);
				return params;
			},
			{ replace: true },
		);
	};

	return (
		<div
			role="group"
			aria-label="Search mode"
			className="flex items-center rounded-md border border-kumo-line p-0.5 shrink-0"
		>
			<Tooltip content="Keyword search" side="bottom" asChild>
				<Button
					variant={semantic ? "ghost" : "secondary"}
					size="xs"
					icon={<MagnifyingGlassIcon size={14} />}
					onClick={() => setMode(false)}
				>
					Keyword
				</Button>
			</Tooltip>
			<Tooltip content="Find messages by meaning" side="bottom" asChild>
				<Button
					variant={semantic ? "secondary" : "ghost"}
					size="xs"
					icon={<BrainIcon size={14} />}
					onClick={() => setMode(true)}
				>
					Semantic
				</Button>
			</Tooltip>
		</div>
	);
}
