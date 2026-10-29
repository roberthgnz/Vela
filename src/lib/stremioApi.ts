import type { LibraryEntry, MediaItem } from "./contracts";
import { postJson, requestJson } from "./transport";

/**
 * Stremio account API, as used by stremio-core (branch development, checked 2026-10-29):
 * POST https://api.strem.io/api/<method> with a JSON body, answered with `{ result }` or `{ error: { code, message } }`.
 * Account linking uses GET https://link.stremio.com/api/v2/{create,read}.
 * Request bodies mirror the serialized `APIRequest`/`DatastoreRequest` values in stremio-core's unit tests.
 */
export const API_URL = "https://api.strem.io/api/";
export const LINK_URL = "https://link.stremio.com/api/v2/";
export const CINEMETA_URL = "https://v3-cinemeta.strem.io/manifest.json";

export type StremioUser = { _id: string; email: string; avatar?: string | null };
export type AddonDescriptor = {
  transportUrl: string;
  manifest: { id: string; name: string; version?: string; description?: string; logo?: string };
  flags?: { official?: boolean; protected?: boolean };
};

/** Library item as stored by Stremio. Times in `state` are milliseconds. */
export type RemoteItem = {
  _id: string;
  name: string;
  type: string;
  poster?: string | null;
  posterShape?: string;
  removed: boolean;
  temp: boolean;
  _ctime?: string | null;
  _mtime: string;
  state: {
    lastWatched?: string | null;
    timeWatched: number;
    timeOffset: number;
    overallTimeWatched: number;
    timesWatched: number;
    flaggedWatched: number;
    duration: number;
    video_id?: string | null;
    watched?: string | null;
    noNotif?: boolean;
  };
  behaviorHints?: Record<string, unknown>;
  [key: string]: unknown;
};

export class StremioApiError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

function friendly(code: number, message: string): string {
  if (code === 1 && /session/i.test(message)) return "La sesión de Stremio ha caducado. Vuelve a iniciar sesión.";
  if (/password|passphrase|wrong/i.test(message)) return "Correo o contraseña incorrectos.";
  if (/user not found|no user/i.test(message)) return "No existe ninguna cuenta de Stremio con ese correo.";
  return `Stremio respondió: ${message}`;
}

async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
  let response: unknown;
  try {
    response = await postJson(`${API_URL}${method}`, body);
  } catch (error) {
    throw new Error(`No se pudo conectar con la cuenta de Stremio. ${error instanceof Error ? error.message : ""}`.trim());
  }
  const envelope = (response ?? {}) as { result?: T; error?: { code?: number; message?: string } };
  if (envelope.error) {
    const code = Number(envelope.error.code ?? 0);
    throw new StremioApiError(code, friendly(code, String(envelope.error.message ?? "error desconocido")));
  }
  if (!("result" in envelope)) throw new Error("La API de Stremio devolvió una respuesta inesperada.");
  return envelope.result as T;
}

export function login(email: string, password: string) {
  return call<{ authKey: string; user: StremioUser }>("login", { type: "Login", email, password, facebook: false });
}

export function getUser(authKey: string) {
  return call<StremioUser>("getUser", { type: "GetUser", authKey });
}

export function logout(authKey: string) {
  return call<unknown>("logout", { type: "Logout", authKey });
}

export function getLibrary(authKey: string) {
  return call<RemoteItem[]>("datastoreGet", { authKey, collection: "libraryItem", ids: [], all: true });
}

export function putLibrary(authKey: string, changes: RemoteItem[]) {
  return call<{ success: boolean }>("datastorePut", { authKey, collection: "libraryItem", changes });
}

export function getAddonCollection(authKey: string) {
  return call<{ addons: AddonDescriptor[]; lastModified?: string }>("addonCollectionGet", {
    type: "AddonCollectionGet",
    authKey,
    update: true,
  });
}

export type LinkCode = { code: string; link: string; qrcode: string };

export async function createLink(): Promise<LinkCode> {
  const response = (await requestJson(`${LINK_URL}create?type=Create`)) as { result?: LinkCode };
  if (!response?.result?.code || !response.result.link) throw new Error("No se pudo crear el código de vinculación.");
  return response.result;
}

/** Returns the session key once the code has been approved in the browser, or null while it is pending. */
export async function readLink(code: string): Promise<string | null> {
  const response = (await requestJson(
    `${LINK_URL}read?${new URLSearchParams({ type: "Read", code })}`,
  )) as { result?: { authKey?: string }; error?: { code?: number } };
  if (response?.result?.authKey) return response.result.authKey;
  if (response?.error?.code === 101) return null;
  throw new Error("La vinculación con Stremio no ha respondido como se esperaba.");
}

/* ---------- Library synchronization ---------- */

export type SyncState = {
  /** Remote `_mtime` (ms) of each item at the last successful synchronization. */
  synced: Record<string, number>;
  /** Items removed in Vela since the last synchronization, by Stremio id. */
  removed: Record<string, { type: string; at: number }>;
};

export type SyncPlan = {
  pull: LibraryEntry[];
  drop: { type: string; id: string }[];
  push: RemoteItem[];
  synced: Record<string, number>;
};

