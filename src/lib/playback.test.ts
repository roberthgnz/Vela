import { beforeEach, describe, expect, it, vi } from 'vitest';

const engine = { value: 'auto' as 'auto' | 'vela' | 'service' };

vi.mock('./torrentEngine', () => ({
  velaEngineAvailable: true,
  torrentEngine: { get: () => engine.value },
  prepareVelaTorrent: vi.fn(async () => ({
    url: 'http://127.0.0.1:5000/token/abc/0',
    fileIdx: 0,
    fileName: 'Sintel.mp4',
    subtitles: [],
  })),
}));

vi.mock('./streamingServer', () => ({
  ensureService: vi.fn(),
  serviceAvailable: vi.fn(),
  prepareTorrent: vi.fn(async () => ({ url: 'http://127.0.0.1:11470/abc/0', fileIdx: 0, fileName: 'Sintel.mp4', subtitles: [] })),
  mediaCapabilities: () => ({}),
  probe: vi.fn(async () => {
    throw new Error('no probe in tests');
  }),
  probeProblems: () => [],
  proxyUrl: () => '',
  transcodeUrl: (_service: string, url: string) => `http://127.0.0.1:11470/hlsv2/x/master.m3u8?mediaURL=${encodeURIComponent(url)}`,
}));

import { containerProblems, resolvePlayback } from './playback';
import { ensureService, prepareTorrent, probe, serviceAvailable } from './streamingServer';
import { prepareVelaTorrent } from './torrentEngine';

const meta = { id: 'tt1', type: 'movie' as const, name: 'Sintel' };
const torrent = { addonName: 'Demo', addonUrl: 'http://addon.test/manifest.json', infoHash: 'abc' };
const service = 'http://127.0.0.1:11470';

describe('containerProblems', () => {
  it('uses the first name with an extension', () => {
    expect(containerProblems(undefined, 'movie.AVI')).toEqual(['contenedor AVI']);
    expect(containerProblems('Episode.mkv', 'http://x/y.avi')).toEqual([]);
    expect(containerProblems('http://127.0.0.1:11470/abc/0', 'clip.m2ts')).toEqual(['contenedor M2TS']);
    expect(containerProblems('http://127.0.0.1:11470/abc/0')).toEqual([]);
    expect(containerProblems('C:\\Users\\me\\Downloads\\Vela\\film.mpg')).toEqual(['contenedor MPG']);
  });
});

