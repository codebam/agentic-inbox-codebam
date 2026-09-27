// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0


import { Badge, Button } from "@cloudflare/kumo";
import { BellRingingIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { base64UrlToBytes, type PushConfig } from "shared/push";
import api from "~/services/api";


/** Path of the push-only service worker (public/sw.js). */
const SERVICE_WORKER_URL = "/sw.js";


/** Push API support probe; the card also renders during SSR, where there is no navigator. */
function pushSupported(): boolean {
	return (
		typeof navigator !== "undefined" &&
		"serviceWorker" in navigator &&
		"PushManager" in window &&
		"Notification" in window
	);
}


/**
 * The endpoint of this browser's existing push subscription, or null when it
 * has none. Never throws: an unsupported browser and a failed lookup both
 * read as "not subscribed".
 */
async function currentEndpoint(): Promise<string | null> {
	if (!pushSupported()) return null;
	try {
		const registration = await navigator.serviceWorker.getRegistration();
		const subscription = await registration?.pushManager.getSubscription();
		return subscription ? subscription.endpoint : null;
	} catch {
		return null;
	}
}


/**
 * Per-mailbox web push (PWA notifications).
 *
 * "Enable on this browser" registers the push worker, asks for notification
 * permission on the click, subscribes with the deployment's VAPID public key
 * and stores the subscription on the mailbox; "Turn off on this browser"
 * removes it again. The notification itself carries only the sender and the
 * subject — never a message body — and is sent for new non-spam mail only.
 *
 * When the server answers `enabled: false` the deployment has no VAPID key
 * yet, so the card explains that instead of offering a button that could
 * only fail.
 */
export default function PushNotificationsCard({
	mailboxId,
}: {
	mailboxId?: string | undefined;
}) {
	const [config, setConfig] = useState<PushConfig | null>(null);
	const [configError, setConfigError] = useState<string | null>(null);
	const [subscribed, setSubscribed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	// Load the deployment-wide config once and read this browser's existing
	// subscription. The worker is registered here too: no permission is
	// needed for that, and it makes an earlier subscription clickable again.
	useEffect(() => {
		let cancelled = false;

		api.getPushConfig()
			.then((next) => {
				if (!cancelled) setConfig(next);
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					setConfigError(
						error instanceof Error
							? error.message
							: "Could not read the push configuration",
					);
				}
			});

		void currentEndpoint().then((endpoint) => {
			if (!cancelled) setSubscribed(endpoint !== null);
		});

		if (pushSupported()) {
			void navigator.serviceWorker.register(SERVICE_WORKER_URL).catch((error: unknown) => {
				console.error("Service worker registration failed:", error);
			});
		}

		return () => {
			cancelled = true;
		};
	}, []);

	const handleSubscribe = async () => {
		if (!mailboxId || !config?.enabled || !config.publicKey) return;
		if (!pushSupported()) {
			setMessage("This browser does not support push notifications.");
			return;
		}

		setBusy(true);
		setMessage(null);
		try {
			const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
			const permission = await Notification.requestPermission();
			if (permission !== "granted") {
				setMessage(
					permission === "denied"
						? "Notifications are blocked for this site — allow them in the browser's site settings."
						: "Notification permission was not granted.",
				);
				return;
			}

			const existing = await registration.pushManager.getSubscription();
			const subscription =
				existing ??
				(await registration.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: base64UrlToBytes(config.publicKey),
				}));

			const json = subscription.toJSON();
			const endpoint = json.endpoint;
			const p256dh = json.keys?.["p256dh"];
			const auth = json.keys?.["auth"];
			if (!endpoint || !p256dh || !auth) {
				setMessage("The browser returned an incomplete push subscription.");
				return;
			}

			await api.subscribePush(mailboxId, { endpoint, p256dh, auth });
			setSubscribed(true);
			setMessage("This browser will be notified about new mail.");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Subscribing failed.");
		} finally {
			setBusy(false);
		}
	};

	const handleUnsubscribe = async () => {
		if (!mailboxId) return;

		setBusy(true);
		setMessage(null);
		try {
			if (pushSupported()) {
				const registration = await navigator.serviceWorker.getRegistration();
				const subscription = await registration?.pushManager.getSubscription();
				if (subscription) {
					// Remove the server row first: if that fails, the browser
					// keeps its subscription and the click can be retried.
					await api.unsubscribePush(mailboxId, subscription.endpoint);
					await subscription.unsubscribe();
				}
			}
			setSubscribed(false);
			setMessage("This browser will no longer be notified.");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Unsubscribing failed.");
		} finally {
			setBusy(false);
		}
	};

	const enabled = config?.enabled === true;
	const notConfigured = config !== null && !enabled;

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-3">
				<BellRingingIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">
					Push notifications
				</span>
				{subscribed ? (
					<Badge variant="primary">On</Badge>
				) : (
					<Badge variant="secondary">Off</Badge>
				)}
			</div>
			<p className="text-xs text-kumo-subtle mb-4">
				Notifies this browser about new non-spam mail with the sender and the
				subject — never the message body. Needs notification permission for this
				site; the app stays usable without it.
			</p>

			{configError && <p className="text-xs text-kumo-danger">{configError}</p>}

			{notConfigured && (
				<p className="text-xs text-kumo-subtle">
					Push is not configured on this server yet. The operator has to set the
					VAPID public key and subject for the deployment, and the private key as a
					wrangler secret, before a browser can subscribe.
				</p>
			)}

			{enabled && (
				<div className="flex items-center gap-3">
					{subscribed ? (
						<Button
							variant="secondary"
							size="sm"
							disabled={busy || !mailboxId}
							loading={busy}
							onClick={() => {
								void handleUnsubscribe();
							}}
						>
							Turn off on this browser
						</Button>
					) : (
						<Button
							variant="secondary"
							size="sm"
							disabled={busy || !mailboxId}
							loading={busy}
							onClick={() => {
								void handleSubscribe();
							}}
						>
							Enable on this browser
						</Button>
					)}
					{message && <p className="text-xs text-kumo-subtle">{message}</p>}
				</div>
			)}
		</div>
	);
}
