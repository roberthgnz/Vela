import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { installGlobalErrorLogging, log } from "./lib/log";
import { getStorageStatus, initStorage } from "./lib/storage";
import "./styles.css";

const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// The stores read their data when their modules load, so the database is loaded first.
async function start() {
  installGlobalErrorLogging();
  await initStorage();
  const status = getStorageStatus();
  log.info(`interface ${__APP_VERSION__} started`, { storage: status.backend, migrated: status.migrated, error: status.error });
  const { default: App } = await import("./App");
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void start();
