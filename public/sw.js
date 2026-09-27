/*
 * Agentic Inbox service worker — web push only.
 *
 * It handles exactly two events: `push` (show the notification the Worker
 * sent) and `notificationclick` (focus the app or open the deep link). The
 * payload is JSON: { title, body, url } — the sender, the subject clamped to
 * 120 characters and the mailbox URL, never a message body.
 *
 * There is deliberately NO `fetch` handler and no caches: mail must never be
 * served from a stale cache, so every request goes straight to the network
 * and this worker never intercepts one.
 */

/* global self, URL */

const DEFAULT_TITLE = "New mail";

self.addEventListener("push", (event) => {
	let payload;
	try {
		payload = event.data ? event.data.json() : {};
	} catch {
		// Malformed payloads still raise a notification: silence would look
		// like push is broken, and the click can still open the app.
		payload = {};
	}

	const title =
		typeof payload.title === "string" && payload.title ? payload.title : DEFAULT_TITLE;
	const url = typeof payload.url === "string" && payload.url ? payload.url : "/";
	const options = {
		body: typeof payload.body === "string" ? payload.body : "",
		data: { url },
		icon: "/favicon.svg",
		badge: "/favicon.svg",
	};

	event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const data = event.notification.data || {};
	const target = typeof data.url === "string" && data.url ? data.url : "/";

	event.waitUntil(
		(async () => {
			const absolute = new URL(target, self.location.origin).href;
			const windows = await self.clients.matchAll({
				type: "window",
				includeUncontrolled: true,
			});
			for (const client of windows) {
				// Focus the tab that already shows this URL; otherwise open a
				// new one so the click always lands somewhere.
				if (client.url === absolute && "focus" in client) {
					await client.focus();
					return;
				}
			}
			await self.clients.openWindow(absolute);
		})(),
	);
});
