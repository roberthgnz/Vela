import { describe, expect, it } from 'vitest';
import { byDay, daysFromToday, upcomingEpisodes } from './calendar';
import type { MediaItem } from './contracts';

const now = new Date(2026, 9, 31, 12, 0, 0);
const iso = (days: number, hour = 20) => new Date(2026, 9, 31 + days, hour).toISOString();

const show = (id: string, name: string, videos: MediaItem['videos']): { meta: MediaItem; addonUrl: string } => ({
  meta: { id, type: 'series', name, videos },
  addonUrl: 'https://addon.example/manifest.json',
});

describe('upcomingEpisodes', () => {
  it('keeps the window from a week ago to 45 days ahead, without specials or bad dates, oldest first', () => {
    const items = upcomingEpisodes(
      [
        show('a', 'Alpha', [
          { id: 'a:1:1', season: 1, episode: 1, released: iso(-30) },
          { id: 'a:1:2', season: 1, episode: 2, released: iso(-3) },
          { id: 'a:1:3', season: 1, episode: 3, released: iso(4) },
          { id: 'a:0:1', season: 0, episode: 1, released: iso(1) },
          { id: 'a:1:4', season: 1, episode: 4, released: 'not a date' },
          { id: 'a:1:9', season: 1, episode: 9, released: iso(60) },
        ]),
        show('b', 'Beta', [{ id: 'b:2:1', season: 2, episode: 1, released: iso(0) }]),
      ],
      now,
    );
    expect(items.map((item) => item.episode.id)).toEqual(['a:1:2', 'b:2:1', 'a:1:3']);
  });

  it('lists a series saved twice only once', () => {
    const series = show('a', 'Alpha', [{ id: 'a:1:1', season: 1, episode: 1, released: iso(1) }]);
    expect(upcomingEpisodes([series, series], now)).toHaveLength(1);
  });
});

describe('byDay and daysFromToday', () => {
  it('groups by local day and counts days from today', () => {
    const items = upcomingEpisodes(
      [
        show('a', 'Alpha', [
          { id: 'a:1:1', season: 1, episode: 1, released: iso(0, 9) },
          { id: 'a:1:2', season: 1, episode: 2, released: iso(1) },
        ]),
        show('b', 'Beta', [{ id: 'b:1:1', season: 1, episode: 1, released: iso(0, 21) }]),
      ],
      now,
    );
    const groups = byDay(items);
    expect(groups.map((group) => group.items.length)).toEqual([2, 1]);
    expect(groups.map((group) => daysFromToday(group.day, now))).toEqual([0, 1]);
  });
});
