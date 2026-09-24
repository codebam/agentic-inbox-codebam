// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { Badge, Button, Input, Loader, Pagination, Tooltip } from "@cloudflare/kumo";
import { ArrowLeftIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import MailboxSplitView from "~/components/MailboxSplitView";
import { formatListDate, getSnippetText } from "~/lib/utils";
import { useUpdateEmail } from "~/queries/emails";
import { SEARCH_PAGE_SIZE, useSearchAllMailboxes } from "~/queries/search";
import { useUIStore } from "~/hooks/useUIStore";
import type { Email } from "~/types";


/** Highlight the free-text part of a Gmail-style query in a result string. */
function highlightTerms(text: string, query: string): React.ReactNode {
	if (!query || !text) return text;
	const freeText = query.replace(/\b(?:from|to|subject|in|is|has|before|after):"[^"]*"/gi, "").replace(/\b(?:from|to|subject|in|is|has|before|after):\S+/gi, "").trim();
	if (!freeText) return text;
	try {
		const escaped = freeText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`(${escaped})`, "gi");
		const parts = text.split(regex);
		if (parts.length === 1) return text;
		// Case-insensitive string comparison; regex.test() with a g flag is stateful.
		const lowerEscaped = escaped.toLowerCase();
		return parts.map((part, i) => part.toLowerCase() === lowerEscaped ? <mark key={i} className="bg-kumo-warning-muted text-kumo-default rounded-sm px-0.5">{part}</mark> : part);
	} catch { return text; }
}


const FOLDER_DISPLAY_NAMES: Record<string, string> = {
	inbox: "Inbox",
	sent: "Sent",
	draft: "Drafts",
	archive: "Archive",
	trash: "Trash",
};


function folderDisplayName(name: string | null | undefined): string {
	if (!name) return "";
	return FOLDER_DISPLAY_NAMES[name.toLowerCase()] || name;
}


/**
 * Cross-mailbox search results (route `/search`).
 *
 * Same result layout as the per-mailbox search page, plus a mailbox label on
 * every row because matches are merged across accounts.
 */
