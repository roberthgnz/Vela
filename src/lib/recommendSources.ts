import type { QueryClient } from "@tanstack/react-query";
import type { CatalogSource, MediaItem } from "./contracts";
import { getCatalog } from "./protocol";
import { canonicalGenres, enrichSeeds, followedPerson, peopleOf, rank, tasteProfile, yearFrom, type Candidate, type Genre, type Seed } from "./recommend";
import { mediaKey } from "./store";
import { imdbId, tmdbId, tmdbUrl, type TmdbContext } from "./tmdbCatalogs";
import { requestJson } from "./transport";

/**
 * The candidates the recommendation engine ranks.
 *
 * - Catalogs (always): Cinemeta's popular and best rated titles, overall and in the user's
 *   favourite genres, for the types the user watches. Without Cinemeta, any Home catalog.
 * - TMDB (with a key): each strong seed's recommendations and similar titles (the item-to-item
 *   neighbours), the seeds' own genres, people and language, and the filmography of the person
 *   the user follows most. TMDB titles need an IMDb id to play, so only the most promising are
 *   looked up.
 */

export type Pool = {
  candidates: Candidate[];
  /** Candidates by person name, for «Más de…». */
  personPools: Record<string, Candidate[]>;
  /** Features of the seeds learned from TMDB, by seed key. */
  seedFeatures: Record<string, Partial<Pick<Seed, "genres" | "people" | "year" | "language">>>;
};

const CINEMETA = "com.linvo.cinemeta";
const IMAGES = "https://image.tmdb.org/t/p";
const STALE = 30 * 60_000;
const MIN_VOTES = 80;

type TmdbResult = {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  genre_ids?: number[];
  original_language?: string;
  job?: string;
};
type TmdbDetails = {
  genres?: { id: number; name: string }[];
  original_language?: string;
  release_date?: string;
  first_air_date?: string;
  created_by?: { id: number; name: string }[];
  credits?: { cast?: { id: number; name: string }[]; crew?: { id: number; name: string; job?: string }[] };
  recommendations?: { results?: TmdbResult[] };
  similar?: { results?: TmdbResult[] };
};

/** A catalog item as a candidate; `position` is its place in a popularity-ordered list, if any. */
export function catalogCandidate(item: MediaItem, addonUrl: string, position?: number): Candidate {
  const rating = Number.parseFloat(item.imdbRating ?? "");
  return {
    item,
    addonUrl,
    genres: canonicalGenres(item.genres),
    people: peopleOf(item),
    year: yearFrom(item.releaseInfo ?? item.released),
    rating: Number.isFinite(rating) && rating > 0 ? rating : undefined,
    popularity: position === undefined ? 0.25 : Math.max(0.05, 1 - position / 160),
  };
}

/** A TMDB result as a candidate, still keyed by its TMDB id (`tmdb:<kind>:<id>`) until its IMDb id is known. */
export function tmdbCandidate(result: TmdbResult, kind: "movie" | "tv", addonUrl: string): Candidate {
  const date = result.release_date || result.first_air_date;
  return {
    item: {
      id: `tmdb:${kind}:${result.id}`,
      type: kind === "movie" ? "movie" : "series",
      name: (result.title || result.name || "").trim(),
      description: result.overview?.trim() || undefined,
      poster: result.poster_path ? `${IMAGES}/w342${result.poster_path}` : undefined,
      background: result.backdrop_path ? `${IMAGES}/w1280${result.backdrop_path}` : undefined,
      releaseInfo: date ? date.slice(0, 4) : undefined,
      imdbRating: result.vote_average ? result.vote_average.toFixed(1) : undefined,
    },
    addonUrl,
    genres: canonicalGenres(result.genre_ids),
    people: [],
    year: yearFrom(date),
    rating: result.vote_average || undefined,
    votes: result.vote_count,
    popularity: result.popularity ? Math.min(1, Math.log10(1 + result.popularity) / 2.8) : undefined,
    language: result.original_language,
  };
}

async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += size) results.push(...(await Promise.all(items.slice(index, index + size).map(run))));
  return results;
}

/** Types worth fetching: those with a real share of the user's taste. */
function wantedTypes(seeds: Seed[]): ("movie" | "series")[] {
  const positive = seeds.filter((seed) => seed.weight > 0);
  const total = positive.reduce((sum, seed) => sum + seed.weight, 0) || 1;
  const share = (type: string) => positive.filter((seed) => seed.type === type).reduce((sum, seed) => sum + seed.weight, 0) / total;
  const types = (["movie", "series"] as const).filter((type) => share(type) >= 0.12);
  return types.length ? [...types] : ["movie", "series"];
}

function topGenres(seeds: Seed[], count: number): Genre[] {
  return [...tasteProfile(seeds).favourites.entries()]
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([genre]) => genre);
}

/**
 * Catalog candidates: popular and best rated, overall and per favourite genre. Each request is a
 * cached query of its own, shared with Home's rows and between pools, and runs with its own
 * signal: cancelling one pool never empties another's lists.
 */
