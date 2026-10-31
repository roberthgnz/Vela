import type { LibraryEntry, MediaItem, VideoState } from "./contracts";
import { bitfieldOrder, decodeWatched, encodeWatched } from "./watched";
import { postJson, requestJson } from "./transport";
import { t } from "./i18n";

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
  if (code === 1 && /session/i.test(message)) return t("lib.stremio.sessionExpired");
  if (/password|passphrase|wrong/i.test(message)) return t("lib.stremio.wrongCredentials");
  if (/user not found|no user/i.test(message)) return t("lib.stremio.noUser");
  return t("lib.stremio.replied", { message });
}

async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
  let response: unknown;
  try {
    response = await postJson(`${API_URL}${method}`, body);
  } catch (error) {
    throw new Error(t("lib.stremio.connectFailed", { details: error instanceof Error ? error.message : "" }).trim());
  }
  const envelope = (response ?? {}) as { result?: T; error?: { code?: number; message?: string } };
  if (envelope.error) {
    const code = Number(envelope.error.code ?? 0);
    throw new StremioApiError(code, friendly(code, String(envelope.error.message ?? "error desconocido")));
  }
  if (!("result" in envelope)) throw new Error(t("lib.stremio.unexpected"));
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
  if (!response?.result?.code || !response.result.link) throw new Error(t("lib.stremio.linkCodeFailed"));
  return response.result;
}

/** Returns the session key once the code has been approved in the browser, or null while it is pending. */
export async function readLink(code: string): Promise<string | null> {
  const response = (await requestJson(
    `${LINK_URL}read?${new URLSearchParams({ type: "Read", code })}`,
  )) as { result?: { authKey?: string }; error?: { code?: number } };
  if (response?.result?.authKey) return response.result.authKey;
  if (response?.error?.code === 101) return null;
  throw new Error(t("lib.stremio.linkFailed"));
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
  /** Local entries rewritten after an upload (for example with the watched field that was sent). */
  local: LibraryEntry[];
  synced: Record<string, number>;
};

const syncedTypes = new Set(["movie", "series"]);
/** `time_offset` values below this (ms) are Stremio's "next episode" pointer (`advance_to_video` stores 1). */
const POINTER_OFFSET = 1000;

function time(value?: string | null): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function localModified(entry: LibraryEntry): number {
  return Math.max(
    entry.addedAt,
    entry.changedAt ?? 0,
    entry.watchedAt ?? 0,
    entry.progress?.updatedAt ?? 0,
    ...Object.values(entry.videos ?? {}).map((video) => video.updatedAt),
  );
}

/** Ids that do not belong to Stremio's catalog (for example Vela's bundled demos) stay local. */
export function syncable(meta: Pick<MediaItem, "id" | "type">): boolean {
  return syncedTypes.has(meta.type) && !meta.id.startsWith("vela:") && !meta.id.startsWith("velatest:");
}

/** Whether Stremio shows the item: in the library, or a temporary «continue watching» item. */
function visible(item: RemoteItem): boolean {
  return !item.removed || (item.temp && item.state.timeOffset > 0);
}

