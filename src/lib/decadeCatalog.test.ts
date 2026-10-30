import { describe, expect, it } from 'vitest';

import type { AddonCatalog, CatalogSource, InstalledAddon, MediaItem } from './contracts';
import { decadeCatalogs, mergeByPopularity } from './decadeCatalog';

const addon = { manifestUrl: 'https://v3-cinemeta.strem.io/manifest.json', manifest: { id: 'com.linvo.cinemeta', name: 'Cinemeta' } } as InstalledAddon;
const other = { manifestUrl: 'https://other/manifest.json', manifest: { id: 'other', name: 'Other' } } as InstalledAddon;
const source = (owner: InstalledAddon, id: string, extra: AddonCatalog['extra'] = []): CatalogSource => ({
  key: `${owner.manifestUrl}|movie|${id}`,
  addon: owner,
  catalog: { type: 'movie', id, name: id, extra },
});
const top = source(addon, 'top', [{ name: 'genre', options: ['Action'] }]);
const year = source(addon, 'year', [{ name: 'genre', isRequired: true, options: ['2026', '1989', '1985', '1980', '1979'] }]);

describe('decade catalogs', () => {
  it("uses Cinemeta's year catalogs for a decade of its popular catalog", () => {
    expect(decadeCatalogs([top, year], top, '1980', {})).toEqual({ source: year, years: ['1989', '1985', '1980'] });
  });

  it('keeps filtering in Vela otherwise', () => {
    expect(decadeCatalogs([top, year], top, 'older', {})).toBeUndefined();
    expect(decadeCatalogs([top, year], top, '1980', { genre: 'Action' })).toBeUndefined();
    expect(decadeCatalogs([top, year], top, '1990', {})).toBeUndefined();
    const foreign = source(other, 'top');
    expect(decadeCatalogs([foreign, year], foreign, '1980', {})).toBeUndefined();
  });

  it('merges the years by popularity without repeats', () => {
    const meta = (id: string, popularity?: number) => ({ id, type: 'movie', name: id, popularity }) as MediaItem;
    const merged = mergeByPopularity([[meta('a', 0.2), meta('b', 0.9)], [meta('c'), meta('a', 0.2), meta('d', 0.5)]]);
    expect(merged.map((item) => item.id)).toEqual(['b', 'd', 'a', 'c']);
  });
});
