import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Tests run inside workerd via @cloudflare/vitest-pool-workers, so Durable
 * Object SQLite storage, R2 and the Hono worker are exercised for real.
 *
 * wrangler.test.jsonc is a slim copy of wrangler.jsonc: no custom routes and
 * no `send_email` binding, so a test run can never deliver mail.
 */
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.test.jsonc" },
			remoteBindings: false,
		}),
	],
	test: {
		include: ["tests/**/*.test.ts"],
	},
});
