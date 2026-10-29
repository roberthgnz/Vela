import { describe, expect, it } from 'vitest';

import type { LibraryEntry, MediaItem, ResolvedStream } from './contracts';
import { nextEpisode, orderedEpisodes, pickNextStream, watchedEpisodes } from './episodes';
import { encodeWatched } from './watched';

const now = Date.parse('2026-10-29T00:00:00Z');
const series: MediaItem = {
  id: 'tt1', type: 'series', name: 'Serie',
  videos: [
    { id: 'tt1:1:2', season: 1, episode: 2, released: '2026-01-02' },
    { id: 'tt1:0:1', season: 0, episode: 1, released: '2026-01-05' },
    { id: 'tt1:1:1', season: 1, episode: 1, released: '2026-01-01' },
    { id: 'tt1:2:1', season: 2, episode: 1, released: '2026-02-01' },
    { id: 'tt1:2:2', season: 2, episode: 2, released: '2026-12-01' },
  ],
};

describe('episodes', () => {
  it('orders seasons with specials last and moves to the next released episode', () => {
    expect(orderedEpisodes(series.videos).map((item) => item.id)).toEqual(['tt1:1:1', 'tt1:1:2', 'tt1:2:1', 'tt1:2:2', 'tt1:0:1']);
    expect(nextEpisode(series, 'tt1:1:1', now)?.id).toBe('tt1:1:2');
    expect(nextEpisode(series, 'tt1:1:2', now)?.id).toBe('tt1:2:1');
    // Unreleased episodes and the jump into specials are skipped, as in stremio-core.
    expect(nextEpisode(series, 'tt1:2:1', now)).toBeUndefined();
    expect(nextEpisode({ ...series, videos: series.videos!.slice(0, 3) }, 'tt1:1:2', now)).toBeUndefined();
    expect(nextEpisode({ type: 'movie', videos: series.videos }, 'tt1:1:1', now)).toBeUndefined();
  });

  it('combines Stremio watched marks with later marks made in Vela', async () => {
    const ids = ['tt1:0:1', 'tt1:1:1', 'tt1:1:2', 'tt1:2:1', 'tt1:2:2'];
    const entry: LibraryEntry = {
      meta: series, addonUrl: '', addedAt: 0, saved: true,
      remoteWatched: await encodeWatched(ids, new Set(['tt1:1:1', 'tt1:1:2'])),
      remoteWatchedAt: 100,
      videos: {
        'tt1:1:2': { seconds: 0, duration: 0, updatedAt: 200, watched: false },
        'tt1:2:1': { seconds: 0, duration: 0, updatedAt: 200, watched: true },
        // Older than the remote field: already reflected there.
        'tt1:1:1': { seconds: 0, duration: 0, updatedAt: 50, watched: false },
      },
    };
    expect([...await watchedEpisodes(entry, series.videos!)].sort()).toEqual(['tt1:1:1', 'tt1:2:1']);
    expect((await watchedEpisodes({ ...entry, remoteWatched: 'garbage' }, series.videos!)).has('tt1:2:1')).toBe(true);
  });

  it('keeps the same release for the next episode', () => {
    const stream = (name: string, extra: Partial<ResolvedStream> = {}): ResolvedStream => ({ name, url: `https://cdn.example/${name}`, addonName: 'A', addonUrl: 'https://a.example/manifest.json', ...extra });
    const current = stream('1080p', { behaviorHints: { bingeGroup: 'a|1080p|web' } });
    const list = [stream('720p'), stream('1080p'), stream('Other', { behaviorHints: { bingeGroup: 'a|1080p|web' } })];
    expect(pickNextStream(list, current)?.name).toBe('Other');
    expect(pickNextStream(list.slice(0, 2), current)?.name).toBe('1080p');
    expect(pickNextStream([stream('1080p', { url: undefined, infoHash: 'x' })], stream('1080p'))).toBeUndefined();
    expect(pickNextStream([stream('4K')], stream('1080p'))).toBeUndefined();
  });
});
