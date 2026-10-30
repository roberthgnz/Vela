import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import type { LibraryEntry, MediaItem } from './contracts';
import {
  canonicalGenres,
  composeHome,
  diversify,
  excluded,
  fatigueFactor,
  likesGenre,
  interactionStrength,
  quality,
  rank,
  reasonText,
  seedsFrom,
  tasteProfile,
  type Candidate,
} from './recommend';
import { catalogCandidate, tmdbPool } from './recommendSources';
import { mediaKey } from './store';
import { createTaste, type TasteState } from './taste';
import type { TmdbContext } from './tmdbCatalogs';

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 30);
const noTaste: TasteState = { ratings: {}, hidden: {} };

const meta = (id: string, genres: string[], extra: Partial<MediaItem> = {}): MediaItem => ({
  id,
  type: 'movie',
  name: `Título ${id}`,
  genres,
  releaseInfo: '2020',
  ...extra,
});

function entry(item: MediaItem, state: Partial<LibraryEntry> = {}): LibraryEntry {
  return { meta: item, addonUrl: 'https://cinemeta.example/manifest.json', addedAt: now - DAY, saved: false, ...state };
}

const finished = (item: MediaItem, at = now - DAY) => entry(item, { watchedAt: at, addedAt: at });
const library = (...entries: LibraryEntry[]) => Object.fromEntries(entries.map((value) => [mediaKey(value.meta.type, value.meta.id), value]));
const candidate = (item: MediaItem, extra: Partial<Candidate> = {}): Candidate => ({ ...catalogCandidate(item, 'https://cinemeta.example/manifest.json', 20), ...extra });

function memory() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
}

describe('recommendation signals', () => {
  it('puts genres from every source in one vocabulary', () => {
    expect(canonicalGenres([878, 'Ciencia ficción', 'Sci-Fi'])).toEqual(['Sci-Fi']);
    expect(canonicalGenres([10765, 'Acción y aventura', 'Unknown'])).toEqual(['Sci-Fi', 'Fantasy', 'Action', 'Adventure']);
    expect(canonicalGenres(['Suspense', 'terror'])).toEqual(['Thriller', 'Horror']);
    expect(likesGenre('Documentary')).toBe('te gustan los documentales');
    expect(likesGenre('Drama')).toBe('te gusta el drama');
  });

  it('weighs finishing over starting over saving, and an early drop least', () => {
    const item = meta('tt1', ['Drama']);
    const watched = interactionStrength(entry(item, { watchedAt: now }), now);
    const half = interactionStrength(entry(item, { progress: { videoId: 'tt1', seconds: 3000, duration: 6000, updatedAt: now } }), now);
    const saved = interactionStrength(entry(item, { saved: true }), now);
    const dropped = interactionStrength(entry(item, { progress: { videoId: 'tt1', seconds: 300, duration: 6000, updatedAt: now - 40 * DAY } }), now);
    expect(watched).toBe(1);
    expect(half).toBeLessThan(watched);
    expect(saved).toBeLessThan(half);
    expect(dropped).toBeLessThan(saved);
    // Binging a series counts more with every episode.
    const series = (count: number) =>
      interactionStrength(
        entry(meta('tt2', ['Drama'], { type: 'series' }), {
          videos: Object.fromEntries(Array.from({ length: count }, (_, index) => [`tt2:1:${index + 1}`, { seconds: 1, duration: 1, updatedAt: now, watched: true }])),
        }),
        now,
      );
    expect(series(8)).toBeGreaterThan(series(1));
  });

  it('turns ratings into seeds: likes count most, dislikes are negative, old ones fade', () => {
    const liked = meta('tt3', ['Western']);
    const disliked = meta('tt4', ['Horror']);
    const seeds = seedsFrom(library(finished(meta('tt1', ['Drama']), now - 400 * DAY)), {
      ratings: {
        [mediaKey('movie', 'tt3')]: { value: 'like', at: now, meta: liked },
        [mediaKey('movie', 'tt4')]: { value: 'dislike', at: now, meta: disliked },
      },
      hidden: {},
    }, now);
    expect(seeds.map((seed) => [seed.id, seed.origin])).toEqual([
      ['tt3', 'liked'],
      ['tt4', 'saved'],
      ['tt1', 'played'],
    ]);
    expect(seeds[0].weight).toBeGreaterThan(1.5);
    expect(seeds[1].weight).toBeLessThan(0);
    expect(seeds[2].weight).toBeLessThan(0.5);
  });

  it('values rare genres over ubiquitous ones and learns type and era', () => {
    const seeds = seedsFrom(library(finished(meta('tt1', ['Drama', 'Western'], { releaseInfo: '1968' }))), noTaste, now);
    const pool = [...Array.from({ length: 30 }, () => ({ genres: ['Drama'] })), { genres: ['Western'] }];
    const taste = tasteProfile(seeds, pool);
    expect(taste.genres.get('Western')).toBe(1);
    expect(taste.genres.get('Drama')!).toBeLessThan(0.5);
    expect(taste.types.movie).toBe(1);
    expect(taste.era?.mean).toBe(1968);
  });
});