export async function catalogPool(sources: CatalogSource[], seeds: Seed[], client: QueryClient): Promise<Pick<Pool, "candidates" | "personPools">> {
  const types = wantedTypes(seeds);
  const genres = topGenres(seeds, 3);
  const cinemeta = sources.filter((source) => source.addon.manifest.id === CINEMETA);
  const requests: { source: CatalogSource; genre?: string; skip?: number; ranked: boolean }[] = [];
  for (const type of types) {
    const top = cinemeta.find((source) => source.catalog.type === type && source.catalog.id === "top");
    const best = cinemeta.find((source) => source.catalog.type === type && source.catalog.id === "imdbRating");
    if (top) requests.push({ source: top, ranked: true }, { source: top, skip: 50, ranked: true });
    for (const genre of genres) {
      const offered = (source?: CatalogSource) => source?.catalog.extra?.find((extra) => extra.name === "genre")?.options?.includes(genre);
      if (top && offered(top)) requests.push({ source: top, genre, ranked: true });
      if (best && offered(best)) requests.push({ source: best, genre, ranked: false });
    }
  }
  if (!requests.length)
    // No Cinemeta: whatever catalogs Home shows, unfiltered.
    for (const source of sources
      .filter((source) => types.includes(source.catalog.type as "movie" | "series"))
      .filter((source) => !source.catalog.extra?.some((extra) => extra.isRequired) && !source.catalog.extraRequired?.length)
      .slice(0, 8))
      requests.push({ source, ranked: true });
  const lists = await Promise.all(
    requests.map(async ({ source, genre, skip, ranked }) => {
      try {
        const items = await client.fetchQuery({
          // The unfiltered first page is the one Home's own row loads: shared, not fetched twice.
          queryKey: genre || skip ? ["recommend-catalog", source.key, genre ?? "", skip ?? 0] : ["catalog", source.key, ""],
          queryFn: ({ signal }) => getCatalog(source, { genre, skip }, signal),
          staleTime: STALE,
        });
        return items.map((item, index) =>
          catalogCandidate(item, source.addon.manifestUrl, ranked ? (genre ? index * 1.6 : index + (skip ?? 0)) : undefined),
        );
      } catch {
        return []; // One failing catalog only narrows the pool.
      }
    }),
  );
  const candidates = lists.flat().filter((candidate) => candidate.item.type === "movie" || candidate.item.type === "series");
  return { candidates, personPools: await searchPerson(cinemeta, seeds, types, client) };
}

/**
 * «Más de…» without TMDB: Cinemeta's search also matches people, so searching the name of the
 * person the user follows lists their work. Titles about the person (documentaries, featurettes)
 * carry the name and are left out.
 */
async function searchPerson(
  cinemeta: CatalogSource[],
  seeds: Seed[],
  types: string[],
  client: QueryClient,
): Promise<Pool["personPools"]> {
  const person = followedPerson(tasteProfile(seeds));
  if (!person) return {};
  const surname = person.split(" ").at(-1)!.toLocaleLowerCase();
  const searchable = cinemeta.filter(
    (source) => types.includes(source.catalog.type) && source.catalog.extra?.some((extra) => extra.name === "search"),
  );
  const lists = await Promise.all(
    searchable.map(async (source) => {
      try {
        const items = await client.fetchQuery({
          queryKey: ["recommend-person-search", source.key, person],
          queryFn: ({ signal }) => getCatalog(source, { search: person }, signal),
          staleTime: STALE,
        });
        return items
          .filter((item) => !item.name.toLocaleLowerCase().includes(surname))
          .slice(0, 20)
          .map((item, index) => ({ ...catalogCandidate(item, source.addon.manifestUrl, index), people: [person] }));
      } catch {
        return [];
      }
    }),
  );
  return { [person]: lists.flat() };
}

type SeedNeighbours = {
  seed: Seed;
  features: Pool["seedFeatures"][string];
  related: { result: TmdbResult; kind: "movie" | "tv"; position: number }[];
  people: Map<string, number>;
};

async function seedNeighbours(seed: Seed, context: TmdbContext, client: QueryClient): Promise<SeedNeighbours | null> {
  if (!/^tt\d+$/.test(seed.id) || (seed.type !== "movie" && seed.type !== "series")) return null;
  const kind: "movie" | "tv" = seed.type === "movie" ? "movie" : "tv";
  const fetchJson = context.fetchJson ?? requestJson;
  let details: TmdbDetails;
  try {
    details = await client.fetchQuery({
      queryKey: ["recommend-tmdb", kind, seed.id, context.language],
      queryFn: async () => {
        const id = await tmdbId(seed.type, seed.id, context);
        if (!id) return {};
        return (await fetchJson(tmdbUrl(`/${kind}/${id}`, { append_to_response: "recommendations,similar,credits" }, context))) as TmdbDetails;
      },
      staleTime: 24 * 60 * 60_000,
      gcTime: 24 * 60 * 60_000,
    });
  } catch {
    return null;
  }
  const people = new Map<string, number>();
  const directors = [...(details.created_by ?? []), ...(details.credits?.crew ?? []).filter((person) => person.job === "Director")].slice(0, 2);
  for (const person of [...directors, ...(details.credits?.cast ?? []).slice(0, 5)]) people.set(person.name, person.id);
  const related = [
    ...(details.recommendations?.results ?? []).map((result, position) => ({ result, kind, position })),
    // Similar titles share keywords and genres, a weaker signal than «people who liked this also liked».
    ...(details.similar?.results ?? []).map((result, position) => ({ result, kind, position: position + 10 })),
  ];
  return {
    seed,
    features: {
      genres: canonicalGenres(details.genres?.map((genre) => genre.id)),
      people: [...people.keys()],
      year: yearFrom(details.release_date || details.first_air_date),
      language: details.original_language,
    },
    related,
    people,
  };
}

