import { describe, expect, it } from 'vitest';
import { manifestFromLink } from './desktop';

describe('manifestFromLink', () => {
  it('turns vela:// and stremio:// add-on links into their https manifest', () => {
    expect(manifestFromLink('vela://addon.example/manifest.json')).toBe('https://addon.example/manifest.json');
    expect(manifestFromLink('VELA://addon.example/config/manifest.json')).toBe('https://addon.example/config/manifest.json');
    expect(manifestFromLink('stremio://addon.example/manifest.json')).toBe('https://addon.example/manifest.json');
    expect(manifestFromLink('stremio://addon.example/a%2Fb/manifest.json?x=1')).toBe('https://addon.example/a%2Fb/manifest.json?x=1');
  });
  it('ignores links that are not add-on manifests', () => {
    expect(manifestFromLink('vela://addon.example/')).toBeUndefined();
    expect(manifestFromLink('stremio://detail/movie/tt1')).toBeUndefined();
    expect(manifestFromLink('https://addon.example/manifest.json')).toBeUndefined();
    expect(manifestFromLink('stremio:///detail/movie/tt1')).toBeUndefined();
    expect(manifestFromLink('vela://')).toBeUndefined();
  });
});
