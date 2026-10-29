import { describe, expect, it } from 'vitest';

import type { ResolvedStream } from './contracts';
import { matchesKeywords, parseKeywords } from './sourceKeywords';

const stream = (title: string): ResolvedStream => ({ addonName: 'A', addonUrl: 'https://a/manifest.json', name: 'A 1080p', title });

describe('source keywords', () => {
  it('splits by comma or line and drops blanks and repeats', () => {
    expect(parseKeywords(' cam, HDR\n\n, cam ,-')).toEqual(['cam', 'HDR']);
  });

  it('matches whole words, ignoring case, accents and punctuation', () => {
    const remux = stream('Movie.2024.WEB-DL.Castellano.x265');
    expect(matchesKeywords(remux, { include: ['web dl'], exclude: [] })).toBe(true);
    expect(matchesKeywords(remux, { include: ['castellano'], exclude: ['X265'] })).toBe(false);
    expect(matchesKeywords(remux, { include: ['Castellano', 'latino'], exclude: [] })).toBe(true);
    expect(matchesKeywords(stream('Camera.Obscura.1080p'), { include: [], exclude: ['cam'] })).toBe(true);
    expect(matchesKeywords(stream('Film HDCAM'), { include: ['español'], exclude: [] })).toBe(false);
    expect(matchesKeywords(stream('Película en ESPANOL'), { include: ['español'], exclude: [] })).toBe(true);
    expect(matchesKeywords(remux, { include: [], exclude: [] })).toBe(true);
  });
});
