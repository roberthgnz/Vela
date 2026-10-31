import type {
  AddonCatalog,
  AddonManifest,
  CatalogSource,
  Episode,
  InstalledAddon,
  MediaItem,
  ResolvedStream,
  Stream,
  Subtitle,
} from './contracts';
import { OPEN_CINEMA_URL, openCinemaFilms, openCinemaManifest, openCinemaStreams } from './open-cinema';
import { currentTmdbContext, TMDB_CATALOGS_URL, tmdbCatalog, tmdbCatalogsManifest } from './tmdbCatalogs';
import { requestJson } from './transport';
import { plural, t } from './i18n';

const CINEMETA_URL = 'https://v3-cinemeta.strem.io/manifest.json';
const genres = ['Action', 'Adventure', 'Animation', 'Biography', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Sport', 'Thriller', 'War', 'Western'];
const cinemetaManifest: AddonManifest = {
  id: 'com.linvo.cinemeta',
  name: 'Cinemeta',
  description: 'The official add-on for movie and series catalogs. Install a stream add-on to watch its titles.',
  version: '3.0.14',
  resources: ['catalog', 'meta'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: ['movie', 'series'].map((type) => ({
    id: 'top', type, name: type === 'movie' ? 'Popular movies' : 'Popular series',
    extra: [
      { name: 'genre', options: type === 'series' ? [...genres, 'Reality-TV', 'Talk-Show', 'Game-Show'] : genres },
      { name: 'search' },
      { name: 'skip' },
    ],
  })),
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string.`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((item) => text(item, label));
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : text(value, label);
}

function httpUrl(value: unknown, label: string): string {
  const raw = text(value, label);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${label} must be an HTTP or HTTPS URL.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`${label} must be an HTTP or HTTPS URL without embedded credentials.`);
  return raw;
}

function optionalUrl(value: unknown, label: string): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : httpUrl(value, label);
}

function optionalStrings(value: unknown, label: string): string[] | undefined {
  return value === undefined || value === null ? undefined : strings(value, label);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative integer.`);
  return value;
}

function date(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const result = text(value, label);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label} must be a date.`);
  return result;
}

function catalog(value: unknown): AddonCatalog {
  const item = record(value, 'Catalog');
  let extra: AddonCatalog['extra'];
  if (item.extra !== undefined) {
    if (!Array.isArray(item.extra)) throw new Error('Catalog extras must be an array.');
    extra = item.extra.map((value) => {
      const entry = record(value, 'Catalog extra');
      return {
        name: text(entry.name, 'Extra name'),
        isRequired: optionalBoolean(entry.isRequired, 'Extra isRequired'),
        options: optionalStrings(entry.options, 'Extra options'),
      };
    });
  }
  return {
    id: text(item.id, 'Catalog ID'),
    type: text(item.type, 'Catalog type'),
    // stremio-core treats the name as optional; such catalogs are shown by their ID.
    name: typeof item.name === 'string' && item.name.trim() ? item.name : text(item.id, 'Catalog ID'),
    extra,
    extraSupported: optionalStrings(item.extraSupported, 'Supported extras'),
    extraRequired: optionalStrings(item.extraRequired, 'Required extras'),
  };
}

/**
 * Validates a manifest as leniently as stremio-core, so that every addon the official apps install
 * installs here too: ID, name, semantic version and a resource list are required; description,
 * logo, types, catalogs and per-resource types are optional, and a bad logo is dropped.
 */
function manifest(value: unknown): AddonManifest {
  const item = record(value, 'Manifest');
  const id = text(item.id, 'Manifest ID');
  const version = text(item.version, 'Manifest version');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i.test(version)) throw new Error('Manifest version must use semantic versioning.');
  if (!Array.isArray(item.resources)) throw new Error('Manifest resources must be an array.');
  if (item.catalogs != null && !Array.isArray(item.catalogs)) throw new Error('Manifest catalogs must be an array.');
  let logo: string | undefined;
  try { logo = optionalUrl(item.logo, 'Manifest logo'); } catch { logo = undefined; }
  return {
    id,
    version,
    name: text(item.name, 'Manifest name'),
    description: typeof item.description === 'string' && item.description.trim() ? item.description : undefined,
    logo,
    types: Array.isArray(item.types) ? item.types.filter((type): type is string => typeof type === 'string' && Boolean(type.trim())) : [],
    idPrefixes: optionalStrings(item.idPrefixes, 'Manifest ID prefixes'),
    resources: item.resources.map((value) => {
      if (typeof value === 'string') return text(value, 'Resource name');
      const entry = record(value, 'Resource');
      return {
        name: text(entry.name, 'Resource name'),
        types: optionalStrings(entry.types, 'Resource types'),
        idPrefixes: optionalStrings(entry.idPrefixes, 'Resource ID prefixes'),
      };
    }),
    catalogs: Array.isArray(item.catalogs) ? item.catalogs.map(catalog) : [],
    ...(item.behaviorHints && typeof item.behaviorHints === 'object' && (item.behaviorHints as { adult?: unknown }).adult === true
      ? { behaviorHints: { adult: true } }
      : {}),
  };
}

function episode(value: unknown): Episode {
  const item = record(value, 'Episode');
  return {
    id: text(item.id, 'Episode ID'),
    title: text(item.title ?? item.name, 'Episode title'),
    released: date(item.released, 'Episode release date'),
    season: item.season === undefined ? undefined : nonnegativeInteger(item.season, 'Season'),
    episode: item.episode === undefined ? undefined : nonnegativeInteger(item.episode, 'Episode number'),
    overview: optionalText(item.overview ?? item.description, 'Episode overview'),
    thumbnail: optionalUrl(item.thumbnail, 'Episode thumbnail'),
  };
}

function media(value: unknown): MediaItem {
  const item = record(value, 'Media');
  if (item.videos !== undefined && item.videos !== null && !Array.isArray(item.videos)) throw new Error('Media videos must be an array.');
  return {
    id: text(item.id, 'Media ID'),
    type: text(item.type, 'Media type'),
    name: text(item.name, 'Media name'),
    poster: optionalUrl(item.poster, 'Media poster'),
    background: optionalUrl(item.background, 'Media background'),
    logo: optionalUrl(item.logo, 'Media logo'),
    description: optionalText(item.description, 'Media description'),
    releaseInfo: optionalText(item.releaseInfo, 'Release info'),
    released: date(item.released, 'Media release date'),
    runtime: optionalText(item.runtime, 'Runtime'),
    imdbRating: optionalText(item.imdbRating, 'Rating'),
    genres: optionalStrings(item.genres, 'Genres'),
    cast: optionalStrings(item.cast, 'Cast'),
    director: optionalStrings(item.director, 'Directors'),
    videos: item.videos?.map(episode),
    trailers: trailers(item),
    ...positiveNumber('tmdbId', item.moviedb_id),
    ...positiveNumber('popularity', item.popularity),
  };
}

/** Optional numeric hints of catalog items; anything else is left out. */
function positiveNumber<K extends string>(key: K, value: unknown): Partial<Record<K, number>> {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? ({ [key]: number } as Record<K, number>) : {};
}

/** YouTube trailers, from `trailerStreams` (streams with ytId) or the older `trailers` list. */
function trailers(item: Record<string, unknown>): MediaItem['trailers'] {
  const found = new Map<string, { ytId: string; title?: string }>();
  const add = (ytId: unknown, title?: unknown) => {
    if (typeof ytId === 'string' && /^[\w-]{11}$/.test(ytId) && !found.has(ytId))
      found.set(ytId, { ytId, title: typeof title === 'string' && title.trim() ? title : undefined });
  };
  if (Array.isArray(item.trailerStreams))
    for (const value of item.trailerStreams) if (value && typeof value === 'object') add((value as Record<string, unknown>).ytId, (value as Record<string, unknown>).title);
  if (Array.isArray(item.trailers))
    for (const value of item.trailers)
      if (value && typeof value === 'object' && ((value as Record<string, unknown>).type ?? 'Trailer') === 'Trailer') add((value as Record<string, unknown>).source);
  return found.size ? [...found.values()] : undefined;
}

function subtitle(value: unknown): Subtitle {
  const item = record(value, 'Subtitle');
  return { id: text(item.id, 'Subtitle ID'), lang: text(item.lang, 'Subtitle language'), url: httpUrl(item.url, 'Subtitle URL') };
}

function headers(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  return Object.fromEntries(Object.entries(record(value, 'Proxy headers')).map(([key, value]) => {
    if (/[\r\n]/.test(key)) throw new Error('Invalid proxy header.');
    if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('Invalid proxy header value.');
    return [key, value];
  }));
}

function stream(value: unknown): Stream {
  const item = record(value, 'Stream');
  const result: Stream = {
    name: optionalText(item.name, 'Stream name'),
    title: optionalText(item.title, 'Stream title'),
    description: optionalText(item.description, 'Stream description'),
    url: optionalUrl(item.url, 'Stream URL'),
    externalUrl: optionalUrl(item.externalUrl, 'External stream URL'),
    ytId: optionalText(item.ytId, 'YouTube ID'),
    infoHash: optionalText(item.infoHash, 'Torrent info hash'),
    fileIdx: item.fileIdx === undefined || item.fileIdx === null ? undefined : nonnegativeInteger(item.fileIdx, 'Torrent file index'),
  };
  const sources = Array.isArray(item.sources)
    ? item.sources.filter((source): source is string => typeof source === 'string' && /^(tracker|dht):\S+$/.test(source))
    : [];
  if (sources.length) result.sources = sources;
  if (!result.url && !result.externalUrl && !result.ytId && !result.infoHash) throw new Error('Stream has no supported source.');
  if (result.ytId && !/^[\w-]{11}$/.test(result.ytId)) throw new Error('Invalid YouTube video ID.');
  if (result.infoHash && !/^[a-f\d]{40}$/i.test(result.infoHash)) throw new Error('Invalid torrent info hash.');
  if (item.subtitles !== undefined && item.subtitles !== null) {
    if (!Array.isArray(item.subtitles)) throw new Error('Stream subtitles must be an array.');
    result.subtitles = item.subtitles.map(subtitle);
  }
  if (item.behaviorHints !== undefined && item.behaviorHints !== null) {
    const hints = record(item.behaviorHints, 'Stream behavior hints');
    const proxy = hints.proxyHeaders === undefined ? undefined : record(hints.proxyHeaders, 'Proxy headers');
    result.behaviorHints = {
      filename: optionalText(hints.filename, 'Stream filename'),
      videoHash: optionalText(hints.videoHash, 'Stream video hash'),
      videoSize: hints.videoSize === undefined ? undefined : nonnegativeInteger(hints.videoSize, 'Stream video size'),
      notWebReady: optionalBoolean(hints.notWebReady, 'Stream notWebReady'),
      bingeGroup: typeof hints.bingeGroup === 'string' && hints.bingeGroup.trim() ? hints.bingeGroup : undefined,
      proxyHeaders: proxy ? { request: headers(proxy.request), response: headers(proxy.response) } : undefined,
    };
  }
  return result;
}

function abort(error: unknown, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (error instanceof Error && error.name === 'AbortError') throw error;
}

function builtin(addon: InstalledAddon): boolean {
  return addon.manifestUrl === OPEN_CINEMA_URL && addon.manifest.id === openCinemaManifest.id;
}

export function isTmdbCatalogs(addon: Pick<InstalledAddon, 'manifestUrl' | 'manifest'>): boolean {
  return addon.manifestUrl === TMDB_CATALOGS_URL && addon.manifest.id === tmdbCatalogsManifest.id;
}

export function normalizeManifestUrl(value: string): string {
  let raw = value.trim().replace(/^stremio:\/\//i, 'https://');
  if (raw === OPEN_CINEMA_URL || raw === TMDB_CATALOGS_URL) return raw;
  if (!raw) throw new Error(t('errors.manifestRequired'));
  if (!/^[a-z][a-z\d+.-]*:/i.test(raw)) raw = `https://${raw}`;
  const valid = httpUrl(raw, 'Add-on address');
  const url = new URL(valid);
  if (!url.pathname.endsWith('/manifest.json')) {
    if (url.pathname.endsWith('.json')) throw new Error(t('errors.manifestSuffix'));
    url.pathname = `${url.pathname.replace(/\/$/, '')}/manifest.json`;
  }
  url.hash = '';
  return url.href;
}

