import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Tests run inside workerd via @cloudflare/vitest-pool-workers, so Durable
 * Object SQLite storage, R2 and the Hono worker are exercised for real.
 *
 * wrangler.test.jsonc is a slim copy of wrangler.jsonc: no custom routes and
 * no `send_email` binding, so a test run can never deliver mail.
 *
 * The aliases mirror the app's tsconfig (`~/*` paths plus the bare `shared/*`
 * imports that resolve through `baseUrl`), so a test can import app modules
 * like `app/lib/utils.ts`.
 */
const appDir = fileURLToPath(new URL("./app", import.meta.url));
const sharedDir = fileURLToPath(new URL("./shared", import.meta.url));

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.test.jsonc" },
			remoteBindings: false,
		}),
	],
	resolve: {
		alias: [
			{ find: /^~\//, replacement: `${appDir}/` },
			{ find: /^shared\//, replacement: `${sharedDir}/` },
		],
	},
	test: {
		include: ["tests/**/*.test.ts"],
		// Default fake send seam (no send_email binding in the test config).
		setupFiles: ["./tests/setup.ts"],
		// Integration tests on real workerd — DO SQLite, R2, RPC round-trips
		// — not unit tests: the 5s default is too tight when the whole suite
		// runs on a loaded machine. Six files used to time out at exactly
		// 5000ms in full runs while passing in isolation.
		testTimeout: 15_000,
		hookTimeout: 15_000,
		// Every file gets its own workerd; one worker per core (16 here)
		// oversubscribes a desk that is also running a compositor and
		// agents. Half the cores keeps full runs stable.
		maxWorkers: 8,
	},
});
