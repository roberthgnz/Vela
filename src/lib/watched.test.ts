import { describe, expect, it } from 'vitest';

import { bitfieldOrder, decodeWatched, encodeWatched, parseWatched } from './watched';

// Test vectors from stremio-core's stremio-watched-bitfield crate (watched_bitfield.rs).
const videos = Array.from({ length: 9 }, (_, index) => `tt2934286:1:${index + 1}`);

describe('Stremio watched bitfield', () => {
  it('decodes and re-encodes the upstream example exactly', async () => {
    const serialized = 'tt2934286:1:5:5:eJyTZwAAAEAAIA==';
    const watched = await decodeWatched(serialized, videos);
    expect(watched.has('tt2934286:1:5')).toBe(true);
    expect(watched.has('tt2934286:1:6')).toBe(false);
    expect(await encodeWatched(videos, watched)).toBe(serialized);
  });

  it('keeps video ids with colons as the anchor', async () => {
    const field = await parseWatched('tt7767422:3:8:24:eJz7//8/AAX9Av4=');
    expect(field).toMatchObject({ anchor: 'tt7767422:3:8', anchorLength: 24 });
  });

  it('serializes an empty list as stremio-core does', async () => {
    expect(await encodeWatched([], new Set())).toBe('undefined:1:eJwDAAAAAAE=');
  });

  it('realigns bits when episodes are added before the anchor', async () => {
    const serialized = await encodeWatched(videos, new Set(['tt2934286:1:2', 'tt2934286:1:5']));
    const withSpecial = ['tt2934286:0:1', ...videos];
    const watched = await decodeWatched(serialized, withSpecial);
    expect([...watched].sort()).toEqual(['tt2934286:1:2', 'tt2934286:1:5']);
    // An unknown anchor yields nothing rather than misplaced marks.
    expect((await decodeWatched(serialized, ['other:1:1'])).size).toBe(0);
  });

  it('round-trips large series', async () => {
    const ids = Array.from({ length: 499 }, (_, index) => `tt2934286:1:${index + 1}`);
    const even = new Set(ids.filter((_, index) => index % 2 === 0));
    expect(await decodeWatched(await encodeWatched(ids, even), ids)).toEqual(even);
  });

  it('orders videos by season, episode and release date like stremio-core', () => {
    expect(bitfieldOrder([
      { id: 's2e1', season: 2, episode: 1 },
      { id: 's1e2', season: 1, episode: 2 },
      { id: 'special', season: 0, episode: 1 },
      { id: 's1e1', season: 1, episode: 1 },
      { id: 'loose' },
    ])).toEqual(['loose', 'special', 's1e1', 's1e2', 's2e1']);
  });
});