export function defaultAddons(): InstalledAddon[] {
  return structuredClone([
    { manifestUrl: OPEN_CINEMA_URL, manifest: openCinemaManifest, enabled: true, installedAt: Date.now() },
    { manifestUrl: CINEMETA_URL, manifest: cinemetaManifest, enabled: true, installedAt: Date.now() },
  ]);
}

export async function loadManifest(value: string, signal?: AbortSignal): Promise<InstalledAddon> {
  signal?.throwIfAborted();
  const manifestUrl = normalizeManifestUrl(value);
  if (manifestUrl === OPEN_CINEMA_URL) return { manifestUrl, manifest: structuredClone(openCinemaManifest), enabled: true, installedAt: Date.now() };
  if (manifestUrl === TMDB_CATALOGS_URL) return { manifestUrl, manifest: structuredClone(tmdbCatalogsManifest), enabled: true, installedAt: Date.now() };
  let response: unknown;
  try { response = await requestJson(manifestUrl, signal); }
  catch (error) { abort(error, signal); throw new Error(t('errors.manifestLoad')); }
  signal?.throwIfAborted();
  return { manifestUrl, manifest: manifest(response), enabled: true, installedAt: Date.now() };
}

export function supportsResource(addon: InstalledAddon, resource: string, type: string, id?: string): boolean {
  if (!addon.enabled) return false;
  if (resource === 'catalog') return addon.manifest.catalogs.some((catalog) => catalog.type === type && (id === undefined || catalog.id === id));
  return addon.manifest.resources.some((entry) => {
    const name = typeof entry === 'string' ? entry : entry.name;
    const types = typeof entry === 'string' ? addon.manifest.types : entry.types ?? addon.manifest.types;
    const prefixes = typeof entry === 'string' ? addon.manifest.idPrefixes : entry.idPrefixes;
    return name === resource && types.includes(type) && (id === undefined || prefixes === undefined || prefixes.some((prefix) => id.startsWith(prefix)));
  });
}

