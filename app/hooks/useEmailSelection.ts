// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface EmailSelection {
	/** Keys currently selected (a subset of the page keys). */
	selectedKeys: ReadonlySet<string>;
	/** Number of selected rows. */
	count: number;
	isSelected: (key: string) => boolean;
	/** Every row on the current page is selected. */
	allSelected: boolean;
	/** Toggle one row. Shift extends the selection from the last toggled row. */
	toggle: (key: string, shiftKey?: boolean) => void;
	/** Select every row on the current page. */
	selectAll: () => void;
	/** Drop the whole selection. */
	clear: () => void;
}

/**
 * Multi-select state for an email list page.
 *
 * `pageKeys` is the ordered list of row keys currently rendered; selection is
 * pruned to that list on every change so a deleted or moved row can never be
 * acted on. Press Escape to clear.
 */
export function useEmailSelection(pageKeys: string[]): EmailSelection {
	const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const anchorRef = useRef<string | null>(null);
	const keySet = useMemo(() => new Set(pageKeys), [pageKeys]);

	const clear = useCallback(() => {
		anchorRef.current = null;
		setSelectedKeys((prev) => (prev.size === 0 ? prev : new Set()));
	}, []);

	const toggle = useCallback(
		(key: string, shiftKey = false) => {
			setSelectedKeys((prev) => {
				const anchor = anchorRef.current;

				if (shiftKey && anchor && keySet.has(anchor) && keySet.has(key)) {
					const start = pageKeys.indexOf(anchor);
					const end = pageKeys.indexOf(key);
					if (start !== -1 && end !== -1) {
						const next = new Set(prev);
						for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
							const pageKey = pageKeys[i];
							if (pageKey !== undefined) next.add(pageKey);
						}
						anchorRef.current = key;
						return next;
					}
				}

				const next = new Set(prev);
				if (next.has(key)) next.delete(key);
				else next.add(key);
				anchorRef.current = key;
				return next;
			});
		},
		[keySet, pageKeys],
	);

	const selectAll = useCallback(() => {
		anchorRef.current = null;
		setSelectedKeys((prev) =>
			prev.size === pageKeys.length && pageKeys.every((key) => prev.has(key))
				? prev
				: new Set(pageKeys),
		);
	}, [pageKeys]);

	// Prune rows that are no longer on the page (deleted, moved, or refetched away).
	useEffect(() => {
		setSelectedKeys((prev) => {
			if (prev.size === 0) return prev;
			let changed = false;
			const next = new Set<string>();
			for (const key of prev) {
				if (keySet.has(key)) next.add(key);
				else changed = true;
			}
			return changed ? next : prev;
		});
	}, [keySet]);

	// Escape clears the selection without touching anything else.
	useEffect(() => {
		if (selectedKeys.size === 0) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") clear();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [selectedKeys.size, clear]);

	const isSelected = useCallback((key: string) => selectedKeys.has(key), [selectedKeys]);

	return {
		selectedKeys,
		count: selectedKeys.size,
		isSelected,
		allSelected: pageKeys.length > 0 && pageKeys.every((key) => selectedKeys.has(key)),
		toggle,
		selectAll,
		clear,
	};
}
