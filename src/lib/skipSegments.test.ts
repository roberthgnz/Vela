import { describe, expect, it } from 'vitest';

import { activeSegment, chapterKind, chapterSegments, skipSegments } from './skipSegments';

describe('skip segments', () => {
  it('recognizes chapter names', () => {
    expect(['Intro', 'Opening', 'OP', 'Recap', 'Créditos', 'End Credits', 'ED', 'Chapter 2', 'Opera'].map(chapterKind)).toEqual([
      'intro', 'intro', 'intro', 'intro', 'credits', 'credits', 'credits', undefined, undefined,
    ]);
  });

  it('builds segments from chapters, merging neighbours and dropping implausible ones', () => {
    const chapters = [
      { start: 0, title: 'Recap' },
      { start: 40, title: 'Opening' },
      { start: 130, title: 'Part A' },
      { start: 1300, title: 'Ending' },
      { start: 1390, title: 'Preview' },
    ];
    expect(chapterSegments(chapters, 1420)).toEqual([
      { kind: 'intro', start: 0, end: 130, source: 'chapters' },
      { kind: 'credits', start: 1300, end: 1390, source: 'chapters' },
    ]);
    expect(chapterSegments([{ start: 0, title: 'Intro' }, { start: 2, title: 'Main' }], 100)).toEqual([]);
    expect(chapterSegments([{ start: 0, title: 'Intro' }], 100)).toEqual([]);
  });

  it('fills missing kinds with the series marks, credits counted from the end', () => {
    const marks = { intro: { start: 60, end: 150 }, creditsFromEnd: 90 };
    expect(skipSegments([], marks, 1500)).toEqual([
      { kind: 'intro', start: 60, end: 150, source: 'marks' },
      { kind: 'credits', start: 1410, end: 1500, source: 'marks' },
    ]);
    const withChapters = skipSegments([{ start: 0, title: 'Main' }, { start: 1350, title: 'Credits' }], marks, 1500);
    expect(withChapters.map((segment) => [segment.kind, segment.source])).toEqual([['intro', 'marks'], ['credits', 'chapters']]);
    expect(activeSegment(withChapters, 100)?.kind).toBe('intro');
    expect(activeSegment(withChapters, 149.5)).toBeUndefined();
  });
});
