import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddonManifest, InstalledAddon, ResolvedStream } from './contracts';
import { defaultAddons, getCatalog, getCatalogSources, getMeta, getStreams, getSubtitles, loadManifest, normalizeManifestUrl, supportsResource } from './protocol';
import { requestJson } from './transport';

vi.mock('./transport', () => ({ requestJson: vi.fn() }));
const request = vi.mocked(requestJson);

function addon(overrides: Partial<AddonManifest> = {}, url = 'https://addon.example/config%2Ftoken/manifest.json?key=private'): InstalledAddon {
  return {
    manifestUrl: url,
    enabled: true,
    installedAt: 1,
    manifest: {
      id: 'org.example.addon', name: 'Example', version: '1.0.0', description: 'Test add-on',
      resources: ['catalog', 'meta', 'stream', 'subtitles'], types: ['movie', 'series'], idPrefixes: ['tt'],
      catalogs: [{ id: 'top', type: 'movie', name: 'Movies', extra: [{ name: 'search' }, { name: 'genre' }, { name: 'skip' }] }],
      ...overrides,
    },
  };
}

beforeEach(() => request.mockReset());

describe('manifest installation', () => {
  it('normalizes Stremio install links and keeps configured paths and query credentials', () => {
    expect(normalizeManifestUrl(' stremio://addon.example/config%2Ftoken/manifest.json?key=private#ignored '))
      .toBe('https://addon.example/config%2Ftoken/manifest.json?key=private');
    expect(normalizeManifestUrl('https://addon.example/custom?key=private')).toBe('https://addon.example/custom/manifest.json?key=private');
    expect(normalizeManifestUrl('addon.example')).toBe('https://addon.example/manifest.json');
  });

  it.each(['javascript:alert(1)', 'file:///tmp/manifest.json', 'https://user:password@addon.example/manifest.json', 'https://addon.example/wrong.json'])('rejects unsafe or unsupported address %s', (value) => {
    expect(() => normalizeManifestUrl(value)).toThrow();
  });

  it('loads and validates a real manifest response', async () => {
    request.mockResolvedValueOnce(addon().manifest);
    const controller = new AbortController();
    const result = await loadManifest('stremio://addon.example/config%2Ftoken/manifest.json?key=private', controller.signal);
    expect(result.manifest.id).toBe('org.example.addon');
    expect(result.enabled).toBe(true);
    expect(request).toHaveBeenCalledWith('https://addon.example/config%2Ftoken/manifest.json?key=private', controller.signal);
  });

  it.each([
    { description: undefined }, { id: '' }, { version: 'latest' }, { resources: [] },
    { types: 'movie' }, { catalogs: [{ type: 'movie', id: 'top' }] },
    { logo: 'data:image/svg+xml,unsafe' }, { resources: [{ name: 'stream', types: 2 }] },
  ])('rejects malformed required fields and unsafe assets: %j', async (changes) => {
    request.mockResolvedValueOnce({ ...addon().manifest, ...changes });
    await expect(loadManifest('https://addon.example')).rejects.toThrow();
  });

  it('does not disclose configured URLs in transport errors', async () => {
    request.mockRejectedValueOnce(new Error('Failed https://addon.example/private-token/manifest.json'));
    await expect(loadManifest('https://addon.example/private-token/manifest.json')).rejects.toThrow('The add-on manifest could not be loaded.');
  });
});

