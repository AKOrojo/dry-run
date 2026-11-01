// Unit tests run in Node without the Cesium/React plugins of vite.config.ts.
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["src/**/*.test.{ts,tsx}"], environment: "node" } });