/** Swaps TMDB ids for IMDb ids; titles without one are dropped (no addon could play them). */
async function withImdb(candidates: Candidate[], context: TmdbContext): Promise<Candidate[]> {
  // TMDB allows about 50 requests a second; 16 at a time keeps a first visit to a few seconds.
  const resolved = await inBatches(candidates, 16, async (candidate) => {
    const [, kind, id] = candidate.item.id.split(":");
    const imdb = await imdbId(kind as "movie" | "tv", Number(id), context);
    return imdb ? { ...candidate, item: { ...candidate.item, id: imdb } } : null;
  });
  return resolved.filter((candidate): candidate is Candidate => Boolean(candidate));
}

/** TMDB candidates: neighbours of the strongest seeds, and the work of the person the user follows most. */
export async function tmdbPool(
  seeds: Seed[],
  context: TmdbContext,
  addonUrl: string,
  client: QueryClient,
  exclude: Set<string>,
): Promise<Pool> {
  const positive = seeds.filter((seed) => seed.weight > 0).slice(0, 8);
  const negative = seeds.filter((seed) => seed.weight < 0).slice(0, 3);
  const found = (await inBatches([...positive, ...negative], 11, (seed) => seedNeighbours(seed, context, client))).filter(
    (value): value is SeedNeighbours => Boolean(value),
  );
  const seedFeatures: Pool["seedFeatures"] = {};
  const stubs = new Map<string, Candidate>();
  const personIds = new Map<string, number>();
  for (const { seed, features, related, people } of found) {
    seedFeatures[seed.key] = features;
    if (seed.weight > 0) for (const [name, id] of people) personIds.set(name, id);
    for (const { result, kind, position } of related) {
      // Titles almost nobody rated are noise in «similar» lists (shorts, unreleased, mislabelled).
      if ((result.vote_count ?? 0) < MIN_VOTES) continue;
      const stub = stubs.get(`${kind}:${result.id}`) ?? tmdbCandidate(result, kind, addonUrl);
      stub.neighbours = { ...stub.neighbours, [seed.key]: Math.min(position, stub.neighbours?.[seed.key] ?? Infinity) };
      stubs.set(`${kind}:${result.id}`, stub);
    }
  }
  const enriched = enrichSeeds(seeds, seedFeatures);
  // Only the most promising neighbours are worth an IMDb lookup each.
  const preliminary = rank([...stubs.values()], enriched, tasteProfile(enriched), { jitter: 0 }).filter((item) => item.score > 0);
  const candidates = await withImdb(preliminary.slice(0, 110), context);

  const personPools: Pool["personPools"] = {};
  const taste = tasteProfile(enriched);
  const person = followedPerson(taste, (name) => personIds.has(name));
  if (person) {
    try {
      const credits = await client.fetchQuery({
        queryKey: ["recommend-person", personIds.get(person), context.language],
        queryFn: async () =>
          (await (context.fetchJson ?? requestJson)(tmdbUrl(`/person/${personIds.get(person)}/combined_credits`, {}, context))) as {
            cast?: TmdbResult[];
            crew?: TmdbResult[];
          },
        staleTime: 24 * 60 * 60_000,
      });
      const works = [...(credits.cast ?? []), ...(credits.crew ?? []).filter((work) => work.job === "Director")]
        .filter((work) => work.media_type === "movie" || work.media_type === "tv")
        // Talk shows and award galas list everyone; real roles have votes.
        .filter((work) => (work.vote_count ?? 0) >= 50 && !(work.genre_ids ?? []).some((genre) => genre === 10767 || genre === 10763))
        .sort((a, b) => (b.vote_count ?? 0) - (a.vote_count ?? 0));
      const unique = [...new Map(works.map((work) => [`${work.media_type}:${work.id}`, work])).values()].slice(0, 30);
      const pool = await withImdb(
        unique.map((work) => ({ ...tmdbCandidate(work, work.media_type as "movie" | "tv", addonUrl), people: [person] })),
        context,
      );
      personPools[person] = pool.filter((candidate) => !exclude.has(mediaKey(candidate.item.type, candidate.item.id)));
    } catch {
      /* No «Más de…» row this time. */
    }
  }
  return { candidates, personPools, seedFeatures };
}
