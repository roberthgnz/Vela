import { useSyncExternalStore } from "react";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

/**
 * Application updates (desktop only). The Rust side checks the release `latest.json`, verifies
 * the installer's signature and runs it; on Windows the installer closes Vela and reopens it.
 */

export type UpdateInfo = { version: string; current: string; notes?: string | null; date?: string | null };

export type UpdateState = {
  status: "idle" | "checking" | "current" | "available" | "installing" | "error";
  info?: UpdateInfo;
  /** Bytes downloaded and total size (when known) while installing. */
  progress?: { downloaded: number; total?: number | null };
  error?: string;
  checkedAt?: number;
  /** The user postponed this version in the notice. */
  dismissed?: string;
};

const autoKey = "vela.ui.updates";
let state: UpdateState = { status: "idle" };
const listeners = new Set<() => void>();

function set(next: Partial<UpdateState>) {
  state = { ...state, ...next };
  for (const listener of [...listeners]) listener();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "No se pudo completar la actualización.";
}

export const updates = {
  supported: () => isTauri(),
  getSnapshot: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Whether Vela looks for updates when it starts (on by default). */
  automatic(): boolean {
    try {
      return localStorage.getItem(autoKey) !== "off";
    } catch {
      return true;
    }
  },
  setAutomatic(value: boolean) {
    try {
      localStorage.setItem(autoKey, value ? "auto" : "off");
    } catch {
      /* The preference is optional. */
    }
    set({});
  },
  async check(): Promise<UpdateInfo | null> {
    if (!isTauri() || state.status === "checking" || state.status === "installing") return state.info ?? null;
    set({ status: "checking", error: undefined });
    try {
      const info = await invoke<UpdateInfo | null>("update_check");
      set({ status: info ? "available" : "current", info: info ?? undefined, checkedAt: Date.now() });
      return info;
    } catch (error) {
      set({ status: "error", error: message(error), checkedAt: Date.now() });
      return null;
    }
  },
  async install() {
    if (state.status !== "available") return;
    set({ status: "installing", progress: { downloaded: 0 }, error: undefined });
    const progress = new Channel<{ downloaded: number; total?: number | null }>();
    progress.onmessage = (value) => set({ progress: value });
    try {
      // Resolves only if the platform does not restart the app by itself.
      await invoke("update_install", { progress });
    } catch (error) {
      set({ status: "error", error: message(error) });
    }
  },
  /** After a failed installation the pending update is gone; look for it again first. */
  async retry() {
    if (await updates.check()) await updates.install();
  },
  dismiss() {
    set({ dismissed: state.info?.version });
  },
};

export function useUpdates(): UpdateState {
  return useSyncExternalStore(updates.subscribe, updates.getSnapshot, updates.getSnapshot);
}
