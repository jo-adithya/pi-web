import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vitest/config";
import { developmentServer } from "./dev-server.js";

export default defineConfig(({ command, mode }) => ({
  server: command === "serve" && mode !== "test" ? developmentServer(process.env) : undefined,
  plugins: [solid()],
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    globals: false,
  },
}));
