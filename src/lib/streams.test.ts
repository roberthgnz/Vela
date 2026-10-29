import { describe, expect, it } from 'vitest';
import { languageOfFlag, regionCode, streamDetail, streamFacts, streamLanguages, streamTags } from './streams';
import type { ResolvedStream } from './contracts';
import { qualityTier, sortSources } from './streams';

const torrentio = {
  addonName: 'Torrentio',
  addonUrl: 'https://torrentio.strem.fun/manifest.json',
  name: 'Torrentio\n1080p',
  infoHash: 'a'.repeat(40),
  title: 'Breaking.Bad.S01.1080p.BluRay.x265-RARBG\nBreaking.Bad.S01E01.1080p.BluRay.x265.mkv\n👤 43 💾 927.02 MB ⚙️ ThePirateBay\nMulti Audio / 🇬🇧 / 🇪🇸 / 🇲🇽',
};

describe('stream presentation', () => {
  it('reads audio languages from country flags', () => {
    expect(regionCode('🇪🇸')).toBe('ES');
    expect(streamLanguages(torrentio).map((language) => [language.code, language.label])).toEqual([
      ['GB', 'Inglés'], ['ES', 'Español (España)'], ['MX', 'Español (Latinoamérica)'],
    ]);
    expect(languageOfFlag('🇨🇭').label).toBe('Suiza');
  });

  it('extracts seeders, provider and multi-audio notes', () => {
    expect(streamFacts(torrentio)).toEqual({ seeders: 43, provider: 'ThePirateBay', multiAudio: true });
    expect(streamFacts({ ...torrentio, title: 'Plain file' })).toEqual({ seeders: undefined, provider: undefined, multiAudio: false });
  });

  it('keeps file names in the description and moves metadata to tags', () => {
    expect(streamDetail(torrentio)).toEqual(['Breaking.Bad.S01.1080p.BluRay.x265-RARBG', 'Breaking.Bad.S01E01.1080p.BluRay.x265.mkv']);
    expect(streamTags(torrentio)).toEqual(['HEVC', 'MKV', '927.02 MB']);
  });
});

describe('source order and quality', () => {
  const s = (name: string, title: string): ResolvedStream => ({ name, title, url: `https://x.example/${name}`, addonName: 'A', addonUrl: 'https://a.example/manifest.json' });
  const list = [
    s('Torrentio 4k', 'Film.2160p.mkv\n👤 30 💾 6.28 GB'),
    s('Torrentio 1080p', 'Film.1080p.mkv\n👤 416 💾 4.82 GB'),
    s('Torrentio 720p', 'Film.720p.mkv\n💾 900 MB'),
    s('Other', 'No details'),
  ];

  it('groups resolutions', () => {
    expect(list.map(qualityTier)).toEqual(['4K', '1080p', '720p', '?']);
  });

  it('sorts by seeders or size and keeps unknown values last in addon order', () => {
    expect(sortSources(list, 'seeders').map((item) => item.name)).toEqual(['Torrentio 1080p', 'Torrentio 4k', 'Torrentio 720p', 'Other']);
    expect(sortSources(list, 'largest').map((item) => item.name)).toEqual(['Torrentio 4k', 'Torrentio 1080p', 'Torrentio 720p', 'Other']);
    expect(sortSources(list, 'smallest').map((item) => item.name)).toEqual(['Torrentio 720p', 'Torrentio 1080p', 'Torrentio 4k', 'Other']);
    expect(sortSources(list, 'addon')).toBe(list);
  });
});
