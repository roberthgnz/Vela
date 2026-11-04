import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryEntry } from './contracts';
import { createPreferencesStore, mediaKey } from './store';
import {
  applyLibraryImport, LibraryImportError, MAX_LIBRARY_IMPORT_BYTES, parseLibraryExport, previewLibraryImport,
} from './libraryImport';

const addon = 'https://example.test/manifest.json';
const key = mediaKey('series', 'test');
function entry(change: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    meta: { id: 'test', type: 'series', name: 'Test series', videos: [{ id: 'test:1:1', season: 1, episode: 1 }] },
    addonUrl: addon,
    addedAt: 100,
    saved: true,
    ...change,
  };
}
function exported(...entries: LibraryEntry[]) {
  return JSON.stringify({ version: 1, exportedAt: '2026-11-05T10:00:00.000Z',
    library: Object.fromEntries(entries.map((item) => [mediaKey(item.meta.type, item.meta.id), item])) });
}
function memory() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }),
    removeItem: (key: string) => { data.delete(key); },
  };
}
function invalid(text: string, code = 'invalid') {
  expect(() => parseLibraryExport(text)).toThrow(LibraryImportError);
  try { parseLibraryExport(text); } catch (error) {
    expect(error).toMatchObject({ code });
  }
}
afterEach(() => vi.restoreAllMocks());

