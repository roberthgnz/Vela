import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ postJson: vi.fn(), requestJson: vi.fn() }));
vi.mock('./transport', () => transport);

import type { LibraryEntry } from './contracts';
import { mediaKey } from './store';
import { decodeWatched, encodeWatched } from './watched';
import { createLink, entryFromRemote, getLibrary, login, planSync, readLink, remoteFromEntry, type RemoteItem } from './stremioApi';

const day = 86_400_000;
const t0 = Date.parse('2026-10-01T00:00:00Z');

function remote(id: string, mtime: number, extra: Partial<RemoteItem> = {}, state: Partial<RemoteItem['state']> = {}): RemoteItem {
  return {
    _id: id, name: `Title ${id}`, type: 'movie', poster: `https://img.example/${id}.jpg`, posterShape: 'poster',
    removed: false, temp: false, _ctime: new Date(t0 - day).toISOString(), _mtime: new Date(mtime).toISOString(),
    state: { lastWatched: null, timeWatched: 0, timeOffset: 0, overallTimeWatched: 0, timesWatched: 0, flaggedWatched: 0, duration: 0, video_id: null, watched: null, noNotif: false, ...state },
    behaviorHints: { defaultVideoId: null },
    ...extra,
  };
}

function local(id: string, addedAt: number, progress?: LibraryEntry['progress'], type = 'movie', saved = true): [string, LibraryEntry] {
  const entry: LibraryEntry = { meta: { id, type, name: `Local ${id}` }, addonUrl: 'https://v3-cinemeta.strem.io/manifest.json', addedAt, saved };
  if (progress) entry.progress = progress;
  return [mediaKey(type, id), entry];
}

describe('Stremio account API', () => {
  beforeEach(() => {
    transport.postJson.mockReset();
    transport.requestJson.mockReset();
  });

  it('sends the request bodies used by stremio-core and unwraps results', async () => {
    transport.postJson.mockResolvedValue({ result: { authKey: 'k', user: { _id: 'u', email: 'a@b.c' } } });
    await login('a@b.c', 'secret');
    expect(transport.postJson).toHaveBeenCalledWith('https://api.strem.io/api/login', { type: 'Login', email: 'a@b.c', password: 'secret', facebook: false });
    transport.postJson.mockResolvedValue({ result: [] });
    await getLibrary('k');
    expect(transport.postJson).toHaveBeenLastCalledWith('https://api.strem.io/api/datastoreGet', { authKey: 'k', collection: 'libraryItem', ids: [], all: true });
  });

  it('turns API errors into readable messages', async () => {
    transport.postJson.mockResolvedValue({ error: { code: 1, message: 'Session does not exist' } });
    await expect(getLibrary('bad')).rejects.toMatchObject({ code: 1, message: expect.stringContaining('caducado') });
  });

  it('creates link codes and treats code 101 as pending', async () => {
    transport.requestJson.mockResolvedValueOnce({ result: { code: 'AB12', link: 'https://link.stremio.com/AB12', qrcode: 'https://link.stremio.com/qr?data=x', success: true } });
    expect((await createLink()).code).toBe('AB12');
    transport.requestJson.mockResolvedValueOnce({ error: { code: 101, message: 'Invalid or expired token' } });
    expect(await readLink('AB12')).toBeNull();
    transport.requestJson.mockResolvedValueOnce({ result: { authKey: 'key' } });
    expect(await readLink('AB12')).toBe('key');
    expect(transport.requestJson).toHaveBeenLastCalledWith('https://link.stremio.com/api/v2/read?type=Read&code=AB12');
  });
});

describe('library mapping', () => {
  it('converts milliseconds and keeps the watched video', () => {
    const entry = entryFromRemote(remote('tt1', t0, { type: 'series' }, { timeOffset: 90_000, duration: 3_600_000, video_id: 'tt1:1:2' }));
    expect(entry.progress).toEqual({ videoId: 'tt1:1:2', seconds: 90, duration: 3600, updatedAt: t0 });
    expect(entry.meta).toEqual({ id: 'tt1', type: 'series', name: 'Title tt1', poster: 'https://img.example/tt1.jpg' });
  });

  it('preserves unknown remote fields when uploading progress', () => {
    const base = remote('tt1', t0, { temp: true, removed: true, custom: 1 }, { timesWatched: 3, watched: 'bits' });
    const [, entry] = local('tt1', t0 - day, { videoId: 'tt1', seconds: 12.5, duration: 100, updatedAt: t0 + day }, 'movie', false);
    const item = remoteFromEntry(entry, base, t0 + 2 * day);
    expect(item).toMatchObject({ custom: 1, temp: true, removed: true, _mtime: new Date(t0 + 2 * day).toISOString() });
    expect(item.state).toMatchObject({ timesWatched: 3, watched: 'bits', timeOffset: 12_500, duration: 100_000, video_id: 'tt1' });
  });
});