describe('ranking', () => {
  const seedItem = meta('tt1', ['Sci-Fi'], { cast: ['Ana Actriz'] });
  const seeds = seedsFrom(library(finished(seedItem)), noTaste, now);
  const key = seeds[0].key;

  it('ranks neighbours, matching genres and people first, and explains why', () => {
    const neighbour = candidate(meta('tt10', ['Drama']), { neighbours: { [key]: 0 } });
    const genre = candidate(meta('tt11', ['Sci-Fi']));
    const person = candidate(meta('tt12', ['Comedy'], { cast: ['Ana Actriz'] }));
    const unrelated = candidate(meta('tt13', ['Comedy']));
    const ranked = rank([unrelated, person, genre, neighbour], seeds, tasteProfile(seeds), { now, jitter: 0 });
    expect(ranked.map((item) => item.item.id)).toEqual(['tt10', 'tt11', 'tt12', 'tt13']);
    expect(ranked[0].match).toBe(98);
    expect(ranked[0].match).toBeGreaterThan(ranked[3].match);
    expect(reasonText(ranked[0].reason)).toBe('Porque viste Título tt1');
    expect(reasonText(ranked[1].reason)).toBe('Te gusta la ciencia ficción');
    expect(reasonText(ranked[2].reason)).toBe('Porque te gusta Ana Actriz');
  });

  it('pushes down what resembles a disliked title', () => {
    const disliked = meta('tt2', ['Sci-Fi']);
    const withDislike = seedsFrom(
      library(finished(seedItem)),
      { ratings: { [mediaKey('movie', 'tt2')]: { value: 'dislike', at: now, meta: disliked } }, hidden: {} },
      now,
    );
    const bad = withDislike.find((seed) => seed.id === 'tt2')!.key;
    const near = candidate(meta('tt20', ['Sci-Fi']), { neighbours: { [bad]: 0 } });
    const other = candidate(meta('tt21', ['Sci-Fi']));
    const ranked = rank([near, other], withDislike, tasteProfile(withDislike), { now, jitter: 0 });
    expect(ranked[0].item.id).toBe('tt21');
    expect(ranked[1].parts.negative).toBeGreaterThan(0);
  });

  it('prefers well rated titles with many votes', () => {
    expect(quality(8.5, 20000)).toBeGreaterThan(quality(8.5, 10));
    expect(quality(9.5, 3)).toBeLessThan(quality(8, 5000));
  });

  it('spreads «Elegidos para ti» across genres', () => {
    // Someone who watches science fiction and comedy: neighbours of the first should not fill the row.
    const both = seedsFrom(library(finished(meta('tt1', ['Sci-Fi', 'Comedy']))), noTaste, now);
    const many = [
      ...Array.from({ length: 6 }, (_, index) => candidate(meta(`tt3${index}`, ['Sci-Fi']), { neighbours: { [both[0].key]: index } })),
      candidate(meta('tt40', ['Comedy'])),
    ];
    const ranked = rank(many, both, tasteProfile(both), { now, jitter: 0 });
    expect(ranked.slice(0, 4).map((item) => item.item.id)).not.toContain('tt40');
    expect(diversify(ranked, 4).map((item) => item.item.id)).toContain('tt40');
  });
});

