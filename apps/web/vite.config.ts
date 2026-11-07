import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vitest/config";
import { developmentServer } from "./dev-server.js";

export default defineConfig(({ command, mode }) => ({
  server: command === "serve" && mode !== "test" ? developmentServer(process.env) : undefined,
  plugins: [solid()],
  resolve: { alias: { "artifact-chart.js?raw": join(dirname(createRequire(import.meta.url).resolve("chart.js")), "chart.umd.min.js") + "?raw" } },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    globals: false,
  },
}));
