import { describe, expect, it } from 'vitest';

import type { InstalledAddon, MediaItem, PlaybackProgress } from './contracts';
import { createPreferencesStore, mediaKey } from './store';

function memoryStorage(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [['vela.preferences.v1', initial]]);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

const movie: MediaItem = {
  id: 'tt1234', type: 'movie', name: 'An evening at sea', genres: ['Drama'],
  videos: [{ id: 'tt1234', title: 'Feature', season: 1, episode: 1 }],
};
const installedAddon: InstalledAddon = {
  manifestUrl: 'https://EXAMPLE.com:443/configuration/manifest.json#fragment',
  enabled: true,
  installedAt: 1,
  manifest: {
    id: 'test.addon', name: 'Test addon', version: '1.0.0', types: ['movie'], resources: ['catalog', 'meta', 'stream'],
    catalogs: [{ id: 'films', name: 'Films', type: 'movie', extra: [{ name: 'genre', options: ['Drama'] }] }],
  },
};
const watchProgress: PlaybackProgress = { videoId: 'tt1234', seconds: 120, duration: 3600, updatedAt: 1 };

describe('local preferences', () => {
  it('roundtrips installed addon configuration, metadata, player settings, and playback progress', () => {
    const storage = memoryStorage();
    const store = createPreferencesStore(storage);
    store.installAddon(installedAddon);
    store.saveMedia(movie, installedAddon.manifestUrl);
    store.updateProgress(movie, installedAddon.manifestUrl, watchProgress);
    store.setServiceUrl('http://localhost:12500/');
    store.setExternalPlayerPath('C:\\Program Files\\VideoLAN\\VLC\\vlc.exe');

    const restored = createPreferencesStore(storage).getSnapshot();
    expect(restored).toEqual(store.getSnapshot());
    expect(restored.addons.find((item) => item.manifest.id === 'test.addon')?.manifestUrl)
      .toBe('https://example.com/configuration/manifest.json');
    expect(restored.library[mediaKey(movie.type, movie.id)].progress?.seconds).toBe(120);
  });

  it('recovers from corrupt JSON and preserves independently valid entries in malformed preferences', () => {
    expect(() => createPreferencesStore(memoryStorage('{broken JSON'))).not.toThrow();
    const corrupt = createPreferencesStore(memoryStorage('{broken JSON'));
    expect(corrupt.getSnapshot().library).toEqual({});
    expect(corrupt.getSnapshot().serviceUrl).toBe('http://127.0.0.1:11470');

    const store = createPreferencesStore(memoryStorage(JSON.stringify({
      version: 1,
      addons: [installedAddon, { manifestUrl: 'javascript:alert(1)' }, null],
      library: {
        good: { meta: movie, addonUrl: installedAddon.manifestUrl, addedAt: 2, progress: { ...watchProgress, seconds: 'invalid' } },
        bad: { meta: { ...movie, id: null }, addonUrl: '', addedAt: 3 },
      },
      serviceUrl: 'javascript:alert(1)',
      externalPlayerPath: 'vlc',
    })));
    expect(store.getSnapshot().addons).toHaveLength(1);
    expect(store.getSnapshot().library).toEqual({
      [mediaKey(movie.type, movie.id)]: { meta: movie, addonUrl: installedAddon.manifestUrl, addedAt: 2 },
    });
    expect(store.getSnapshot().externalPlayerPath).toBe('vlc');
  });

  it('ignores prototype keys and never restores stream credentials or unknown metadata fields', () => {
    const malicious = JSON.stringify({
      version: 1, addons: [], library: {
        valid: {
          meta: { ...movie, streams: [{ url: 'https://private.example/token' }], constructor: { polluted: true } },
          addonUrl: 'https://example.com/manifest.json', addedAt: 1,
        },
      },
    }).replace('"library":{', '"__proto__":{"polluted":true},"library":{"__proto__":{"meta":{"id":"bad","type":"movie","name":"Bad"},"addonUrl":"","addedAt":1},"constructor":{"polluted":true},');
    const store = createPreferencesStore(memoryStorage(malicious));
    expect(Object.keys(store.getSnapshot().library)).toEqual([mediaKey(movie.type, movie.id)]);
    expect(store.getSnapshot().library[mediaKey(movie.type, movie.id)].meta).toEqual(movie);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    store.saveMedia({ ...movie, streams: [{ url: 'secret' }] } as MediaItem, 'https://example.com/manifest.json');
    expect(store.getSnapshot().library[mediaKey(movie.type, movie.id)].meta).toEqual(movie);
  });

  it('deduplicates canonical addon URLs and preserves the library while toggling, reinstalling, and removing addons', () => {
    const store = createPreferencesStore(memoryStorage());
    store.installAddon(installedAddon);
    store.updateProgress(movie, installedAddon.manifestUrl, watchProgress);
    const initial = store.getSnapshot();
    const canonical = 'https://example.com/configuration/manifest.json';
    const addedAt = initial.addons.find((item) => item.manifestUrl === canonical)?.installedAt;

    store.toggleAddon(canonical);
    expect(store.getSnapshot().addons.find((item) => item.manifestUrl === canonical)?.enabled).toBe(false);
    expect(store.getSnapshot().library).toEqual(initial.library);
    store.installAddon({ ...installedAddon, manifestUrl: canonical });
    expect(store.getSnapshot().addons.filter((item) => item.manifestUrl === canonical)).toHaveLength(1);
    expect(store.getSnapshot().addons.find((item) => item.manifestUrl === canonical)).toMatchObject({ enabled: true, installedAt: addedAt });
    store.removeAddon(canonical);
    expect(store.getSnapshot().addons.some((item) => item.manifestUrl === canonical)).toBe(false);
    expect(store.getSnapshot().library).toEqual(initial.library);
  });

  it('clamps playback positions and keeps the previous progress when a new write is invalid', () => {
    const store = createPreferencesStore(memoryStorage());
    const key = mediaKey(movie.type, movie.id);
    store.updateProgress(movie, '', { ...watchProgress, seconds: 5000 });
    expect(store.getSnapshot().library[key].progress).toMatchObject({ seconds: 3600, duration: 3600 });
    const valid = store.getSnapshot();
    store.updateProgress(movie, '', { ...watchProgress, seconds: Number.NaN });
    store.updateProgress(movie, '', { ...watchProgress, duration: Number.POSITIVE_INFINITY });
    expect(store.getSnapshot()).toBe(valid);
    store.updateProgress(movie, '', { ...watchProgress, seconds: -5, duration: -10 });
    expect(store.getSnapshot().library[key].progress).toMatchObject({ seconds: 0, duration: 0 });
    store.updateProgress(movie, '', { ...watchProgress, seconds: 50, duration: 0 });
    expect(store.getSnapshot().library[key].progress).toMatchObject({ seconds: 50, duration: 0 });
  });

  it('keeps in-memory changes usable when storage fails and clears the error after a successful save', () => {
    const backing = memoryStorage();
    let fail = true;
    const store = createPreferencesStore({
      ...backing,
      setItem(key, value) {
        if (fail) throw new Error('Storage quota exceeded');
        backing.setItem(key, value);
      },
    });
    store.saveMedia(movie, 'https://example.com/manifest.json');
    expect(store.getSnapshot().library[mediaKey(movie.type, movie.id)].meta).toEqual(movie);
    expect(store.getPersistenceError()).toContain('Storage quota exceeded');
    fail = false;
    store.setExternalPlayerPath('vlc');
    expect(store.getPersistenceError()).toBeUndefined();
    expect(createPreferencesStore(backing).getSnapshot()).toEqual(store.getSnapshot());
  });

  it('provides stable snapshots, immutable updates, collision-free keys, and observable exact state', () => {
    const storage = memoryStorage();
    const store = createPreferencesStore(storage);
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);
    expect(mediaKey('a:b', 'c')).not.toBe(mediaKey('a', 'b:c'));
    const observed: unknown[] = [];
    const unsubscribe = store.subscribe(() => observed.push(store.getSnapshot()));
    store.toggleMedia(movie, 'https://example.com/manifest.json');
    const saved = store.getSnapshot();
    expect(saved).not.toBe(before);
    expect(before.library).toEqual({});
    expect(observed.at(-1)).toBe(saved);
    expect(createPreferencesStore(storage).getSnapshot()).toEqual(saved);
    unsubscribe();
    store.toggleMedia(movie, 'https://example.com/manifest.json');
    expect(store.getSnapshot().library).toEqual({});
    expect(saved.library[mediaKey(movie.type, movie.id)]).toBeDefined();
    store.saveMedia(movie, 'https://example.com/manifest.json');
    store.clearLibrary();
    expect(createPreferencesStore(storage).getSnapshot().library).toEqual({});
  });
});
