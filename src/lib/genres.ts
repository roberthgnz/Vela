import type { CatalogSource } from './contracts';
import { browsable, catalogFilters } from './protocol';

/**
 * TMDB's Spanish genre names (shown when the details are translated) and the English names that
 * catalogs such as Cinemeta offer as filters.
 */
const translations: Record<string, string[]> = {
  acción: ['Action'],
  aventura: ['Adventure'],
  'action & adventure': ['Action', 'Adventure'],
  animación: ['Animation'],
  comedia: ['Comedy'],
  crimen: ['Crime'],
  documental: ['Documentary'],
  familia: ['Family'],
  fantasía: ['Fantasy'],
  historia: ['History'],
  terror: ['Horror'],
  música: ['Music'],
  misterio: ['Mystery'],
  'ciencia ficción': ['Sci-Fi'],
  'sci-fi & fantasy': ['Sci-Fi', 'Fantasy'],
  suspense: ['Thriller'],
  bélica: ['War'],
  'war & politics': ['War'],
  reality: ['Reality-TV'],
  talk: ['Talk-Show'],
};

const lower = (value: string) => value.toLocaleLowerCase('es');

export type GenreTarget = { source: CatalogSource; value: string };

/** The catalog (Cinemeta first) that can list titles of a genre, and the filter option to pick. */
export function genreTarget(sources: CatalogSource[], genre: string): GenreTarget | undefined {
  const wanted = new Set([genre, ...(translations[lower(genre)] ?? [])].map(lower));
  const ordered = sources
    .filter((source) => browsable(source.catalog))
    .sort(
      (a, b) =>
        Number(b.addon.manifest.id === 'com.linvo.cinemeta') - Number(a.addon.manifest.id === 'com.linvo.cinemeta'),
    );
  for (const source of ordered) {
    const filter = catalogFilters(source.catalog).find((item) => item.name === 'genre');
    const value = filter?.options.find((option) => wanted.has(lower(option)));
    if (value) return { source, value };
  }
  return undefined;
}