describe('resolvePlayback torrent engines', () => {
  beforeEach(() => {
    vi.mocked(ensureService).mockReset();
    vi.mocked(serviceAvailable).mockReset();
    vi.mocked(prepareTorrent).mockClear();
    vi.mocked(prepareVelaTorrent).mockClear();
  });

  it('auto: uses Stremio Service when it answers', async () => {
    engine.value = 'auto';
    vi.mocked(ensureService).mockResolvedValue(true);
    const target = await resolvePlayback(meta, torrent, service);
    expect(target.torrentEngine).toBe('service');
    expect(target.url).toBe('http://127.0.0.1:11470/abc/0');
    expect(target.transcodeUrl).toContain('hlsv2');
    expect(prepareVelaTorrent).not.toHaveBeenCalled();
  });

  it("auto: falls back to Vela's engine without Stremio Service", async () => {
    engine.value = 'auto';
    vi.mocked(ensureService).mockResolvedValue(false);
    const target = await resolvePlayback(meta, torrent, service, { episode: { id: 'e', season: 1, episode: 2 } });
    expect(target.torrentEngine).toBe('vela');
    expect(target.url).toBe('http://127.0.0.1:5000/token/abc/0');
    expect(target.transcodeUrl).toBeUndefined();
    expect(target.note).toContain('Sintel.mp4');
    expect(prepareVelaTorrent).toHaveBeenCalledWith(torrent, { id: 'e', season: 1, episode: 2 });
    expect(prepareTorrent).not.toHaveBeenCalled();
  });

  it("vela: never starts Stremio's server, but still offers its conversion when it already runs", async () => {
    engine.value = 'vela';
    vi.mocked(serviceAvailable).mockResolvedValue(true);
    const target = await resolvePlayback(meta, torrent, service);
    expect(ensureService).not.toHaveBeenCalled();
    expect(target.torrentEngine).toBe('vela');
    expect(target.transcodeUrl).toContain(encodeURIComponent('http://127.0.0.1:5000/token/abc/0'));
  });

  it('vela: asks for Stremio Service while the torrent opens, and does not wait for a server that hangs', async () => {
    vi.useFakeTimers();
    try {
      engine.value = 'vela';
      vi.mocked(serviceAvailable).mockReturnValue(new Promise(() => {}));
      const pending = resolvePlayback(meta, torrent, service);
      await vi.advanceTimersByTimeAsync(500);
      const target = await pending;
      expect(target.torrentEngine).toBe('vela');
      expect(target.transcodeUrl).toBeUndefined();
      expect(vi.mocked(serviceAvailable).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(prepareVelaTorrent).mock.invocationCallOrder[0],
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not inspect the file before the player starts: the player does it in the background', async () => {
    engine.value = 'vela';
    vi.mocked(serviceAvailable).mockResolvedValue(true);
    const target = await resolvePlayback(meta, torrent, service);
    expect(target.url).toBe('http://127.0.0.1:5000/token/abc/0');
    expect(target.convertIfNeeded).toBe(true);
    expect(probe).not.toHaveBeenCalled();
    // A plain link with nothing suspicious only gets the conversion offered.
    const link = { addonName: 'Demo', addonUrl: 'http://addon.test/manifest.json', url: 'https://media.test/a.mp4' };
    const direct = await resolvePlayback(meta, link, service);
    expect(direct.url).toBe('https://media.test/a.mp4');
    expect(direct.transcodeUrl).toContain('hlsv2');
    expect(direct.convertIfNeeded).toBe(false);
  });

  it('service: explains that Stremio Service is needed when it does not answer', async () => {
    engine.value = 'service';
    vi.mocked(ensureService).mockResolvedValue(false);
    await expect(resolvePlayback(meta, torrent, service)).rejects.toThrow(/Stremio Service/);
    expect(prepareVelaTorrent).not.toHaveBeenCalled();
  });

  it('a plain link waits half a second at most for Stremio Service (a refused connection takes two on Windows)', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(serviceAvailable).mockReturnValue(new Promise(() => {}));
      const link = { addonName: 'Demo', addonUrl: 'http://addon.test/manifest.json', url: 'https://media.test/a.mp4' };
      const pending = resolvePlayback(meta, link, service);
      await vi.advanceTimersByTimeAsync(500);
      const target = await pending;
      expect(target.url).toBe('https://media.test/a.mp4');
      expect(target.transcodeUrl).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks files whose container the built-in player cannot open, from the file name or the URL', async () => {
    vi.mocked(serviceAvailable).mockResolvedValue(false);
    const link = { addonName: 'Demo', addonUrl: 'http://addon.test/manifest.json', url: 'https://media.test/Old%20Film.avi?token=1' };
    const target = await resolvePlayback(meta, link, service);
    expect(target.unsupported).toEqual(['contenedor AVI']);
    expect(target.transcodeUrl).toBeUndefined();
    engine.value = 'vela';
    vi.mocked(prepareVelaTorrent).mockResolvedValueOnce({
      url: 'http://127.0.0.1:5000/token/abc/0',
      fileIdx: 0,
      fileName: 'Sintel.wmv',
      subtitles: [],
    } as Awaited<ReturnType<typeof prepareVelaTorrent>>);
    expect((await resolvePlayback(meta, torrent, service)).unsupported).toEqual(['contenedor WMV']);
    // MP4 and MKV are left to the inspection of their tracks.
    expect((await resolvePlayback(meta, { ...link, url: 'https://media.test/a.mkv' }, service)).unsupported).toBeUndefined();
  });

  it('external players get the local URL of either engine', async () => {
    engine.value = 'vela';
    const target = await resolvePlayback(meta, torrent, service, { external: true });
    expect(target).toEqual({
      url: 'http://127.0.0.1:5000/token/abc/0',
      externalUrl: 'http://127.0.0.1:5000/token/abc/0',
      torrentEngine: 'vela',
    });
  });
});
