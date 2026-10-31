import type { AddonCatalog, AddonManifest, MediaItem } from "./contracts";
import { storage } from "./storage";
import { requestJson } from "./transport";

/**
 * Vela's own catalogs from The Movie Database, with the user's TMDB key: trending and top rated
 * titles, what each streaming service offers in the user's country, «Recomendado para ti» from
 * the library, and catalogs for children's profiles. Everything comes back in the language of
 * Settings › Información. Items carry IMDb ids, so Cinemeta's details and the stream addons work
 * as with any other catalog. (Stremio's «popular in your area» catalogs rely on its users' data
 * and have no equivalent here.)
 */

export const TMDB_CATALOGS_URL = "vela://tmdb/manifest.json";
export const TMDB_CATALOGS_ID = "com.vela.tmdb";
const API = "https://api.themoviedb.org/3";
const IMAGES = "https://image.tmdb.org/t/p";

/** Streaming services with catalogs, by TMDB watch provider id. */
export const providers: { id: number; name: string }[] = [
  { id: 8, name: "Netflix" },
  { id: 119, name: "Prime Video" },
  { id: 337, name: "Disney+" },
  { id: 1899, name: "Max" },
  { id: 350, name: "Apple TV+" },
  { id: 149, name: "Movistar Plus+" },
  { id: 1773, name: "SkyShowtime" },
];

/** TMDB genres (ids are stable; names in Spanish, as Vela's interface). */
const movieGenres: Record<string, number> = {
  Acción: 28, Animación: 16, Aventura: 12, "Ciencia ficción": 878, Comedia: 35, Crimen: 80, Documental: 99, Drama: 18,
  Familia: 10751, Fantasía: 14, Historia: 36, Misterio: 9648, Música: 10402, Romance: 10749, Suspense: 53, Terror: 27, Bélica: 10752, Western: 37,
};
const tvGenres: Record<string, number> = {
  "Acción y aventura": 10759, Animación: 16, Comedia: 35, Crimen: 80, Documental: 99, Drama: 18, Familia: 10751, Infantil: 10762,
  Misterio: 9648, "Ciencia ficción y fantasía": 10765, Reality: 10764, "Bélica y política": 10768, Western: 37,
};

const genreExtra = (type: string) => ({ name: "genre", options: Object.keys(type === "movie" ? movieGenres : tvGenres) });
const skip = { name: "skip" };

function catalog(id: string, type: "movie" | "series", name: string, genres = true): AddonCatalog {
  return { id, type, name, extra: genres ? [genreExtra(type), skip] : [skip] };
}

const both = (id: string, name: string, genres = true) => [catalog(id, "movie", name, genres), catalog(id, "series", name, genres)];

/** Whether a catalog is one a children's profile may see. */
export function kidsCatalog(source: { addon: { manifestUrl: string; manifest: { id: string } }; catalog: { id: string } }): boolean {
  return source.addon.manifestUrl === TMDB_CATALOGS_URL && source.addon.manifest.id === TMDB_CATALOGS_ID && source.catalog.id === "kids";
}

