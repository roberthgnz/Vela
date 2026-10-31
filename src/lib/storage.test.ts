import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopStorage, getStorageStatus, MIGRATION_KEY, type Change } from './storage';

function fakeLocalStorage(entries: Record<string, string>) {
  const keys = Object.keys(entries);
  return {
    length: keys.length,
    key: (index: number) => keys[index] ?? null,
    getItem: (key: string) => entries[key] ?? null,
    setItem: () => {},
    removeItem: () => {},
  };
}

describe('desktop storage', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads what was loaded and writes changes in one batch', async () => {
    const writes: Change[][] = [];
    const storage = createDesktopStorage(async (changes) => void writes.push(changes));
    await storage.init([{ key: 'vela.a', value: '1' }]);
    expect(storage.getItem('vela.a')).toBe('1');
    expect(storage.getItem('vela.missing')).toBeNull();

    storage.setItem('vela.a', '2');
    storage.setItem('vela.b', 'x');
    storage.setItem('vela.b', 'y');
    storage.removeItem('vela.a');
    expect(storage.getItem('vela.a')).toBeNull();
    expect(storage.getStatus().pending).toBe(2);
    expect(writes).toEqual([]);

    await vi.advanceTimersByTimeAsync(60);
    expect(writes).toEqual([[{ key: 'vela.a', value: null }, { key: 'vela.b', value: 'y' }]]);
    expect(storage.getStatus()).toMatchObject({ pending: 0, error: undefined, backend: 'desktop' });
  });

  it('skips writes that change nothing', async () => {
    const writer = vi.fn(async () => {});
    const storage = createDesktopStorage(writer);
    await storage.init([{ key: 'vela.a', value: '1' }]);
    storage.setItem('vela.a', '1');
    storage.removeItem('vela.none');
    await vi.advanceTimersByTimeAsync(100);
    expect(writer).not.toHaveBeenCalled();
  });

  it('keeps failed changes, reports the error and retries', async () => {
    let fail = true;
    const writes: Change[][] = [];
    const storage = createDesktopStorage(async (changes) => {
      if (fail) throw new Error('disk full');
      writes.push(changes);
    });
    await storage.init([]);
    storage.setItem('vela.a', '1');
    await vi.advanceTimersByTimeAsync(60);
    expect(storage.getStatus()).toMatchObject({ error: 'disk full', pending: 1 });
    // A newer value wins over the failed one.
    storage.setItem('vela.a', '2');
    fail = false;
    await vi.advanceTimersByTimeAsync(5_100);
    expect(writes).toEqual([[{ key: 'vela.a', value: '2' }]]);
    expect(storage.getStatus()).toMatchObject({ error: undefined, pending: 0 });
  });

  it('flush writes everything pending at once', async () => {
    const writes: Change[][] = [];
    const storage = createDesktopStorage(async (changes) => void writes.push(changes));
    await storage.init([]);
    storage.setItem('vela.a', '1');
    await storage.flush();
    expect(writes).toEqual([[{ key: 'vela.a', value: '1' }]]);
    expect(storage.getStatus().pending).toBe(0);
    // Nothing pending: no write.
    await storage.flush();
    expect(writes).toHaveLength(1);
  });

  it('copies the vela.* keys of localStorage into an empty database once', async () => {
    const writes: Change[][] = [];
    const storage = createDesktopStorage(async (changes) => void writes.push(changes));
    const legacy = fakeLocalStorage({ 'vela.preferences.v2': '{"version":2}', 'vela.profiles.v1': '{}', other: 'ignored' });
    await storage.init([], legacy);
    expect(storage.getItem('vela.preferences.v2')).toBe('{"version":2}');
    expect(storage.getItem('other')).toBeNull();
    expect(storage.getStatus().migrated).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].map((change) => change.key).sort()).toEqual(['vela.preferences.v2', 'vela.profiles.v1', MIGRATION_KEY]);
    expect(JSON.parse(storage.getItem(MIGRATION_KEY)!)).toMatchObject({ from: 'localStorage', keys: 2 });
  });

  it('leaves a database with preferences alone even when localStorage has keys', async () => {
    const writer = vi.fn(async () => {});
    const storage = createDesktopStorage(writer);
    await storage.init(
      [{ key: 'vela.preferences.v2', value: 'db' }],
      fakeLocalStorage({ 'vela.preferences.v2': 'old', 'vela.y': 'old' }),
    );
    expect(storage.getItem('vela.preferences.v2')).toBe('db');
    expect(storage.getItem('vela.y')).toBeNull();
    expect(storage.getStatus().migrated).toBe(false);
    expect(writer).not.toHaveBeenCalled();
  });

  it('still migrates a database that only has stray keys (no preferences, no note)', async () => {
    const writes: Change[][] = [];
    const storage = createDesktopStorage(async (changes) => void writes.push(changes));
    await storage.init([{ key: 'vela.ui.volume', value: '0.5' }], fakeLocalStorage({ 'vela.preferences.v2': 'old' }));
    expect(storage.getItem('vela.preferences.v2')).toBe('old');
    expect(storage.getItem('vela.ui.volume')).toBe('0.5');
    expect(storage.getStatus().migrated).toBe(true);
    expect(writes).toHaveLength(1);
  });

  it('does not migrate twice', async () => {
    const writer = vi.fn(async () => {});
    const storage = createDesktopStorage(writer);
    await storage.init([{ key: MIGRATION_KEY, value: '{}' }], fakeLocalStorage({ 'vela.preferences.v2': 'old' }));
    expect(storage.getItem('vela.preferences.v2')).toBeNull();
    expect(writer).not.toHaveBeenCalled();
  });

  it('asks for a backup right after migrating, and only then', async () => {
    const backup = vi.fn(async () => {});
    const migrated = createDesktopStorage(async () => {}, 'desktop', backup);
    await migrated.init([], fakeLocalStorage({ 'vela.preferences.v2': '{}' }));
    expect(backup).toHaveBeenCalledTimes(1);
    const existing = createDesktopStorage(async () => {}, 'desktop', backup);
    await existing.init([{ key: 'vela.preferences.v2', value: '{}' }], fakeLocalStorage({ 'vela.preferences.v2': 'old' }));
    expect(backup).toHaveBeenCalledTimes(1);
  });

  it('does not migrate when localStorage has nothing of Vela', async () => {
    const writer = vi.fn(async () => {});
    const storage = createDesktopStorage(writer);
    await storage.init([], fakeLocalStorage({ foo: 'bar' }));
    expect(storage.getStatus().migrated).toBe(false);
    expect(writer).not.toHaveBeenCalled();
  });

  it('notifies subscribers when the status changes', async () => {
    const storage = createDesktopStorage(async () => {});
    await storage.init([]);
    const listener = vi.fn();
    storage.subscribe(listener);
    storage.setItem('vela.a', '1');
    expect(listener).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('storage status', () => {
  it('is the same object until it changes, as useSyncExternalStore needs', () => {
    // A new object on every read made React re-render forever: Home stayed blank in the browser.
    expect(getStorageStatus()).toBe(getStorageStatus());
  });
});
