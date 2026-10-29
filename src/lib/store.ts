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
} from './contracts';
import { defaultAddons, normalizeManifestUrl } from './protocol';

const storageKey = 'vela.preferences.v1';
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

function defaults(): AppPreferences {
  return { version: 1, addons: defaultAddons(), library: {}, serviceUrl: defaultServiceUrl, externalPlayerPath: '' };
}

export function mediaKey(type: string, id: string): string {
  return JSON.stringify([type, id]);
}

function readPreferences(value: unknown, fallback: AppPreferences): AppPreferences {
  if (!record(value) || value.version !== 1) return fallback;
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
      if (key === '__proto__' || key === 'prototype' || key === 'constructor' || !record(item)) continue;
      const meta = media(item.meta);
      if (!meta || typeof item.addonUrl !== 'string' || typeof item.addedAt !== 'number'
        || !Number.isFinite(item.addedAt) || item.addedAt < 0) continue;
      const entry: LibraryEntry = { meta, addonUrl: item.addonUrl, addedAt: item.addedAt };
      const savedProgress = progress(item.progress);
      if (savedProgress) entry.progress = savedProgress;
      library[mediaKey(meta.type, meta.id)] = entry;
    }
  }
  return {
    version: 1,
    addons: Array.isArray(value.addons) ? [...addons.values()] : fallback.addons,
    library,
    serviceUrl: serviceUrl(value.serviceUrl) ?? fallback.serviceUrl,
    externalPlayerPath: typeof value.externalPlayerPath === 'string' ? value.externalPlayerPath : '',
  };
}

function storageFailure(action: string, error: unknown): string {
  const detail = error instanceof Error && error.message ? ` ${error.message}` : '';
  return `${action} Your changes remain available for this session.${detail}`;
}

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
      const saved = storage.getItem(storageKey);
      if (saved !== null) state = readPreferences(JSON.parse(saved), state);
    } catch (error) {
      persistenceError = storageFailure('Saved preferences could not be read.', error);
    }
  }

  const listeners = new Set<() => void>();
  function update(next: AppPreferences) {
    if (next === state) return;
    state = next;
    if (storage) {
      try {
        storage.setItem(storageKey, JSON.stringify(state));
        persistenceError = undefined;
      } catch (error) {
        persistenceError = storageFailure('Changes could not be saved to this device.', error);
      }
    }
    for (const listener of [...listeners]) listener();
  }

  function saveMedia(meta: MediaItem, addonUrl: string) {
    const parsed = media(meta);
    if (!parsed) return;
    const key = mediaKey(parsed.type, parsed.id);
    const existing = state.library[key];
    const entry: LibraryEntry = { meta: parsed, addonUrl, addedAt: existing?.addedAt ?? Date.now() };
    if (existing?.progress) entry.progress = existing.progress;
    update({ ...state, library: { ...state.library, [key]: entry } });
  }

  function removeMedia(type: string, id: string) {
    const key = mediaKey(type, id);
    if (!Object.hasOwn(state.library, key)) return;
    const library = { ...state.library };
    delete library[key];
    update({ ...state, library });
  }

  return {
    getSnapshot: () => state,
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
      if (Object.hasOwn(state.library, mediaKey(meta.type, meta.id))) removeMedia(meta.type, meta.id);
      else saveMedia(meta, addonUrl);
    },
    updateProgress(meta: MediaItem, addonUrl: string, value: PlaybackProgress) {
      const parsed = media(meta);
      const parsedProgress = progress(value, Date.now());
      if (!parsed || !parsedProgress) return;
      const key = mediaKey(parsed.type, parsed.id);
      const existing = state.library[key];
      update({
        ...state,
        library: {
          ...state.library,
          [key]: { meta: parsed, addonUrl, addedAt: existing?.addedAt ?? Date.now(), progress: parsedProgress },
        },
      });
    },
    setServiceUrl(value: string) {
      const parsed = serviceUrl(value);
      if (parsed && parsed !== state.serviceUrl) update({ ...state, serviceUrl: parsed });
    },
    setExternalPlayerPath(value: string) {
      const path = value.trim();
      if (path !== state.externalPlayerPath) update({ ...state, externalPlayerPath: path });
    },
    clearLibrary() {
      if (Object.keys(state.library).length) update({ ...state, library: {} });
    },
    /** Applies a batch of synchronized entries and removals in one update. */
    mergeLibrary(entries: LibraryEntry[], removals: { type: string; id: string }[] = []) {
      const library = { ...state.library };
      let changed = false;
      for (const value of entries) {
        const meta = media(value.meta);
        if (!meta || typeof value.addonUrl !== 'string' || !Number.isFinite(value.addedAt) || value.addedAt < 0) continue;
        const entry: LibraryEntry = { meta, addonUrl: value.addonUrl, addedAt: value.addedAt };
        const savedProgress = value.progress && progress(value.progress);
        if (savedProgress) entry.progress = savedProgress;
        library[mediaKey(meta.type, meta.id)] = entry;
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
