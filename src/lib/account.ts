import { useSyncExternalStore } from "react";
import { storage } from "./storage";
import { MAIN_PROFILE, mediaKey, preferencesStore } from "./store";
import {
  getAddonCollection,
  getLibrary,
  getUser,
  login,
  logout,
  planSync,
  putLibrary,
  StremioApiError,
  syncable,
  type StremioUser,
  type SyncState,
} from "./stremioApi";
import { deleteSecret, getSecret, setSecret } from "./transport";

const storageKey = "vela.account.v1";
const secretName = "stremio-auth-key";

export type SyncSummary = { pulled: number; pushed: number; removed: number; at: number };

export type AccountState = {
  status: "loading" | "signed-out" | "signed-in";
  user?: { id: string; email: string; avatar?: string };
  syncing: boolean;
  lastSync?: SyncSummary;
  error?: string;
};

type Persisted = {
  user?: AccountState["user"];
  /** Vela profile whose library is synchronized with the account (absent: the main profile). */
  profile?: string;
  lastSync?: SyncSummary;
  sync: SyncState;
};

function readPersisted(): Persisted {
  try {
    const value = JSON.parse(storage.getItem(storageKey) || "null") as Persisted | null;
    if (value && typeof value === "object" && value.sync) return value;
  } catch {
    /* A damaged account cache only means the next sync starts from scratch. */
  }
  return { sync: { synced: {}, removed: {} } };
}

let persisted = readPersisted();
let state: AccountState = { status: "loading", syncing: false, user: persisted.user, lastSync: persisted.lastSync };
const listeners = new Set<() => void>();
let applying = false;
let knownKeys = new Set(Object.keys(preferencesStore.getSnapshot().library));
let knownProfile = preferencesStore.getProfile();

/** Only the profile that signed in synchronizes; other profiles stay local. */
function ownsAccount(): boolean {
  return preferencesStore.getProfile() === (persisted.profile ?? MAIN_PROFILE);
}

function save() {
  try {
    storage.setItem(storageKey, JSON.stringify(persisted));
  } catch {
    /* Persisting sync metadata is best effort. */
  }
}

function set(next: Partial<AccountState>) {
  state = { ...state, ...next };
  for (const listener of [...listeners]) listener();
}

/** Remembers titles removed in Vela so the next sync can remove them from the account too. */
preferencesStore.subscribe(() => {
  const library = preferencesStore.getSnapshot().library;
  const keys = new Set(Object.keys(library));
  // Switching profiles replaces the whole library: that is not a removal.
  if (preferencesStore.getProfile() !== knownProfile) {
    knownProfile = preferencesStore.getProfile();
    knownKeys = keys;
    return;
  }
  if (!applying && state.status === "signed-in" && ownsAccount()) {
    for (const key of knownKeys) {
      if (keys.has(key)) continue;
      const [type, id] = JSON.parse(key) as [string, string];
      if (syncable({ type, id })) persisted.sync.removed[id] = { type, at: Date.now() };
    }
    save();
  }
  knownKeys = keys;
});

function userOf(user: StremioUser): AccountState["user"] {
  return { id: user._id, email: user.email, avatar: user.avatar || undefined };
}

async function authKey(): Promise<string> {
  const key = await getSecret(secretName);
  if (!key) throw new Error("No hay ninguna sesión de Stremio guardada en este equipo.");
  return key;
}

async function expire(error: unknown) {
  if (error instanceof StremioApiError && error.code === 1) {
    await deleteSecret(secretName).catch(() => {});
    persisted = { sync: persisted.sync };
    save();
    set({ status: "signed-out", user: undefined, syncing: false, error: error.message });
    return true;
  }
  return false;
}

export const account = {
  getSnapshot: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  async init() {
    if (!persisted.user) {
      set({ status: "signed-out" });
      return;
    }
    try {
      await authKey();
      set({ status: "signed-in" });
      void account.sync();
    } catch {
      set({ status: "signed-out", user: undefined });
    }
  },

  async signInWithKey(key: string, known?: StremioUser) {
    const user = known ?? (await getUser(key));
    await setSecret(secretName, key);
    // A new account, or the same one linked to another profile, starts a new synchronization history.
    if (persisted.user?.id !== user._id || (persisted.profile ?? MAIN_PROFILE) !== preferencesStore.getProfile())
      persisted.sync = { synced: {}, removed: {} };
    persisted.user = userOf(user);
    persisted.profile = preferencesStore.getProfile();
    save();
    set({ status: "signed-in", user: persisted.user, error: undefined });
    await account.sync();
  },

  async signInWithPassword(email: string, password: string) {
    const result = await login(email.trim(), password);
    await account.signInWithKey(result.authKey, result.user);
  },

  async signOut() {
    const key = await getSecret(secretName).catch(() => null);
    if (key) await logout(key).catch(() => {});
    await deleteSecret(secretName);
    persisted = { sync: { synced: {}, removed: {} } };
    save();
    set({ status: "signed-out", user: undefined, lastSync: undefined, error: undefined });
  },

  /** Pulls the account library, merges it with the local one and uploads local changes. */
  async sync(): Promise<SyncSummary | undefined> {
    if (state.status !== "signed-in" || state.syncing || !ownsAccount()) return undefined;
    set({ syncing: true, error: undefined });
    try {
      const key = await authKey();
      const remote = await getLibrary(key);
      const plan = await planSync(preferencesStore.getSnapshot().library, remote, persisted.sync);
      if (plan.push.length) await putLibrary(key, plan.push);
      applying = true;
      try {
        preferencesStore.mergeLibrary([...plan.local, ...plan.pull], plan.drop);
      } finally {
        applying = false;
        knownKeys = new Set(Object.keys(preferencesStore.getSnapshot().library));
      }
      const removed = plan.push.filter((item) => item.removed && !item.temp).length;
      persisted.sync = { synced: { ...persisted.sync.synced, ...plan.synced }, removed: {} };
      const summary: SyncSummary = {
        pulled: plan.pull.length + plan.drop.length,
        pushed: plan.push.length - removed,
        removed,
        at: Date.now(),
      };
      persisted.lastSync = summary;
      save();
      set({ syncing: false, lastSync: summary });
      return summary;
    } catch (error) {
      if (!(await expire(error)))
        set({ syncing: false, error: error instanceof Error ? error.message : "No se pudo sincronizar." });
      return undefined;
    }
  },

  async addons() {
    try {
      return (await getAddonCollection(await authKey())).addons;
    } catch (error) {
      await expire(error);
      throw error;
    }
  },

  /** Profile linked to the account, or undefined when signed out. */
  profile(): string | undefined {
    return state.status === "signed-in" ? (persisted.profile ?? MAIN_PROFILE) : undefined;
  },

  isInLibrary(type: string, id: string) {
    return Object.hasOwn(preferencesStore.getSnapshot().library, mediaKey(type, id));
  },
};

export function useAccount(): AccountState {
  return useSyncExternalStore(account.subscribe, account.getSnapshot, account.getSnapshot);
}
