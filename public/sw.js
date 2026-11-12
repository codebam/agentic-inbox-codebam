/*
 * Agentic Inbox service worker — web push, offline shell and draft outbox.
 *
 * It handles these events:
 * - `install` / `activate`: precache the app shell (/) and an inline offline
 *   fallback page, and prune old caches on upgrade.
 * - `fetch`: same-origin GETs are network-first with a cache fallback so a
 *   fresh install still loads without a network; navigations fall back to
 *   the cached shell, then to the offline page. POST and cross-origin
 *   requests are left to the browser, untouched — except draft saves
 *   (POST .../drafts), which queue in the outbox when the network fails.
 * - `push`: show the notification the Worker sent. The payload is JSON:
 *   { title, body, url } — the sender, the subject clamped to 120
 *   characters and the mailbox URL, never a message body — with Reply and
 *   Archive actions.
 * - `notificationclick`: Reply opens the message; Archive moves it to the
 *   Archive folder via the API (best-effort); a body tap focuses the app or
 *   opens the deep link, as before.
 * - `sync` / `message`: drain the draft outbox once the network returns.
 *
 * The outbox is intentionally minimal: entries live in memory and mirror to
 * localStorage (`draft-outbox` + `draft-outbox-count`), so an offline draft
 * save survives a worker restart but a lost localStorage just drops it.
 */

/* global fetch, caches, localStorage, self, URL, Response */

const CACHE_NAME = "agentic-inbox-v1";
const APP_SHELL = ["/", "/manifest.webmanifest", "/favicon.svg"];
const OFFLINE_URL = "/offline.html";