describe('resource eligibility', () => {
  it('uses global restrictions for short declarations and independent restrictions for full declarations', () => {
    const item = addon({ resources: ['meta', { name: 'stream', types: ['series'] }] });
    expect(supportsResource(item, 'meta', 'movie', 'tt123')).toBe(true);
    expect(supportsResource(item, 'meta', 'movie', 'custom:123')).toBe(false);
    expect(supportsResource(item, 'stream', 'series', 'custom:123')).toBe(true);
    expect(supportsResource(item, 'stream', 'movie', 'tt123')).toBe(false);
  });

  it('respects per-resource prefixes and disabled add-ons', () => {
    const item = addon({ resources: [{ name: 'stream', types: ['movie'], idPrefixes: ['custom:'] }] });
    expect(supportsResource(item, 'stream', 'movie', 'custom:1')).toBe(true);
    expect(supportsResource(item, 'stream', 'movie', 'tt123')).toBe(false);
    expect(supportsResource({ ...item, enabled: false }, 'stream', 'movie', 'custom:1')).toBe(false);
  });

  it('requests declared catalogs independently of content ID prefixes and filters source types', () => {
    const active = addon({ catalogs: [{ id: 'feed', type: 'movie', name: 'Feed' }, { id: 'feed', type: 'series', name: 'Series' }] });
    expect(supportsResource(active, 'catalog', 'movie', 'feed')).toBe(true);
    expect(getCatalogSources([active, { ...active, enabled: false }], 'movie')).toHaveLength(1);
    expect(new Set(getCatalogSources([active]).map((source) => source.key)).size).toBe(2);
  });
});

