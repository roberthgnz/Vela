import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Subtitle } from './contracts';

// The desktop app, whose log and storage writes go nowhere in this test.
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('./transport', () => ({
  externalPlayerKind: vi.fn(async () => 'mpv'),
  launchExternalPlayer: vi.fn(async () => ({ ipc: true, player: 'mpv' })),
  sendExternalSubtitles: vi.fn(async () => true),
}));
vi.mock('./protocol', () => ({ getSubtitles: vi.fn() }));
vi.mock('./store', () => ({
  CREDITS_THRESHOLD: 0.9,
  WATCHED_THRESHOLD: 0.85,
  preferencesStore: {
    getSnapshot: () => ({
      addons: [],
      externalPlayerPath: '',
      player: { subtitleLanguage: 'spa', subtitleSecondary: 'eng', subtitlesAuto: true },
    }),
  },
}));

import { externalSubtitles, playExternally } from './externalPlayback';
import { getSubtitles } from './protocol';
import { externalPlayerKind, launchExternalPlayer, sendExternalSubtitles } from './transport';

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

describe('playExternally', () => {
  const meta = { id: 'tt1', type: 'movie' as const, name: 'Sintel' };
  const stream = {
    addonName: 'Demo',
    addonUrl: 'http://addon.test/manifest.json',
    url: 'https://media.test/a.mkv',
    subtitles: [sub('own', 'eng')],
  };
  const options = { meta, addonUrl: stream.addonUrl, videoId: 'tt1', stream };

  beforeEach(() => vi.clearAllMocks());

  it('starts MPV without waiting for the subtitle addons and sends their files when they answer', async () => {
    let answer!: (items: Subtitle[]) => void;
    vi.mocked(getSubtitles).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const launch = await playExternally(stream.url, options);
    expect(launch.player).toBe('mpv');
    expect(vi.mocked(launchExternalPlayer).mock.calls[0][2]?.subtitles).toEqual(['https://subs.example/own.srt']);
    expect(sendExternalSubtitles).not.toHaveBeenCalled();
    answer([sub('own', 'eng'), sub('es', 'spa')]);
    await vi.waitFor(() => expect(sendExternalSubtitles).toHaveBeenCalled());
    const [, urls, showFirst] = vi.mocked(sendExternalSubtitles).mock.calls[0];
    expect(urls).toEqual(['https://subs.example/es.srt']);
    // Spanish is preferred and was not there at the start: it is the one shown.
    expect(showFirst).toBe(true);
  });

  it('waits for the subtitle addons with VLC, which only takes subtitles when it starts', async () => {
    vi.mocked(externalPlayerKind).mockResolvedValueOnce('vlc');
    vi.mocked(launchExternalPlayer).mockResolvedValueOnce({ ipc: true, player: 'vlc' });
    vi.mocked(getSubtitles).mockResolvedValueOnce([sub('own', 'eng'), sub('es', 'spa')]);
    await playExternally(stream.url, options);
    expect(vi.mocked(launchExternalPlayer).mock.calls[0][2]?.subtitles).toEqual([
      'https://subs.example/es.srt',
      'https://subs.example/own.srt',
    ]);
    expect(sendExternalSubtitles).not.toHaveBeenCalled();
  });
});