describe('home page', () => {
  const sciFi = Array.from({ length: 60 }, (_, index) =>
    candidate(meta(`tt5${String(index).padStart(2, '0')}`, ['Sci-Fi', index % 2 ? 'Thriller' : 'Adventure'], { background: 'https://img.example/b.jpg', description: 'Sinopsis', releaseInfo: index % 4 === 1 ? '2026' : '2001' }), {
      rating: index % 3 === 0 ? 8.4 : 6.8,
      popularity: index % 3 === 0 ? 0.2 : 0.8,
    }),
  );
  const comedies = Array.from({ length: 6 }, (_, index) => candidate(meta(`tt6${index}`, ['Comedy'])));

  it('builds personalized rows without played, hidden or disliked titles, nor too many repeats', () => {
    const played = meta('tt500', ['Sci-Fi']);
    const lib = library(finished(meta('tt1', ['Sci-Fi', 'Thriller'])), finished(meta('tt2', ['Sci-Fi', 'Adventure'])), finished(played));
    const taste: TasteState = {
      ratings: { [mediaKey('movie', 'tt501')]: { value: 'dislike', at: now, meta: meta('tt501', ['Sci-Fi']) } },
      hidden: { [mediaKey('movie', 'tt502')]: now },
    };
    const page = composeHome([...sciFi, ...comedies], lib, taste, seedsFrom(lib, taste, now), { now, rowSize: 10 });
    const shown = page.rows.flatMap((row) => row.items.map((item) => item.item.id));
    for (const id of ['tt500', 'tt501', 'tt502']) expect(shown).not.toContain(id);
    expect(page.rows[0]).toMatchObject({ id: 'top', title: 'Elegidos para ti' });
    expect(page.rows.map((row) => row.title)).toEqual(
      expect.arrayContaining(['Porque viste Título tt1', 'Porque te gusta la ciencia ficción', 'Joyas ocultas']),
    );
    const counts = new Map<string, number>();
    for (const id of shown) counts.set(id, (counts.get(id) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    expect(page.hero?.item.background).toBeTruthy();
    expect(page.rows[0].items.some((item) => item.key === page.hero!.key)).toBe(false);
    expect(page.rows.every((row) => row.items.length >= 5)).toBe(true);
  });

  it('shows nothing on a cold start', () => {
    expect(composeHome(sciFi, {}, noTaste, [], { now }).rows).toEqual([]);
  });

  it('keeps saved but unplayed titles recommendable', () => {
    const lib = library(entry(meta('tt500', ['Sci-Fi']), { saved: true }));
    expect(excluded(lib, noTaste).size).toBe(0);
  });

  it('lets titles shown many times without being opened give way to fresh ones', () => {
    const seeds = seedsFrom(library(finished(meta('tt1', ['Sci-Fi']))), noTaste, now);
    const worn = candidate(meta('tt70', ['Sci-Fi']), { rating: 8 });
    const fresh = candidate(meta('tt71', ['Sci-Fi']), { rating: 7.6 });
    const order = (fatigue: Record<string, number>) =>
      rank([worn, fresh], seeds, tasteProfile(seeds), { now, jitter: 0, fatigue }).map((item) => item.item.id);
    expect(order({})).toEqual(['tt70', 'tt71']);
    // Three visits are free.
    expect(order({ [mediaKey('movie', 'tt70')]: 3 })).toEqual(['tt70', 'tt71']);
    expect(order({ [mediaKey('movie', 'tt70')]: 6 })).toEqual(['tt71', 'tt70']);
    expect(fatigueFactor(100)).toBe(0.5);
  });

  it('starts from a single «Me gusta» and does not recommend rated titles back', () => {
    const liked = meta('tt80', ['Sci-Fi']);
    const taste: TasteState = { ratings: { [mediaKey('movie', 'tt80')]: { value: 'like', at: now, meta: liked } }, hidden: {} };
    const pool = [candidate(liked), ...Array.from({ length: 12 }, (_, index) => candidate(meta(`tt8${index + 10}`, ['Sci-Fi'])))];
    const page = composeHome(pool, {}, taste, seedsFrom({}, taste, now), { now });
    expect(page.rows[0].items.length).toBeGreaterThanOrEqual(6);
    expect(page.rows.flatMap((row) => row.items).some((item) => item.item.id === 'tt80')).toBe(false);
  });
});

describe('ratings store', () => {
  it('counts one showing per visit and forgets it once the title is opened', () => {
    const store = createTaste(memory());
    const key = mediaKey('movie', 'tt1');
    store.markSeen([key], now);
    store.markSeen([key], now + 60_000);
    expect(store.getSnapshot().seen?.[key].count).toBe(1);
    store.markSeen([key], now + 7 * 60 * 60_000);
    expect(store.getSnapshot().seen?.[key].count).toBe(2);
    store.rate(meta('tt2', ['Drama']), 'like');
    expect(store.getSnapshot().seen?.[key].count).toBe(2);
    store.opened('movie', 'tt1');
    expect(store.getSnapshot().seen?.[key]).toBeUndefined();
  });

  it('rates, toggles and hides per profile, and persists', () => {
    const storage = memory();
    const store = createTaste(storage);
    const item = meta('tt1', ['Drama'], { cast: Array.from({ length: 10 }, (_, index) => `Actor ${index}`) });
    store.hide('movie', 'tt1');
    store.rate(item, 'like');
    // Liking brings a hidden title back.
    expect(store.getSnapshot().hidden).toEqual({});
    expect(store.rating('movie', 'tt1')).toBe('like');
    expect(store.getSnapshot().ratings[mediaKey('movie', 'tt1')].meta.cast).toHaveLength(6);
    expect(createTaste(storage).rating('movie', 'tt1')).toBe('like');
    store.switchProfile('kids-1');
    expect(store.rating('movie', 'tt1')).toBeUndefined();
    store.switchProfile('main');
    store.rate(item, null);
    expect(store.rating('movie', 'tt1')).toBeUndefined();
  });
});

describe('TMDB neighbours', () => {
  it('collects each seed’s related titles, resolves IMDb ids and finds the person to follow', async () => {
    const calls: string[] = [];
    const context: TmdbContext = {
      apiKey: 'k',
      language: 'es-ES',
      library: [],
      fetchJson: async (raw) => {
        const url = new URL(raw);
        calls.push(url.pathname);
        const path = url.pathname.replace('/3', '');
        if (path.startsWith('/find/tt1')) return { movie_results: [{ id: 100 }] };
        if (path.startsWith('/find/tt2')) return { movie_results: [{ id: 200 }] };
        const external = /^\/(movie|tv)\/(\d+)\/external_ids$/.exec(path);
        if (external) return { imdb_id: external[2] === '9' ? null : `tt9${external[2]}` };
        if (path === '/movie/100' || path === '/movie/200')
          return {
            genres: [{ id: 878, name: 'Ciencia ficción' }],
            original_language: 'en',
            credits: { cast: [{ id: 7, name: 'Ana Actriz' }], crew: [{ id: 8, name: 'Dora Directora', job: 'Director' }] },
            recommendations: { results: [{ id: 1, title: 'Uno', genre_ids: [878], vote_average: 8, vote_count: 900 }, { id: 9, title: 'Sin IMDb', genre_ids: [878], vote_count: 500 }, { id: 5, title: 'Casi nadie la vio', genre_ids: [878], vote_count: 3 }] },
            similar: { results: [{ id: 2, title: 'Dos', genre_ids: [878, 53], vote_count: 300 }] },
          };
        if (path === '/person/8/combined_credits')
          return { crew: [{ id: 3, media_type: 'movie', job: 'Director', title: 'Tres', vote_count: 500, genre_ids: [18] }] };
        throw new Error(`Unexpected ${path}`);
      },
    };
    const lib = library(finished(meta('tt1', ['Drama'])), finished(meta('tt2', ['Drama'])));
    const seeds = seedsFrom(lib, noTaste, now);
    const pool = await tmdbPool(seeds, context, 'https://cinemeta.example/manifest.json', new QueryClient(), new Set());
    const one = pool.candidates.find((item) => item.item.id === 'tt91')!;
    expect(one.neighbours).toEqual({ [seeds[0].key]: 0, [seeds[1].key]: 0 });
    expect(pool.candidates.find((item) => item.item.id === 'tt92')!.neighbours![seeds[0].key]).toBe(10);
    expect(pool.candidates.some((item) => item.item.id.startsWith('tmdb:'))).toBe(false);
    // Titles almost nobody rated are left out, before any IMDb lookup.
    expect(pool.candidates.some((item) => item.item.id === 'tt95')).toBe(false);
    expect(calls.some((path) => path.endsWith('/movie/5/external_ids'))).toBe(false);
    expect(pool.seedFeatures[seeds[0].key]).toMatchObject({ genres: ['Sci-Fi'], language: 'en', people: ['Dora Directora', 'Ana Actriz'] });
    expect(Object.keys(pool.personPools)).toEqual(['Dora Directora']);
    expect(pool.personPools['Dora Directora'].map((item) => item.item.id)).toEqual(['tt93']);
  });
});