describe('catalog protocol', () => {
  it('encodes resource path segments and extras once while preserving configured query strings', async () => {
    const item = addon({ catalogs: [{ id: 'list/special', type: 'movie', name: 'Feed', extra: [{ name: 'search' }, { name: 'genre' }, { name: 'skip' }] }] });
    request.mockResolvedValueOnce({ metas: [{ id: 'tt1', type: 'movie', name: 'One', poster: 'https://image.example/1.jpg' }] });
    const source = getCatalogSources([item])[0];
    expect(await getCatalog(source, { search: 'film & café/2026', genre: 'Sci-Fi', skip: 20 })).toHaveLength(1);
    expect(request).toHaveBeenCalledWith('https://addon.example/config%2Ftoken/catalog/movie/list%2Fspecial/search=film%20%26%20caf%C3%A9%2F2026&genre=Sci-Fi&skip=20.json?key=private', undefined);
  });

  it('only calls search catalogs when their required search extra is present', async () => {
    const source = getCatalogSources([addon({ catalogs: [{ id: 'search', type: 'movie', name: 'Search', extra: [{ name: 'search', isRequired: true }] }] })])[0];
    expect(await getCatalog(source)).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce({ metas: [] });
    await getCatalog(source, { search: 'arrival' });
    expect(request).toHaveBeenCalledOnce();
  });

  it('does not return unfiltered results for unsupported search or repeat unsupported pages', async () => {
    const source = getCatalogSources([addon({ catalogs: [{ id: 'feed', type: 'movie', name: 'Feed' }] })])[0];
    expect(await getCatalog(source, { search: 'query' })).toEqual([]);
    expect(await getCatalog(source, { skip: 20 })).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it('honors legacy required extras and allowed options', async () => {
    const source = getCatalogSources([addon({ catalogs: [{ id: 'feed', type: 'movie', name: 'Feed', extraSupported: ['genre'], extraRequired: ['genre'], extra: [{ name: 'genre', options: ['Drama'] }] }] })])[0];
    expect(await getCatalog(source)).toEqual([]);
    expect(await getCatalog(source, { genre: 'Action' })).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce({ metas: [] });
    await getCatalog(source, { genre: 'Drama' });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    { metas: {} }, { metas: [{ id: 'tt1', type: 'movie' }] },
    { metas: [{ id: 'tt1', type: 'movie', name: 'Film', poster: 'javascript:alert(1)' }] },
  ])('rejects invalid media response %j', async (response) => {
    request.mockResolvedValueOnce(response);
    await expect(getCatalog(getCatalogSources([addon()])[0])).rejects.toThrow();
  });

  it('validates series metadata and encodes episode-like IDs', async () => {
    request.mockResolvedValueOnce({ meta: { id: 'tt1:part/one', type: 'series', name: 'Series', videos: [{ id: 'tt1:1:1', title: 'Pilot', season: 1, episode: 1, released: '2020-01-01T00:00:00Z' }] } });
    const result = await getMeta(addon(), 'series', 'tt1:part/one');
    expect(result.videos?.[0].title).toBe('Pilot');
    expect(request).toHaveBeenCalledWith('https://addon.example/config%2Ftoken/meta/series/tt1%3Apart%2Fone.json?key=private', undefined);
  });

  it('normalizes absent optional Cinemeta fields and its episode name alias', async () => {
    request.mockResolvedValueOnce({ meta: { id: 'tt1', type: 'series', name: 'Series', director: null, imdbRating: '', released: null, videos: [{ id: 'tt1:1:1', name: 'Pilot', season: 1, episode: 1, released: null, overview: '' }] } });
    const result = await getMeta(addon(), 'series', 'tt1');
    expect(result.director).toBeUndefined();
    expect(result.imdbRating).toBeUndefined();
    expect(result.released).toBeUndefined();
    expect(result.videos?.[0].title).toBe('Pilot');
  });

  it('rejects metadata returned for a different title', async () => {
    request.mockResolvedValueOnce({ meta: { id: 'tt2', type: 'movie', name: 'Wrong title' } });
    await expect(getMeta(addon(), 'movie', 'tt1')).rejects.toThrow('different title');
  });
});

describe('streams and subtitles', () => {
  it('aggregates concurrent stream requests while tolerating an individual failed add-on', async () => {
    const first = addon({}, 'https://first.example/manifest.json');
    const second = addon({ name: 'Working' }, 'https://second.example/manifest.json');
    request.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ streams: [{ name: '1080p', url: 'https://video.example/film.mp4' }] });
    const result = await getStreams([first, second], 'movie', 'tt1');
    expect(result).toMatchObject([{ name: '1080p', addonName: 'Working', addonUrl: second.manifestUrl }]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('distinguishes total add-on failure from a successful empty stream response', async () => {
    request.mockRejectedValueOnce(new Error('private token URL')).mockResolvedValueOnce({ streams: [] });
    await expect(getStreams([addon()], 'movie', 'tt1')).rejects.toThrow('All 1 stream add-ons failed');
    expect(await getStreams([addon()], 'movie', 'tt1')).toEqual([]);
    expect(await getStreams([addon({ resources: ['meta'] })], 'movie', 'tt1')).toEqual([]);
  });

  it.each([{ url: 'file:///bad.mp4' }, { infoHash: 'bad' }, {}, { url: 'https://ok.example/a.mp4', subtitles: [{ id: '1', lang: 'eng', url: 'javascript:alert(1)' }] }])('rejects invalid stream source %j', async (value) => {
    request.mockResolvedValueOnce({ streams: [value] });
    await expect(getStreams([addon()], 'movie', 'tt1')).rejects.toThrow('stream add-ons failed');
  });

  it('retains torrent, YouTube and external stream source information', async () => {
    request.mockResolvedValueOnce({ streams: [{ infoHash: 'a'.repeat(40), fileIdx: 3 }, { ytId: 'abcdefghijk' }, { externalUrl: 'https://watch.example/film' }] });
    expect(await getStreams([addon()], 'movie', 'tt1')).toHaveLength(3);
  });

  it('accepts protocol null defaults for optional stream fields and an unspecified torrent index', async () => {
    request.mockResolvedValueOnce({ streams: [{ infoHash: 'a'.repeat(40), fileIdx: null, name: null, subtitles: null, behaviorHints: null }] });
    const [result] = await getStreams([addon()], 'movie', 'tt1');
    expect(result.infoHash).toBe('a'.repeat(40));
    expect(result.fileIdx).toBeUndefined();
  });

  it('uses video ID with file-specific subtitle extras, merges embedded subtitles and deduplicates', async () => {
    const embedded = { id: 'one', lang: 'eng', url: 'https://subs.example/1.srt' };
    const selected: ResolvedStream = { addonName: 'Stream', addonUrl: 'https://stream.example/manifest.json', subtitles: [embedded], behaviorHints: { videoHash: '0123456789abcdef', videoSize: 123456, filename: 'Film & Movie.mkv' } };
    request.mockResolvedValueOnce({ subtitles: [embedded, { id: 'two', lang: 'spa', url: 'https://subs.example/2.srt' }] });
    expect(await getSubtitles([addon()], 'series', 'tt1:2:3', selected)).toHaveLength(2);
    expect(request).toHaveBeenCalledWith('https://addon.example/config%2Ftoken/subtitles/series/tt1%3A2%3A3/videoHash=0123456789abcdef&videoSize=123456&filename=Film%20%26%20Movie.mkv.json?key=private', undefined);
  });

  it('keeps embedded subtitles when all subtitle add-ons are unavailable', async () => {
    request.mockRejectedValueOnce(new Error('offline'));
    const selected = { addonName: 'Stream', addonUrl: 'https://stream.example/manifest.json', subtitles: [{ id: 'one', lang: 'eng', url: 'https://subs.example/1.vtt' }] };
    expect(await getSubtitles([addon()], 'movie', 'tt1', selected)).toEqual(selected.subtitles);
  });

  it('preserves cancellation despite a successful response from another add-on', async () => {
    request.mockRejectedValueOnce(new DOMException('Cancelled', 'AbortError')).mockResolvedValueOnce({ streams: [] });
    await expect(getStreams([addon(), addon()], 'movie', 'tt1')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('honors already aborted signals and aborts after pending transport completion', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(getStreams([addon()], 'movie', 'tt1', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).not.toHaveBeenCalled();
    const pending = new AbortController();
    request.mockImplementationOnce(async () => { pending.abort(); return { streams: [] }; });
    await expect(getStreams([addon()], 'movie', 'tt1', pending.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('built-in add-ons', () => {
  it('ships Cinemeta catalogs and metadata without promising Cinemeta streams', () => {
    const cinemeta = defaultAddons().find((item) => item.manifest.id === 'com.linvo.cinemeta')!;
    expect(cinemeta.enabled).toBe(true);
    expect(cinemeta.manifestUrl).toBe('https://v3-cinemeta.strem.io/manifest.json');
    expect(getCatalogSources([cinemeta]).map((source) => `${source.catalog.type}/${source.catalog.id}`)).toEqual(['movie/top', 'series/top']);
    expect(supportsResource(cinemeta, 'meta', 'movie', 'tt1')).toBe(true);
    expect(supportsResource(cinemeta, 'stream', 'movie', 'tt1')).toBe(false);
  });

  it('runs Open Cinema through the same manifest, catalog, metadata, and stream APIs', async () => {
    const open = await loadManifest('vela://open-cinema/manifest.json');
    expect(open.manifest.id).toBe('com.vela.open-cinema');
    const source = getCatalogSources([open])[0];
    const films = await getCatalog(source);
    expect(films.map((film) => film.name)).toEqual(['Big Buck Bunny · Tráiler', 'Sintel · Tráiler']);
    expect(await getCatalog(source, { search: 'sintel' })).toHaveLength(1);
    expect(await getCatalog(source, { genre: 'Animation' })).toHaveLength(2);
    expect(await getCatalog(source, { skip: 3 })).toEqual([]);
    const meta = await getMeta(open, films[0].type, films[0].id);
    expect(meta.description).toContain('Creative Commons Attribution');
    expect((await getStreams([open], 'movie', meta.id))[0].url).toMatch(/^https:\/\//);
    expect(request).not.toHaveBeenCalled();
  });

  it('does not leak mutable built-in state between callers', async () => {
    const first = defaultAddons();
    first[0].manifest.name = 'Changed';
    expect(defaultAddons()[0].manifest.name).toBe('Open Cinema');
  });
});
