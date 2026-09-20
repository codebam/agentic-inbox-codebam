// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Split the heaviest client-only dependency families out of the route bundles.
 * The composer is lazy-loaded; these manual chunks keep each vendor payload
 * below Vite's 500 kB warning threshold and let the browser cache them
 * independently.
 */
function manualChunks(id: string): string | undefined {
  const normalizedId = id.replace(/\\/g, "/");

  if (/node_modules\/(?:react|react-dom|scheduler)\//.test(normalizedId)) {
    return "vendor-react";
  }
  if (normalizedId.includes("node_modules/@tiptap/")) return "vendor-tiptap";
  if (normalizedId.includes("node_modules/prosemirror-"))
    return "vendor-prosemirror";

  if (
    /node_modules\/(?:micromark|mdast-util-|hast-util-|unist-|property-information|stringify-entities|markdown-table|linkifyjs|parse-entities|character-entities|decode-named-character-reference|html-void-elements|space-separated-tokens|comma-separated-tokens|ccount|devlop|bail|trough|is-plain-obj|extend|longest-streak|zwitch|trim-lines|escape-string-regexp|vfile)/.test(
      normalizedId,
    )
  ) {
    return "vendor-markdown";
  }

  return undefined;
}

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
});