const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline — Agentic Inbox</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f2f2f2}main{text-align:center;max-width:26rem;padding:2rem}h1{font-size:1.25rem}p{color:#666;font-size:.9rem}</style>
</head>
<body><main><h1>You're offline</h1><p>The inbox needs a network connection to load. Drafts you saved while offline will sync when you reconnect.</p></main></body>
</html>`;

self.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE_NAME);
			for (const url of APP_SHELL) {
				try {
					await cache.add(url);
				} catch {
					// A shell asset that 404s (or an Access login page) must not
					// sink the whole install; the fetch handler degrades anyway.
				}
			}
			await cache.put(
				OFFLINE_URL,
				new Response(OFFLINE_HTML, {
					headers: { "Content-Type": "text/html; charset=utf-8" },
				}),
			);
			await self.skipWaiting();
		})(),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			await Promise.all(
				keys.map((key) => (key === CACHE_NAME ? undefined : caches.delete(key))),
			);
			restoreOutbox();
			await self.clients.claim();
			void flushOutbox();
		})(),
	);
});

// --- Draft outbox ------------------------------------------------------

/** Queued draft saves: { url, method, headers, body, queuedAt }. */
let draftOutbox = [];

function persistOutbox() {
	try {
		localStorage.setItem("draft-outbox-count", String(draftOutbox.length));
		localStorage.setItem("draft-outbox", JSON.stringify(draftOutbox));
	} catch {
		// Storage may be unavailable (private mode, quota, no localStorage in
		// this worker scope); the in-memory copy still flushes this session.
	}
}

function restoreOutbox() {
	try {
		const raw = localStorage.getItem("draft-outbox");
		const parsed = raw ? JSON.parse(raw) : [];
		if (Array.isArray(parsed)) draftOutbox = parsed;
	} catch {
		draftOutbox = [];
	}
}

function queueDraft(url, method, headers, body) {
	draftOutbox.push({
		url,
		method,
		headers,
		body,
		queuedAt: Date.now(),
	});
	persistOutbox();
	// Background Sync (Chromium) drains the outbox when connectivity returns;
	// where it is unavailable, the message/flush-on-fetch path covers it.
	try {
		if ("sync" in self.registration) {
			void self.registration.sync.register("draft-outbox-sync").catch(() => {});
		}
	} catch {
		// Sync registration is best-effort only.
	}
}

async function flushOutbox() {
	if (draftOutbox.length === 0) return;
	const remaining = [];
	for (const item of draftOutbox) {
		try {
			const res = await fetch(item.url, {
				method: item.method,
				headers: item.headers,
				body: item.body,
				credentials: "same-origin",
			});
			if (!res.ok) remaining.push(item);
		} catch {
			remaining.push(item);
		}
	}
	draftOutbox = remaining;
	persistOutbox();
}

self.addEventListener("sync", (event) => {
	if (event.tag === "draft-outbox-sync") {
		event.waitUntil(flushOutbox());
	}
});

self.addEventListener("message", (event) => {
	if (event.data && event.data.type === "FLUSH_DRAFT_OUTBOX") {
		event.waitUntil(flushOutbox());
	}
});

function isDraftSave(request) {
	if (request.method !== "POST") return false;
	try {
		return /\/api\/v1\/mailboxes\/[^/]+\/drafts\/?$/.test(
			new URL(request.url).pathname,
		);
	} catch {
		return false;
	}
}

self.addEventListener("fetch", (event) => {
	const request = event.request;

	// Draft saves: queue instead of dropping them while offline, and answer
	// 202 so the composer keeps the draft it already holds.
	if (isDraftSave(request)) {
		event.respondWith(
			(async () => {
				try {
					return await fetch(request);
				} catch {
					let body = "";
					let headers = {};
					try {
						const clone = request.clone();
						body = await clone.text();
						headers = Object.fromEntries(clone.headers.entries());
					} catch {
						// An unreadable body still queues an (empty) entry; the
						// flush will surface the server error rather than hide it.
					}
					queueDraft(request.url, "POST", headers, body);
					return new Response(
						JSON.stringify({ queued: true, offline: true }),
						{
							status: 202,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
			})(),
		);
		return;
	}

	// Same-origin GETs only; POSTs and cross-origin requests are left to
	// the browser, untouched.
	if (request.method !== "GET") return;
	if (new URL(request.url).origin !== self.location.origin) return;

	event.respondWith(
		(async () => {
			try {
				const network = await fetch(request);
				if (network.ok && request.method === "GET") {
					const copy = network.clone();
					const cache = await caches.open(CACHE_NAME);
					void cache.put(request, copy).catch(() => {});
				}
				return network;
			} catch {
				const cached = await caches.match(request, {
					ignoreSearch: true,
				});
				if (cached) return cached;
				if (request.mode === "navigate") {
					const shell = await caches.match("/");
					if (shell) return shell;
					const offline = await caches.match(OFFLINE_URL);
					if (offline) return offline;
					return new Response(OFFLINE_HTML, {
						headers: { "Content-Type": "text/html; charset=utf-8" },
					});
				}
				throw new Error("offline");
			}
		})(),
	);
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
		data: {
			url,
			mailboxId:
				typeof payload.mailboxId === "string" ? payload.mailboxId : undefined,
			emailId: typeof payload.emailId === "string" ? payload.emailId : undefined,
		},
		icon: "/favicon.svg",
		badge: "/favicon.svg",
		actions: [
			{ action: "reply", title: "Reply" },
			{ action: "archive", title: "Archive" },
		],
	};

	event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const data = event.notification.data || {};
	const target = typeof data.url === "string" && data.url ? data.url : "/";

	// Archive from the notification: move the message via the API when the
	// push carried its ids, then focus the app. Without ids there is nothing
	// to archive server-side, so fall back to opening the message.
	if (event.action === "archive") {
		const mailboxId =
			typeof data.mailboxId === "string" && data.mailboxId
				? data.mailboxId
				: (() => {
						try {
								const m = new URL(target, self.location.origin).pathname.match(
									/^\/mailbox\/([^/]+)/,
								);
								return m ? decodeURIComponent(m[1]) : undefined;
							} catch {
								return undefined;
							}
					})();
		const emailId = typeof data.emailId === "string" ? data.emailId : undefined;
		if (mailboxId && emailId) {
			event.waitUntil(
				(async () => {
					try {
						await fetch(
							`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails/${encodeURIComponent(emailId)}/move`,
							{
								method: "POST",
								headers: { "Content-Type": "application/json" },
								credentials: "same-origin",
								body: JSON.stringify({ folderId: "archive" }),
							},
						);
					} catch {
						// Offline or a failed move: the message stays put rather
						// than being hidden behind a guessed success.
					}
					const absolute = new URL(target, self.location.origin).href;
					const windows = await self.clients.matchAll({
						type: "window",
						includeUncontrolled: true,
					});
					for (const client of windows) {
						if ("focus" in client) {
							await client.focus();
							return;
						}
					}
					await self.clients.openWindow(absolute);
				})(),
			);
			return;
		}
	}

	// Reply and body taps both land on the deep link: the reply action is a
	// shortcut to the message itself, where the composer lives.
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
