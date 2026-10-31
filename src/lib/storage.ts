import { useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * Where Vela keeps its data on this device. The interface reads and writes synchronously, as it
 * did with localStorage; in the desktop app the data lives in Vela's own SQLite database
 * (`storage.rs`), loaded into memory at start, and every change is sent to Rust in batches. In a
 * browser the data stays in localStorage; without either (tests) it stays in memory.
 *
 * The first time the desktop app starts with a database that has no preferences yet, it copies the
 * `vela.*` keys from WebView2's localStorage, where earlier versions kept everything. That copy is
 * left untouched, as a backup an older version can still read.
 */
export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type Change = { key: string; value: string | null };
export type Writer = (changes: Change[]) => Promise<void>;

export type Backend = "desktop" | "browser" | "memory";
export type StorageStatus = {
  backend: Backend;
  /** Changes not yet written to disk (desktop). */
  pending: number;
  /** The last write failure; the changes are kept and retried. */
  error?: string;
  /** Whether this start copied the data from localStorage. */
  migrated: boolean;
};

const PREFIX = "vela.";
export const MIGRATION_KEY = "vela.storage.migrated";
/** The key every installation that ever ran has (see `store.ts`). */
const PREFERENCES_KEY = "vela.preferences.v2";
/** Wait before a batch so bursts (progress every second, several keys at once) share a write. */
const BATCH_DELAY = 50;
const RETRY_DELAY = 5_000;

export type DesktopStorage = KeyValueStorage & {
  /** Loads the saved entries; `legacy` is copied when the database is empty. */
  init(entries: Change[], legacy?: KeyValueStorage & { length: number; key(index: number): string | null }): Promise<void>;
  /** Resolves when nothing is left to write (or the write failed and will be retried). */
  flush(): Promise<void>;
  getStatus(): StorageStatus;
  subscribe(listener: () => void): () => void;
};

export function createDesktopStorage(writer: Writer, backend: Backend = "desktop"): DesktopStorage {
  const data = new Map<string, string>();
  const pending = new Map<string, string | null>();
  const listeners = new Set<() => void>();
  let status: StorageStatus = { backend, pending: 0, migrated: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> | undefined;

  function setStatus(next: Partial<StorageStatus>) {
    status = { ...status, ...next, pending: pending.size };
    for (const listener of [...listeners]) listener();
  }

  async function write(): Promise<void> {
    const batch = [...pending].map(([key, value]) => ({ key, value }));
    pending.clear();
    try {
      await writer(batch);
      setStatus({ error: undefined });
    } catch (error) {
      // Keep the failed changes unless a newer one replaced them meanwhile.
      for (const change of batch) if (!pending.has(change.key)) pending.set(change.key, change.value);
      setStatus({ error: error instanceof Error ? error.message : String(error) });
      timer = setTimeout(schedule, RETRY_DELAY);
    }
  }

  function schedule() {
    timer = undefined;
    if (writing || !pending.size) return;
    writing = write().finally(() => {
      writing = undefined;
      if (pending.size && !timer) timer = setTimeout(schedule, BATCH_DELAY);
    });
  }

  function queue(key: string, value: string | null) {
    pending.set(key, value);
    if (!timer && !writing) timer = setTimeout(schedule, BATCH_DELAY);
    setStatus({});
  }

  return {
    getItem: (key) => data.get(key) ?? null,
    setItem(key, value) {
      const text = String(value);
      if (data.get(key) === text) return;
      data.set(key, text);
      queue(key, text);
    },
    removeItem(key) {
      if (!data.has(key)) return;
      data.delete(key);
      queue(key, null);
    },
    async init(entries, legacy) {
      data.clear();
      for (const { key, value } of entries) if (value !== null) data.set(key, value);
      // A database that already holds the preferences (or was migrated) is the truth, even when
      // localStorage still has the old copy.
      if (!legacy || data.has(PREFERENCES_KEY) || data.has(MIGRATION_KEY)) return;
      const copied: string[] = [];
      for (let index = 0; index < legacy.length; index++) {
        const key = legacy.key(index);
        if (!key?.startsWith(PREFIX)) continue;
        const value = legacy.getItem(key);
        if (value === null) continue;
        data.set(key, value);
        pending.set(key, value);
        copied.push(key);
      }
      if (!copied.length) return;
      const note = JSON.stringify({ from: "localStorage", at: new Date().toISOString(), keys: copied.length });
      data.set(MIGRATION_KEY, note);
      pending.set(MIGRATION_KEY, note);
      setStatus({ migrated: true });
      await this.flush();
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      // One pass: a failure keeps the changes for the retry timer instead of looping here.
      if (writing) await writing;
      if (pending.size && !status.error) {
        schedule();
        if (writing) await writing;
      }
    },
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** localStorage with its exceptions swallowed (private mode, full quota): the data lives for the session. */
function browserStorage(): KeyValueStorage {
  const memory = new Map<string, string>();
  return {
    getItem(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return memory.get(key) ?? null;
      }
    },
    setItem(key, value) {
      memory.set(key, String(value));
      try {
        localStorage.setItem(key, value);
      } catch {
        /* Kept in memory. */
      }
    },
    removeItem(key) {
      memory.delete(key);
      try {
        localStorage.removeItem(key);
      } catch {
        /* Nothing else to remove. */
      }
    },
  };
}

function hasLocalStorage(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage !== null;
  } catch {
    return false;
  }
}

const desktop = isTauri()
  ? createDesktopStorage((changes) => invoke("storage_write", { changes }))
  : undefined;
const fallback: KeyValueStorage & { getStatus(): StorageStatus; subscribe(listener: () => void): () => void } = {
  ...(hasLocalStorage()
    ? browserStorage()
    : (() => {
        const memory = new Map<string, string>();
        return {
          getItem: (key: string) => memory.get(key) ?? null,
          setItem: (key: string, value: string) => void memory.set(key, String(value)),
          removeItem: (key: string) => void memory.delete(key),
        };
      })()),
  // One object: `useSyncExternalStore` re-renders forever when a snapshot is new on every call.
  getStatus: () => fallbackStatus,
  subscribe: () => () => {},
};
const fallbackStatus: StorageStatus = { backend: hasLocalStorage() ? "browser" : "memory", pending: 0, migrated: false };

let active: KeyValueStorage = desktop ?? fallback;

/** The device storage every module reads and writes. Call `initStorage` before the first read in the desktop app. */
export const storage: KeyValueStorage = {
  getItem: (key) => active.getItem(key),
  setItem: (key, value) => active.setItem(key, value),
  removeItem: (key) => active.removeItem(key),
};

/**
 * Loads the database in the desktop app (and migrates localStorage the first time). When the
 * database cannot be opened, the app keeps using localStorage and `getStorageStatus` says so.
 */
export async function initStorage(): Promise<void> {
  if (!desktop) return;
  try {
    const entries = await invoke<Change[]>("storage_load");
    await desktop.init(entries, hasLocalStorage() ? localStorage : undefined);
    active = desktop;
  } catch (error) {
    active = fallback;
    unavailable = { ...fallbackStatus, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The fallback's status with why the database could not be opened (one object, as above). */
let unavailable: StorageStatus | undefined;

export function getStorageStatus(): StorageStatus {
  if (active === desktop && desktop) return desktop.getStatus();
  return unavailable ?? fallback.getStatus();
}

export function subscribeStorage(listener: () => void): () => void {
  return active === desktop && desktop ? desktop.subscribe(listener) : fallback.subscribe(listener);
}

/** Writes everything pending (before closing the window). */
export function flushStorage(): Promise<void> {
  return active === desktop && desktop ? desktop.flush() : Promise.resolve();
}

export function useStorageStatus(): StorageStatus {
  return useSyncExternalStore(subscribeStorage, getStorageStatus, getStorageStatus);
}

export type StorageInfo = {
  path: string;
  folder: string;
  size: number;
  keys: number;
  backups: { name: string; size: number; created: number }[];
};

/** Where the database is and which backups exist (desktop only). */
export async function storageInfo(): Promise<StorageInfo | null> {
  if (!desktop || active !== desktop) return null;
  return invoke<StorageInfo>("storage_info");
}

export async function backupStorage(): Promise<string> {
  await flushStorage();
  return invoke<string>("storage_backup");
}

export function revealStorage(): Promise<void> {
  return invoke("storage_reveal");
}
