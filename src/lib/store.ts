import { useSyncExternalStore } from 'react';

import type {
  AddonCatalog,
  AddonManifest,
  AppPreferences,
  Episode,
  InstalledAddon,
  LibraryEntry,
  MediaItem,
  PlaybackProgress,
  PlayerPreferences,
  VideoState,
} from './contracts';
import { normalizeLanguage } from './languages';
import { defaultAddons, normalizeManifestUrl } from './protocol';

/**
 * Version 2 adds per-video history, watched marks, library vs «Seguir viendo» entries and player
 * preferences. It is stored under a new key so the version 1 data stays untouched as a backup
 * (and readable by older builds); it is migrated once, when no version 2 data exists.
 */
const storageKey = 'vela.preferences.v2';
const legacyKey = 'vela.preferences.v1';
/** The profile whose data lives in `vela.preferences.v2` (every install's original data). */
export const MAIN_PROFILE = 'main';
/** Other profiles keep their own library and preferences under this prefix. */
export const profileKey = (id: string) => `vela.profile.${id}.v1`;

/** What each profile has of its own; addons and services are shared. */
type ProfileData = Pick<AppPreferences, 'library' | 'player' | 'metadataLanguage'>;

function profileData(value: AppPreferences): ProfileData {
  return { library: value.library, player: value.player, metadataLanguage: value.metadataLanguage };
}
const defaultServiceUrl = 'http://127.0.0.1:11470';

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

function finite(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum;
}

function safeKey(key: string): boolean {
  return key !== '__proto__' && key !== 'prototype' && key !== 'constructor';
}

function canonicalManifestUrl(value: unknown): string | undefined {
  if (!nonempty(value)) return undefined;
  try {
    return normalizeManifestUrl(value);
  } catch {
    return undefined;
  }
}

