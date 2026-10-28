import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cesium from "vite-plugin-cesium";

// Dev: UI on :5173 proxies /api and /runs to the local API on :8080 (same-origin like prod).
export default defineConfig({
  plugins: [react(), cesium()],
  envDir: "..", // read the repo-root .env (single env file for the whole team)
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8080", "/runs": "http://localhost:8080" },
  },
});
