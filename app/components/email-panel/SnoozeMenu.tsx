// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, Tooltip } from "@cloudflare/kumo";
import { useEffect, useRef, useState } from "react";
import {
	formatSnoozeTime,
	isPastOrInvalid,
	snoozePresets,
	toDateTimeLocalValue,
	type SnoozePreset,
} from "~/lib/snooze";

/** Extra menu entry rendered under the presets, e.g. "Clear reminder". */
export interface SnoozeMenuExtraItem {
	label: string;
	onSelect: () => void;
}

interface SnoozeMenuProps {
	/** Tooltip and accessible name for the trigger button. */
	label: string;
	/** Optional shorter accessible name when `label` is dynamic. */
	ariaLabel?: string | undefined;
	icon: React.ReactNode;
	/** Heading shown above the presets, e.g. "Snooze until". */
	header: string;
	/** Receives the chosen local time as an ISO 8601 instant. */
	onPick: (iso: string) => void;
	/** Extra entries rendered under the presets. */
	extraItems?: ReadonlyArray<SnoozeMenuExtraItem> | undefined;
	/** Tints the trigger when a time is already set. */
	active?: boolean | undefined;
	/**
	 * Renders the trigger as a labelled button with this text instead of the
	 * icon-only square button (the composer's "Send later").
	 */
	triggerLabel?: string | undefined;
	/**
	 * Direction the dropdown opens in. Use "up" for triggers pinned to the
	 * bottom of a panel, where a downward menu would be clipped.
	 */
	placement?: "up" | "down" | undefined;
	/** Disables the trigger, e.g. while the composer cannot schedule a send. */
	disabled?: boolean | undefined;
}

/**
 * Presets and clock reading captured when the menu opens, so the render
 * below stays a pure function of state (no Date.now during render).
 */
interface OpenMenu {
	presets: SnoozePreset[];
	nowMs: number;
	minValue: string;
}

/**
 * Dropdown shared by the message toolbar's Snooze and Remind me actions and
 * the composer's Send later: canned local presets plus a custom date/time.
 * Presets that have slipped into the past are disabled and the custom input
 * refuses past values — the server rejects past timestamps.
 */
export default function SnoozeMenu({
	label,
	ariaLabel,
	icon,
	header,
	onPick,
	extraItems,
	active,
	triggerLabel,
	placement = "down",
	disabled,
}: SnoozeMenuProps) {
	const [menu, setMenu] = useState<OpenMenu | null>(null);
	const [custom, setCustom] = useState("");
	const ref = useRef<HTMLDivElement>(null);
	const open = menu !== null;

	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setMenu(null);
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	// Presets are built on open so "Later today" reflects the current time,
	// not the time the message was opened.
	const toggleMenu = () => {
		if (menu) {
			setMenu(null);
			return;
		}
		const now = new Date();
		setMenu({
			presets: snoozePresets(),
			nowMs: now.getTime(),
			minValue: toDateTimeLocalValue(now),
		});
	};

	const choose = (iso: string) => {
		onPick(iso);
		setCustom("");
		setMenu(null);
	};

	// `custom` is a local datetime-local value; empty or not in the future
	// means the Set time button stays disabled.
	const customTime = custom ? new Date(custom).getTime() : Number.NaN;
	const canSubmitCustom =
		menu !== null &&
		custom !== "" &&
		Number.isFinite(customTime) &&
		customTime > menu.nowMs;

	return (
		<div ref={ref} className="relative">
			{triggerLabel !== undefined ? (
				<Button
					variant="secondary"
					size="sm"
					icon={icon}
					onClick={toggleMenu}
					disabled={disabled}
					aria-label={ariaLabel ?? label}
				>
					{triggerLabel}
				</Button>
			) : (
				<Tooltip content={label} side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={icon}
						onClick={toggleMenu}
						disabled={disabled}
						aria-label={ariaLabel ?? label}
						className={active ? "text-kumo-brand" : ""}
					/>
				</Tooltip>
			)}
			{menu && (
				<div
					className={`absolute z-50 w-60 rounded-lg border border-kumo-line bg-kumo-elevated shadow-lg py-1 ${
						placement === "up" ? "bottom-full right-0 mb-1" : "top-full left-0 mt-1"
					}`}
				>
					<div className="px-3 py-1.5 text-xs font-medium text-kumo-subtle">
						{header}
					</div>
					<div className="h-px bg-kumo-line my-1" />
					{menu.presets.map((preset) => {
						// Belt and braces: a preset that slipped into the past is
						// never selectable.
						const isPast =
							preset.until.getTime() <= menu.nowMs ||
							isPastOrInvalid(preset.until.toISOString());
						return (
							<button
								key={preset.id}
								type="button"
								disabled={isPast}
								className="w-full text-left px-3 py-1.5 text-sm text-kumo-default hover:bg-kumo-overlay transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
								onClick={() => {
									if (isPast) return;
									choose(preset.until.toISOString());
								}}
							>
								<span className="block">{preset.label}</span>
								<span className="block text-xs text-kumo-subtle">
									{formatSnoozeTime(preset.until.toISOString())}
								</span>
							</button>
						);
					})}
					{extraItems && extraItems.length > 0 && (
						<>
							<div className="h-px bg-kumo-line my-1" />
							{extraItems.map((item) => (
								<button
									key={item.label}
									type="button"
									className="w-full text-left px-3 py-1.5 text-sm text-kumo-default hover:bg-kumo-overlay transition-colors"
									onClick={() => {
										item.onSelect();
										setCustom("");
										setMenu(null);
									}}
								>
									{item.label}
								</button>
							))}
						</>
					)}
					<div className="h-px bg-kumo-line my-1" />
					<div className="px-3 pt-1 pb-2">
						<Input
							type="datetime-local"
							size="sm"
							label="Custom date and time"
							value={custom}
							min={menu.minValue}
							onChange={(e) => setCustom(e.target.value)}
						/>
						<Button
							variant="secondary"
							size="sm"
							className="mt-2 w-full"
							disabled={!canSubmitCustom}
							onClick={() => {
								if (!canSubmitCustom) return;
								choose(new Date(customTime).toISOString());
							}}
						>
							Set time
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}
