import { describe, expect, it } from 'vitest';
import { mpvKey, mpvLanguages, videoPlayer } from './embeddedMpv';

const key = (value: string, modifiers: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) =>
  mpvKey({ key: value, ctrlKey: false, altKey: false, metaKey: false, ...modifiers });

describe('mpvKey', () => {
  it('names the keys mpv knows and passes printable characters through', () => {
    expect(key(' ')).toBe('SPACE');
    expect(key('ArrowLeft')).toBe('LEFT');
    expect(key('ArrowDown')).toBe('DOWN');
    expect(key('Home')).toBe('HOME');
    expect(key('k')).toBe('k');
    expect(key('G')).toBe('G');
    expect(key('<')).toBe('<');
    expect(key('7')).toBe('7');
  });
  it('keeps shortcuts with modifiers and unknown keys away from mpv', () => {
    expect(key('k', { ctrlKey: true })).toBeUndefined();
    expect(key('f', { altKey: true })).toBeUndefined();
    expect(key('Shift')).toBeUndefined();
    expect(key('F5')).toBeUndefined();
    expect(key('ñ')).toBeUndefined();
  });
});

describe('mpvLanguages', () => {
  it('lists the three- and two-letter codes, preferred first, without repeats', () => {
    expect(mpvLanguages('spa', 'eng')).toBe('spa,es,eng,en');
    expect(mpvLanguages('es', '')).toBe('spa,es');
    expect(mpvLanguages('spa', 'spa')).toBe('spa,es');
    expect(mpvLanguages('', '')).toBe('');
  });
});

describe('videoPlayer', () => {
  it('defaults to the built-in player and remembers mpv', () => {
    expect(videoPlayer.get()).toBe('builtin');
    videoPlayer.set('mpv');
    expect(videoPlayer.get()).toBe('mpv');
    videoPlayer.set('builtin');
    expect(videoPlayer.get()).toBe('builtin');
  });
});