let addonAllowed: (addon: InstalledAddon) => boolean = () => true;

/** Leaves out addons the active profile may not see (adult addons); set by the content filter. */
export function setAddonFilter(allowed: (addon: InstalledAddon) => boolean) {
  addonAllowed = allowed;
}

export function getCatalogSources(addons: InstalledAddon[], type?: string): CatalogSource[] {
  return addons.filter((addon) => addon.enabled && addonAllowed(addon)).flatMap((addon) => addon.manifest.catalogs
    .filter((catalog) => type === undefined || catalog.type === type)
    .map((catalog) => ({ key: JSON.stringify([addon.manifestUrl, catalog.type, catalog.id]), addon, catalog })));
}

function resourceUrl(addon: InstalledAddon, resource: string, type: string, id: string, extra: Record<string, string> = {}): string {
  if ([resource, type, id].some((segment) => !segment || segment === '.' || segment === '..')) throw new Error('Invalid add-on resource identifier.');
  const url = new URL(normalizeManifestUrl(addon.manifestUrl));
  const encoded = Object.entries(extra).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
  const path = [resource, type, id].map(encodeURIComponent).join('/');
  url.pathname = `${url.pathname.slice(0, -'manifest.json'.length)}${path}${encoded ? `/${encoded}` : ''}.json`;
  return url.href;
}

