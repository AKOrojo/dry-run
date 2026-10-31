import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cesium from "vite-plugin-cesium";
import { readFileSync } from "node:fs";

// Cesium's files are served from a versioned path so the API can cache them as immutable (dryrun/api/static.py):
// upgrading the cesium package changes the URL instead of leaving browsers on the old build.
const CESIUM_VERSION = JSON.parse(readFileSync(new URL("./node_modules/cesium/package.json", import.meta.url), "utf8")).version;

// Dev: UI on :5173 proxies /api and /runs to the local API on :8080 (same-origin like prod).
export default defineConfig({
  plugins: [react(), cesium({ cesiumBaseUrl: `cesium-${CESIUM_VERSION}/` })],
  envDir: "..", // read the repo-root .env (single env file for the whole team)
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8080", "/runs": "http://localhost:8080" },
  },
});
