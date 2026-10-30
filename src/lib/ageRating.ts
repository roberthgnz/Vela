/**
 * Age ratings from TMDB (https://developer.themoviedb.org/reference/movie-release-dates and
 * /tv-series-content-ratings), turned into a minimum age. Spain's rating is preferred, then the
 * United States', then any other numeric one.
 */

export type TitleRating = {
  /** TMDB marks pornographic titles as `adult`. */
  adult: boolean;
  /** Minimum age (0 = all audiences); null when no country rates it. */
  age: number | null;
};

const named: Record<string, number> = {
  // Spain (ICAA for films, CNMC for television).
  A: 0,
  AI: 0,
  TP: 0,
  INFANTIL: 0,
  X: 18,
  // United States (MPA and TV Parental Guidelines).
  G: 0,
  PG: 7,
  "PG-13": 13,
  R: 17,
  "NC-17": 18,
  "TV-Y": 0,
  "TV-Y7": 7,
  "TV-G": 0,
  "TV-PG": 10,
  "TV-14": 14,
  "TV-MA": 17,
  // Common elsewhere.
  U: 0,
  "ALL": 0,
  L: 0,
};

/** The minimum age a certification stands for, or null when it is empty or unknown. */
export function certificationAge(certification: string): number | null {
  const value = certification.trim().toUpperCase();
  if (!value) return null;
  if (value in named) return named[value];
  const digits = /^\+?(\d{1,2})\+?$/.exec(value) ?? /^(?:[A-Z]+[-\s]?)?(\d{1,2})\+?$/.exec(value);
  if (!digits) return null;
  const age = Number(digits[1]);
  return age <= 21 ? age : null;
}

/** Picks the age from the certifications of each country: Spain, then the US, then the strictest. */
export function pickAge(byCountry: { country: string; certifications: string[] }[]): number | null {
  const ages = (country: string) =>
    byCountry
      .filter((item) => item.country === country)
      .flatMap((item) => item.certifications.map(certificationAge))
      .filter((age): age is number => age !== null);
  for (const country of ["ES", "US"]) {
    const found = ages(country);
    if (found.length) return Math.max(...found);
  }
  const others = byCountry.flatMap((item) => item.certifications.map(certificationAge)).filter((age): age is number => age !== null);
  return others.length ? Math.max(...others) : null;
}

type Find = { movie_results?: { id: number; adult?: boolean }[]; tv_results?: { id: number; adult?: boolean }[] };
type ReleaseDates = { results?: { iso_3166_1: string; release_dates?: { certification?: string }[] }[] };
type ContentRatings = { results?: { iso_3166_1: string; rating?: string }[] };

/** Looks up a title by IMDb id. `fetchJson` receives TMDB URLs without the key (added by the caller). */
export async function lookupRating(
  imdbId: string,
  type: string,
  fetchJson: (path: string, params?: Record<string, string>) => Promise<unknown>,
): Promise<TitleRating> {
  const found = (await fetchJson(`/find/${imdbId}`, { external_source: "imdb_id" })) as Find;
  const series = type === "series";
  const hit = (series ? found.tv_results : found.movie_results)?.[0] ?? (series ? found.movie_results : found.tv_results)?.[0];
  if (!hit) return { adult: false, age: null };
  const kind = found.tv_results?.[0] === hit ? "tv" : "movie";
  if (kind === "movie") {
    const dates = (await fetchJson(`/movie/${hit.id}/release_dates`)) as ReleaseDates;
    return {
      adult: Boolean(hit.adult),
      age: pickAge(
        (dates.results ?? []).map((item) => ({
          country: item.iso_3166_1,
          certifications: (item.release_dates ?? []).map((date) => date.certification ?? ""),
        })),
      ),
    };
  }
  const ratings = (await fetchJson(`/tv/${hit.id}/content_ratings`)) as ContentRatings;
  return {
    adult: Boolean(hit.adult),
    age: pickAge((ratings.results ?? []).map((item) => ({ country: item.iso_3166_1, certifications: [item.rating ?? ""] }))),
  };
}

export type AgeLimit = { maxAge?: number; hideUnrated?: boolean };

/** Whether a rated title fits a profile's limit (`undefined` limit: everything fits). */
export function fitsLimit(rating: TitleRating, limit: AgeLimit): boolean {
  if (rating.adult) return false;
  if (limit.maxAge === undefined) return true;
  if (rating.age === null) return !limit.hideUnrated;
  return rating.age <= limit.maxAge;
}
