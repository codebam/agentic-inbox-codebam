#!/usr/bin/env node
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Agent-first MCP bridge.
 *
 * Some MCP clients only speak the stdio transport. This process translates
 * stdio JSON-RPC to the remote Streamable HTTP MCP endpoint used by Agentic
 * Inbox, and authenticates using the local Wrangler credential:
 *
 *   npx wrangler auth token
 *
 * The token is read into memory only. It is never written to disk and never
 * printed to stdout, which is reserved for the MCP protocol. If the remote
 * server rejects the token, the bridge asks Wrangler for a refreshed token and
 * retries the request once.
 *
 * Usage:
 *   node scripts/mcp-bridge.mjs --url https://email.example.com/mcp
 *
 * Environment:
 *   MCP_URL                Remote MCP endpoint when --url is omitted.
 *   MCP_AUTH_TOKEN         Optional bearer token override (tests/CI).
 *   MCP_WRANGLER           Optional path to a wrangler executable.
 *   CLOUDFLARE_API_TOKEN   Same credential precedence as Wrangler itself.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BRIDGE_VERSION = "1.1.0";
const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOCAL_BIN = join(PROJECT_ROOT, "node_modules", ".bin");
const LOCAL_WRANGLER = join(LOCAL_BIN, process.platform === "win32" ? "wrangler.cmd" : "wrangler");
const AUTH_ENV = {
	...process.env,
	PATH: `${LOCAL_BIN}${delimiter}${process.env.PATH ?? ""}`,
};

class BridgeError extends Error {
	constructor(message, status) {
		super(message);
		this.name = "BridgeError";
		this.status = status;
	}
}

function parseArgs(argv) {
	const options = { url: undefined, token: undefined, help: false };

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		if (arg === "--url" || arg === "-u") {
			options.url = argv[++index];
			continue;
		}
		if (arg === "--token") {
			options.token = argv[++index];
			continue;
		}
		if (!arg.startsWith("-") && !options.url) {
			options.url = arg;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

function usage() {
	return [
		"Usage: node scripts/mcp-bridge.mjs --url <https://host/mcp> [--token <token>]",
		"",
		"Authenticates with the local Wrangler login key unless MCP_AUTH_TOKEN",
		"or CLOUDFLARE_API_TOKEN is set.",
	].join("\n");
}

function normalizeUrl(raw) {
	if (!raw) throw new Error("Missing --url. " + usage());
	const url = new URL(raw);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("The MCP URL must use http or https.");
	}
	if (!url.pathname || url.pathname === "/") url.pathname = "/mcp";
	return url.toString();
}

function parseWranglerToken(stdout) {
	const text = String(stdout);

	// `wrangler auth token --json` may pretty-print the JSON across multiple
	// lines, so match the fields instead of trying to parse one line at a time.
	const typeMatch = text.match(/"type"\s*:\s*"([^"]*)"/);
	if (typeMatch?.[1] === "api_key") {
		throw new Error(
			"Wrangler is using CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL. Set CLOUDFLARE_API_TOKEN or run `wrangler login` instead.",
		);
	}

	const tokenMatch = text.match(/"token"\s*:\s*"([^"]+)"/);
	if (tokenMatch?.[1]?.trim()) {
		return tokenMatch[1].trim();
	}

	// Fallback for `wrangler auth token` without --json: the token is printed
	// on its own line and contains no whitespace.
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index];
		if (line.length >= 20 && !line.includes(" ") && /^[A-Za-z0-9._~+/=-]+$/.test(line)) {
			return line;
		}
	}

	return null;
}

async function runWranglerAuthToken() {
	const authArgs = ["auth", "token", "--json"];
	const npxArgs = ["--no-install", "wrangler", "auth", "token", "--json"];
	const configuredWrangler = process.env.MCP_WRANGLER?.trim();
	const primaryWrangler = configuredWrangler
		? { command: configuredWrangler, args: authArgs }
		: { command: LOCAL_WRANGLER, args: authArgs };
	const candidates =
		process.platform === "win32"
			? [
					primaryWrangler,
					{ command: "wrangler.cmd", args: authArgs },
					{ command: "npx.cmd", args: npxArgs },
				]
			: [
					primaryWrangler,
					{ command: "wrangler", args: authArgs },
					{ command: "npx", args: npxArgs },
				];

	let lastError;
	for (const candidate of candidates) {
		try {
			const { stdout } = await execFileAsync(candidate.command, candidate.args, {
				encoding: "utf8",
				env: AUTH_ENV,
				maxBuffer: 1024 * 1024,
				shell: process.platform === "win32",
				windowsHide: true,
			});
			const token = parseWranglerToken(stdout);
			if (token) return token;
			lastError = new Error(`${candidate.command} did not return a token`);
		} catch (error) {
			lastError = error;
		}
	}

	throw new Error(
		`Could not read the Wrangler login key. Run \`wrangler login\` first.${
			lastError instanceof Error && lastError.message ? ` (${lastError.message})` : ""
		}`,
	);
}

