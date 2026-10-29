import { describe, expect, it } from 'vitest';

import { kidsCatalog, region, tmdbCatalog, TMDB_CATALOGS_URL, tmdbCatalogsManifest, type TmdbContext } from './tmdbCatalogs';

/** Fake TMDB: lists ids 1–3 (3 has no IMDb id) and records every request. */
function fake(library: TmdbContext['library'] = []) {
  const calls: URL[] = [];
  const context: TmdbContext = {
    apiKey: 'k',
    language: 'es-MX',
    library,
    fetchJson: async (raw) => {
      const url = new URL(raw);
      calls.push(url);
      const external = /\/(movie|tv)\/(\d+)\/external_ids$/.exec(url.pathname);
      if (external) return { imdb_id: external[2] === '3' ? null : `tt000000${external[2]}` };
      if (url.pathname.startsWith('/3/find/')) return { movie_results: [{ id: 50 }], tv_results: [{ id: 60 }] };
      if (/\/recommendations$/.test(url.pathname)) return { results: [{ id: 1, title: 'Uno' }, { id: 2, title: 'Dos' }] };
      return {
        results: [
          { id: 1, title: 'Uno', poster_path: '/a.jpg', release_date: '2024-05-01', vote_average: 7.25 },
          { id: 2, name: 'Dos', first_air_date: '2023-01-01' },
          { id: 3, title: 'Sin IMDb' },
        ],
      };
    },
  };
  return { calls, context };
}

describe('tmdb catalogs', () => {
  it('turns results into catalog items with IMDb ids and drops titles without one', async () => {
    const { context, calls } = fake();
    const items = await tmdbCatalog('trending', 'movie', {}, context);
    expect(items.map((item) => [item.id, item.name, item.releaseInfo])).toEqual([['tt0000001', 'Uno', '2024'], ['tt0000002', 'Dos', '2023']]);
    expect(items[0]).toMatchObject({ type: 'movie', poster: 'https://image.tmdb.org/t/p/w342/a.jpg', imdbRating: '7.3' });
    expect(calls[0].pathname).toBe('/3/trending/movie/week');
    expect(calls[0].searchParams.get('language')).toBe('es-MX');
  });

  it('asks for a streaming service in the language region, with genre and page', async () => {
    const { context, calls } = fake();
    await tmdbCatalog('provider-8', 'series', { genre: 'Animación', skip: '40' }, context);
    const params = calls[0].searchParams;
    expect(calls[0].pathname).toBe('/3/discover/tv');
    expect([params.get('with_watch_providers'), params.get('watch_region'), params.get('with_genres'), params.get('page')]).toEqual(['8', 'MX', '16', '3']);
    expect(region('es-ES')).toBe('ES');
    expect(region('')).toBe('US');
  });

  it('recommends from the library and leaves out what is already there', async () => {
    const { context } = fake([{ id: 'tt0000001', type: 'movie' }, { id: 'tt9', type: 'series' }]);
    const items = await tmdbCatalog('recommended', 'movie', {}, context);
    expect(items.map((item) => item.id)).toEqual(['tt0000002']);
    expect(await tmdbCatalog('recommended', 'movie', {}, fake().context)).toEqual([]);
  });

  it('restricts the children catalogs and recognizes them', async () => {
    const { context, calls } = fake();
    await tmdbCatalog('kids', 'movie', {}, context);
    await tmdbCatalog('kids', 'series', {}, context);
    const [movies, series] = calls.filter((url) => url.pathname.includes('/discover/'));
    expect([movies.searchParams.get('certification.lte'), movies.searchParams.get('include_adult')]).toEqual(['G', 'false']);
    expect(series.searchParams.get('with_genres')).toBe('10762');
    const addon = { manifestUrl: TMDB_CATALOGS_URL, manifest: tmdbCatalogsManifest };
    expect(kidsCatalog({ addon, catalog: { id: 'kids' } })).toBe(true);
    expect(kidsCatalog({ addon, catalog: { id: 'trending' } })).toBe(false);
    expect(kidsCatalog({ addon: { ...addon, manifestUrl: 'https://x/manifest.json' }, catalog: { id: 'kids' } })).toBe(false);
  });
});
