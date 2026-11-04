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
import { t } from "./i18n";

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
// Responses belong to the session and profile that started them, including after switching back.
let sessionRevision = 0;
let profileRevision = 0;
let credentialWrite: Promise<void> = Promise.resolve();

/** Serialize OS credential changes so an old deletion cannot finish after a newer sign-in. */
function changeSecret(revision: number, change: () => Promise<void>): Promise<void> {
  const next = credentialWrite.catch(() => {}).then(async () => {
    if (revision === sessionRevision) await change();
  });
  credentialWrite = next;
  return next;
}

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
    profileRevision++;
    if (state.syncing) set({ syncing: false });
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
  if (!key) throw new Error(t("lib.account.noSession"));
  return key;
}

async function expire(error: unknown, revision: number) {
  if (revision !== sessionRevision) return true;
  if (error instanceof StremioApiError && error.code === 1) {
    const expired = ++sessionRevision;
    persisted = { sync: persisted.sync };
    save();
    set({ status: "signed-out", user: undefined, syncing: false, lastSync: undefined, error: error.message });
    await changeSecret(expired, () => deleteSecret(secretName)).catch(() => {});
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
    const revision = sessionRevision;
    if (!persisted.user) {
      set({ status: "signed-out" });
      return;
    }
    try {
      await authKey();
      if (revision !== sessionRevision) return;
      set({ status: "signed-in" });
      void account.sync();
    } catch {
      if (revision !== sessionRevision) return;
      set({ status: "signed-out", user: undefined });
    }
  },

  async signInWithKey(key: string, known?: StremioUser) {
    const revision = ++sessionRevision;
    const profile = preferencesStore.getProfile();
    const profileAtStart = profileRevision;
    const current = () => revision === sessionRevision && profileAtStart === profileRevision;
    if (state.syncing) set({ syncing: false });
    const user = known ?? (await getUser(key));
    if (!current()) return;
    await changeSecret(revision, () => setSecret(secretName, key));
    // Once the credential write starts, finish linking its original profile even if the user
    // navigates to another one meanwhile. Otherwise the cache could name the old account while
    // the OS already holds the new account's key. A newer sign-in/sign-out still supersedes it.
    if (revision !== sessionRevision) return;
    // A new account, or the same one linked to another profile, starts a new synchronization history.
    if (persisted.user?.id !== user._id || (persisted.profile ?? MAIN_PROFILE) !== profile) {
      persisted.sync = { synced: {}, removed: {} };
      persisted.lastSync = undefined;
    }
    persisted.user = userOf(user);
    persisted.profile = profile;
    save();
    set({ status: "signed-in", user: persisted.user, syncing: false, lastSync: persisted.lastSync, error: undefined });
    await account.sync();
  },

  async signInWithPassword(email: string, password: string) {
    const revision = ++sessionRevision;
    const profileAtStart = profileRevision;
    if (state.syncing) set({ syncing: false });
    const result = await login(email.trim(), password);
    if (revision !== sessionRevision || profileAtStart !== profileRevision) return;
    await account.signInWithKey(result.authKey, result.user);
  },

  async signOut() {
    const revision = ++sessionRevision;
    persisted = { sync: { synced: {}, removed: {} } };
    save();
    set({ status: "signed-out", user: undefined, syncing: false, lastSync: undefined, error: undefined });
    const key = await getSecret(secretName).catch(() => null);
    if (revision !== sessionRevision) return;
    await changeSecret(revision, () => deleteSecret(secretName));
    if (key && revision === sessionRevision) await logout(key).catch(() => {});
  },

  /** Pulls the account library, merges it with the local one and uploads local changes. */
  async sync(): Promise<SyncSummary | undefined> {
    if (state.status !== "signed-in" || state.syncing || !ownsAccount()) return undefined;
    const revision = sessionRevision;
    const profileAtStart = profileRevision;
    const current = () => revision === sessionRevision && profileAtStart === profileRevision;
    set({ syncing: true, error: undefined });
    try {
      const key = await authKey();
      if (!current()) return undefined;
      const remote = await getLibrary(key);
      if (!current()) return undefined;
      const library = preferencesStore.getSnapshot().library;
      const removedAtStart = { ...persisted.sync.removed };
      const plan = await planSync(library, remote, { synced: { ...persisted.sync.synced }, removed: removedAtStart });
      if (!current()) return undefined;
      if (plan.push.length) await putLibrary(key, plan.push);
      if (!current()) return undefined;
      // An upload can take seconds. Keep edits/removals made since planning instead of replacing
      // them with its earlier snapshot, and leave them unacknowledged for the next sync.
      const latest = preferencesStore.getSnapshot().library;
      const unchanged = (type: string, id: string) => latest[mediaKey(type, id)] === library[mediaKey(type, id)];
      const pull = plan.pull.filter((entry) => unchanged(entry.meta.type, entry.meta.id));
      const local = plan.local.filter((entry) => unchanged(entry.meta.type, entry.meta.id));
      const drop = plan.drop.filter((entry) => unchanged(entry.type, entry.id));
      const beforeById = new Map(Object.values(library).map((entry) => [entry.meta.id, entry]));
      const latestById = new Map(Object.values(latest).map((entry) => [entry.meta.id, entry]));
      const synced = Object.fromEntries(Object.entries(plan.synced).filter(([id]) => beforeById.get(id) === latestById.get(id)));
      applying = true;
      try {
        preferencesStore.mergeLibrary([...local, ...pull], drop);
      } finally {
        applying = false;
        knownKeys = new Set(Object.keys(preferencesStore.getSnapshot().library));
      }
      const removed = plan.push.filter((item) => item.removed && !item.temp).length;
      const pendingRemovals = { ...persisted.sync.removed };
      for (const [id, tombstone] of Object.entries(removedAtStart)) {
        if (pendingRemovals[id] === tombstone && Object.hasOwn(synced, id)) delete pendingRemovals[id];
      }
      persisted.sync = { synced: { ...persisted.sync.synced, ...synced }, removed: pendingRemovals };
      const summary: SyncSummary = {
        pulled: pull.length + drop.length,
        pushed: plan.push.length - removed,
        removed,
        at: Date.now(),
      };
      persisted.lastSync = summary;
      save();
      set({ syncing: false, lastSync: summary });
      return summary;
    } catch (error) {
      if (!current()) return undefined;
      const expired = await expire(error, revision);
      if (!expired && current())
        set({ syncing: false, error: error instanceof Error ? error.message : t("lib.account.syncFailed") });
      return undefined;
    }
  },

  async addons() {
    const revision = sessionRevision;
    try {
      const key = await authKey();
      if (revision !== sessionRevision) throw new Error(t("lib.account.noSession"));
      const result = await getAddonCollection(key);
      if (revision !== sessionRevision) throw new Error(t("lib.account.noSession"));
      return result.addons;
    } catch (error) {
      await expire(error, revision);
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
