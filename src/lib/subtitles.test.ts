import { describe, expect, it } from 'vitest';

import { languageLabel, normalizeLanguage, pickByLanguage, sameLanguage } from './languages';
import { activeCues, decodeSubtitle, dedupeSubtitles, detectFormat, parseSubtitle, SubtitleError, syncCandidates, syncDelay } from './subtitles';

const encode = (text: string) => new TextEncoder().encode(text);

describe('languages', () => {
  it('normalizes ISO 639-1, bibliographic, OpenSubtitles and named codes', () => {
    expect(['es', 'spa', 'es-ES', 'es_419', 'Spanish', 'spl'].map(normalizeLanguage)).toEqual(Array(6).fill('spa'));
    expect(['fre', 'fr', 'fra'].map(normalizeLanguage)).toEqual(['fra', 'fra', 'fra']);
    expect(normalizeLanguage('pob')).toBe('por');
    expect(sameLanguage('ger', 'de')).toBe(true);
    expect(sameLanguage('', '')).toBe(false);
    expect(languageLabel('fre')).toBe('Francés');
    expect(languageLabel('pob')).toBe('Portugués (Brasil)');
    expect(languageLabel('xx-custom')).toBe('xx-custom');
  });

  it('picks the primary language, then the secondary one, choosing the first match', () => {
    const items = [{ lang: 'eng', id: 1 }, { lang: 'es', id: 2 }, { lang: 'spa', id: 3 }];
    expect(pickByLanguage(items, (item) => item.lang, 'spa', 'eng')?.id).toBe(2);
    expect(pickByLanguage(items, (item) => item.lang, 'ita', 'eng')?.id).toBe(1);
    expect(pickByLanguage(items, (item) => item.lang, 'ita', '')).toBeUndefined();
  });
});

describe('subtitle decoding', () => {
  it('reads UTF-8, Windows-1252 and UTF-16 files', () => {
    expect(decodeSubtitle(encode('﻿Canción'))).toEqual({ text: 'Canción', encoding: 'utf-8' });
    expect(decodeSubtitle(Uint8Array.from([0x43, 0x61, 0x6e, 0x63, 0x69, 0xf3, 0x6e]))).toEqual({ text: 'Canción', encoding: 'windows-1252' });
    const utf16 = new Uint8Array([0xff, 0xfe, ...[...'1\n00:00:01,000'].flatMap((char) => [char.charCodeAt(0), 0])]);
    expect(decodeSubtitle(utf16).text).toBe('1\n00:00:01,000');
    const bomless = new Uint8Array([...'1\n00:00:01,000 --> 00:00:02,000\nHola'].flatMap((char) => [char.charCodeAt(0), 0]));
    expect(decodeSubtitle(bomless)).toMatchObject({ encoding: 'utf-16le' });
  });

  it('detects the format from the content, not the file name', () => {
    expect(detectFormat('WEBVTT\n\n00:01.000 --> 00:02.000\nHi')).toBe('vtt');
    expect(detectFormat('[Script Info]\nScriptType: v4.00+')).toBe('ass');
    expect(detectFormat('1\r\n00:00:01,000 --> 00:00:02,000\r\nHi')).toBe('srt');
    expect(detectFormat('<html>Not found</html>')).toBeUndefined();
    expect(() => parseSubtitle('<html>Not found</html>')).toThrow(SubtitleError);
    expect(() => parseSubtitle('1\n00:00:05,000 --> 00:00:01,000\nBackwards')).toThrow(/vacío o dañado/);
  });
});

