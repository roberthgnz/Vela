import type { MediaItem } from './contracts';

/**
 * Filters for search results and catalogs. Catalogs only take their own extras (genre, search…),
 * so these narrow and order the titles already loaded, in Vela. The search offers no rating
 * filter: Cinemeta's search results carry no rating.
 */
export type SearchFilters = {
  type: 'all' | 'movie' | 'series';
  /** First year of a decade (`'2020'`), `'older'` (before 1980) or `''` for any year. */
  decade: string;
  /** Minimum IMDb rating; 0 for any. */
  rating: number;
  sort: 'relevance' | 'newest' | 'oldest' | 'rating';
};

export const noSearchFilters: SearchFilters = { type: 'all', decade: '', rating: 0, sort: 'relevance' };

export const decades = ['2020', '2010', '2000', '1990', '1980'] as const;

export function activeFilters(filters: SearchFilters): number {
  return (
    Number(filters.type !== 'all') +
    Number(Boolean(filters.decade)) +
    Number(filters.rating > 0) +
    Number(filters.sort !== 'relevance')
  );
}

/** The year a title came out (or a series started), from `releaseInfo` («2008–2013») or `released`. */
export function startYear(meta: MediaItem): number | undefined {
  const match = /\d{4}/.exec(meta.releaseInfo || meta.released || '');
  return match ? Number(match[0]) : undefined;
}

function rating(meta: MediaItem): number {
  const value = Number.parseFloat(meta.imdbRating ?? '');
  return Number.isFinite(value) ? value : 0;
}

export function applySearchFilters<T extends { meta: MediaItem }>(items: T[], filters: SearchFilters): T[] {
  const result = items.filter(({ meta }) => {
    if (filters.type !== 'all' && meta.type !== filters.type) return false;
    if (filters.rating && rating(meta) < filters.rating) return false;
    if (filters.decade) {
      const year = startYear(meta);
      if (year === undefined) return false;
      if (filters.decade === 'older') return year < 1980;
      const from = Number(filters.decade);
      return year >= from && year < from + 10;
    }
    return true;
  });
  // Stable sorts keep the catalogs' relevance order among equals; titles without a year go last.
  if (filters.sort === 'rating') result.sort((a, b) => rating(b.meta) - rating(a.meta));
  else if (filters.sort !== 'relevance') {
    const direction = filters.sort === 'newest' ? -1 : 1;
    result.sort((a, b) => {
      const first = startYear(a.meta);
      const second = startYear(b.meta);
      if (first === undefined || second === undefined) return Number(first === undefined) - Number(second === undefined);
      return (first - second) * direction;
    });
  }
  return result;
}
