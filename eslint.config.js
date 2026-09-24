// ESLint flat config.
//
// Type-aware rules (typescript-eslint's *TypeChecked* presets) run on the files
// that belong to a TypeScript project: app/, workers/, shared/ and the root
// config files. `tests/` and `scripts/` belong to no tsconfig, so they get the
// syntax-level rules only — making the test suite type-checked is a separate
// job (it is ~150 type errors away from clean today).
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Files a tsconfig project covers, so type-aware rules can run on them.
const TYPE_AWARE_FILES = [
	"app/**/*.ts",
	"app/**/*.tsx",
	"workers/**/*.ts",
	"shared/**/*.ts",
	"vite.config.ts",
	"vitest.config.ts",
	"react-router.config.ts",
];

// react-hooks ships its ruleset as a flat config object (array in some versions).
const reactHooksRecommended = Array.isArray(reactHooks.configs.recommended)
	? Object.assign({}, ...reactHooks.configs.recommended.map((c) => c.rules ?? {}))
	: reactHooks.configs.recommended.rules;

export default tseslint.config(
	// Build output and generated files.
	{
		ignores: [
			"build/**",
			"dist/**",
			".react-router/**",
			".wrangler/**",
			"node_modules/**",
			".hermes/**",
			".worktrees/**",
			"worker-configuration.d.ts",
		],
	},

	js.configs.recommended,

	// Syntax-level TypeScript rules — no type information required.
	{
		files: ["**/*.ts", "**/*.tsx", "**/*.mjs"],
		extends: [...tseslint.configs.recommended],
	},

	// Type-aware rules, where a tsconfig project covers the file.
	{
		files: TYPE_AWARE_FILES,
		extends: [...tseslint.configs.recommendedTypeChecked],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},

	// React UI.
	{
		files: ["app/**/*.{ts,tsx}"],
		plugins: { "react-hooks": reactHooks },
		rules: { ...reactHooksRecommended },
		languageOptions: { globals: { ...globals.browser } },
	},

	// Worker runtime: Hono API, Durable Objects, MCP server.
	{
		files: ["workers/**/*.ts", "shared/**/*.ts"],
		languageOptions: { globals: { ...globals.worker } },
	},

	// Node-side tooling.
	{
		files: ["scripts/**/*.mjs"],
		languageOptions: { globals: { ...globals.node } },
	},
);
