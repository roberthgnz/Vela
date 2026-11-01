import { describe, expect, it } from 'vitest';

import { configureUrl, filterCommunityAddons, parseCommunityCatalog } from './communityAddons';

function descriptor(id: string, manifest: Record<string, unknown> = {}, transportUrl = `https://${id}.example.com/manifest.json`) {
  return {
    transportUrl,
    transportName: 'http',
    manifest: { id, name: id, version: '1.0.0', types: ['movie'], resources: ['stream'], catalogs: [], ...manifest },
  };
}

describe('community addon catalog', () => {
  it('reads addons and their hints from an addon_catalog response', () => {
    const [addon] = parseCommunityCatalog({
      addons: [
        descriptor('torrentio', {
          name: 'Torrentio',
          description: 'Torrent streams',
          logo: 'https://torrentio.example.com/logo.png',
          types: ['movie', 'series'],
          resources: ['stream', { name: 'meta', types: ['movie'] }, 'addon_catalog'],
          behaviorHints: { configurable: true, p2p: true },
        }),
      ],
    });
    expect(addon).toEqual({
      manifestUrl: 'https://torrentio.example.com/manifest.json',
      id: 'torrentio',
      name: 'Torrentio',
      version: '1.0.0',
      description: 'Torrent streams',
      logo: 'https://torrentio.example.com/logo.png',
      types: ['movie', 'series'],
      capabilities: ['stream', 'meta'],
      configurable: true,
      configurationRequired: false,
      adult: false,
      p2p: true,
    });
  });

  it('leaves out entries that are not usable HTTP addons and repeated addresses', () => {
    const addons = parseCommunityCatalog({
      addons: [
        descriptor('one'),
        descriptor('one'),
        descriptor('ftp', {}, 'ftp://ftp.example.com/manifest.json'),
        { transportUrl: 'https://nameless.example.com/manifest.json', manifest: { id: 'nameless' } },
        { ...descriptor('ipfs'), transportName: 'ipfs' },
        'junk',
        descriptor('folder', {}, 'https://folder.example.com/addon'),
      ],
    });
    expect(addons.map((addon) => addon.manifestUrl)).toEqual([
      'https://one.example.com/manifest.json',
      'https://folder.example.com/addon/manifest.json',
    ]);
    expect(() => parseCommunityCatalog({})).toThrow();
  });

  it('marks addons that must be set up first as configurable', () => {
    const [addon] = parseCommunityCatalog({ addons: [descriptor('debrid', { behaviorHints: { configurationRequired: true } })] });
    expect(addon).toMatchObject({ configurable: true, configurationRequired: true });
  });

  it('finds the setup page next to the manifest', () => {
    expect(configureUrl('https://addon.example.com/some/path/manifest.json')).toBe('https://addon.example.com/some/path/configure');
    expect(configureUrl('https://addon.example.com/manifest.json')).toBe('https://addon.example.com/configure');
  });

  it('filters by words, feature and adult content', () => {
    const addons = parseCommunityCatalog({
      addons: [
        descriptor('subs', { name: 'Subtítulos Latinos', resources: ['subtitles'] }),
        descriptor('streams', { name: 'Streams', description: 'Películas en español' }),
        descriptor('adult', { name: 'Adult streams', behaviorHints: { adult: true } }),
      ],
    });
    const names = (list: typeof addons) => list.map((addon) => addon.name);
    expect(names(filterCommunityAddons(addons, {}))).toEqual(['Subtítulos Latinos', 'Streams']);
    expect(names(filterCommunityAddons(addons, { adult: true }))).toHaveLength(3);
    expect(names(filterCommunityAddons(addons, { query: 'subtitulos' }))).toEqual(['Subtítulos Latinos']);
    expect(names(filterCommunityAddons(addons, { query: 'PELICULAS espanol' }))).toEqual(['Streams']);
    expect(names(filterCommunityAddons(addons, { query: 'example.com', capability: 'stream' }))).toEqual(['Streams']);
  });
});
