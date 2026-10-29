import { describe, expect, it } from 'vitest';

import { emptyLayout, homeRows, moveRow, renameRow, toggleRow } from './catalogLayout';
import type { AddonCatalog, CatalogSource, InstalledAddon } from './contracts';
import { createPreferencesStore } from './store';

function source(addonId: string, type: string, id: string, extra?: AddonCatalog['extra']): CatalogSource {
  const addon = { manifestUrl: `https://${addonId}/manifest.json`, manifest: { id: addonId, name: addonId } } as InstalledAddon;
  const catalog = { type, id, name: `${addonId} ${id}`, extra } as AddonCatalog;
  return { key: JSON.stringify([addon.manifestUrl, type, id]), addon, catalog };
}

const other = source('other', 'movie', 'top');
const cinemetaMovie = source('com.linvo.cinemeta', 'movie', 'top');
const cinemetaSeries = source('com.linvo.cinemeta', 'series', 'top');
const searchOnly = source('other', 'movie', 'search', [{ name: 'search', isRequired: true }]);
const extras = Array.from({ length: 10 }, (_, index) => source('more', 'movie', `c${index}`));
const sources = [other, cinemetaMovie, cinemetaSeries, searchOnly, ...extras];

describe('home catalog layout', () => {
  it('puts Cinemeta first, skips catalogs that need extras and shows ten rows by default', () => {
    const rows = homeRows(sources, emptyLayout);
    expect(rows.slice(0, 3).map((row) => row.title)).toEqual(['Películas populares', 'Series populares', 'other top']);
    expect(rows.map((row) => row.source)).not.toContain(searchOnly);
    expect(rows.filter((row) => row.visible)).toHaveLength(10);
    expect(rows.slice(0, 3).map((row) => row.browse)).toEqual(['movie', 'series', 'movie']);
    expect(homeRows([source('tv', 'tv', 'live')], emptyLayout)[0].browse).toBeUndefined();
  });

  it('moves, hides and renames rows, keeping new catalogs at the end', () => {
    let rows = homeRows(sources, emptyLayout);
    let layout = moveRow(rows, emptyLayout, other.key, -1);
    layout = toggleRow(layout, rows[12]);
    layout = renameRow(layout, cinemetaSeries.key, '  Mis series  ');
    rows = homeRows([...sources, source('new', 'series', 'x')], layout);
    expect(rows.slice(0, 3).map((row) => row.title)).toEqual(['Películas populares', 'other top', 'Mis series']);
    expect(rows[12].visible).toBe(true);
    expect(rows.at(-1)?.source.addon.manifest.id).toBe('new');
    expect(renameRow(layout, cinemetaSeries.key, ' ').names).toEqual({});
  });

  it('keeps a layout per profile', () => {
    const values = new Map<string, string>();
    const store = createPreferencesStore({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    });
    store.setCatalogLayout({ order: ['a', 'a'], hidden: { b: true, c: 'yes' as unknown as boolean }, names: { c: ' Nombre ' } });
    expect(store.getSnapshot().catalogs).toEqual({ order: ['a'], hidden: { b: true }, names: { c: 'Nombre' } });
    store.switchProfile('kid');
    expect(store.getSnapshot().catalogs).toEqual(emptyLayout);
  });
});