const cli = parseArgs(process.argv.slice(2));
if (cli.help) {
	process.stderr.write(usage() + "\n");
	process.exit(0);
}

const remoteUrl = normalizeUrl(cli.url ?? process.env.MCP_URL);
let cachedToken =
	cli.token ?? process.env.MCP_AUTH_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN ?? null;
let tokenRefresh;
let sessionId;
let protocolVersion;

async function getToken(forceRefresh = false) {
	if (cachedToken && !forceRefresh) return cachedToken;

	if (tokenRefresh) return tokenRefresh;

	tokenRefresh = (async () => {
		if (cli.token) {
			cachedToken = cli.token;
			return cachedToken;
		}
		if (process.env.MCP_AUTH_TOKEN || process.env.CLOUDFLARE_API_TOKEN) {
			cachedToken = process.env.MCP_AUTH_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
			return cachedToken;
		}
		cachedToken = await runWranglerAuthToken();
		return cachedToken;
	})();

	try {
		return await tokenRefresh;
	} finally {
		tokenRefresh = undefined;
	}
}

function requestIdOf(message) {
	const messages = Array.isArray(message) ? message : [message];
	for (const entry of messages) {
		if (entry && typeof entry === "object" && entry.id !== undefined && entry.id !== null) {
			return entry.id;
		}
	}
	return null;
}

function writeMessage(message) {
	if (
		message &&
		typeof message === "object" &&
		!Array.isArray(message) &&
		message.result &&
		typeof message.result.protocolVersion === "string"
	) {
		protocolVersion = message.result.protocolVersion;
	}
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeErrorMessage(message, error) {
	const id = requestIdOf(message);
	const detail = error instanceof Error ? error.message : String(error);
	const status = error instanceof BridgeError ? error.status : undefined;
	writeMessage({
		jsonrpc: "2.0",
		id,
		error: {
			code: -32000,
			message: `agentic-inbox-codebam MCP bridge error${status ? ` (HTTP ${status})` : ""}: ${detail}`,
		},
	});
}

async function emitMessages(payload) {
	const messages = Array.isArray(payload) ? payload : [payload];
	for (const message of messages) writeMessage(message);
}

async function consumeSse(response) {
	if (!response.body) return;
	const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = "";

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += value;
			buffer = buffer.replace(/\r\n/g, "\n");

			let boundary = buffer.indexOf("\n\n");
			while (boundary !== -1) {
				const block = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);

				const dataLines = block
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart());
				const data = dataLines.join("\n").trim();

				if (data) {
					try {
						await emitMessages(JSON.parse(data));
					} catch {
						process.stderr.write(
							"[agentic-inbox-codebam-mcp] Ignoring malformed SSE data from server.\n",
						);
					}
				}

				boundary = buffer.indexOf("\n\n");
			}
		}
	} finally {
		reader.releaseLock?.();
	}
}

async function handleResponse(response) {
	if (!response.ok) {
		let body;
		try {
			body = await response.text();
		} catch {
			body = "";
		}
		throw new BridgeError(
			body.trim().slice(0, 400) || response.statusText || "Upstream MCP request failed",
			response.status,
		);
	}

	const session = response.headers.get("mcp-session-id");
	if (session) sessionId = session;

	const contentType = response.headers.get("content-type") ?? "";

	if (response.status === 202) {
		await response.body?.cancel?.().catch?.(() => {});
		return;
	}

	if (contentType.includes("text/event-stream")) {
		await consumeSse(response);
		return;
	}

	if (contentType.includes("application/json")) {
		await emitMessages(await response.json());
		return;
	}

	const text = await response.text();
	if (!text.trim()) return;

	try {
		await emitMessages(JSON.parse(text));
	} catch {
		throw new BridgeError(
			`Unexpected upstream response: ${text.slice(0, 200)}`,
			response.status,
		);
	}
}

// ── Scoped-token adapter ──────────────────────────────────────────────────
// mailflare's /mcp endpoint only accepts ep_ MCP API keys. The ain1_/ain2_
// scoped automation tokens (the agentic-inbox wire format the harness bridge
// and mobile app mint) authenticate against POST /api/v1/scoped/<tool>
// instead. When the resolved credential is such a token, the bridge serves
// the MCP protocol locally and dispatches tools/call to that scoped surface,
// so no server change is needed. ep_/Wrangler credentials keep the original
// /mcp forwarding below. tools/list is served from mcp-tool-manifest.json,
// generated from mailflare's facade by scripts/export-mcp-manifest.mjs.
const SCOPED_TOKEN_RE = /^ain[12]_/;
const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), "mcp-tool-manifest.json");
let toolManifest;

function isScopedToken(token) {
	return typeof token === "string" && SCOPED_TOKEN_RE.test(token);
}