export default function AllSearchRoute() {
	const [searchParams, setSearchParams] = useSearchParams();
	const navigate = useNavigate();
	const urlQuery = searchParams.get("q") || "";
	const [draftQuery, setDraftQuery] = useState(urlQuery);
	const [page, setPage] = useState(1);
	const { selectedEmailId, selectedMailboxId, isComposing, selectEmail, closePanel } = useUIStore();
	const updateEmail = useUpdateEmail();


	// Keep the input in sync with the URL (back/forward, links, redirects).
	useEffect(() => {
		setDraftQuery(urlQuery);
	}, [urlQuery]);


	// A new query is a new result set: reset paging and close the reading pane.
	const prevQueryRef = useRef(urlQuery);
	useEffect(() => {
		if (prevQueryRef.current === urlQuery) return;
		prevQueryRef.current = urlQuery;
		setPage(1);
		closePanel();
	}, [closePanel, urlQuery]);


	const { data, isLoading, isError, refetch } = useSearchAllMailboxes(urlQuery, page);
	const results = data?.results ?? [];
	const totalCount = data?.totalCount ?? 0;
	const isPanelOpen = selectedEmailId !== null || isComposing;


	const submitSearch = () => {
		const q = draftQuery.trim();
		setSearchParams(q ? { q } : {});
	};


	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Enter") submitSearch();
	};


	const handleRowClick = (email: Email) => {
		selectEmail(email.id, email.mailboxId);
		if (!email.read && email.mailboxId) {
			updateEmail.mutate({ mailboxId: email.mailboxId, id: email.id, data: { read: true } });
		}
	};


	return (
		<MailboxSplitView
			selectedEmailId={selectedEmailId}
			isComposing={isComposing}
			mailboxId={selectedMailboxId ?? undefined}
		>
			<>
				<div className="flex items-center gap-2 px-4 py-3.5 border-b border-kumo-line shrink-0 md:px-5">
					<Tooltip content="Back to all accounts" side="bottom" asChild><Button variant="ghost" shape="square" size="sm" icon={<ArrowLeftIcon size={18} />} onClick={() => navigate("/all")} aria-label="Back to all accounts" /></Tooltip>
					<div className="min-w-0 flex-1"><h1 className="text-lg font-semibold text-kumo-default truncate">Search All Accounts</h1>{!isLoading && !isError && <span className="text-sm text-kumo-subtle">{totalCount} result{totalCount !== 1 ? "s" : ""}{urlQuery ? ` for "${urlQuery}"` : ""}</span>}</div>
				</div>
				<div className="px-4 py-2 border-b border-kumo-line shrink-0 md:px-5">
					<Input className="w-full max-w-xl" aria-label="Search all accounts" placeholder="Search all accounts... (try from:name, is:unread, has:attachment)" value={draftQuery} onChange={(e) => setDraftQuery(e.target.value)} onKeyDown={handleKeyDown} />
				</div>
				<div className="flex-1 overflow-y-auto">
					{isLoading ? <div className="flex justify-center py-16"><Loader size="lg" /></div> : isError ? (
						<div className="flex flex-col items-center justify-center py-24 px-6 text-center">
							<div className="mb-4"><MagnifyingGlassIcon size={48} weight="thin" className="text-kumo-subtle" /></div>
							<h3 className="text-base font-semibold text-kumo-default mb-1.5">Search failed</h3>
							<p className="text-sm text-kumo-subtle max-w-xs">Something went wrong while searching across your accounts. Check your connection and try again.</p>
							<Button variant="secondary" className="mt-4" onClick={() => void refetch()}>Retry</Button>
						</div>
					) : results.length === 0 ? (
						<div className="flex flex-col items-center justify-center py-24 px-6 text-center">
							<div className="mb-4"><MagnifyingGlassIcon size={48} weight="thin" className="text-kumo-subtle" /></div>
							<h3 className="text-base font-semibold text-kumo-default mb-1.5">No results found</h3>
							<p className="text-sm text-kumo-subtle max-w-xs">{urlQuery ? `Nothing matched "${urlQuery}" in any account. Try different keywords or check your spelling.` : "Enter a search term to find emails across all accounts by subject, sender, or content."}</p>
							{urlQuery && <p className="text-xs text-kumo-subtle mt-3 max-w-sm">Tip: Use operators like <code className="bg-kumo-tint px-1 rounded">from:name</code>, <code className="bg-kumo-tint px-1 rounded">is:unread</code>, <code className="bg-kumo-tint px-1 rounded">has:attachment</code>, <code className="bg-kumo-tint px-1 rounded">before:2025-01-01</code></p>}
						</div>
					) : (
						<div>{results.map((email) => {
							const isSelected = selectedEmailId === email.id && selectedMailboxId === email.mailboxId;
							const snippet = getSnippetText(email.snippet, 120);
							const folderName = (email as Email & { folder_name?: string }).folder_name;
							const accountLabel = email.mailboxId?.split("@")[0] || "unknown";
							return (
								<div key={`${email.mailboxId ?? "mailbox"}-${email.id}`} role="button" tabIndex={0} onClick={() => handleRowClick(email)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleRowClick(email); } }} className={`group flex items-center gap-3 w-full text-left cursor-pointer transition-colors border-b border-kumo-line px-4 py-2.5 md:px-5 md:py-3 ${isPanelOpen ? "md:px-4 md:py-2.5" : ""} ${isSelected ? "bg-kumo-tint" : "hover:bg-kumo-tint"}`}>
									<div className="w-2.5 shrink-0 flex justify-center">{!email.read && <div className="h-2 w-2 rounded-full bg-kumo-brand" />}</div>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2"><Badge variant="secondary" className="shrink-0">{accountLabel}</Badge><span className={`truncate text-sm ${!email.read ? "font-semibold text-kumo-default" : "text-kumo-strong"}`}>{highlightTerms(email.sender.split("@")[0] ?? email.sender, urlQuery)}</span>{folderName && <Badge variant="outline">{folderDisplayName(folderName)}</Badge>}<span className="text-sm text-kumo-subtle shrink-0 ml-auto">{formatListDate(email.date)}</span></div>
										<div className={`truncate text-sm mt-0.5 ${!email.read ? "font-medium text-kumo-default" : "text-kumo-subtle"}`}>{highlightTerms(email.subject, urlQuery)}</div>
										{snippet && <div className="truncate text-xs text-kumo-subtle mt-0.5">{highlightTerms(snippet, urlQuery)}</div>}
									</div>
								</div>
							);
						})}</div>
					)}
				</div>
				{totalCount > SEARCH_PAGE_SIZE && <div className="flex justify-center py-3 border-t border-kumo-line shrink-0"><Pagination page={page} setPage={setPage} perPage={SEARCH_PAGE_SIZE} totalCount={totalCount} /></div>}
			</>
		</MailboxSplitView>
	);
}