export function entryFromRemote(item: RemoteItem): LibraryEntry {
  const meta: MediaItem = { id: item._id, type: item.type, name: item.name };
  if (item.poster && /^https?:\/\//.test(item.poster)) meta.poster = item.poster;
  const mtime = time(item._mtime);
  const entry: LibraryEntry = {
    meta,
    addonUrl: CINEMETA_URL,
    addedAt: Math.min(time(item._ctime) || mtime, mtime),
    saved: !item.removed,
  };
  const { timeOffset, duration, video_id } = item.state;
  const videoId = video_id || item._id;
  if (timeOffset >= POINTER_OFFSET && duration > 0) {
    entry.progress = { videoId, seconds: timeOffset / 1000, duration: duration / 1000, updatedAt: mtime };
    entry.videos = { [videoId]: { seconds: timeOffset / 1000, duration: duration / 1000, updatedAt: mtime } };
  } else if (timeOffset > 0) entry.progress = { videoId, seconds: 0, duration: 0, updatedAt: mtime };
  if (item.type === "movie" && (item.state.timesWatched > 0 || item.state.flaggedWatched > 0)) entry.watchedAt = mtime;
  if (item.state.watched) {
    entry.remoteWatched = item.state.watched;
    entry.remoteWatchedAt = mtime;
  }
  return entry;
}

/** Combines a newer remote item with the local entry without dropping local history. */
function mergeRemote(local: LibraryEntry, item: RemoteItem): LibraryEntry {
  const pulled = entryFromRemote(item);
  const videos: Record<string, VideoState> = { ...local.videos };
  for (const [id, video] of Object.entries(pulled.videos ?? {})) {
    const mine = videos[id];
    videos[id] = mine && mine.updatedAt > video.updatedAt ? mine : { ...video, watched: mine?.watched };
    if (videos[id].watched === undefined) delete videos[id].watched;
  }
  const merged: LibraryEntry = {
    ...local,
    saved: pulled.saved,
    progress: pulled.progress,
    videos: Object.keys(videos).length ? videos : undefined,
    remoteWatched: pulled.remoteWatched ?? local.remoteWatched,
    remoteWatchedAt: pulled.remoteWatched ? pulled.remoteWatchedAt : local.remoteWatchedAt,
  };
  if (!merged.progress) delete merged.progress;
  if (!merged.videos) delete merged.videos;
  if (local.meta.type === "movie") {
    if (pulled.watchedAt) merged.watchedAt = Math.max(pulled.watchedAt, local.watchedAt ?? 0);
    else if ((local.watchedAt ?? 0) < time(item._mtime)) delete merged.watchedAt;
  }
  return merged;
}

/**
 * Builds Stremio's watched field for a series from the remote field and the episodes marked
 * in Vela after it. Returns undefined (keep the remote value) when the episode list is
 * unknown, nothing changed locally or the remote field cannot be decoded.
 */
export async function watchedField(entry: LibraryEntry, remote: string | null | undefined): Promise<string | undefined> {
  const videos = entry.meta.videos;
  const since = entry.remoteWatchedAt ?? 0;
  const marks = Object.entries(entry.videos ?? {}).filter(
    ([, video]) => video.watched !== undefined && video.updatedAt > since,
  );
  if (entry.meta.type !== "series" || !videos?.length || !marks.length) return undefined;
  const order = bitfieldOrder(videos);
  let watched: Set<string>;
  try {
    watched = remote ? await decodeWatched(remote, order) : new Set();
  } catch {
    return undefined;
  }
  for (const [id, video] of marks) {
    if (video.watched) watched.add(id);
    else watched.delete(id);
  }
  return encodeWatched(order, watched);
}

export function remoteFromEntry(
  entry: LibraryEntry,
  base: RemoteItem | undefined,
  now: number,
  watched?: string,
): RemoteItem {
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
  if (progress && progress.seconds > 0) {
    state.timeOffset = Math.round(progress.seconds * 1000);
    state.duration = Math.round(progress.duration * 1000);
    state.video_id = progress.videoId;
    state.lastWatched = new Date(progress.updatedAt).toISOString();
  } else if (progress) {
    // Pointer to the next episode, as stremio-core's `advance_to_video`.
    state.timeOffset = 1;
    state.video_id = progress.videoId;
  } else state.timeOffset = 0;
  if (entry.meta.type === "movie" && entry.watchedAt !== undefined) {
    if (entry.watchedAt > 0) {
      state.timesWatched = Math.max(1, state.timesWatched);
      state.flaggedWatched = 1;
    } else {
      state.timesWatched = 0;
      state.flaggedWatched = 0;
    }
  }
  if (watched) state.watched = watched;
  else if (!base && entry.remoteWatched) state.watched = entry.remoteWatched;
  return {
    ...base,
    _id: entry.meta.id,
    // Keep Stremio's name: Vela may show a translated one.
    name: base?.name ?? entry.meta.name,
    type: entry.meta.type,
    poster: entry.meta.poster ?? base?.poster ?? null,
    posterShape: base?.posterShape ?? "poster",
    removed: !entry.saved,
    // Items outside the library are Stremio's temporary «continue watching» items.
    temp: entry.saved ? false : (base?.temp ?? true),
    _ctime: base?._ctime ?? new Date(entry.addedAt).toISOString(),
    _mtime: new Date(now).toISOString(),
    state,
    behaviorHints: base?.behaviorHints ?? {},
  };
}

/** Local entry after its upload: the watched field that was sent becomes the synchronized one. */
function afterPush(entry: LibraryEntry, item: RemoteItem, now: number): LibraryEntry | undefined {
  if (!item.state.watched || item.state.watched === entry.remoteWatched) return undefined;
  return { ...entry, remoteWatched: item.state.watched, remoteWatchedAt: now };
}

/**
 * Plans a two-way merge. The most recent side wins per title, as in stremio-core:
 * Stremio's `_mtime` is compared with the latest local change (saved, watched or played).
 * Titles removed in Vela since the last sync are pushed as `removed`. Remote fields Vela does
 * not edit are kept, and local per-episode history is never discarded.
 */
export async function planSync(
  local: Record<string, LibraryEntry>,
  remote: RemoteItem[],
  state: SyncState,
  now = Date.now(),
): Promise<SyncPlan> {
  const plan: SyncPlan = { pull: [], drop: [], push: [], local: [], synced: {} };
  const remoteById = new Map(remote.filter((item) => syncedTypes.has(item.type)).map((item) => [item._id, item]));
  const localById = new Map(
    Object.values(local)
      .filter((entry) => syncable(entry.meta))
      .map((entry) => [entry.meta.id, entry]),
  );
  const push = async (entry: LibraryEntry, base: RemoteItem | undefined) => {
    const item = remoteFromEntry(entry, base, now, await watchedField(entry, base?.state.watched ?? entry.remoteWatched));
    plan.push.push(item);
    const updated = afterPush(entry, item, now);
    if (updated) plan.local.push(updated);
    plan.synced[entry.meta.id] = now;
  };
  for (const [id, item] of remoteById) {
    const mtime = time(item._mtime);
    const entry = localById.get(id);
    const tombstone = state.removed[id];
    if (!entry) {
      if (tombstone && visible(item) && tombstone.at >= mtime) {
        plan.push.push({ ...item, removed: true, temp: false, _mtime: new Date(now).toISOString() });
        plan.synced[id] = now;
      } else if (visible(item)) {
        plan.pull.push(entryFromRemote(item));
        plan.synced[id] = mtime;
      } else plan.synced[id] = mtime;
      continue;
    }
    const changedLocally = localModified(entry) > (state.synced[id] ?? 0);
    const localWins = changedLocally && localModified(entry) > mtime;
    if (localWins) await push(entry, item);
    else {
      if (mtime > localModified(entry)) {
        if (visible(item)) plan.pull.push(mergeRemote(entry, item));
        else if (entry.videos || entry.watchedAt || entry.remoteWatched)
          // Removed in Stremio: leave the library but keep the watched history on this device.
          plan.pull.push({ ...mergeRemote(entry, item), saved: false, progress: undefined });
        else plan.drop.push({ type: entry.meta.type, id });
      }
      plan.synced[id] = mtime;
    }
  }
  for (const [id, entry] of localById) {
    if (remoteById.has(id)) continue;
    // Never upload titles that only exist as local history (removed and nothing to continue).
    if (!entry.saved && !entry.progress) continue;
    await push(entry, undefined);
  }
  for (const entry of plan.pull) if (!entry.progress) delete entry.progress;
  return plan;
}
