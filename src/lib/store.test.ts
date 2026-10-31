import { describe, expect, it } from 'vitest';

import type { InstalledAddon, MediaItem, PlaybackProgress } from './contracts';
import { createPreferencesStore, defaultPlayer, mediaKey } from './store';

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
const series: MediaItem = {
  id: 'tt9', type: 'series', name: 'Harbour lights',
  videos: [1, 2, 3].map((episode) => ({ id: `tt9:1:${episode}`, season: 1, episode, overview: 'Long text' })),
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
      [mediaKey(movie.type, movie.id)]: { meta: movie, addonUrl: installedAddon.manifestUrl, addedAt: 2, saved: true },
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

  it('migrates version 1 data to version 2 without touching the original key', () => {
    const v1 = JSON.stringify({
      version: 1, addons: [installedAddon], serviceUrl: 'http://127.0.0.1:11470', externalPlayerPath: '',
      library: { x: { meta: series, addonUrl: 'https://example.com/manifest.json', addedAt: 5, progress: { videoId: 'tt9:1:2', seconds: 30, duration: 60, updatedAt: 6 } } },
    });
    const storage = memoryStorage(v1);
    const store = createPreferencesStore(storage);
    const entry = store.getSnapshot().library[mediaKey('series', 'tt9')];
    expect(store.getSnapshot().version).toBe(2);
    expect(entry).toMatchObject({ saved: true, addedAt: 5, progress: { videoId: 'tt9:1:2', seconds: 30 } });
    expect(store.getSnapshot().player).toEqual(defaultPlayer);
    store.setPlayer({ subtitleLanguage: 'es', seekLong: 9999 });
    expect(storage.getItem('vela.preferences.v1')).toBe(v1);
    const restored = createPreferencesStore(storage).getSnapshot();
    expect(restored.player).toMatchObject({ subtitleLanguage: 'spa', seekLong: 600 });
    store.setPlayer({ subtitleColor: '#ffe45c' });
    expect(store.getSnapshot().player.subtitleColor).toBe('#ffe45c');
    store.setPlayer({ subtitleColor: 'red; content: x' });
    expect(store.getSnapshot().player.subtitleColor).toBe('#ffffff');
    expect(restored.library).toEqual(store.getSnapshot().library);
  });

  it('keeps per-episode history, watched marks and the next-episode pointer', () => {
    const store = createPreferencesStore(memoryStorage());
    const key = mediaKey('series', 'tt9');
    store.updateProgress(series, '', { videoId: 'tt9:1:1', seconds: 50, duration: 60, updatedAt: 0 });
    let entry = store.getSnapshot().library[key];
    expect(entry.saved).toBe(false);
    expect(entry.videos?.['tt9:1:1']).toMatchObject({ seconds: 50, duration: 60 });
    // Episode overviews are not persisted in the library.
    expect(entry.meta.videos?.[0]).not.toHaveProperty('overview');
    store.setWatched(series, '', ['tt9:1:1'], true);
    store.finishVideo(series, '', 'tt9:1:1', 'tt9:1:2');
    entry = store.getSnapshot().library[key];
    expect(entry.progress).toMatchObject({ videoId: 'tt9:1:2', seconds: 0, duration: 0 });
    expect(entry.videos?.['tt9:1:1']).toMatchObject({ watched: true, seconds: 0 });
    store.updateProgress(series, '', { videoId: 'tt9:1:2', seconds: 10, duration: 60, updatedAt: 0 });
    expect(store.getSnapshot().library[key].videos?.['tt9:1:1'].watched).toBe(true);
    store.setWatched(series, '', ['tt9:1:1'], false);
    expect(store.getSnapshot().library[key].videos?.['tt9:1:1'].watched).toBe(false);
  });

  it('separates the library from «Seguir viendo» and keeps history when a title leaves the library', () => {
    const store = createPreferencesStore(memoryStorage());
    const key = mediaKey(movie.type, movie.id);
    store.saveMedia(movie, '');
    store.updateProgress(movie, '', watchProgress);
    // Dismissing from «Seguir viendo» keeps the title saved.
    store.dismissProgress(movie.type, movie.id);
    expect(store.getSnapshot().library[key]).toMatchObject({ saved: true });
    expect(store.getSnapshot().library[key].progress).toBeUndefined();
    store.setWatched(movie, '', [movie.id], true);
    store.toggleMedia(movie, '');
    expect(store.getSnapshot().library[key]).toMatchObject({ saved: false });
    expect(store.getSnapshot().library[key].watchedAt).toBeGreaterThan(0);
    store.toggleMedia(movie, '');
    expect(store.getSnapshot().library[key].saved).toBe(true);
  });

  it('refreshes an installed manifest only when the address still serves the same addon', () => {
    const store = createPreferencesStore(memoryStorage());
    store.installAddon(installedAddon);
    const canonical = 'https://example.com/configuration/manifest.json';
    store.toggleAddon(canonical);
    const newer = { ...installedAddon, manifest: { ...installedAddon.manifest, version: '1.1.0', types: ['movie', 'series'] } };
    store.refreshAddon(newer);
    expect(store.getSnapshot().addons.find((item) => item.manifestUrl === canonical)).toMatchObject({ enabled: false, manifest: { version: '1.1.0' } });
    store.refreshAddon({ ...installedAddon, manifest: { ...installedAddon.manifest, id: 'other.addon', name: 'Other' } });
    expect(store.getSnapshot().addons.find((item) => item.manifestUrl === canonical)?.manifest.id).toBe('test.addon');
  });

  it('keeps a library and preferences per profile without touching the main profile data', () => {
    const storage = memoryStorage();
    const store = createPreferencesStore(storage);
    store.installAddon(installedAddon);
    store.saveMedia(movie, '');
    store.switchProfile('kids');
    expect(store.getProfile()).toBe('kids');
    expect(store.getSnapshot().library).toEqual({});
    // Shared settings stay.
    expect(store.getSnapshot().addons.some((item) => item.manifest.id === 'test.addon')).toBe(true);
    store.saveMedia(series, '');
    store.setPlayer({ subtitleLanguage: 'eng' });
    const main = JSON.parse(storage.getItem('vela.preferences.v2')!);
    expect(Object.keys(main.library)).toEqual([mediaKey(movie.type, movie.id)]);
    expect(main.player.subtitleLanguage).toBe('spa');
    expect(Object.keys(JSON.parse(storage.getItem('vela.profile.kids.v1')!).library)).toEqual([mediaKey('series', 'tt9')]);
    store.switchProfile('main');
    expect(Object.keys(store.getSnapshot().library)).toEqual([mediaKey(movie.type, movie.id)]);
    store.switchProfile('kids');
    expect(store.getSnapshot().player.subtitleLanguage).toBe('eng');
    store.switchProfile('main');
    store.forgetProfile('kids');
    expect(storage.getItem('vela.profile.kids.v1')).toBeNull();
  });
});