const syncedTypes = new Set(["movie", "series"]);

function time(value?: string | null): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function localModified(entry: LibraryEntry): number {
  return Math.max(entry.addedAt, entry.progress?.updatedAt ?? 0);
}

/** Ids that do not belong to Stremio's catalog (for example Vela's bundled demos) stay local. */
export function syncable(meta: Pick<MediaItem, "id" | "type">): boolean {
  return syncedTypes.has(meta.type) && !meta.id.startsWith("vela:") && !meta.id.startsWith("velatest:");
}

export function entryFromRemote(item: RemoteItem): LibraryEntry {
  const meta: MediaItem = { id: item._id, type: item.type, name: item.name };
  if (item.poster && /^https?:\/\//.test(item.poster)) meta.poster = item.poster;
  const mtime = time(item._mtime);
  const entry: LibraryEntry = {
    meta,
    addonUrl: CINEMETA_URL,
    addedAt: Math.min(time(item._ctime) || mtime, mtime),
  };
  const { timeOffset, duration, video_id } = item.state;
  if (timeOffset > 0 && duration > 0)
    entry.progress = {
      videoId: video_id || item._id,
      seconds: timeOffset / 1000,
      duration: duration / 1000,
      updatedAt: mtime,
    };
  return entry;
}

export function remoteFromEntry(entry: LibraryEntry, base: RemoteItem | undefined, now: number): RemoteItem {
  const progress = entry.progress;
  const state: RemoteItem["state"] = {
    lastWatched: null,
    timeWatched: 0,
    timeOffset: 0,
    overallTimeWatched: 0,
    timesWatched: 0,
    flaggedWatched: 0,
    duration: 0,
    video_id: null,
    watched: null,
    noNotif: false,
    ...base?.state,
  };
  if (progress) {
    state.timeOffset = Math.round(progress.seconds * 1000);
    state.duration = Math.round(progress.duration * 1000);
    state.video_id = progress.videoId;
    state.lastWatched = new Date(progress.updatedAt).toISOString();
  }
  return {
    ...base,
    _id: entry.meta.id,
    name: entry.meta.name,
    type: entry.meta.type,
    poster: entry.meta.poster ?? base?.poster ?? null,
    posterShape: base?.posterShape ?? "poster",
    removed: base?.temp ? base.removed : false,
    temp: base?.temp ?? false,
    _ctime: base?._ctime ?? new Date(entry.addedAt).toISOString(),
    _mtime: new Date(now).toISOString(),
    state,
    behaviorHints: base?.behaviorHints ?? {},
  };
}

/**
 * Plans a two-way merge. The most recent side wins per title, as in stremio-core:
 * Stremio's `_mtime` is compared with the latest local change (added or watched).
 * Titles removed in Vela since the last sync are pushed as `removed`.
 */
export function planSync(
  local: Record<string, LibraryEntry>,
  remote: RemoteItem[],
  state: SyncState,
  now = Date.now(),
): SyncPlan {
  const plan: SyncPlan = { pull: [], drop: [], push: [], synced: {} };
  const remoteById = new Map(remote.filter((item) => syncedTypes.has(item.type)).map((item) => [item._id, item]));
  const localById = new Map(
    Object.values(local)
      .filter((entry) => syncable(entry.meta))
      .map((entry) => [entry.meta.id, entry]),
  );
  for (const [id, item] of remoteById) {
    const mtime = time(item._mtime);
    const entry = localById.get(id);
    const tombstone = state.removed[id];
    const visible = !item.removed || (item.temp && item.state.timeOffset > 0);
    if (!entry) {
      if (tombstone && visible && tombstone.at >= mtime) {
        plan.push.push({ ...item, removed: true, temp: false, _mtime: new Date(now).toISOString() });
        plan.synced[id] = now;
      } else if (visible) {
        plan.pull.push(entryFromRemote(item));
        plan.synced[id] = mtime;
      } else plan.synced[id] = mtime;
      continue;
    }
    const changedLocally = localModified(entry) > (state.synced[id] ?? 0);
    const localWins = changedLocally && localModified(entry) > mtime;
    if (!visible) {
      if (localWins) {
        plan.push.push(remoteFromEntry(entry, { ...item, temp: false }, now));
        plan.synced[id] = now;
      } else {
        plan.drop.push({ type: entry.meta.type, id });
        plan.synced[id] = mtime;
      }
    } else if (localWins) {
      plan.push.push(remoteFromEntry(entry, item, now));
      plan.synced[id] = now;
    } else {
      if (mtime > localModified(entry)) {
        // Keep the richer local metadata; take Stremio's progress, which is newer.
        const pulled = entryFromRemote(item);
        plan.pull.push({ meta: entry.meta, addonUrl: entry.addonUrl, addedAt: entry.addedAt, progress: pulled.progress });
      }
      plan.synced[id] = mtime;
    }
  }
  for (const [id, entry] of localById) {
    if (remoteById.has(id)) continue;
    plan.push.push(remoteFromEntry(entry, undefined, now));
    plan.synced[id] = now;
  }
  return plan;
}
