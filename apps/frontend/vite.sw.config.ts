import { defineConfig } from "vite";

/**
 * Builds the service worker as one classic script at public/sw.js.
 *
 * Into public/ rather than dist/: the dev server serves public/ as-is,
 * so `pnpm dev` gets a working worker too, and the main build copies it
 * into dist/ with everything else. Unhashed, because the browser finds
 * a worker by its URL. The output is gitignored.
 */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: "public",
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: "src/sw/sw.ts",
      formats: ["iife"],
      name: "tmcServiceWorker",
      fileName: () => "sw.js",
    },
  },
});
