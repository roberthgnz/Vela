import { afterEach, describe, expect, it } from 'vitest';

import type { InstalledAddon } from './contracts';
import { getCatalogSources, setAddonFilter } from './protocol';

function addon(id: string, adult?: boolean): InstalledAddon {
  return {
    manifestUrl: `https://${id}/manifest.json`,
    enabled: true,
    installedAt: 0,
    manifest: {
      id,
      name: id,
      version: '1.0.0',
      resources: ['catalog'],
      types: ['movie'],
      catalogs: [{ type: 'movie', id: 'top', name: 'Top' }],
      ...(adult ? { behaviorHints: { adult: true } } : {}),
    },
  };
}

describe('adult addons', () => {
  afterEach(() => setAddonFilter(() => true));

  it('leaves out the catalogs of addons the profile may not see', () => {
    const addons = [addon('family'), addon('adult', true)];
    expect(getCatalogSources(addons)).toHaveLength(2);
    setAddonFilter((item) => !item.manifest.behaviorHints?.adult);
    expect(getCatalogSources(addons).map((source) => source.addon.manifest.id)).toEqual(['family']);
  });
});
