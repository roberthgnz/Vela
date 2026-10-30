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

  it('looks up films and series by IMDb id', async () => {
    const responses: Record<string, unknown> = {
      '/find/tt1': { movie_results: [{ id: 5, adult: false }], tv_results: [] },
      '/movie/5/release_dates': { results: [{ iso_3166_1: 'ES', release_dates: [{ certification: '18' }] }] },
      '/find/tt2': { movie_results: [], tv_results: [{ id: 9 }] },
      '/tv/9/content_ratings': { results: [{ iso_3166_1: 'US', rating: 'TV-Y7' }] },
      '/find/tt3': { movie_results: [], tv_results: [] },
    };
    const fetchJson = async (path: string) => responses[path];
    expect(await lookupRating('tt1', 'movie', fetchJson)).toEqual({ adult: false, age: 18 });
    expect(await lookupRating('tt2', 'series', fetchJson)).toEqual({ adult: false, age: 7 });
    expect(await lookupRating('tt3', 'movie', fetchJson)).toEqual({ adult: false, age: null });
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
