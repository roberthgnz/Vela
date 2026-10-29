import { describe, expect, it } from 'vitest';

import { externalSubtitles } from './externalPlayback';

const sub = (id: string, lang: string, url = `https://subs.example/${id}.srt`) => ({ id, lang, url });

describe('externalSubtitles', () => {
  it('puts the preferred language first, then the secondary, then the rest', () => {
    const items = [sub('a', 'fre'), sub('b', 'eng'), sub('c', 'es'), sub('d', 'spa')];
    expect(externalSubtitles(items, 'spa', 'eng')).toEqual([
      'https://subs.example/c.srt',
      'https://subs.example/d.srt',
      'https://subs.example/b.srt',
      'https://subs.example/a.srt',
    ]);
  });

  it('drops duplicates and non-HTTP URLs, and caps files per language and in total', () => {
    const many = Array.from({ length: 6 }, (_, index) => sub(`e${index}`, 'eng'));
    const items = [sub('x', 'spa'), sub('x2', 'spa', 'https://subs.example/x.srt'), sub('f', 'spa', 'file:///c:/x.srt'), ...many];
    const urls = externalSubtitles(items, 'spa', 'eng', 3, 2);
    expect(urls).toEqual(['https://subs.example/x.srt', 'https://subs.example/e0.srt', 'https://subs.example/e1.srt']);
  });
});
