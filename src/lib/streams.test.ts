import { describe, expect, it } from 'vitest';
import { languageOfFlag, regionCode, streamDetail, streamFacts, streamLanguages, streamTags } from './streams';

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