/** Extras a user can choose from a list (genre, year, sort…), as declared by the catalog. */
export function catalogFilters(catalog: AddonCatalog): { name: string; options: string[]; required: boolean }[] {
  return (catalog.extra ?? [])
    .filter((extra) => extra.options?.length && extra.name !== 'search' && extra.name !== 'skip')
    .map((extra) => ({
      name: extra.name,
      options: extra.options!,
      required: Boolean(extra.isRequired || catalog.extraRequired?.includes(extra.name)),
    }));
}

/** Whether a catalog can be browsed without typing: every required extra has a list of options. */
export function browsable(catalog: AddonCatalog): boolean {
  const filters = new Set(catalogFilters(catalog).map((filter) => filter.name));
  const required = [...(catalog.extra ?? []).filter((extra) => extra.isRequired).map((extra) => extra.name), ...catalog.extraRequired ?? []];
  return required.every((name) => filters.has(name) || name === 'skip');
}

export async function getCatalog(source: CatalogSource, options: { search?: string; genre?: string; skip?: number; extra?: Record<string, string> } = {}, signal?: AbortSignal): Promise<MediaItem[]> {
  signal?.throwIfAborted();
  const { addon, catalog } = source;
  if (!supportsResource(addon, 'catalog', catalog.type, catalog.id)) return [];
  const declared = catalog.extra ?? [];
  const supported = new Set([...declared.map((extra) => extra.name), ...catalog.extraSupported ?? [], ...catalog.extraRequired ?? []]);
  const required = new Set([...declared.filter((extra) => extra.isRequired).map((extra) => extra.name), ...catalog.extraRequired ?? []]);
  const extra: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.extra ?? {})) if (value && name !== 'skip' && name !== 'search') extra[name] = value;
  if (options.search?.trim()) extra.search = options.search.trim();
  if (options.genre) extra.genre = options.genre;
  if (options.skip !== undefined) {
    nonnegativeInteger(options.skip, 'Catalog offset');
    if (options.skip > 0 || required.has('skip')) extra.skip = String(options.skip);
  }
  if (Object.keys(extra).some((name) => !supported.has(name)) || [...required].some((name) => !extra[name])) return [];
  if (declared.some((entry) => extra[entry.name] !== undefined && entry.options && !entry.options.includes(extra[entry.name]))) return [];
  if (builtin(addon)) return structuredClone(openCinemaFilms.filter((item) =>
    (!extra.search || `${item.name} ${item.description}`.toLowerCase().includes(extra.search.toLowerCase())) &&
    (!extra.genre || item.genres?.includes(extra.genre))).slice(Number(extra.skip ?? 0)));
  if (isTmdbCatalogs(addon)) {
    const items = await tmdbCatalog(catalog.id, catalog.type, extra, await currentTmdbContext());
    signal?.throwIfAborted();
    return items;
  }
  let response: unknown;
  try { response = await requestJson(resourceUrl(addon, 'catalog', catalog.type, catalog.id, extra), signal); }
  catch (error) { abort(error, signal); throw new Error(t('errors.catalogLoad', { addon: addon.manifest.name })); }
  signal?.throwIfAborted();
  const metas = record(response, 'Catalog response').metas;
  if (!Array.isArray(metas)) throw new Error(t('errors.catalogInvalid'));
  return metas.map(media);
}

