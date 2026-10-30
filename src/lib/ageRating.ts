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

type Find = { movie_results?: { id: number }[]; tv_results?: { id: number }[] };
type ReleaseDates = { results?: { iso_3166_1: string; release_dates?: { certification?: string }[] }[] };
type ContentRatings = { results?: { iso_3166_1: string; rating?: string }[] };
type Details = { adult?: boolean; release_dates?: ReleaseDates; content_ratings?: ContentRatings };

/**
 * Looks up a title's rating. With its TMDB id (Cinemeta's catalogs carry it) that is one request:
 * the details with the ratings appended; otherwise TMDB is searched by IMDb id first.
 * `fetchJson` receives TMDB paths without the key (added by the caller).
 */
export async function lookupRating(
  title: { id: string; type: string; tmdbId?: number },
  fetchJson: (path: string, params?: Record<string, string>) => Promise<unknown>,
): Promise<TitleRating> {
  let kind: "movie" | "tv" = title.type === "series" ? "tv" : "movie";
  let id = title.tmdbId;
  if (!id) {
    const found = (await fetchJson(`/find/${title.id}`, { external_source: "imdb_id" })) as Find;
    const preferred = kind === "tv" ? found.tv_results : found.movie_results;
    const other = kind === "tv" ? found.movie_results : found.tv_results;
    if (preferred?.[0]) id = preferred[0].id;
    else if (other?.[0]) {
      id = other[0].id;
      kind = kind === "tv" ? "movie" : "tv";
    } else return { adult: false, age: null };
  }
  const append = kind === "movie" ? "release_dates" : "content_ratings";
  const details = (await fetchJson(`/${kind}/${id}`, { append_to_response: append })) as Details;
  const byCountry =
    kind === "movie"
      ? (details.release_dates?.results ?? []).map((item) => ({
          country: item.iso_3166_1,
          certifications: (item.release_dates ?? []).map((date) => date.certification ?? ""),
        }))
      : (details.content_ratings?.results ?? []).map((item) => ({ country: item.iso_3166_1, certifications: [item.rating ?? ""] }));
  return { adult: Boolean(details.adult), age: pickAge(byCountry) };
}

export type AgeLimit = { maxAge?: number; hideUnrated?: boolean };

/** Whether a rated title fits a profile's limit (`undefined` limit: everything fits). */
export function fitsLimit(rating: TitleRating, limit: AgeLimit): boolean {
  if (rating.adult) return false;
  if (limit.maxAge === undefined) return true;
  if (rating.age === null) return !limit.hideUnrated;
  return rating.age <= limit.maxAge;
}
