import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ postJson: vi.fn(), requestJson: vi.fn() }));
vi.mock('./transport', () => transport);

import { describeTorrent, ensureService, isLocalService, peerSources, prepareTorrent, setTorrentProfile, torrentProfileOf, torrentProfiles, probeProblems, proxyUrl, torrentStats, torrentUrl, transcodeUrl } from './streamingServer';

const hash = '08ada5a7a6183aae1e09d831df6748d566095a10';
const files = ['Sintel.de.srt', 'Sintel.en.srt', 'Sintel.es.srt', 'Sintel.fr.srt', 'Sintel.it.srt', 'Sintel.mp4', 'poster.jpg']
  .map((name) => ({ name, length: 1 }));
const capabilities = { formats: ['mp4', 'matroska,webm'], videoCodecs: ['h264', 'vp9'], audioCodecs: ['aac', 'opus'], maxAudioChannels: 8 };

describe('streaming server client', () => {
  beforeEach(() => {
    transport.postJson.mockReset();
    transport.requestJson.mockReset();
  });

  it('normalizes peer sources like stremio-video and adds DHT only when sources exist', () => {
    expect(peerSources(hash)).toEqual([]);
    expect(peerSources(hash, ['udp://tracker.example:1337', 'tracker:udp://tracker.example:1337', 'dht:abc'])).toEqual([
      `dht:${hash}`, 'tracker:udp://tracker.example:1337', 'dht:abc',
    ]);
    expect(torrentUrl('http://127.0.0.1:11470/', hash.toUpperCase(), 5)).toBe(`http://127.0.0.1:11470/${hash}/5`);
    expect(torrentUrl('http://127.0.0.1:11470', hash, 1, ['tracker:udp://a:1'])).toBe(
      `http://127.0.0.1:11470/${hash}/1?tr=tracker%3Audp%3A%2F%2Fa%3A1`,
    );
  });

  it('asks the server to guess the file, sending season and episode for series', async () => {
    transport.postJson.mockResolvedValue({ guessedFileIdx: 5, files });
    const prepared = await prepareTorrent('http://127.0.0.1:11470', { infoHash: hash }, { season: 2, episode: 3 });
    expect(transport.postJson).toHaveBeenCalledWith(`http://127.0.0.1:11470/${hash}/create`, {
      torrent: { infoHash: hash },
      guessFileIdx: { season: 2, episode: 3 },
    });
    expect(prepared).toMatchObject({ url: `http://127.0.0.1:11470/${hash}/5`, fileIdx: 5, fileName: 'Sintel.mp4' });
    expect(prepared.subtitles.map((item) => [item.lang, item.url])).toEqual(
      ['de', 'en', 'es', 'fr', 'it'].map((lang, index) => [lang, `http://127.0.0.1:11470/${hash}/${index}`]),
    );
  });

  it('keeps an explicit index, adds peer search and rejects files that are not videos', async () => {
    transport.postJson.mockResolvedValue({ files });
    await prepareTorrent('http://s', { infoHash: hash, fileIdx: 5, sources: ['tracker:udp://a:1'] });
    expect(transport.postJson.mock.calls[0][1]).toEqual({
      torrent: { infoHash: hash },
      guessFileIdx: false,
      peerSearch: { sources: [`dht:${hash}`, 'tracker:udp://a:1'], min: 40, max: 200 },
    });
    await expect(prepareTorrent('http://s', { infoHash: hash, fileIdx: 0 })).rejects.toThrow('Sintel.de.srt');
    await expect(prepareTorrent('http://s', { infoHash: hash, fileIdx: 40 })).rejects.toThrow('no existe');
    transport.postJson.mockResolvedValue({ files });
    await expect(prepareTorrent('http://s', { infoHash: hash })).rejects.toThrow('ningún archivo de vídeo');
  });

  it('explains torrents without peers or metadata', async () => {
    transport.postJson.mockRejectedValue(new Error('The addon request timed out.'));
    await expect(prepareTorrent('http://s', { infoHash: hash })).rejects.toThrow('no encontró pares ni metadatos');
  });

  it('builds proxy URLs with request and response headers', () => {
    expect(proxyUrl('http://127.0.0.1:11470', 'https://cdn.example/v/a.mp4?t=1', { Referer: 'https://x.example/' }, { 'content-type': 'video/mp4' }))
      .toBe('http://127.0.0.1:11470/proxy/d=https%3A%2F%2Fcdn.example&h=Referer%3Ahttps%3A%2F%2Fx.example%2F&r=content-type%3Avideo%2Fmp4/v/a.mp4?t=1');
  });

  it('reports unsupported containers and codecs from a probe', () => {
    expect(probeProblems({ format: { name: 'mov,mp4,m4a,3gp,3g2,mj2' }, streams: [{ track: 'video', codec: 'h264' }, { track: 'audio', codec: 'aac', channels: 6 }] }, capabilities)).toEqual([]);
    expect(probeProblems({ format: { name: 'matroska,webm' }, streams: [{ track: 'video', codec: 'hevc' }, { track: 'audio', codec: 'dts' }] }, capabilities))
      .toEqual(['vídeo HEVC', 'audio DTS', 'ninguna pista de audio compatible']);
    expect(probeProblems({ format: { name: 'avi' }, streams: [] }, capabilities)).toEqual(['contenedor avi']);
  });

  it('requests an HLS conversion limited to codecs the player decodes', () => {
    const url = new URL(transcodeUrl('http://127.0.0.1:11470', 'http://127.0.0.1:11470/x/1', capabilities));
    expect(url.pathname).toMatch(/^\/hlsv2\/[a-f0-9]{24}\/master\.m3u8$/);
    expect(url.searchParams.get('mediaURL')).toBe('http://127.0.0.1:11470/x/1');
    expect(url.searchParams.getAll('videoCodecs')).toEqual(['h264', 'vp9']);
    expect(url.searchParams.get('maxAudioChannels')).toBe('2');
  });
});

