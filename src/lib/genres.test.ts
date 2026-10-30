import { describe, expect, it } from 'vitest';

import type { AddonCatalog, CatalogSource, InstalledAddon } from './contracts';
import { genreTarget } from './genres';

function source(addonId: string, id: string, genres?: string[]): CatalogSource {
  const addon = { manifestUrl: `https://${addonId}/manifest.json`, manifest: { id: addonId, name: addonId } } as InstalledAddon;
  const catalog = { type: 'movie', id, name: id, extra: genres ? [{ name: 'genre', options: genres }] : [] } as AddonCatalog;
  return { key: JSON.stringify([addon.manifestUrl, 'movie', id]), addon, catalog };
}

const other = source('other', 'top', ['Horror', 'Drama']);
const cinemeta = source('com.linvo.cinemeta', 'top', ['Action', 'Horror', 'Sci-Fi']);
const plain = source('plain', 'list');

describe('genre links', () => {
  it('prefers Cinemeta and matches names regardless of case', () => {
    expect(genreTarget([other, plain, cinemeta], 'horror')).toEqual({ source: cinemeta, value: 'Horror' });
    expect(genreTarget([other, cinemeta], 'Drama')).toEqual({ source: other, value: 'Drama' });
  });

  it('maps the Spanish names of translated details', () => {
    expect(genreTarget([cinemeta], 'Ciencia ficción')?.value).toBe('Sci-Fi');
    expect(genreTarget([cinemeta], 'Action & Adventure')?.value).toBe('Action');
  });

  it('finds nothing when no catalog offers the genre', () => {
    expect(genreTarget([plain, cinemeta], 'Western')).toBeUndefined();
  });
});
