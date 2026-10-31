import type { CatalogLayout, CatalogSource } from './contracts';
import { t } from './i18n';

/** Rows shown on Home until the user arranges them (Cinemeta's two plus eight more). */
export const DEFAULT_HOME_ROWS = 10;

export const emptyLayout: CatalogLayout = { order: [], hidden: {}, names: {} };

export type HomeRow = {
  source: CatalogSource;
  /** Name shown on Home: the user's, or Vela's default. */
  title: string;
  /** Name the row has without a custom one. */
  defaultTitle: string;
  visible: boolean;
  /** Movie and series rows open their catalog in the movies or series section («Ver todo»). */
  browse?: 'movie' | 'series';
};

/** Catalogs that Home can show: those that need no required extra (genre, search…). */
export function homeSources(sources: CatalogSource[]): CatalogSource[] {
  return sources.filter((source) => !source.catalog.extra?.some((extra) => extra.isRequired) && !source.catalog.extraRequired?.length);
}

/** The name a catalog shows everywhere, honouring the user's rename. */
export function catalogTitle(source: CatalogSource, layout: CatalogLayout, fallback = source.catalog.name): string {
  return layout.names[source.key]?.trim() || fallback;
}

/**
 * Every Home-eligible catalog in display order. Without a layout, Cinemeta's popular movies and
 * series come first, then the other catalogs in addon order, and only the first ten are visible.
 * Arranged catalogs keep their place; new ones are appended in default order.
 */
export function homeRows(sources: CatalogSource[], layout: CatalogLayout): HomeRow[] {
  const eligible = homeSources(sources);
  const cinemeta = eligible.filter((source) => source.addon.manifest.id === 'com.linvo.cinemeta');
  const movie = cinemeta.find((source) => source.catalog.type === 'movie') ?? eligible.find((source) => source.catalog.type === 'movie');
  const series = cinemeta.find((source) => source.catalog.type === 'series') ?? eligible.find((source) => source.catalog.type === 'series');
  const defaults = [movie, series, ...eligible.filter((source) => source !== movie && source !== series)].filter(
    (source): source is CatalogSource => Boolean(source),
  );
  const rank = new Map(layout.order.map((key, index) => [key, index]));
  const ordered = defaults
    .map((source, index) => ({ source, index }))
    .sort((a, b) => (rank.get(a.source.key) ?? Infinity) - (rank.get(b.source.key) ?? Infinity) || a.index - b.index);
  return ordered.map(({ source, index }) => {
    const type = source.catalog.type;
    const browse = type === 'movie' || type === 'series' ? type : undefined;
    // «Populares» describes Cinemeta's top catalogs; any other addon keeps its own catalog name.
    const popular = (source === movie || source === series) && source.addon.manifest.id === 'com.linvo.cinemeta';
    const defaultTitle = popular ? (type === 'movie' ? t('lib.catalogLayout.popularMovies') : t('lib.catalogLayout.popularSeries')) : source.catalog.name;
    const hidden = layout.hidden[source.key];
    return {
      source,
      title: catalogTitle(source, layout, defaultTitle),
      defaultTitle,
      visible: hidden === undefined ? index < DEFAULT_HOME_ROWS : !hidden,
      browse,
    };
  });
}

/** Moves a row one place up or down, writing the full order so later catalogs stay below it. */
export function moveRow(rows: HomeRow[], layout: CatalogLayout, key: string, step: -1 | 1): CatalogLayout {
  const order = rows.map((row) => row.source.key);
  const from = order.indexOf(key);
  const to = from + step;
  if (from < 0 || to < 0 || to >= order.length) return layout;
  [order[from], order[to]] = [order[to], order[from]];
  return { ...layout, order };
}

/** Shows or hides a row; its current visibility is frozen so the default limit no longer applies. */
export function toggleRow(layout: CatalogLayout, row: HomeRow): CatalogLayout {
  return { ...layout, hidden: { ...layout.hidden, [row.source.key]: row.visible } };
}

export function renameRow(layout: CatalogLayout, key: string, name: string): CatalogLayout {
  const names = { ...layout.names };
  if (name.trim()) names[key] = name.trim();
  else delete names[key];
  return { ...layout, names };
}