describe('planSync', () => {
  const empty = { synced: {}, removed: {} };

  it('pulls remote-only titles and pushes local-only ones, ignoring Vela demo ids', async () => {
    const plan = await planSync(Object.fromEntries([local('tt2', t0), local('vela:sintel', t0)]), [remote('tt1', t0)], empty, t0 + day);
    expect(plan.pull.map((entry) => entry.meta.id)).toEqual(['tt1']);
    expect(plan.push.map((item) => [item._id, item.removed])).toEqual([['tt2', false]]);
  });

  it('lets the newest side win', async () => {
    const library = Object.fromEntries([
      local('old', t0, { videoId: 'old', seconds: 5, duration: 10, updatedAt: t0 }),
      local('new', t0, { videoId: 'new', seconds: 9, duration: 10, updatedAt: t0 + 3 * day }),
    ]);
    const plan = await planSync(library, [
      remote('old', t0 + day, {}, { timeOffset: 7000, duration: 10_000, video_id: 'old' }),
      remote('new', t0 + day),
    ], empty, t0 + 4 * day);
    expect(plan.pull).toHaveLength(1);
    expect(plan.pull[0].progress?.seconds).toBe(7);
    expect(plan.pull[0].meta.name).toBe('Local old');
    expect(plan.push.map((item) => item._id)).toEqual(['new']);
  });

  it('propagates removals in both directions', async () => {
    const plan = await planSync(Object.fromEntries([local('gone-remote', t0)]), [
      remote('gone-remote', t0 + day, { removed: true }),
      remote('gone-local', t0),
    ], { synced: { 'gone-remote': t0, 'gone-local': t0 }, removed: { 'gone-local': { type: 'movie', at: t0 + day } } }, t0 + 2 * day);
    expect(plan.drop).toEqual([{ type: 'movie', id: 'gone-remote' }]);
    expect(plan.push.map((item) => [item._id, item.removed])).toEqual([['gone-local', true]]);
  });

  it('keeps continue-watching items that Stremio marks as temporary', async () => {
    const plan = await planSync({}, [remote('tt9', t0, { removed: true, temp: true }, { timeOffset: 1000, duration: 2000 }), remote('tt8', t0, { removed: true })], empty);
    expect(plan.pull.map((entry) => entry.meta.id)).toEqual(['tt9']);
  });

  it('does nothing when both sides are unchanged since the last sync', async () => {
    const [key, entry] = local('tt1', t0 - day, { videoId: 'tt1', seconds: 1, duration: 2, updatedAt: t0 });
    const plan = await planSync({ [key]: entry }, [remote('tt1', t0, {}, { timeOffset: 1000, duration: 2000 })], { synced: { tt1: t0 }, removed: {} });
    expect(plan.pull).toEqual([]);
    expect(plan.push).toEqual([]);
  });

  const episodes = [1, 2, 3].map((episode) => ({ id: `tt5:1:${episode}`, season: 1, episode }));

  it('uploads titles watched outside the library as temporary items and the next-episode pointer', async () => {
    const [key, entry] = local('tt5', t0, { videoId: 'tt5:1:2', seconds: 0, duration: 0, updatedAt: t0 + day }, 'series', false);
    const plan = await planSync({ [key]: entry }, [], empty, t0 + 2 * day);
    expect(plan.push[0]).toMatchObject({ _id: 'tt5', removed: true, temp: true, state: { timeOffset: 1, video_id: 'tt5:1:2' } });
    const pulled = entryFromRemote(plan.push[0]);
    expect(pulled).toMatchObject({ saved: false, progress: { videoId: 'tt5:1:2', seconds: 0, duration: 0 } });
  });

  it('merges episode marks into the Stremio watched field without dropping remote ones', async () => {
    const remoteField = await encodeWatched(episodes.map((item) => item.id), new Set(['tt5:1:1']));
    const [key, entry] = local('tt5', t0, undefined, 'series');
    entry.meta.videos = episodes;
    entry.videos = { 'tt5:1:2': { seconds: 0, duration: 0, updatedAt: t0 + 2 * day, watched: true } };
    const base = remote('tt5', t0 + day, { type: 'series', custom: 'kept' }, { watched: remoteField, timesWatched: 4 });
    const plan = await planSync({ [key]: entry }, [base], { synced: { tt5: t0 + day }, removed: {} }, t0 + 3 * day);
    expect(plan.push).toHaveLength(1);
    expect(plan.push[0]).toMatchObject({ custom: 'kept', state: { timesWatched: 4 } });
    const watched = await decodeWatched(plan.push[0].state.watched!, episodes.map((item) => item.id));
    expect([...watched].sort()).toEqual(['tt5:1:1', 'tt5:1:2']);
    expect(plan.local[0].remoteWatched).toBe(plan.push[0].state.watched);
  });

  it('keeps an undecodable or unknown remote watched field untouched', async () => {
    const [key, entry] = local('tt6', t0 + 2 * day, undefined, 'series');
    entry.videos = { 'tt6:1:1': { seconds: 0, duration: 0, updatedAt: t0 + 2 * day, watched: true } };
    const plan = await planSync({ [key]: entry }, [remote('tt6', t0, { type: 'series' }, { watched: 'opaque:1:value' })], empty, t0 + 3 * day);
    expect(plan.push[0].state.watched).toBe('opaque:1:value');
  });

  it('keeps local history when Stremio removes a watched title, and marks watched movies', async () => {
    const [key, entry] = local('tt7', t0);
    entry.videos = { tt7: { seconds: 100, duration: 100, updatedAt: t0, watched: true } };
    const plan = await planSync({ [key]: entry }, [remote('tt7', t0 + day, { removed: true })], { synced: { tt7: t0 }, removed: {} }, t0 + 2 * day);
    expect(plan.drop).toEqual([]);
    expect(plan.pull[0]).toMatchObject({ saved: false, videos: { tt7: { watched: true } } });
    const [movieKey, movieEntry] = local('tt8', t0);
    movieEntry.watchedAt = t0 + day;
    const pushed = await planSync({ [movieKey]: movieEntry }, [], empty, t0 + 2 * day);
    expect(pushed.push[0].state).toMatchObject({ timesWatched: 1, flaggedWatched: 1 });
    expect(entryFromRemote(pushed.push[0]).watchedAt).toBe(t0 + 2 * day);
  });
});
