import type { CatalogSource, MediaItem } from './contracts';

/**
 * Cinemeta's «Popular» catalogs hold few titles of any one decade, so filtering them by decade in
 * Vela meant loading page after page. Cinemeta also publishes a catalog per year («year», its
 * `genre` extra is the year): for a decade Vela asks for its years at once and merges them by
 * Cinemeta's own popularity.
 */
export type YearCatalogs = { source: CatalogSource; years: string[] };

const CINEMETA = 'com.linvo.cinemeta';
/** Titles per page in Cinemeta's catalogs. */
export const CINEMETA_PAGE = 50;

export function decadeCatalogs(
  sources: CatalogSource[],
  selected: CatalogSource,
  decade: string,
  extra: Record<string, string>,
): YearCatalogs | undefined {
  if (!/^\d{4}$/.test(decade) || selected.addon.manifest.id !== CINEMETA || selected.catalog.id !== 'top') return undefined;
  // The year catalog cannot combine a year with a genre.
  if (Object.values(extra).some(Boolean)) return undefined;
  const source = sources.find(
    (item) => item.addon.manifestUrl === selected.addon.manifestUrl && item.catalog.type === selected.catalog.type && item.catalog.id === 'year',
  );
  const options = source?.catalog.extra?.find((item) => item.name === 'genre')?.options ?? [];
  const from = Number(decade);
  const years = options.filter((option) => /^\d{4}$/.test(option) && Number(option) >= from && Number(option) < from + 10);
  return source && years.length ? { source, years: years.sort().reverse() } : undefined;
}

/** Merges the years' pages, most popular first, without repeating a title. */
export function mergeByPopularity(pages: MediaItem[][]): MediaItem[] {
  const seen = new Set<string>();
  return pages
    .flat()
    .filter((meta) => {
      const key = `${meta.type}:${meta.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((meta, index) => ({ meta, index }))
    .sort((a, b) => (b.meta.popularity ?? 0) - (a.meta.popularity ?? 0) || a.index - b.index)
    .map(({ meta }) => meta);
}
