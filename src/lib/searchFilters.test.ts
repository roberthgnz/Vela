import { describe, expect, it } from 'vitest';

import type { MediaItem } from './contracts';
import { activeFilters, applySearchFilters, noSearchFilters, startYear } from './searchFilters';

const item = (id: string, type: 'movie' | 'series', releaseInfo: string, imdbRating?: string) => ({
  meta: { id, type, name: id, releaseInfo, imdbRating } as MediaItem,
});

const results = [
  item('a', 'movie', '1999', '8.7'),
  item('b', 'series', '2008–2013', '9.5'),
  item('c', 'movie', '2023', '6.1'),
  item('d', 'movie', ''),
  item('e', 'series', '1975', '7.9'),
];
const ids = (list: { meta: MediaItem }[]) => list.map(({ meta }) => meta.id);

describe('search filters', () => {
  it('reads the first year of a release', () => {
    expect(startYear(results[1].meta)).toBe(2008);
    expect(startYear(results[3].meta)).toBeUndefined();
  });

  it('keeps everything in relevance order without filters', () => {
    expect(ids(applySearchFilters(results, noSearchFilters))).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(activeFilters(noSearchFilters)).toBe(0);
  });

  it('filters by type and decade', () => {
    expect(ids(applySearchFilters(results, { ...noSearchFilters, type: 'movie' }))).toEqual(['a', 'c', 'd']);
    expect(ids(applySearchFilters(results, { ...noSearchFilters, decade: '2000' }))).toEqual(['b']);
    expect(ids(applySearchFilters(results, { ...noSearchFilters, decade: 'older' }))).toEqual(['e']);
    expect(activeFilters({ ...noSearchFilters, type: 'movie', decade: '1990' })).toBe(2);
  });

  it('filters and orders by rating, unrated titles last', () => {
    expect(ids(applySearchFilters(results, { ...noSearchFilters, rating: 8 }))).toEqual(['a', 'b']);
    expect(ids(applySearchFilters(results, { ...noSearchFilters, sort: 'rating' }))).toEqual(['b', 'a', 'e', 'c', 'd']);
  });

  it('orders by year, with undated titles last', () => {
    expect(ids(applySearchFilters(results, { ...noSearchFilters, sort: 'newest' }))).toEqual(['c', 'b', 'a', 'e', 'd']);
    expect(ids(applySearchFilters(results, { ...noSearchFilters, sort: 'oldest' }))).toEqual(['e', 'a', 'b', 'c', 'd']);
  });
});
