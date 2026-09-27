/*
 * Agentic Inbox service worker — web push, plus the pass-through fetch
 * handler Chromium requires before it will install the app on Android.
 *
 * It handles three events: `push` (show the notification the Worker sent),
 * `notificationclick` (focus the app or open the deep link) and `fetch`. The
 * push payload is JSON: { title, body, url } — the sender, the subject clamped
 * to 120 characters and the mailbox URL, never a message body.
 *
 * The `fetch` handler exists because Chromium on Android will not mint a
 * WebAPK ("Install app") for an app whose service worker has no fetch handler,
 * and an empty listener does not count. It is a straight pass-through: nothing
 * is cached and nothing is rewritten, so mail is never served from a stale
 * cache and every request reaches the network exactly as it would without this
 * worker.
 */

/* global fetch, self, URL */

self.addEventListener("fetch", (event) => {
	const request = event.request;
	// Same-origin GETs only; POSTs and cross-origin requests are left to the
	// browser, untouched.
	if (request.method !== "GET") return;
	if (new URL(request.url).origin !== self.location.origin) return;
	event.respondWith(fetch(request));
});

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