describe('torrent swarm', () => {
  it('reads the server stats and summarizes them', async () => {
    // Taken from a real torrent on server 4.22.3: 145 addresses found, 55 connection slots busy, 3 handshakes.
    transport.requestJson.mockResolvedValueOnce({ peers: 3, unchoked: 1, unique: 145, queued: 89, swarmConnections: 55, swarmSize: 55, downloadSpeed: 0, downloaded: 0, peerSearchRunning: true });
    const stats = await torrentStats('http://127.0.0.1:11470/', 'A2D9D5DE');
    expect(transport.requestJson).toHaveBeenLastCalledWith('http://127.0.0.1:11470/a2d9d5de/stats.json');
    expect(stats).toEqual({ peers: 3, found: 145, unchoked: 1, speed: 0, downloaded: 0, searching: true });
    expect(describeTorrent(stats)).toBe('3 de 145 pares conectados · 0 KB/s · 0 MB descargados');
    expect(describeTorrent({ ...stats, peers: 1, found: 1, speed: 2_540_000, downloaded: 290_000_000 })).toBe('1 par conectado · 2.4 MB/s · 277 MB descargados');
    expect(describeTorrent({ ...stats, peers: 4, found: 0 })).toBe('4 pares conectados · 0 KB/s · 0 MB descargados');
  });
});

describe('ensureService', () => {
  it('only treats the default local address as one Vela can start', () => {
    expect(isLocalService('http://127.0.0.1:11470')).toBe(true);
    expect(isLocalService('http://localhost:11470/')).toBe(true);
    expect(isLocalService('http://192.168.1.10:11470')).toBe(false);
    expect(isLocalService('https://127.0.0.1:12470')).toBe(false);
    expect(isLocalService('not a url')).toBe(false);
  });

  it('answers at once when the server responds, and gives up on remote servers without starting one', async () => {
    transport.requestJson.mockResolvedValueOnce({ values: {} });
    expect(await ensureService('http://127.0.0.1:11470')).toBe(true);
    transport.requestJson.mockRejectedValueOnce(new Error('refused'));
    expect(await ensureService('http://192.168.1.10:11470')).toBe(false);
  });
});

describe('torrent profiles', () => {
  it('recognizes the server defaults and only sends integer limits', () => {
    // Values reported by server 4.22.3 out of the box.
    const shipped = { btMaxConnections: 55, btHandshakeTimeout: 20000, btRequestTimeout: 4000, btDownloadSpeedSoftLimit: 2621440, btDownloadSpeedHardLimit: 3670016, btMinPeersForStable: 5, cacheSize: 2147483648 };
    expect(torrentProfileOf(shipped)).toBe('default');
    expect(torrentProfileOf({ ...shipped, btMaxConnections: 70 })).toBeUndefined();
    for (const profile of Object.values(torrentProfiles))
      for (const value of Object.values(profile.values)) expect(Number.isInteger(value) && value > 0).toBe(true);
  });

  it('posts only the torrent limits and fails when the server does not confirm', async () => {
    transport.postJson.mockResolvedValueOnce({ success: true });
    await setTorrentProfile('http://127.0.0.1:11470/', 'fast');
    expect(transport.postJson).toHaveBeenLastCalledWith('http://127.0.0.1:11470/settings', torrentProfiles.fast.values);
    transport.postJson.mockResolvedValueOnce({ error: 'nope' });
    await expect(setTorrentProfile('http://127.0.0.1:11470', 'soft')).rejects.toThrow();
  });
});
