// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Input } from "@cloudflare/kumo";
import {
	useEffect,
	useId,
	useRef,
	useState,
	type KeyboardEvent,
} from "react";
import { useContactSearch } from "~/queries/contacts";
import type { Contact } from "~/types";

/** Typing pause before a lookup fires — long enough to swallow most keystrokes. */
const LOOKUP_DEBOUNCE_MS = 175;

/** The recipient being typed: everything after the last comma, trimmed. */
function currentRecipientToken(value: string): string {
	const lastComma = value.lastIndexOf(",");
	return (lastComma === -1 ? value : value.slice(lastComma + 1)).trim();
}

/**
 * Replace only the token after the last comma and end it with ", " so the
 * caret is ready for the next recipient. Everything before the token is kept
 * verbatim: accepting a suggestion never rewrites text the user did not pick.
 */
function replaceCurrentToken(value: string, address: string): string {
	const lastComma = value.lastIndexOf(",");
	const head = lastComma === -1 ? "" : value.slice(0, lastComma + 1).trimEnd();
	return head ? `${head} ${address}, ` : `${address}, `;
}

/** "Name — address" when the contact has a name, the bare address otherwise. */
function contactLabel(contact: Contact): string {
	const name = contact.name?.trim();
	return name ? `${name} — ${contact.email}` : contact.email;
}

interface RecipientFieldProps {
	/** Field label, e.g. "To" — also names the suggestion list. */
	label: string;
	value: string;
	onChange: (value: string) => void;
	mailboxId: string | undefined;
	placeholder?: string | undefined;
	required?: boolean | undefined;
}

/**
 * The composer's To/Cc/Bcc input plus an advisory contact suggestion list.
 *
 * As the operator types the token after the last comma, a debounced and
 * bounded lookup against the mailbox's contacts shows ranked matches under
 * the field. ArrowDown/ArrowUp move the highlight, Enter accepts the
 * highlighted suggestion and leaves the caret ready for the next recipient,
 * Escape or a blur closes the list, and clicking a suggestion accepts it.
 *
 * Suggestions are advisory only: they never block, rewrite or submit anything
 * by themselves, and a failed lookup simply shows no list.
 */
export default function RecipientField({
	label,
	value,
	onChange,
	mailboxId,
	placeholder,
	required,
}: RecipientFieldProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const debounceRef = useRef<number | null>(null);
	const caretRef = useRef<number | null>(null);
	const listId = useId();

	const [token, setToken] = useState("");
	const [debouncedToken, setDebouncedToken] = useState("");
	const [focused, setFocused] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	const [highlight, setHighlight] = useState(-1);

	const search = useContactSearch(mailboxId, debouncedToken, {
		enabled: focused,
	});
	const suggestions = (search.data?.contacts ?? []).filter(
		(contact) => contact.email.toLowerCase() !== token.toLowerCase(),
	);
	// Never opens for an empty token, after Escape/accept, or without matches.
	const open = focused && !dismissed && token.length > 0 && suggestions.length > 0;

	/** Fire the lookup only after a pause in typing; nothing runs per keystroke. */
	const scheduleLookup = (nextToken: string) => {
		if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
		if (!nextToken) {
			debounceRef.current = null;
			setDebouncedToken("");
			return;
		}
		debounceRef.current = window.setTimeout(() => {
			debounceRef.current = null;
			setDebouncedToken(nextToken);
		}, LOOKUP_DEBOUNCE_MS);
	};

	const handleChange = (next: string) => {
		onChange(next);
		const nextToken = currentRecipientToken(next);
		setToken(nextToken);
		setHighlight(-1);
		setDismissed(false);
		scheduleLookup(nextToken);
	};

	const handleFocus = () => {
		setFocused(true);
		setDismissed(false);
		const current = currentRecipientToken(value);
		setToken(current);
		scheduleLookup(current);
	};

	const handleBlur = () => {
		setFocused(false);
		setHighlight(-1);
	};

	const accept = (contact: Contact) => {
		const next = replaceCurrentToken(value, contact.email);
		onChange(next);
		setToken("");
		setHighlight(-1);
		setDismissed(true);
		// Placed once React has committed the new value; see the effect below.
		caretRef.current = next.length;
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (!open) return;

		if (event.key === "ArrowDown") {
			event.preventDefault();
			setHighlight((previous) => Math.min(previous + 1, suggestions.length - 1));
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			setHighlight((previous) => Math.max(previous - 1, 0));
			return;
		}
		if (event.key === "Enter") {
			// While the list is open, Enter belongs to it: it accepts the
			// highlighted suggestion or does nothing — it never submits the
			// composer mid-typing.
			event.preventDefault();
			const contact = highlight >= 0 ? suggestions[highlight] : undefined;
			if (contact) accept(contact);
			return;
		}
		if (event.key === "Escape") {
			// Closes the list only, not the compose dialog around it.
			event.preventDefault();
			event.stopPropagation();
			setDismissed(true);
			setHighlight(-1);
		}
	};

	// Drop a pending lookup when the field goes away mid-keystroke.
	useEffect(
		() => () => {
			if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
		},
		[],
	);

	// After an accepted suggestion, put the caret at the end of the new value
	// so the operator can type the next recipient straight away.
	useEffect(() => {
		const caret = caretRef.current;
		if (caret === null) return;
		caretRef.current = null;
		inputRef.current?.setSelectionRange(caret, caret);
	}, [value]);

	return (
		<div className="relative">
			<Input
				ref={inputRef}
				label={label}
				type="text"
				size="sm"
				placeholder={placeholder}
				value={value}
				required={required}
				onChange={(event) => handleChange(event.target.value)}
				onKeyDown={handleKeyDown}
				onFocus={handleFocus}
				onBlur={handleBlur}
				role="combobox"
				aria-autocomplete="list"
				aria-expanded={open}
				aria-controls={open ? listId : undefined}
				aria-activedescendant={
					highlight >= 0 ? `${listId}-option-${highlight}` : undefined
				}
			/>
			{open && (
				<div
					id={listId}
					role="listbox"
					aria-label={`${label} suggestions`}
					className="absolute top-full right-0 left-0 z-50 mt-1 max-h-56 overflow-y-auto rounded-lg border border-kumo-line bg-kumo-elevated py-1 shadow-lg"
				>
					{suggestions.map((contact, index) => (
						<button
							key={contact.id}
							id={`${listId}-option-${index}`}
							type="button"
							role="option"
							aria-selected={index === highlight}
							className={`w-full truncate px-3 py-1.5 text-left text-xs transition-colors ${
								index === highlight
									? "bg-kumo-overlay text-kumo-default"
									: "text-kumo-default hover:bg-kumo-tint"
							}`}
							// Keeps focus in the input so the click lands before blur
							// would close the list.
							onMouseDown={(event) => event.preventDefault()}
							onMouseEnter={() => setHighlight(index)}
							onClick={() => accept(contact)}
						>
							{contactLabel(contact)}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
