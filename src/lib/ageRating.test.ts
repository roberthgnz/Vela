import { describe, expect, it } from 'vitest';

import { certificationAge, fitsLimit, lookupRating, pickAge } from './ageRating';

describe('age ratings', () => {
  it('reads Spanish, US and numeric certifications', () => {
    expect(certificationAge('A')).toBe(0);
    expect(certificationAge('12')).toBe(12);
    expect(certificationAge(' 16 ')).toBe(16);
    expect(certificationAge('PG-13')).toBe(13);
    expect(certificationAge('TV-MA')).toBe(17);
    expect(certificationAge('FSK 16')).toBe(16);
    expect(certificationAge('')).toBeNull();
    expect(certificationAge('Unrated')).toBeNull();
  });

  it('prefers Spain, then the US, then the strictest other rating', () => {
    expect(pickAge([{ country: 'US', certifications: ['R'] }, { country: 'ES', certifications: ['', '16'] }])).toBe(16);
    expect(pickAge([{ country: 'GB', certifications: ['15'] }, { country: 'US', certifications: ['PG-13'] }])).toBe(13);
    expect(pickAge([{ country: 'GB', certifications: ['12A', '15'] }, { country: 'DE', certifications: ['12'] }])).toBe(15);
    expect(pickAge([{ country: 'ES', certifications: [''] }])).toBeNull();
  });

  it('looks up a title in one request with its TMDB id, or searches by IMDb id', async () => {
    const responses: Record<string, unknown> = {
      '/movie/5': { adult: false, release_dates: { results: [{ iso_3166_1: 'ES', release_dates: [{ certification: '18' }] }] } },
      '/find/tt2': { movie_results: [], tv_results: [{ id: 9 }] },
      '/tv/9': { adult: true, content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-Y7' }] } },
      '/find/tt3': { movie_results: [], tv_results: [] },
    };
    const paths: string[] = [];
    const fetchJson = async (path: string, params?: Record<string, string>) => {
      paths.push(`${path}${params?.append_to_response ? `+${params.append_to_response}` : ''}`);
      return responses[path];
    };
    expect(await lookupRating({ id: 'tt1', type: 'movie', tmdbId: 5 }, fetchJson)).toEqual({ adult: false, age: 18 });
    expect(paths).toEqual(['/movie/5+release_dates']);
    expect(await lookupRating({ id: 'tt2', type: 'series' }, fetchJson)).toEqual({ adult: true, age: 7 });
    expect(paths.slice(1)).toEqual(['/find/tt2', '/tv/9+content_ratings']);
    expect(await lookupRating({ id: 'tt3', type: 'movie' }, fetchJson)).toEqual({ adult: false, age: null });
  });

  it('applies a profile limit', () => {
    expect(fitsLimit({ adult: false, age: 16 }, {})).toBe(true);
    expect(fitsLimit({ adult: true, age: null }, {})).toBe(false);
    expect(fitsLimit({ adult: false, age: 16 }, { maxAge: 12 })).toBe(false);
    expect(fitsLimit({ adult: false, age: 12 }, { maxAge: 12 })).toBe(true);
    expect(fitsLimit({ adult: false, age: null }, { maxAge: 12 })).toBe(true);
    expect(fitsLimit({ adult: false, age: null }, { maxAge: 12, hideUnrated: true })).toBe(false);
  });
});
