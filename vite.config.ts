import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { addonProxyPlugin } from "./dev/proxy.ts";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [react(), addonProxyPlugin()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // Agent worktrees and scratch output live inside the project; they must not reload the app.
  server: { host: "127.0.0.1", port: 1430, strictPort: true, watch: { ignored: ["**/.claude/**", "**/.tmp/**", "**/src-tauri/target/**"] } },
  preview: { host: "127.0.0.1", port: 1431, strictPort: true },
  clearScreen: false,
  // JASSUB locates its worker and WebAssembly files relative to its own module.
  // Its CommonJS dependencies still need pre-bundling in development.
  optimizeDeps: {
    exclude: ["jassub"],
    include: ["jassub > throughput", "jassub > abslink", "jassub > abslink/w3c", "jassub > rvfc-polyfill", "jassub > lfa-ponyfill"],
  },
  build: { target: "es2022", sourcemap: false },
  // Component and hook tests declare `// @vitest-environment jsdom` at the top of the file.
  test: { include: ["src/**/*.test.{ts,tsx}"], environment: "node", setupFiles: ["src/test-setup.ts"] },
});
