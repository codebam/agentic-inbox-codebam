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
	},
});