export async function getMeta(addon: InstalledAddon, type: string, id: string, signal?: AbortSignal): Promise<MediaItem> {
  signal?.throwIfAborted();
  if (!supportsResource(addon, 'meta', type, id)) throw new Error(t('errors.metaUnsupported'));
  if (builtin(addon)) {
    const item = openCinemaFilms.find((item) => item.id === id && item.type === type);
    if (!item) throw new Error(t('errors.notInOpenCinema'));
    return structuredClone(item);
  }
  let response: unknown;
  try { response = await requestJson(resourceUrl(addon, 'meta', type, id), signal); }
  catch (error) { abort(error, signal); throw new Error(t('errors.metaLoad', { addon: addon.manifest.name })); }
  signal?.throwIfAborted();
  const item = media(record(response, 'Metadata response').meta);
  if (item.id !== id || item.type !== type) throw new Error(t('errors.metaMismatch'));
  return item;
}

async function collect<T>(addons: InstalledAddon[], resource: string, type: string, id: string, fetchItems: (addon: InstalledAddon) => Promise<T[]>, signal?: AbortSignal): Promise<T[]> {
  signal?.throwIfAborted();
  const eligible = addons.filter((addon) => supportsResource(addon, resource, type, id));
  const results = await Promise.allSettled(eligible.map(fetchItems));
  signal?.throwIfAborted();
  for (const result of results) if (result.status === 'rejected') abort(result.reason, signal);
  const successful = results.filter((result) => result.status === 'fulfilled');
  if (results.length && !successful.length) throw new Error(resource === 'stream' ? plural(results.length, 'errors.streamAddonsDown.one', 'errors.streamAddonsDown.other') : plural(results.length, 'errors.subtitleAddonsDown.one', 'errors.subtitleAddonsDown.other'));
  return successful.flatMap((result) => result.value);
}