function scopedBaseUrl() {
	return remoteUrl.replace(/\/mcp\/?$/, "");
}

function loadToolManifest() {
	if (!toolManifest) toolManifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
	return toolManifest;
}

function scopedResult(id, result) {
	writeMessage({ jsonrpc: "2.0", id, result });
}

async function callScopedTool(name, args, token) {
	const url = `${scopedBaseUrl()}/api/v1/scoped/${encodeURIComponent(name)}`;
	let response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				"user-agent": `agentic-inbox-codebam-mcp-bridge/${BRIDGE_VERSION}`,
			},
			body: JSON.stringify(args ?? {}),
		});
	} catch (error) {
		throw new BridgeError(`Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const text = await response.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = { error: text.slice(0, 400) || response.statusText };
	}
	return { content: [{ type: "text", text: JSON.stringify(body) }], isError: !response.ok };
}

async function handleScopedMessage(message, token) {
	const method = message?.method;
	const id = message?.id;
	const params = message?.params ?? {};
	// Notifications (no id) get no response.
	if (method === "notifications/initialized" || method === "notifications/cancelled") return;
	if (method === "initialize") {
		scopedResult(id, {
			protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
			capabilities: { tools: {} },
			serverInfo: { name: "agentic-inbox-codebam", version: BRIDGE_VERSION },
		});
		return;
	}
	if (method === "ping") {
		scopedResult(id, {});
		return;
	}
	if (method === "tools/list") {
		scopedResult(id, { tools: loadToolManifest() });
		return;
	}
	if (method === "tools/call") {
		scopedResult(id, await callScopedTool(params.name, params.arguments, token));
		return;
	}
	if (id !== undefined && id !== null) {
		writeMessage({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not supported in scoped mode: ${method}` } });
	}
}

async function postMessage(message, alreadyRetried = false) {
	const token = await getToken();
	if (isScopedToken(token)) return handleScopedMessage(message, token);
	const headers = new Headers({
		accept: "application/json, text/event-stream",
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
		"user-agent": `agentic-inbox-codebam-mcp-bridge/${BRIDGE_VERSION}`,
	});

	if (sessionId) headers.set("mcp-session-id", sessionId);
	if (protocolVersion) headers.set("mcp-protocol-version", protocolVersion);

	let response;
	try {
		response = await fetch(remoteUrl, {
			method: "POST",
			headers,
			body: JSON.stringify(message),
		});
	} catch (error) {
		throw new BridgeError(
			`Could not reach ${remoteUrl}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (response.status === 401 && !alreadyRetried) {
		await response.body?.cancel?.().catch?.(() => {});
		await getToken(true);
		return postMessage(message, true);
	}

	return handleResponse(response);
}

let queue = Promise.resolve();
let closed = false;

function enqueue(line) {
	queue = queue
		.then(async () => {
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				writeMessage({
					jsonrpc: "2.0",
					id: null,
					error: { code: -32700, message: "Parse error in stdio bridge." },
				});
				return;
			}

			try {
				await postMessage(message);
			} catch (error) {
				writeErrorMessage(message, error);
			}
		})
		.catch((error) => {
			process.stderr.write(
				`[agentic-inbox-codebam-mcp] Unexpected bridge error: ${
					error instanceof Error ? (error.stack ?? error.message) : String(error)
				}\n`,
			);
		});
}

async function terminateSession() {
	if (closed || !sessionId) return;
	closed = true;
	try {
		const token = await getToken();
		const headers = new Headers({
			authorization: `Bearer ${token}`,
			"mcp-session-id": sessionId,
			"user-agent": `agentic-inbox-codebam-mcp-bridge/${BRIDGE_VERSION}`,
		});
		const response = await fetch(remoteUrl, { method: "DELETE", headers });
		await response.body?.cancel?.().catch?.(() => {});
	} catch {
		// Session cleanup is best effort.
	}
}

const lines = readline.createInterface({
	input: process.stdin,
	terminal: false,
});

lines.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	enqueue(trimmed);
});

lines.on("close", () => {
	void (async () => {
		await queue;
		await terminateSession();
		process.exit(0);
	})();
});

process.on("SIGINT", () => {
	void (async () => {
		await queue;
		await terminateSession();
		process.exit(0);
	})();
});

process.on("SIGTERM", () => {
	void (async () => {
		await queue;
		await terminateSession();
		process.exit(0);
	})();
});

// Resolve the Wrangler credential before the first MCP initialize request so
// clients get an actionable error immediately when no login key exists.
try {
	const token = await getToken();
	const target = isScopedToken(token)
		? `${scopedBaseUrl()}/api/v1/scoped (scoped-token adapter)`
		: remoteUrl;
	process.stderr.write(
		`[agentic-inbox-codebam-mcp] Bridging stdio to ${target} using the local credential.\n`,
	);
} catch (error) {
	process.stderr.write(
		`[agentic-inbox-codebam-mcp] ${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exit(1);
}