export const tmdbCatalogsManifest: AddonManifest = {
  id: TMDB_CATALOGS_ID,
  name: "TMDB",
  version: "1.0.0",
  description: "Tendencias, mejor valoradas, plataformas de tu país, recomendaciones según tu biblioteca y catálogos infantiles, en tu idioma. Necesita una clave de TMDB.",
  resources: ["catalog"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [
    ...both("recommended", "Recomendado para ti", false),
    ...both("trending", "Tendencias"),
    ...both("top", "Mejor valoradas"),
    ...providers.flatMap((provider) => both(`provider-${provider.id}`, provider.name)),
    catalog("kids", "movie", "Películas infantiles", false),
    catalog("kids", "series", "Series infantiles", false),
  ],
};

type Result = {
  id: number;
  title?: string;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
};
type Page = { results?: Result[] };

export type TmdbContext = {
  apiKey: string;
  /** BCP 47, e.g. "es-ES"; its region picks the streaming services' country. */
  language: string;
  /** IMDb ids of the library, newest first, for recommendations and to leave out what is there. */
  library: { id: string; type: string }[];
  fetchJson?: (url: string) => Promise<unknown>;
};

const PAGE = 20;

/** Supplies the key, language and library at request time (set by the app; keeps this module free of the store). */
let provide: (() => Promise<TmdbContext | null>) | undefined;
export function provideTmdbContext(value: () => Promise<TmdbContext | null>) {
  provide = value;
}

export async function currentTmdbContext(): Promise<TmdbContext> {
  const context = await provide?.();
  if (!context) throw new Error("Los catálogos de TMDB necesitan una clave de TMDB (Ajustes › Información).");
  return context;
}
/** TMDB ids never change their IMDb id: the lookups are kept between sessions (bounded). */
const imdbStorageKey = "vela.tmdb.imdb.v1";
const maxImdbCache = 4000;
const imdbCache = new Map<string, string | null>();
const tmdbIdCache = new Map<string, number | null>();
let imdbLoaded = false;
let imdbSaveTimer: ReturnType<typeof setTimeout> | undefined;

function loadImdbCache() {
  if (imdbLoaded) return;
  imdbLoaded = true;
  try {
    const saved = JSON.parse(storage.getItem(imdbStorageKey) ?? "null") as [string, string | null][] | null;
    if (Array.isArray(saved))
      for (const [key, value] of saved) if (typeof key === "string" && (value === null || /^tt\d+$/.test(value))) imdbCache.set(key, value);
  } catch {
    /* The cache only saves requests. */
  }
}

function saveImdbCache() {
  if (imdbSaveTimer) return;
  imdbSaveTimer = setTimeout(() => {
    imdbSaveTimer = undefined;
    try {
      storage.setItem(imdbStorageKey, JSON.stringify([...imdbCache].slice(-maxImdbCache)));
    } catch {
      /* Full storage: lookups are repeated next time. */
    }
  }, 2000);
}

function url(path: string, params: Record<string, string>, context: TmdbContext): string {
  const language = context.language || "es-ES";
  return `${API}${path}?${new URLSearchParams({ language, ...params, api_key: context.apiKey })}`;
}

/** A TMDB API URL with the context's key and language. */
export const tmdbUrl = url;

export function region(language: string): string {
  return /-([A-Z]{2})$/.exec(language)?.[1] ?? "US";
}

export async function imdbId(kind: "movie" | "tv", id: number, context: TmdbContext): Promise<string | null> {
  const key = `${kind}:${id}`;
  loadImdbCache();
  if (imdbCache.has(key)) return imdbCache.get(key)!;
  const fetchJson = context.fetchJson ?? requestJson;
  let value: string | null = null;
  try {
    const ids = (await fetchJson(url(`/${kind}/${id}/external_ids`, {}, context))) as { imdb_id?: string | null };
    value = ids.imdb_id && /^tt\d+$/.test(ids.imdb_id) ? ids.imdb_id : null;
  } catch {
    return null; // Not cached: a network error should not hide the title for good.
  }
  imdbCache.set(key, value);
  saveImdbCache();
  return value;
}

/** Turns TMDB results into catalog items; titles without an IMDb id are left out (no addon could play them). */
async function items(results: Result[], kind: "movie" | "tv", context: TmdbContext): Promise<MediaItem[]> {
  const type = kind === "movie" ? "movie" : "series";
  const ids: (string | null)[] = [];
  for (let index = 0; index < results.length; index += 8)
    ids.push(...(await Promise.all(results.slice(index, index + 8).map((result) => imdbId(kind, result.id, context)))));
  return results.flatMap((result, index) => {
    const id = ids[index];
    if (!id) return [];
    const date = result.release_date || result.first_air_date;
    const item: MediaItem = {
      id,
      type,
      name: (result.title || result.name || "").trim() || id,
      description: result.overview?.trim() || undefined,
      poster: result.poster_path ? `${IMAGES}/w342${result.poster_path}` : undefined,
      background: result.backdrop_path ? `${IMAGES}/w1280${result.backdrop_path}` : undefined,
      releaseInfo: date ? date.slice(0, 4) : undefined,
      imdbRating: result.vote_average ? result.vote_average.toFixed(1) : undefined,
    };
    return [item];
  });
}

export async function tmdbId(type: string, imdb: string, context: TmdbContext): Promise<number | null> {
  const key = `${type}:${imdb}`;
  if (tmdbIdCache.has(key)) return tmdbIdCache.get(key)!;
  const fetchJson = context.fetchJson ?? requestJson;
  try {
    const found = (await fetchJson(url(`/find/${imdb}`, { external_source: "imdb_id" }, context))) as {
      movie_results?: { id: number }[];
      tv_results?: { id: number }[];
    };
    const id = (type === "series" ? found.tv_results : found.movie_results)?.[0]?.id ?? null;
    tmdbIdCache.set(key, id);
    return id;
  } catch {
    return null;
  }
}

/** Mixes TMDB's recommendations for the latest titles in the library, leaving out what is already there. */
async function recommended(kind: "movie" | "tv", context: TmdbContext, page: number): Promise<Result[]> {
  const type = kind === "movie" ? "movie" : "series";
  const seeds = context.library.filter((entry) => entry.type === type && /^tt\d+$/.test(entry.id)).slice(0, 6);
  if (!seeds.length) return [];
  const fetchJson = context.fetchJson ?? requestJson;
  const lists = await Promise.all(
    seeds.map(async (seed) => {
      const id = await tmdbId(type, seed.id, context);
      if (!id) return [];
      try {
        return ((await fetchJson(url(`/${kind}/${id}/recommendations`, { page: String(page) }, context))) as Page).results ?? [];
      } catch {
        return [];
      }
    }),
  );
  // Round-robin so every seed contributes near the top; repeated titles count once.
  const seen = new Set<number>();
  const merged: Result[] = [];
  for (let index = 0; lists.some((list) => index < list.length); index++)
    for (const list of lists) {
      const result = list[index];
      if (result && !seen.has(result.id)) {
        seen.add(result.id);
        merged.push(result);
      }
    }
  return merged;
}

/** One page of a TMDB catalog. `skip` counts items, as in the addon protocol. */
export async function tmdbCatalog(catalogId: string, type: string, extra: Record<string, string>, context: TmdbContext): Promise<MediaItem[]> {
  const kind = type === "movie" ? "movie" : "tv";
  const page = Math.floor(Number(extra.skip ?? 0) / PAGE) + 1;
  if (page > 20) return [];
  const genre = extra.genre ? (kind === "movie" ? movieGenres : tvGenres)[extra.genre] : undefined;
  const fetchJson = context.fetchJson ?? requestJson;
  const discover = (params: Record<string, string>) =>
    fetchJson(url(`/discover/${kind}`, { page: String(page), include_adult: "false", ...params, ...(genre ? { with_genres: String(genre) } : {}) }, context)) as Promise<Page>;
  let results: Result[] = [];
  if (catalogId === "recommended") {
    const all = await recommended(kind, context, 1);
    const owned = new Set(context.library.map((entry) => entry.id));
    const fresh = await items(all, kind, context);
    return fresh.filter((item) => !owned.has(item.id)).slice((page - 1) * PAGE, page * PAGE);
  } else if (catalogId === "trending") {
    results = genre
      ? (await discover({ sort_by: "popularity.desc" })).results ?? []
      : ((await fetchJson(url(`/trending/${kind}/week`, { page: String(page) }, context))) as Page).results ?? [];
  } else if (catalogId === "top") {
    results = (await discover({ sort_by: "vote_average.desc", "vote_count.gte": kind === "movie" ? "1500" : "500" })).results ?? [];
  } else if (catalogId.startsWith("provider-")) {
    const provider = catalogId.slice("provider-".length);
    results = (await discover({ sort_by: "popularity.desc", with_watch_providers: provider, watch_region: region(context.language), with_watch_monetization_types: "flatrate" })).results ?? [];
  } else if (catalogId === "kids") {
    // Films rated for all audiences in the US (G) in family or animation genres; series in TMDB's Kids genre.
    results = (
      await discover(
        kind === "movie"
          ? { sort_by: "popularity.desc", certification_country: "US", "certification.lte": "G", with_genres: "10751|16" }
          : { sort_by: "popularity.desc", with_genres: "10762" },
      )
    ).results ?? [];
  } else return [];
  return items(results, kind, context);
}