function serviceUrl(value: unknown): string | undefined {
  if (!nonempty(value)) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.href.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

function episode(value: unknown): Episode | undefined {
  if (!record(value) || !nonempty(value.id)) return undefined;
  const result: Episode = { id: value.id };
  for (const key of ['title', 'released', 'thumbnail', 'overview'] as const) {
    if (typeof value[key] === 'string') result[key] = value[key];
  }
  for (const key of ['season', 'episode'] as const) {
    if (typeof value[key] === 'number' && Number.isInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  }
  return result;
}

function media(value: unknown): MediaItem | undefined {
  if (!record(value) || !nonempty(value.id) || !nonempty(value.type) || !nonempty(value.name)) return undefined;
  const result: MediaItem = { id: value.id, type: value.type, name: value.name };
  for (const key of ['poster', 'background', 'logo', 'description', 'releaseInfo', 'released', 'runtime', 'imdbRating'] as const) {
    if (typeof value[key] === 'string') result[key] = value[key];
  }
  for (const key of ['genres', 'cast', 'director'] as const) {
    const list = strings(value[key]);
    if (list) result[key] = list;
  }
  if (Array.isArray(value.videos)) result.videos = value.videos.map(episode).filter((item): item is Episode => !!item);
  return result;
}

/** Library entries keep the episode list (needed for watched marks and the next episode) without long texts. */
function storedMedia(value: unknown): MediaItem | undefined {
  const parsed = media(value);
  if (parsed?.videos) parsed.videos = parsed.videos.map(({ overview: _overview, thumbnail: _thumbnail, ...video }) => video);
  return parsed;
}

function catalog(value: unknown): AddonCatalog | undefined {
  if (!record(value) || !nonempty(value.id) || !nonempty(value.type) || !nonempty(value.name)) return undefined;
  const result: AddonCatalog = { id: value.id, type: value.type, name: value.name };
  for (const key of ['extraSupported', 'extraRequired'] as const) {
    const list = strings(value[key]);
    if (list) result[key] = list;
  }
  if (Array.isArray(value.extra)) {
    result.extra = value.extra.flatMap((item) => {
      if (!record(item) || !nonempty(item.name)) return [];
      const extra: NonNullable<AddonCatalog['extra']>[number] = { name: item.name };
      if (typeof item.isRequired === 'boolean') extra.isRequired = item.isRequired;
      const options = strings(item.options);
      if (options) extra.options = options;
      return [extra];
    });
  }
  return result;
}

function manifest(value: unknown): AddonManifest | undefined {
  if (!record(value) || !nonempty(value.id) || !nonempty(value.name) || !nonempty(value.version)
    || !Array.isArray(value.resources) || !Array.isArray(value.types) || !Array.isArray(value.catalogs)) return undefined;
  const result: AddonManifest = {
    id: value.id,
    name: value.name,
    version: value.version,
    types: strings(value.types) ?? [],
    resources: value.resources.flatMap((item): AddonManifest['resources'] => {
      if (typeof item === 'string') return [item];
      if (!record(item) || !nonempty(item.name)) return [];
      const resource: Exclude<AddonManifest['resources'][number], string> = { name: item.name };
      const types = strings(item.types);
      const idPrefixes = strings(item.idPrefixes);
      if (types) resource.types = types;
      if (idPrefixes) resource.idPrefixes = idPrefixes;
      return [resource];
    }),
    catalogs: value.catalogs.map(catalog).filter((item): item is AddonCatalog => !!item),
  };
  for (const key of ['description', 'logo'] as const) {
    if (typeof value[key] === 'string') result[key] = value[key];
  }
  const idPrefixes = strings(value.idPrefixes);
  if (idPrefixes) result.idPrefixes = idPrefixes;
  return result;
}

function addon(value: unknown): InstalledAddon | undefined {
  if (!record(value)) return undefined;
  const manifestUrl = canonicalManifestUrl(value.manifestUrl);
  const parsedManifest = manifest(value.manifest);
  if (!manifestUrl || !parsedManifest) return undefined;
  return {
    manifestUrl,
    manifest: parsedManifest,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    installedAt: typeof value.installedAt === 'number' && Number.isFinite(value.installedAt) && value.installedAt >= 0
      ? value.installedAt : 0,
  };
}

function progress(value: unknown, updatedAt?: number): PlaybackProgress | undefined {
  if (!record(value) || !nonempty(value.videoId) || typeof value.seconds !== 'number' || !Number.isFinite(value.seconds)
    || typeof value.duration !== 'number' || !Number.isFinite(value.duration)) return undefined;
  const duration = Math.max(0, value.duration);
  const seconds = Math.max(0, duration > 0 ? Math.min(value.seconds, duration) : value.seconds);
  const timestamp = updatedAt ?? value.updatedAt;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0) return undefined;
  return { videoId: value.videoId, seconds, duration, updatedAt: timestamp };
}

function videoState(value: unknown): VideoState | undefined {
  if (!record(value) || !finite(value.seconds) || !finite(value.duration) || !finite(value.updatedAt)) return undefined;
  const state: VideoState = {
    seconds: value.duration > 0 ? Math.min(value.seconds, value.duration) : value.seconds,
    duration: value.duration,
    updatedAt: value.updatedAt,
  };
  if (typeof value.watched === 'boolean') state.watched = value.watched;
  return state;
}

/** Parses a stored entry. Version 1 had no `saved` flag: every entry was shown in the library. */
function entry(value: unknown): LibraryEntry | undefined {
  if (!record(value)) return undefined;
  const meta = storedMedia(value.meta);
  if (!meta || typeof value.addonUrl !== 'string' || !finite(value.addedAt)) return undefined;
  const result: LibraryEntry = { meta, addonUrl: value.addonUrl, addedAt: value.addedAt, saved: value.saved !== false };
  const savedProgress = progress(value.progress);
  if (savedProgress) result.progress = savedProgress;
  if (record(value.videos)) {
    const videos: Record<string, VideoState> = {};
    for (const [id, item] of Object.entries(value.videos)) {
      const state = safeKey(id) && videoState(item);
      if (state) videos[id] = state;
    }
    if (Object.keys(videos).length) result.videos = videos;
  }
  if (finite(value.watchedAt)) result.watchedAt = value.watchedAt;
  if (finite(value.changedAt)) result.changedAt = value.changedAt;
  if (nonempty(value.remoteWatched)) result.remoteWatched = value.remoteWatched;
  if (finite(value.remoteWatchedAt)) result.remoteWatchedAt = value.remoteWatchedAt;
  return result;
}

export const defaultPlayer: PlayerPreferences = {
  subtitleLanguage: 'spa',
  subtitleSecondary: 'eng',
  subtitlesAuto: false,
  subtitleSize: 100,
  subtitleOpacity: 1,
  subtitleBackground: 0.5,
  audioLanguage: '',
  audioSecondary: '',
  seekShort: 5,
  seekLong: 10,
  autoNext: true,
  nextCountdown: 10,
};

const ranges: Partial<Record<keyof PlayerPreferences, [number, number]>> = {
  subtitleSize: [50, 250],
  subtitleOpacity: [0, 1],
  subtitleBackground: [0, 1],
  seekShort: [1, 120],
  seekLong: [1, 600],
  nextCountdown: [0, 60],
};

function player(value: unknown): PlayerPreferences {
  const result = { ...defaultPlayer };
  if (!record(value)) return result;
  for (const key of Object.keys(defaultPlayer) as (keyof PlayerPreferences)[]) {
    const item = value[key];
    const fallback = defaultPlayer[key];
    if (typeof fallback === 'boolean' && typeof item === 'boolean') (result[key] as boolean) = item;
    else if (typeof fallback === 'string' && typeof item === 'string') (result[key] as string) = item ? normalizeLanguage(item) : '';
    else if (typeof fallback === 'number' && typeof item === 'number' && Number.isFinite(item)) {
      const [min, max] = ranges[key] ?? [0, Number.MAX_SAFE_INTEGER];
      (result[key] as number) = Math.min(max, Math.max(min, item));
    }
  }
  return result;
}

function defaults(): AppPreferences {
  return {
    version: 2,
    addons: defaultAddons(),
    library: {},
    serviceUrl: defaultServiceUrl,
    externalPlayerPath: '',
    player: { ...defaultPlayer },
    metadataLanguage: 'es-ES',
  };
}

function metadataLanguage(value: unknown, fallback: string): string {
  return typeof value === 'string' && (value === '' || /^[a-z]{2}(?:-[A-Z]{2})?$/.test(value)) ? value : fallback;
}

export function mediaKey(type: string, id: string): string {
  return JSON.stringify([type, id]);
}

function readPreferences(value: unknown, fallback: AppPreferences): AppPreferences {
  if (!record(value) || (value.version !== 1 && value.version !== 2)) return fallback;
  const addons = new Map<string, InstalledAddon>();
  if (Array.isArray(value.addons)) {
    for (const item of value.addons) {
      const parsed = addon(item);
      if (parsed) addons.set(parsed.manifestUrl, parsed);
    }
  }
  const library: Record<string, LibraryEntry> = {};
  if (record(value.library)) {
    for (const [key, item] of Object.entries(value.library)) {
      if (!safeKey(key)) continue;
      const parsed = entry(item);
      if (parsed) library[mediaKey(parsed.meta.type, parsed.meta.id)] = parsed;
    }
  }
  return {
    version: 2,
    addons: Array.isArray(value.addons) ? [...addons.values()] : fallback.addons,
    library,
    serviceUrl: serviceUrl(value.serviceUrl) ?? fallback.serviceUrl,
    externalPlayerPath: typeof value.externalPlayerPath === 'string' ? value.externalPlayerPath : '',
    player: player(value.player),
    metadataLanguage: metadataLanguage(value.metadataLanguage, fallback.metadataLanguage),
  };
}

function storageFailure(action: string, error: unknown): string {
  const detail = error instanceof Error && error.message ? ` ${error.message}` : '';
  return `${action} Your changes remain available for this session.${detail}`;
}

/** Whether an entry carries history worth keeping when it leaves the library. */
function hasHistory(item: LibraryEntry): boolean {
  return Boolean(item.progress || item.watchedAt || item.remoteWatched || Object.keys(item.videos ?? {}).length);
}

/** Percentage of a video after which Stremio counts it as watched (`WATCHED_THRESHOLD_COEF`). */
export const WATCHED_THRESHOLD = 0.7;
/** Past this point the position is not resumed (`CREDITS_THRESHOLD_COEF`). */
export const CREDITS_THRESHOLD = 0.9;

export function createPreferencesStore(providedStorage?: PreferenceStorage) {
  let storage = providedStorage;
  let persistenceError: string | undefined;
  let state = defaults();
  if (!storage && typeof window !== 'undefined') {
    try {
      storage = window.localStorage;
    } catch (error) {
      persistenceError = storageFailure('Local storage is unavailable.', error);
    }
  }
  if (storage) {
    try {
      const saved = storage.getItem(storageKey) ?? storage.getItem(legacyKey);
      if (saved !== null) state = readPreferences(JSON.parse(saved), state);
    } catch (error) {
      persistenceError = storageFailure('Saved preferences could not be read.', error);
    }
  }

  const listeners = new Set<() => void>();
  let profile = MAIN_PROFILE;
  // The main profile's data, kept while another profile is active so that
  // `vela.preferences.v2` (which also holds the shared settings) can be rewritten intact.
  let main: ProfileData = profileData(state);

  function persist() {
    if (!storage) return;
    try {
      if (profile === MAIN_PROFILE) storage.setItem(storageKey, JSON.stringify(state));
      else {
        storage.setItem(storageKey, JSON.stringify({ ...state, ...main }));
        storage.setItem(profileKey(profile), JSON.stringify({ version: 2, ...profileData(state) }));
      }
      persistenceError = undefined;
    } catch (error) {
      persistenceError = storageFailure('Changes could not be saved to this device.', error);
    }
  }

  function update(next: AppPreferences) {
    if (next === state) return;
    state = next;
    if (profile === MAIN_PROFILE) main = profileData(state);
    persist();
    for (const listener of [...listeners]) listener();
  }

  /** Loads a profile's library and preferences; shared settings stay as they are. */
  function switchProfile(id: string) {
    if (id === profile) return;
    let data: ProfileData;
    if (id === MAIN_PROFILE) data = main;
    else {
      const fresh = defaults();
      data = profileData(fresh);
      try {
        const saved = storage?.getItem(profileKey(id));
        if (saved) data = profileData(readPreferences({ ...JSON.parse(saved), version: 2 }, fresh));
      } catch {
        /* An unreadable profile starts empty. */
      }
    }
    profile = id;
    state = { ...state, ...data };
    for (const listener of [...listeners]) listener();
  }

  function setEntry(key: string, value: LibraryEntry | undefined) {
    const library = { ...state.library };
    if (value) library[key] = value;
    else delete library[key];
    update({ ...state, library });
  }

  /** The entry for a title, created outside the library (only «Seguir viendo») when missing. */
  function base(meta: MediaItem, addonUrl: string): [string, LibraryEntry] | undefined {
    const parsed = storedMedia(meta);
    if (!parsed) return undefined;
    const key = mediaKey(parsed.type, parsed.id);
    const existing = state.library[key];
    // Keep the stored episode list when the caller only has a preview without videos.
    if (!parsed.videos && existing?.meta.videos) parsed.videos = existing.meta.videos;
    return [key, existing
      ? { ...existing, meta: parsed, addonUrl: addonUrl || existing.addonUrl }
      : { meta: parsed, addonUrl, addedAt: Date.now(), saved: false }];
  }

  function saveMedia(meta: MediaItem, addonUrl: string) {
    const found = base(meta, addonUrl);
    if (!found) return;
    const [key, item] = found;
    setEntry(key, { ...item, saved: true, changedAt: Date.now(), addedAt: state.library[key]?.saved ? item.addedAt : Date.now() });
  }

  /** Takes a title out of the library. Its watched history stays (as Stremio keeps removed items' state). */
  function removeMedia(type: string, id: string) {
    const key = mediaKey(type, id);
    const existing = state.library[key];
    if (!existing) return;
    const { progress: _progress, ...rest } = existing;
    const kept: LibraryEntry = { ...rest, saved: false, changedAt: Date.now() };
    setEntry(key, hasHistory(kept) ? kept : undefined);
  }

  function setVideos(meta: MediaItem, addonUrl: string, videoIds: string[], watched: boolean) {
    const found = base(meta, addonUrl);
    if (!found || !videoIds.length) return;
    const [key, item] = found;
    const now = Date.now();
    const videos = { ...item.videos };
    for (const id of videoIds) {
      if (!safeKey(id)) continue;
      videos[id] = { ...(videos[id] ?? { seconds: 0, duration: 0 }), watched, updatedAt: now };
    }
    const next: LibraryEntry = { ...item, videos };
    if (meta.type !== 'series' || videoIds.includes(meta.id)) next.watchedAt = watched ? now : 0;
    // A watched title has nothing left to resume.
    if (watched && next.progress && videoIds.includes(next.progress.videoId) && next.progress.seconds > 0) {
      next.progress = { ...next.progress, seconds: 0, duration: 0, updatedAt: now };
      if (meta.type !== 'series') delete next.progress;
    }
    setEntry(key, next);
  }

  return {
    getSnapshot: () => state,
    getProfile: () => profile,
    switchProfile,
    /** Deletes the stored data of a profile that is not active. */
    forgetProfile(id: string) {
      if (id === MAIN_PROFILE || id === profile) return;
      try {
        storage?.removeItem(profileKey(id));
      } catch {
        /* Nothing else to clean up. */
      }
    },
    getPersistenceError: () => persistenceError,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    installAddon(value: InstalledAddon) {
      const parsed = addon(value);
      if (!parsed) return;
      const existing = state.addons.find((item) => item.manifestUrl === parsed.manifestUrl);
      const installed: InstalledAddon = { ...parsed, enabled: true, installedAt: existing?.installedAt ?? Date.now() };
      const addons = existing
        ? state.addons.map((item) => item.manifestUrl === parsed.manifestUrl ? installed : item)
        : [...state.addons, installed];
      update({ ...state, addons });
    },
    /** Replaces an installed addon's manifest with a newer copy, keeping whether it is enabled. */
    refreshAddon(value: InstalledAddon) {
      const parsed = addon(value);
      const existing = parsed && state.addons.find((item) => item.manifestUrl === parsed.manifestUrl);
      // A different id means the address now serves another addon: keep the installed one.
      if (!parsed || !existing || existing.manifest.id !== parsed.manifest.id) return;
      if (JSON.stringify(existing.manifest) === JSON.stringify(parsed.manifest)) return;
      update({
        ...state,
        addons: state.addons.map((item) => (item === existing ? { ...existing, manifest: parsed.manifest } : item)),
      });
    },
    removeAddon(manifestUrl: string) {
      const canonical = canonicalManifestUrl(manifestUrl);
      const addons = state.addons.filter((item) => item.manifestUrl !== canonical);
      if (addons.length !== state.addons.length) update({ ...state, addons });
    },
    toggleAddon(manifestUrl: string) {
      const canonical = canonicalManifestUrl(manifestUrl);
      if (!state.addons.some((item) => item.manifestUrl === canonical)) return;
      update({ ...state, addons: state.addons.map((item) => item.manifestUrl === canonical ? { ...item, enabled: !item.enabled } : item) });
    },
    saveMedia,
    removeMedia,
    toggleMedia(meta: MediaItem, addonUrl: string) {
      if (state.library[mediaKey(meta.type, meta.id)]?.saved) removeMedia(meta.type, meta.id);
      else saveMedia(meta, addonUrl);
    },
    /** Records the position of a video and makes it the title's «continue» pointer. */
    updateProgress(meta: MediaItem, addonUrl: string, value: PlaybackProgress) {
      const parsedProgress = progress(value, Date.now());
      const found = base(meta, addonUrl);
      if (!found || !parsedProgress || !safeKey(parsedProgress.videoId)) return;
      const [key, item] = found;
      const previous = item.videos?.[parsedProgress.videoId];
      const video: VideoState = {
        seconds: parsedProgress.seconds,
        duration: parsedProgress.duration,
        updatedAt: parsedProgress.updatedAt,
      };
      if (previous?.watched !== undefined) video.watched = previous.watched;
      setEntry(key, { ...item, progress: parsedProgress, videos: { ...item.videos, [parsedProgress.videoId]: video } });
    },
    /** Marks videos (episodes, or the movie itself) as watched or unwatched. */
    setWatched(meta: MediaItem, addonUrl: string, videoIds: string[], watched: boolean) {
      setVideos(meta, addonUrl, videoIds, watched);
    },
    /**
     * Called when a video ends or is closed past the credits: the pointer moves to the next
     * episode (as Stremio's `advance_to_video`) or is cleared when there is none.
     */
    finishVideo(meta: MediaItem, addonUrl: string, videoId: string, nextVideoId?: string) {
      const found = base(meta, addonUrl);
      if (!found) return;
      const [key, item] = found;
      const now = Date.now();
      const next: LibraryEntry = { ...item, changedAt: now };
      if (nextVideoId) next.progress = { videoId: nextVideoId, seconds: 0, duration: 0, updatedAt: now };
      else delete next.progress;
      if (!safeKey(videoId)) return;
      const previous = item.videos?.[videoId];
      if (previous) next.videos = { ...item.videos, [videoId]: { ...previous, seconds: 0, updatedAt: now } };
      setEntry(key, next.saved || hasHistory(next) ? next : undefined);
    },
    /** Removes a title from «Seguir viendo» without touching the library or its watched marks. */
    dismissProgress(type: string, id: string) {
      const key = mediaKey(type, id);
      const existing = state.library[key];
      if (!existing?.progress) return;
      const { progress: _progress, ...rest } = existing;
      const next: LibraryEntry = { ...rest, changedAt: Date.now() };
      setEntry(key, next.saved || hasHistory(next) ? next : undefined);
    },
    setServiceUrl(value: string) {
      const parsed = serviceUrl(value);
      if (parsed && parsed !== state.serviceUrl) update({ ...state, serviceUrl: parsed });
    },
    setExternalPlayerPath(value: string) {
      const path = value.trim();
      if (path !== state.externalPlayerPath) update({ ...state, externalPlayerPath: path });
    },
    setMetadataLanguage(value: string) {
      const next = metadataLanguage(value, state.metadataLanguage);
      if (next !== state.metadataLanguage) update({ ...state, metadataLanguage: next });
    },
    setPlayer(value: Partial<PlayerPreferences>) {
      const next = player({ ...state.player, ...value });
      if (JSON.stringify(next) !== JSON.stringify(state.player)) update({ ...state, player: next });
    },
    clearLibrary() {
      if (Object.keys(state.library).length) update({ ...state, library: {} });
    },
    /** Applies a batch of synchronized entries and removals in one update. */
    mergeLibrary(entries: LibraryEntry[], removals: { type: string; id: string }[] = []) {
      const library = { ...state.library };
      let changed = false;
      for (const value of entries) {
        const parsed = entry(value);
        if (!parsed) continue;
        library[mediaKey(parsed.meta.type, parsed.meta.id)] = parsed;
        changed = true;
      }
      for (const { type, id } of removals) {
        const key = mediaKey(type, id);
        if (Object.hasOwn(library, key)) {
          delete library[key];
          changed = true;
        }
      }
      if (changed) update({ ...state, library });
    },
  };
}

export const preferencesStore = createPreferencesStore();

export function usePreferences(): AppPreferences {
  return useSyncExternalStore(preferencesStore.subscribe, preferencesStore.getSnapshot, preferencesStore.getSnapshot);
}