describe('subtitle parsing', () => {
  it('parses SRT with missing indexes, colon milliseconds, markup and broken blocks', () => {
    const parsed = parseSubtitle([
      '1', '00:00:01,000 --> 00:00:02,500', '<i>Hola</i> &amp; adiós', '',
      '00:00:03:200 --> 00:00:04,000', '{\\an8}Sin índice', 'segunda línea', '',
      '3', '00:00:09,000 --> 00:00:08,000', 'Al revés', '',
      '4', '00:00:05,000 --> 00:00:06,000', '', '',
      '5', '1:02:03,004 --> 1:02:04,000', 'Hora sin cero',
    ].join('\n'));
    expect(parsed.format).toBe('srt');
    expect(parsed.cues).toEqual([
      { start: 1, end: 2.5, text: 'Hola & adiós' },
      { start: 3.2, end: 4, text: 'Sin índice\nsegunda línea' },
      { start: 3723.004, end: 3724, text: 'Hora sin cero' },
    ]);
    expect(parsed.skipped).toBe(2);
  });

  it('parses WebVTT with settings, identifiers and short timestamps', () => {
    const parsed = parseSubtitle('WEBVTT\n\nNOTE comment\n\nintro\n00:01.000 --> 00:02.000 line:0 align:center\n<c.yellow>Arriba</c>\n');
    expect(parsed.cues).toEqual([{ start: 1, end: 2, text: 'Arriba', top: true }]);
  });

  it('turns ASS dialogue into plain cues, keeping commas, line breaks and top alignment', () => {
    const parsed = parseSubtitle([
      '[Script Info]', 'ScriptType: v4.00+', '',
      '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, Alignment', 'Style: Default,Arial,48,2', 'Style: Sign,Arial,36,8', '',
      '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.00,0:00:06.00,Default,,0,0,0,,{\\c&H00FF00&}Hola, mundo\\Nsegunda',
      'Dialogue: 0,0:00:02.00,0:00:08.00,Sign,,0,0,0,,Cartel',
      'Comment: 0,0:00:02.00,0:00:08.00,Default,,0,0,0,,Ignorado',
    ].join('\n'));
    expect(parsed.cues).toEqual([
      { start: 1, end: 6, text: 'Hola, mundo\nsegunda' },
      { start: 2, end: 8, text: 'Cartel', top: true },
    ]);
  });

  it('returns overlapping cues once and in order', () => {
    const cues = [
      { start: 0, end: 10, text: 'Larga' },
      { start: 1, end: 3, text: 'Repetida' },
      { start: 1.5, end: 3, text: 'Repetida' },
      { start: 2, end: 2.5, text: 'Corta' },
      { start: 4, end: 5, text: 'Después' },
    ];
    expect(activeCues(cues, 2.2).map((cue) => cue.text)).toEqual(['Larga', 'Repetida', 'Corta']);
    expect(activeCues(cues, 3).map((cue) => cue.text)).toEqual(['Larga']);
    expect(activeCues(cues, 11)).toEqual([]);
  });

  it('lists nearby lines for syncing by ear and derives the delay', () => {
    const cues = [
      { start: 1, end: 2, text: 'Lejos' },
      { start: 100, end: 102, text: 'Antes' },
      { start: 100, end: 102, text: 'Antes' },
      { start: 110, end: 112, text: 'Ahora' },
      { start: 125, end: 127, text: 'Después' },
      { start: 400, end: 401, text: 'Final' },
    ];
    expect(syncCandidates(cues, 112, 2).map((cue) => cue.text)).toEqual(['Antes', 'Ahora', 'Después']);
    expect(syncCandidates(cues, 112, 0, 60, 2).map((cue) => cue.text)).toEqual(['Antes', 'Ahora']);
    expect(syncDelay(cues[3], 113.04)).toBe(3);
    expect(syncDelay(cues[4], 120)).toBe(-5);
  });

  it('removes duplicate subtitle entries by URL', () => {
    const list = dedupeSubtitles([
      { id: 'a', lang: 'spa', url: 'https://subs.example/1.srt' },
      { id: 'b', lang: 'es', url: 'https://SUBS.example/1.srt' },
      { id: 'a', lang: 'spa', url: 'https://subs.example/2.srt' },
    ]);
    expect(list.map((item) => item.url)).toEqual(['https://subs.example/1.srt', 'https://subs.example/2.srt']);
  });
});
