import { describe, expect, it, vi } from 'vitest';

vi.mock('./transport', () => ({ requestJson: vi.fn(), getSecret: vi.fn(), setSecret: vi.fn(), deleteSecret: vi.fn() }));

import type { MediaItem } from './contracts';
import { applyTranslation, translate, validTmdbKey } from './tmdb';

const key = '0123456789abcdef0123456789abcdef';
const series: MediaItem = {
  id: 'tt0903747', type: 'series', name: 'Breaking Bad', description: 'English synopsis', genres: ['Drama'],
  videos: [
    { id: 'tt0903747:1:1', season: 1, episode: 1, title: 'Pilot', overview: 'English pilot' },
    { id: 'tt0903747:1:2', season: 1, episode: 2, title: "Cat's in the Bag..." },
    { id: 'tt0903747:2:1', season: 2, episode: 1, title: 'Seven Thirty-Seven' },
  ],
};

function api(responses: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchJson = async (url: string) => {
    calls.push(url);
    const path = new URL(url).pathname.replace('/3', '');
    if (!(path in responses)) throw new Error('El addon respondió con HTTP 404.');
    return responses[path];
  };
  return { calls, fetchJson };
}

describe('TMDB translation', () => {
  it('accepts only v3 API keys', () => {
    expect(validTmdbKey(` ${key} `)).toBe(true);
    expect(validTmdbKey('eyJhbGciOiJIUzI1NiJ9.token')).toBe(false);
  });

  it('finds the title by IMDb id and translates details and episodes in the chosen language', async () => {
    const { calls, fetchJson } = api({
      '/find/tt0903747': { tv_results: [{ id: 1396 }] },
      '/tv/1396': { name: 'Breaking Bad', overview: 'Un profesor de química…', genres: [{ name: 'Drama' }, { name: 'Crimen' }] },
      '/tv/1396/season/1': { episodes: [{ episode_number: 1, name: 'Piloto', overview: 'Walter recibe…' }, { episode_number: 2, name: 'Episodio 2', overview: '' }] },
    });
    const translation = await translate(series, 'es-ES', key, fetchJson);
    expect(calls[0]).toBe(`https://api.themoviedb.org/3/find/tt0903747?external_source=imdb_id&language=es-ES&api_key=${key}`);
    expect(calls.some((url) => url.includes('/tv/1396/season/2'))).toBe(true);
    const translated = applyTranslation(series, translation);
    expect(translated).toMatchObject({ name: 'Breaking Bad', description: 'Un profesor de química…', genres: ['Drama', 'Crimen'] });
    // Untranslated or missing episodes keep the addon's text.
    expect(translated.videos?.map((video) => [video.title, video.overview])).toEqual([
      ['Piloto', 'Walter recibe…'],
      ["Cat's in the Bag...", undefined],
      ['Seven Thirty-Seven', undefined],
    ]);
  });

  it('uses movie results for films and ignores ids TMDB cannot find', async () => {
    const { fetchJson } = api({
      '/find/tt0120791': { movie_results: [{ id: 6435 }] },
      '/movie/6435': { title: 'Prácticamente magia', overview: '' },
    });
    const movie: MediaItem = { id: 'tt0120791', type: 'movie', name: 'Practical Magic', description: 'Two witch sisters' };
    expect(applyTranslation(movie, await translate(movie, 'es-ES', key, fetchJson))).toMatchObject({ name: 'Prácticamente magia', description: 'Two witch sisters' });
    expect(await translate({ ...movie, id: 'tt0000001' }, 'es-ES', key, api({ '/find/tt0000001': {} }).fetchJson)).toBeNull();
    expect(await translate({ ...movie, id: 'vela:sintel' }, 'es-ES', key, fetchJson)).toBeNull();
  });
});