export async function getStreams(addons: InstalledAddon[], type: string, videoId: string, signal?: AbortSignal): Promise<ResolvedStream[]> {
  return collect(addons.filter((addon) => addonAllowed(addon)), 'stream', type, videoId, async (addon) => {
    const response = builtin(addon) ? { streams: openCinemaStreams(videoId) } : await requestJson(resourceUrl(addon, 'stream', type, videoId), signal);
    const streams = record(response, 'Stream response').streams;
    if (!Array.isArray(streams)) throw new Error('Streams must be an array.');
    return streams.map((item) => ({ ...stream(item), addonName: addon.manifest.name, addonUrl: addon.manifestUrl }));
  }, signal);
}

export async function getSubtitles(addons: InstalledAddon[], type: string, videoId: string, stream?: ResolvedStream, signal?: AbortSignal): Promise<Subtitle[]> {
  signal?.throwIfAborted();
  const embedded = stream?.subtitles?.map(subtitle) ?? [];
  const hints = stream?.behaviorHints;
  const extra: Record<string, string> = {};
  if (hints?.videoHash) extra.videoHash = hints.videoHash;
  if (hints?.videoSize !== undefined) extra.videoSize = String(hints.videoSize);
  if (hints?.filename) extra.filename = hints.filename;
  let fetched: Subtitle[];
  try {
    fetched = await collect(addons, 'subtitles', type, videoId, async (addon) => {
      const response = record(await requestJson(resourceUrl(addon, 'subtitles', type, videoId, extra), signal), 'Subtitle response');
      if (!Array.isArray(response.subtitles)) throw new Error('Subtitles must be an array.');
      return response.subtitles.map(subtitle);
    }, signal);
  } catch (error) {
    abort(error, signal);
    if (!embedded.length) throw error;
    fetched = [];
  }
  return [...new Map([...embedded, ...fetched].map((item) => [`${item.lang}:${item.url}`, item])).values()];
}

/**
 * Offset for the next catalog page, or undefined when there is none. The offset counts every
 * item received (as the addon paginates), but paging stops when a page brings no title that was
 * not already shown: addons that ignore `skip` would otherwise be asked for the same page forever.
 */
export function nextCatalogSkip(pages: MediaItem[][], supportsSkip: boolean): number | undefined {
  const last = pages.at(-1);
  if (!supportsSkip || !last?.length) return undefined;
  const earlier = new Set(pages.slice(0, -1).flat().map((item) => `${item.type}\u0000${item.id}`));
  if (pages.length > 1 && last.every((item) => earlier.has(`${item.type}\u0000${item.id}`))) return undefined;
  return pages.reduce((sum, page) => sum + page.length, 0);
}
