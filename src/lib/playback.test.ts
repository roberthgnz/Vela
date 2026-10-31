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

import { resolvePlayback } from './playback';
import { ensureService, prepareTorrent, serviceAvailable } from './streamingServer';
import { prepareVelaTorrent } from './torrentEngine';

const meta = { id: 'tt1', type: 'movie' as const, name: 'Sintel' };
const torrent = { addonName: 'Demo', addonUrl: 'http://addon.test/manifest.json', infoHash: 'abc' };
const service = 'http://127.0.0.1:11470';

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

  it('service: explains that Stremio Service is needed when it does not answer', async () => {
    engine.value = 'service';
    vi.mocked(ensureService).mockResolvedValue(false);
    await expect(resolvePlayback(meta, torrent, service)).rejects.toThrow(/Stremio Service/);
    expect(prepareVelaTorrent).not.toHaveBeenCalled();
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
