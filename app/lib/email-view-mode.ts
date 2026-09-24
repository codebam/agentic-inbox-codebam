// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


/**
 * Session-scoped email view choice.
 *
 * A manual HTML | plain text toggle should survive switching messages and
 * closing the panel, so it lives in a module-level value instead of
 * component state. `null` means "no manual choice yet — use the configured
 * default" (mailbox override, app-wide setting, or HTML).
 */


import { useSyncExternalStore } from "react";
import type { EmailViewMode } from "shared/email-view";


let sessionMode: EmailViewMode | null = null;
const listeners = new Set<() => void>();


function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}


function getSnapshot(): EmailViewMode | null {
	return sessionMode;
}


/** Record the manual view choice for the rest of the session. */
export function setSessionEmailViewMode(mode: EmailViewMode) {
	if (sessionMode === mode) return;
	sessionMode = mode;
	for (const listener of listeners) listener();
}


/** The session's manual view choice, or null when the default applies. */
export function useSessionEmailViewMode(): EmailViewMode | null {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
