import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { addonProxyPlugin } from "./dev/proxy.ts";

export default defineConfig({
  plugins: [react(), addonProxyPlugin()],
  server: { host: "127.0.0.1", port: 1430, strictPort: true },
  preview: { host: "127.0.0.1", port: 1431, strictPort: true },
  clearScreen: false,
  build: { target: "es2022", sourcemap: false },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