describe('Vela library export parser', () => {
  it('roundtrips titles, continue pointers and explicit watched/unwatched history', () => {
    const saved = entry({
      progress: { videoId: 'test:1:2', seconds: 0, duration: 0, updatedAt: 210 },
      videos: {
        'test:1:1': { seconds: 0, duration: 900, updatedAt: 200, watched: true },
        'test:1:2': { seconds: 0, duration: 0, updatedAt: 210, watched: false },
      },
    });
    expect(parseLibraryExport(exported(saved))).toEqual({ entries: [saved], exportedAt: '2026-11-05T10:00:00.000Z' });
  });

  it('rejects malformed files, unknown versions and non-library shapes', () => {
    for (const value of ['{broken', 'null', '[]', '{"version":1}', '{"version":1,"library":[]}',
      '{"version":1,"exportedAt":"not a date","library":{}}']) invalid(value);
    invalid('{"version":2,"library":{}}', 'unsupported');
  });

  it('validates every title and rejects damaged optional history without silently losing it', () => {
    for (const damaged of [
      { ...entry(), saved: 'true' },
      { ...entry(), addedAt: -1 },
      { ...entry(), changedAt: 'yesterday' },
      { ...entry(), progress: { videoId: 'test:1:1', seconds: 999, duration: 100, updatedAt: 200 } },
      { ...entry(), videos: { 'test:1:1': { seconds: 1, duration: 100, updatedAt: 200, watched: 'yes' } } },
      { ...entry(), meta: { ...entry().meta, videos: [{ id: 'test:1:1', episode: 'one' }] } },
      { ...entry(), meta: { ...entry().meta, genres: ['Drama', 7] } },
      { ...entry(), addonUrl: 'javascript:alert(1)' },
    ]) invalid(JSON.stringify({ version: 1, library: { [key]: damaged } }));
    invalid(JSON.stringify({ version: 1, library: { [key]: entry(), bad: { meta: {} } } }));
  });

  it('rejects duplicate JSON keys, including escaped equivalents and dangerous property names', () => {
    const name = JSON.stringify(key);
    const item = JSON.stringify(entry());
    invalid(`{"version":1,"library":{${name}:${item},${name}:${item}}}`);
    invalid('{"version":1,"ver\\u0073ion":1,"library":{}}');
    invalid('{"version":1,"library":{},"__proto__":{"polluted":true}}');
    invalid(exported(entry()).replace('"name":"Test series"', '"name":"Test series","constructor":{"polluted":true}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('requires each library key to match its actual type and id', () => {
    invalid(JSON.stringify({ version: 1, library: { different: entry() } }));
    invalid(JSON.stringify({ version: 1, library: { '[ "series", "test" ]': entry() } }));
  });

  it('limits file size in UTF-8 bytes, not only character count', () => {
    invalid(' '.repeat(MAX_LIBRARY_IMPORT_BYTES + 1), 'tooLarge');
    invalid('ü'.repeat(MAX_LIBRARY_IMPORT_BYTES / 2 + 1), 'tooLarge');
  });

  it('accepts built-in addons and ignores non-library settings and unknown stream credentials', () => {
    const value = JSON.parse(exported(entry({ addonUrl: 'vela://open-cinema/manifest.json' })));
    value.account = { authKey: 'must not import' };
    value.player = { volume: 0 };
    value.library[key].meta.streams = [{ url: 'https://private.test/token' }];
    const parsed = parseLibraryExport(JSON.stringify(value));
    expect(parsed.entries[0].addonUrl).toBe('vela://open-cinema/manifest.json');
    expect(parsed.entries[0].meta).not.toHaveProperty('streams');
    expect(parsed).not.toHaveProperty('account');
  });
});

describe('non-destructive library import', () => {
  it('adds titles to only the active profile and leaves settings, collections and other storage intact', () => {
    const storage = memory();
    storage.setItem('vela.account.v1', '{"user":"original"}');
    const store = createPreferencesStore(storage);
    store.saveMedia({ id: 'main', name: 'Main title', type: 'movie' }, addon);
    store.setPlayer({ seekShort: 15 });
    store.switchProfile('other');
    const before = store.getSnapshot();
    const parsed = parseLibraryExport(exported(entry()));
    expect(applyLibraryImport(parsed, store)).toEqual({ added: 1, updated: 0, unchanged: 0, total: 1 });
    expect(store.getSnapshot()).toMatchObject({ player: before.player, addons: before.addons, collections: before.collections });
    expect(store.getSnapshot().library[key]).toEqual(entry());
    expect(storage.getItem('vela.account.v1')).toBe('{"user":"original"}');
    store.switchProfile('main');
    expect(store.getSnapshot().library[key]).toBeUndefined();
    expect(store.getSnapshot().library[mediaKey('movie', 'main')]).toBeDefined();
    expect(store.getSnapshot().player.seekShort).toBe(15);
    store.switchProfile('other');
    expect(store.getSnapshot().library[key]).toEqual(entry());
  });

  it('preserves newer local progress, watched marks and titles absent from the export', () => {
    const store = createPreferencesStore(memory());
    const local = entry({
      progress: { videoId: 'test:1:1', seconds: 70, duration: 100, updatedAt: 400 },
      videos: { 'test:1:1': { seconds: 70, duration: 100, updatedAt: 400, watched: false } },
    });
    store.mergeLibrary([local, entry({ meta: { id: 'extra', type: 'movie', name: 'Keep me' } })]);
    const older = entry({
      progress: { videoId: 'test:1:1', seconds: 10, duration: 100, updatedAt: 200 },
      videos: { 'test:1:1': { seconds: 10, duration: 100, updatedAt: 200, watched: true } },
    });
    expect(applyLibraryImport(parseLibraryExport(exported(older)), store)).toMatchObject({ unchanged: 1 });
    expect(store.getSnapshot().library[key]).toEqual(local);
    expect(store.getSnapshot().library[mediaKey('movie', 'extra')]).toBeDefined();
  });

  it('merges newer progress and episode marks individually, keeping local metadata and previous episodes', () => {
    const store = createPreferencesStore(memory());
    store.mergeLibrary([entry({
      videos: {
        'test:1:1': { seconds: 0, duration: 100, updatedAt: 300, watched: true },
        'test:1:2': { seconds: 10, duration: 100, updatedAt: 200, watched: true },
      },
    })]);
    const incoming = entry({
      meta: { ...entry().meta, name: 'Different metadata' },
      progress: { videoId: 'test:1:2', seconds: 35, duration: 100, updatedAt: 400 },
      videos: { 'test:1:2': { seconds: 35, duration: 100, updatedAt: 400, watched: false } },
    });
    expect(applyLibraryImport(parseLibraryExport(exported(incoming)), store)).toMatchObject({ updated: 1 });
    expect(store.getSnapshot().library[key]).toMatchObject({
      meta: { name: 'Test series' },
      progress: incoming.progress,
      videos: { 'test:1:1': { watched: true }, 'test:1:2': { watched: false, seconds: 35 } },
    });
  });

  it('keeps equal timestamps local and never turns a missing watched flag into an unwatched mark', () => {
    const store = createPreferencesStore(memory());
    store.mergeLibrary([entry({ videos: { 'test:1:1': { seconds: 20, duration: 100, updatedAt: 200, watched: true } } })]);
    const tied = entry({ videos: { 'test:1:1': { seconds: 1, duration: 100, updatedAt: 200, watched: false } } });
    expect(applyLibraryImport(parseLibraryExport(exported(tied)), store)).toMatchObject({ unchanged: 1 });
    const later = entry({ videos: { 'test:1:1': { seconds: 30, duration: 100, updatedAt: 300 } } });
    applyLibraryImport(parseLibraryExport(exported(later)), store);
    expect(store.getSnapshot().library[key].videos?.['test:1:1']).toMatchObject({ seconds: 30, watched: true });
  });

  it('respects a newer dismissal of the continue pointer without inventing current timestamps', () => {
    vi.spyOn(Date, 'now').mockReturnValue(9_000);
    const store = createPreferencesStore(memory());
    store.mergeLibrary([entry({ progress: { videoId: 'test:1:1', seconds: 20, duration: 100, updatedAt: 200 } })]);
    applyLibraryImport(parseLibraryExport(exported(entry({ changedAt: 400 }))), store);
    expect(store.getSnapshot().library[key].progress).toBeUndefined();
    expect(store.getSnapshot().library[key].changedAt).toBe(400);
    const oldResume = entry({ progress: { videoId: 'test:1:1', seconds: 10, duration: 100, updatedAt: 300 } });
    expect(applyLibraryImport(parseLibraryExport(exported(oldResume)), store)).toMatchObject({ unchanged: 1 });
  });

  it('keeps newer saved status and preserves the historical clock when the export had only addedAt', () => {
    const store = createPreferencesStore(memory());
    store.mergeLibrary([entry({ changedAt: 300, saved: false })]);
    applyLibraryImport(parseLibraryExport(exported(entry({ changedAt: 200 }))), store);
    expect(store.getSnapshot().library[key].saved).toBe(false);
    applyLibraryImport(parseLibraryExport(exported(entry({ addedAt: 400 }))), store);
    expect(store.getSnapshot().library[key]).toMatchObject({ saved: true, changedAt: 400, addedAt: 100 });
  });

  it('compares explicit movie watched and unwatched marks using their video timestamps', () => {
    const movie = { id: 'movie', name: 'Movie', type: 'movie' };
    const movieKey = mediaKey('movie', 'movie');
    const store = createPreferencesStore(memory());
    store.mergeLibrary([entry({ meta: movie, watchedAt: 0, videos: { movie: { seconds: 0, duration: 100, updatedAt: 400, watched: false } } })]);
    const watched = entry({ meta: movie, watchedAt: 200, videos: { movie: { seconds: 0, duration: 100, updatedAt: 200, watched: true } } });
    applyLibraryImport(parseLibraryExport(exported(watched)), store);
    expect(store.getSnapshot().library[movieKey].watchedAt).toBe(0);
    applyLibraryImport(parseLibraryExport(exported(entry({ ...watched, watchedAt: 500, videos: { movie: { seconds: 0, duration: 100, updatedAt: 500, watched: true } } }))), store);
    expect(store.getSnapshot().library[movieKey].watchedAt).toBe(500);
  });

  it('preserves remote watched history by its original timestamp without importing account acknowledgements', () => {
    const storage = memory();
    storage.setItem('vela.account.v1', '{"sync":{"synced":{"test":900}}}');
    const store = createPreferencesStore(storage);
    store.mergeLibrary([entry({ remoteWatched: 'local:1:bits', remoteWatchedAt: 300 })]);
    applyLibraryImport(parseLibraryExport(exported(entry({ remoteWatched: 'old:1:bits', remoteWatchedAt: 200 }))), store);
    expect(store.getSnapshot().library[key].remoteWatched).toBe('local:1:bits');
    applyLibraryImport(parseLibraryExport(exported(entry({ remoteWatched: 'new:1:bits', remoteWatchedAt: 400 }))), store);
    expect(store.getSnapshot().library[key]).toMatchObject({ remoteWatched: 'new:1:bits', remoteWatchedAt: 400 });
    expect(storage.getItem('vela.account.v1')).toBe('{"sync":{"synced":{"test":900}}}');
  });

  it('is idempotent: importing the same file twice produces no second write or notification', () => {
    const storage = memory();
    const store = createPreferencesStore(storage);
    const observe = vi.fn();
    store.subscribe(observe);
    const parsed = parseLibraryExport(exported(entry({ videos: { 'test:1:1': { seconds: 1, duration: 100, updatedAt: 200, watched: false } } })));
    applyLibraryImport(parsed, store);
    const snapshot = store.getSnapshot();
    const writes = storage.setItem.mock.calls.length;
    const notifications = observe.mock.calls.length;
    expect(applyLibraryImport(parsed, store)).toEqual({ added: 0, updated: 0, unchanged: 1, total: 1 });
    expect(store.getSnapshot()).toBe(snapshot);
    expect(storage.setItem).toHaveBeenCalledTimes(writes);
    expect(observe).toHaveBeenCalledTimes(notifications);
  });

  it('replans against current data when playback advances after the preview', () => {
    const store = createPreferencesStore(memory());
    store.mergeLibrary([entry({ progress: { videoId: 'test:1:1', seconds: 1, duration: 100, updatedAt: 100 } })]);
    const parsed = parseLibraryExport(exported(entry({ progress: { videoId: 'test:1:1', seconds: 20, duration: 100, updatedAt: 200 } })));
    expect(previewLibraryImport(parsed, store.getSnapshot().library)).toMatchObject({ updated: 1 });
    vi.spyOn(Date, 'now').mockReturnValue(300);
    store.updateProgress(entry().meta, addon, { videoId: 'test:1:1', seconds: 30, duration: 100, updatedAt: 300 });
    expect(applyLibraryImport(parsed, store)).toMatchObject({ unchanged: 1 });
    expect(store.getSnapshot().library[key].progress?.seconds).toBe(30);
  });

  it('validates the entire batch before applying any record, including direct API calls', () => {
    const store = createPreferencesStore(memory());
    const before = store.getSnapshot();
    expect(() => applyLibraryImport({ entries: [entry(), entry()] }, store)).toThrow(LibraryImportError);
    expect(store.getSnapshot()).toBe(before);
    expect(() => applyLibraryImport({ entries: [entry(), { ...entry(), addedAt: -1 }] }, store)).toThrow(LibraryImportError);
    expect(store.getSnapshot()).toBe(before);
    expect(applyLibraryImport({ entries: [] }, store)).toEqual({ added: 0, updated: 0, unchanged: 0, total: 0 });
    expect(store.getSnapshot()).toBe(before);
  });
});