describe('library collections', () => {
  it('groups saved titles, saving them when added, and keeps them per profile', () => {
    const backing = memoryStorage();
    const store = createPreferencesStore(backing);
    const id = store.createCollection('  Ciencia   ficción ');
    expect(store.getSnapshot().collections).toMatchObject([{ id, name: 'Ciencia ficción', keys: [] }]);
    expect(() => store.createCollection('ciencia ficción')).toThrow('duplicate');
    expect(() => store.createCollection('   ')).toThrow('empty');

    store.setInCollection(id, movie, 'https://addon/manifest.json', true);
    expect(store.getSnapshot().library[mediaKey('movie', movie.id)]?.saved).toBe(true);
    expect(store.getSnapshot().collections[0].keys).toEqual([mediaKey('movie', movie.id)]);

    store.renameCollection(id, 'Sci-fi');
    expect(createPreferencesStore(backing).getSnapshot().collections).toMatchObject([{ id, name: 'Sci-fi' }]);

    store.switchProfile('kids');
    expect(store.getSnapshot().collections).toEqual([]);
    store.switchProfile('main');
    expect(store.getSnapshot().collections).toHaveLength(1);

    // Leaving the library also leaves its collections.
    store.removeMedia('movie', movie.id);
    expect(store.getSnapshot().collections[0].keys).toEqual([]);
    store.deleteCollection(id);
    expect(store.getSnapshot().collections).toEqual([]);
  });

  it('drops collections that are not valid when reading', () => {
    const store = createPreferencesStore(memoryStorage(JSON.stringify({
      version: 1,
      library: {},
      collections: [
        { id: 'a', name: 'Ok', keys: ['["movie","tt1"]', '["movie","tt1"]', 7], createdAt: 1 },
        { id: 'a', name: 'Duplicate id', keys: [] },
        { id: '__proto__', name: 'Unsafe', keys: [] },
        { name: 'No id', keys: [] },
      ],
    })));
    expect(store.getSnapshot().collections).toEqual([{ id: 'a', name: 'Ok', keys: ['["movie","tt1"]'], createdAt: 1 }]);
  });
});
