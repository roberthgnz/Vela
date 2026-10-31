import type { LibraryEntry, MediaItem } from "./contracts";
import { mediaKey } from "./store";
import type { TasteState } from "./taste";
import { t } from "./i18n";

/**
 * Vela's recommendation engine: a hybrid ranker in the spirit of a streaming service's home page.
 *
 * 1. Signals. Every title the user touched becomes a weighted seed: finished, binged, started,
 *    saved, abandoned, liked or disliked, decaying with time.
 * 2. Taste profile. Genres (weighted by how rare they are in the pool, like TF-IDF), people,
 *    movie/series mix, era and original language, learned from the seeds.
 * 3. Candidates. Titles from the catalogs and, with a TMDB key, the titles TMDB relates to each
 *    seed (item-to-item neighbours, the collaborative part).
 * 4. Ranking. Neighbour evidence + content match + people + quality (Bayesian average) +
 *    popularity, scaled by type, era and language fit; disliked neighbours are pushed down.
 * 5. Page. A billboard, «Elegidos para ti» re-ranked for diversity (MMR), «Porque viste…»,
 *    genre and people rows, hidden gems and new releases, without showing a title too often.
 *
 * Everything here is pure; `recommendSources` fetches the candidates.
 */

/** Genres in one vocabulary: Cinemeta's English names (also the values its catalogs filter by). */
export type Genre = string;

const tmdbGenreIds: Record<number, Genre[]> = {
  28: ["Action"], 12: ["Adventure"], 16: ["Animation"], 35: ["Comedy"], 80: ["Crime"], 99: ["Documentary"], 18: ["Drama"],
  10751: ["Family"], 14: ["Fantasy"], 36: ["History"], 27: ["Horror"], 10402: ["Music"], 9648: ["Mystery"], 10749: ["Romance"],
  878: ["Sci-Fi"], 53: ["Thriller"], 10752: ["War"], 37: ["Western"], 10759: ["Action", "Adventure"], 10762: ["Family"],
  10764: ["Reality-TV"], 10765: ["Sci-Fi", "Fantasy"], 10766: ["Drama"], 10767: ["Talk-Show"], 10768: ["War"],
};

/** Names a genre can arrive with (Cinemeta, TMDB in Spanish or English), lower case. */
const genreAliases: Record<string, Genre[]> = {
  action: ["Action"], acción: ["Action"], adventure: ["Adventure"], aventura: ["Adventure"],
  "action & adventure": ["Action", "Adventure"], "acción y aventura": ["Action", "Adventure"],
  animation: ["Animation"], animación: ["Animation"], biography: ["Biography"], biografía: ["Biography"],
  comedy: ["Comedy"], comedia: ["Comedy"], crime: ["Crime"], crimen: ["Crime"], documentary: ["Documentary"],
  documental: ["Documentary"], drama: ["Drama"], soap: ["Drama"], telenovela: ["Drama"], family: ["Family"],
  familia: ["Family"], kids: ["Family"], infantil: ["Family"], fantasy: ["Fantasy"], fantasía: ["Fantasy"],
  history: ["History"], historia: ["History"], horror: ["Horror"], terror: ["Horror"], music: ["Music"],
  musical: ["Music"], música: ["Music"], mystery: ["Mystery"], misterio: ["Mystery"], romance: ["Romance"],
  "sci-fi": ["Sci-Fi"], "science fiction": ["Sci-Fi"], "ciencia ficción": ["Sci-Fi"],
  "sci-fi & fantasy": ["Sci-Fi", "Fantasy"], "ciencia ficción y fantasía": ["Sci-Fi", "Fantasy"],
  sport: ["Sport"], deporte: ["Sport"], thriller: ["Thriller"], suspense: ["Thriller"], war: ["War"],
  bélica: ["War"], "war & politics": ["War"], "bélica y política": ["War"], western: ["Western"],
  "reality-tv": ["Reality-TV"], reality: ["Reality-TV"], "talk-show": ["Talk-Show"], talk: ["Talk-Show"],
  "game-show": ["Game-Show"],
};

/** Spanish name of each genre and how a row says «because you like…». */
const genreNames: Record<Genre, [label: string, phrase: string]> = {
  Action: [t("recommend.genre.action"), t("recommend.genre.action.phrase")], Adventure: [t("recommend.genre.adventure"), t("recommend.genre.adventure.phrase")], Animation: [t("recommend.genre.animation"), t("recommend.genre.animation.phrase")],
  Biography: [t("recommend.genre.biography"), t("recommend.genre.biography.phrase")], Comedy: [t("recommend.genre.comedy"), t("recommend.genre.comedy.phrase")], Crime: [t("recommend.genre.crime"), t("recommend.genre.crime.phrase")],
  Documentary: [t("recommend.genre.documentary"), t("recommend.genre.documentary.phrase")], Drama: [t("recommend.genre.drama"), t("recommend.genre.drama.phrase")], Family: [t("recommend.genre.family"), t("recommend.genre.family.phrase")],
  Fantasy: [t("recommend.genre.fantasy"), t("recommend.genre.fantasy.phrase")], History: [t("recommend.genre.history"), t("recommend.genre.history.phrase")], Horror: [t("recommend.genre.horror"), t("recommend.genre.horror.phrase")],
  Music: [t("recommend.genre.music"), t("recommend.genre.music.phrase")], Mystery: [t("recommend.genre.mystery"), t("recommend.genre.mystery.phrase")], Romance: [t("recommend.genre.romance"), t("recommend.genre.romance.phrase")],
  "Sci-Fi": [t("recommend.genre.sciFi"), t("recommend.genre.sciFi.phrase")], Sport: [t("recommend.genre.sport"), t("recommend.genre.sport.phrase")], Thriller: [t("recommend.genre.thriller"), t("recommend.genre.thriller.phrase")],
  War: [t("recommend.genre.war"), t("recommend.genre.war.phrase")], Western: [t("recommend.genre.western"), t("recommend.genre.western.phrase")], "Reality-TV": [t("recommend.genre.reality"), t("recommend.genre.reality.phrase")],
  "Talk-Show": [t("recommend.genre.talkShow"), t("recommend.genre.talkShow.phrase")], "Game-Show": [t("recommend.genre.gameShow"), t("recommend.genre.gameShow.phrase")],
};

export function genreLabel(genre: Genre): string {
  return genreNames[genre]?.[0] ?? genre;
}

/** «te gusta el drama», «te gustan los documentales». */
export function likesGenre(genre: Genre): string {
  const phrase = genrePhrase(genre);
  return t(/^(los|las) /.test(phrase) ? "recommend.likesPlural" : "recommend.likes", { phrase });
}

export function genrePhrase(genre: Genre): string {
  return genreNames[genre]?.[1] ?? genre.toLocaleLowerCase("es");
}

/** Genres in the common vocabulary; TMDB ids or names in either language. Unknown names are dropped. */
export function canonicalGenres(values: readonly (string | number)[] | undefined): Genre[] {
  const genres = new Set<Genre>();
  for (const value of values ?? []) {
    const found = typeof value === "number" ? tmdbGenreIds[value] : genreAliases[value.trim().toLocaleLowerCase("es")];
    for (const genre of found ?? []) genres.add(genre);
  }
  return [...genres];
}

/** A title that may be recommended, with the features the ranker uses. */
export type Candidate = {
  /** Shown and opened as any catalog item. */
  item: MediaItem;
  addonUrl: string;
  genres: Genre[];
  /** Cast and directors. */
  people: string[];
  year?: number;
  /** 0–10. */
  rating?: number;
  votes?: number;
  /** 0–1, from the catalog position or TMDB's popularity. */
  popularity?: number;
  /** ISO 639-1 original language, when known. */
  language?: string;
  /** Item-to-item evidence: seed key → position of this title among that seed's related titles (0 is first). */
  neighbours?: Record<string, number>;
};

export type Seed = {
  key: string;
  type: string;
  id: string;
  name: string;
  /** How much this title says about the user's taste; negative for dislikes. */
  weight: number;
  genres: Genre[];
  people: string[];
  year?: number;
  language?: string;
  /** Last interaction (ms). */
  at: number;
  /** What made it a seed: playing it, a «Me gusta», or only adding it to the library. */
  origin: SeedOrigin;
};

export type SeedOrigin = "played" | "liked" | "saved";

const DAY = 86_400_000;

export function yearFrom(value?: string): number | undefined {
  const year = Number(/\d{4}/.exec(value ?? "")?.[0]);
  return year > 1870 && year < 2200 ? year : undefined;
}

/** Directors first, then the leading cast. */
export function peopleOf(meta: Pick<MediaItem, "cast" | "director">): string[] {
  return [...new Set([...(meta.director ?? []).slice(0, 2), ...(meta.cast ?? []).slice(0, 5)].map((name) => name.trim()).filter(Boolean))];
}

/** Episodes finished, from the per-video history. */
function finishedEpisodes(entry: LibraryEntry): number {
  return Object.values(entry.videos ?? {}).filter(
    (video) => video.watched === true || (video.watched !== false && video.duration > 0 && video.seconds >= video.duration * 0.9),
  ).length;
}

/** Whether the user has played any of a title (then it is not recommended again). */
export function played(entry: LibraryEntry): boolean {
  const progress = entry.progress;
  if (entry.watchedAt || finishedEpisodes(entry) > 0) return true;
  if (progress && progress.duration === 0 && progress.seconds === 0) return entry.meta.type === "series";
  return Boolean(progress && progress.duration > 0 && progress.seconds / progress.duration > 0.03);
}

/**
 * How strongly one library entry speaks for the user's taste, before time decay. Finishing is the
 * clearest signal; binging a series grows with the episodes; a title dropped early says little.
 */
export function interactionStrength(entry: LibraryEntry, now: number): number {
  const progress = entry.progress;
  const fraction = progress && progress.duration > 0 ? Math.min(1, progress.seconds / progress.duration) : 0;
  const episodes = finishedEpisodes(entry);
  let strength = 0;
  if (entry.watchedAt) strength = 1;
  if (entry.meta.type === "series" && episodes > 0) strength = Math.max(strength, 0.55 + 0.45 * Math.min(1, Math.log2(1 + episodes) / 4));
  // Pointing to the next episode means at least one was finished.
  if (progress && progress.duration === 0 && progress.seconds === 0 && entry.meta.type === "series") strength = Math.max(strength, 0.6);
  if (fraction > 0.03) {
    let started = 0.3 + 0.6 * fraction;
    // Dropped early and not touched for three weeks: a weak signal, not a recommendation engine's favourite.
    if (fraction < 0.2 && now - progress!.updatedAt > 21 * DAY && !entry.watchedAt && !episodes) started *= 0.35;
    strength = Math.max(strength, started);
  }
  if (entry.saved) strength = Math.max(strength, 0.45);
  return strength;
}

/** Halves every `halfLife` days, but an old favourite still counts for something. */
export function recency(at: number, now: number, halfLife = 120): number {
  const age = Math.max(0, now - at) / DAY;
  return Math.max(0.25, 0.5 ** (age / halfLife));
}

/** The user's taste signals, strongest first: library entries and ratings, merged per title. */
export function seedsFrom(library: Record<string, LibraryEntry>, taste: TasteState, now = Date.now()): Seed[] {
  const seeds = new Map<string, Seed>();
  for (const entry of Object.values(library)) {
    const strength = interactionStrength(entry, now);
    if (strength <= 0) continue;
    const at = Math.max(entry.addedAt, entry.progress?.updatedAt ?? 0, entry.watchedAt ?? 0, entry.changedAt ?? 0);
    const key = mediaKey(entry.meta.type, entry.meta.id);
    seeds.set(key, {
      key,
      type: entry.meta.type,
      id: entry.meta.id,
      name: entry.meta.name,
      weight: strength * recency(at, now),
      genres: canonicalGenres(entry.meta.genres),
      people: peopleOf(entry.meta),
      year: yearFrom(entry.meta.releaseInfo ?? entry.meta.released),
      at,
      origin: played(entry) ? "played" : "saved",
    });
  }
  for (const [key, mark] of Object.entries(taste.ratings)) {
    const previous = seeds.get(key);
    // An explicit rating outweighs anything inferred, and decays more slowly.
    const weight = (mark.value === "like" ? 1.6 : -1.2) * recency(mark.at, now, 240);
    seeds.set(key, {
      key,
      type: mark.meta.type,
      id: mark.meta.id,
      name: mark.meta.name,
      weight: mark.value === "like" ? Math.max(weight, previous?.weight ?? 0) : weight,
      genres: previous?.genres.length ? previous.genres : canonicalGenres(mark.meta.genres),
      people: previous?.people.length ? previous.people : peopleOf(mark.meta),
      year: previous?.year ?? yearFrom(mark.meta.releaseInfo),
      at: Math.max(previous?.at ?? 0, mark.at),
      origin: previous?.origin === "played" ? "played" : mark.value === "like" ? "liked" : "saved",
    });
  }
  return [...seeds.values()].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || b.at - a.at);
}

/** Adds features learned elsewhere (TMDB's genres, people and language) to the seeds. */
export function enrichSeeds(seeds: Seed[], extra: Record<string, Partial<Pick<Seed, "genres" | "people" | "year" | "language">>>): Seed[] {
  return seeds.map((seed) => {
    const more = extra[seed.key];
    if (!more) return seed;
    return {
      ...seed,
      genres: [...new Set([...seed.genres, ...(more.genres ?? [])])],
      people: [...new Set([...seed.people, ...(more.people ?? [])])],
      year: seed.year ?? more.year,
      language: seed.language ?? more.language,
    };
  });
}

export type Taste = {
  /** Genre affinity, −1 to 1, weighted by rarity: what tells this user's taste apart (for scoring). */
  genres: Map<Genre, number>;
  /** Genre affinity, −1 to 1, as watched: what the user likes most (for genre rows). */
  favourites: Map<Genre, number>;
  /** People affinity, 0 to 1. */
  people: Map<string, number>;
  /** How many positive seeds each person appears in. */
  peopleSeeds: Map<string, number>;
  /** Share of the positive weight on movies and on series. */
  types: Record<string, number>;
  languages: Map<string, number>;
  /** Weighted mean and spread of release years. */
  era?: { mean: number; spread: number };
  /** Positive weight in total; 0 means a cold start. */
  strength: number;
};

/**
 * The taste profile. `pool` sets the rarity of each genre: liking dramas says less than liking
 * westerns, because nearly everything is a drama.
 */
export function tasteProfile(seeds: Seed[], pool: Pick<Candidate, "genres">[] = []): Taste {
  const frequency = new Map<Genre, number>();
  for (const candidate of pool) for (const genre of candidate.genres) frequency.set(genre, (frequency.get(genre) ?? 0) + 1);
  const rarity = (genre: Genre) => (pool.length ? Math.log(1 + pool.length / (1 + (frequency.get(genre) ?? 0))) : 1);
  const genres = new Map<Genre, number>();
  const people = new Map<string, number>();
  const peopleSeeds = new Map<string, number>();
  const types: Record<string, number> = {};
  const languages = new Map<string, number>();
  let strength = 0;
  let years = 0;
  let yearSum = 0;
  let yearSquares = 0;
  for (const seed of seeds) {
    const positive = seed.weight > 0;
    for (const genre of seed.genres) genres.set(genre, (genres.get(genre) ?? 0) + seed.weight / Math.sqrt(seed.genres.length));
    if (!positive) continue;
    strength += seed.weight;
    types[seed.type] = (types[seed.type] ?? 0) + seed.weight;
    seed.people.forEach((person, index) => {
      // Directors and leads first: later cast names count less.
      people.set(person, (people.get(person) ?? 0) + seed.weight / (1 + index * 0.35));
      peopleSeeds.set(person, (peopleSeeds.get(person) ?? 0) + 1);
    });
    if (seed.language) languages.set(seed.language, (languages.get(seed.language) ?? 0) + seed.weight);
    if (seed.year) {
      years += seed.weight;
      yearSum += seed.weight * seed.year;
      yearSquares += seed.weight * seed.year * seed.year;
    }
  }
  const normalized = (values: Map<Genre, number>) => {
    const top = Math.max(1e-9, ...[...values.values()].map(Math.abs));
    return new Map([...values].map(([genre, value]) => [genre, value / top]));
  };
  const favourites = normalized(genres);
  const weighted = normalized(new Map([...genres].map(([genre, value]) => [genre, value * rarity(genre)])));
  const topPerson = Math.max(1e-9, ...people.values());
  for (const [person, value] of people) people.set(person, value / topPerson);
  for (const type of Object.keys(types)) types[type] /= strength || 1;
  const languageTotal = [...languages.values()].reduce((sum, value) => sum + value, 0);
  for (const [language, value] of languages) languages.set(language, value / (languageTotal || 1));
  const era = years > 0 ? { mean: yearSum / years, spread: Math.sqrt(Math.max(0, yearSquares / years - (yearSum / years) ** 2)) } : undefined;
  return { genres: weighted, favourites, people, peopleSeeds, types, languages, era, strength };
}

/** The person the user follows most: in at least two liked or played titles (and `known` to a source). */
export function followedPerson(taste: Taste, known: (name: string) => boolean = () => true): string | undefined {
  return [...taste.people.entries()]
    .filter(([name]) => (taste.peopleSeeds.get(name) ?? 0) >= 2 && known(name))
    .sort((a, b) => b[1] - a[1])[0]?.[0];
}

export type Reason =
  | { kind: "seed"; seed: string; name: string; origin: SeedOrigin }
  | { kind: "person"; name: string }
  | { kind: "genre"; genre: Genre }
  | { kind: "quality" };

export type Scored = Candidate & {
  key: string;
  score: number;
  /** «98 % de coincidencia». */
  match: number;
  reason: Reason;
  /** Part of the score each signal contributed, for tests and tuning. */
  parts: { neighbours: number; content: number; people: number; quality: number; popularity: number; negative: number };
};

/** Bayesian average: few votes pull a rating toward the mean. */
export function quality(rating?: number, votes?: number): number {
  if (!rating) return 0.35;
  const prior = 6.6;
  const weight = votes === undefined ? 0.6 : votes / (votes + 400);
  const value = weight * rating + (1 - weight) * prior;
  return Math.min(1, Math.max(0, (value - 5.5) / 3));
}

/** Small and stable within a day: the page changes a little every day, as a service's home does. */
export function dailyJitter(key: string, day: number): number {
  let hash = 2166136261 ^ day;
  for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  return ((hash >>> 0) % 1000) / 1000;
}

export type RankOptions = {
  now?: number;
  jitter?: number;
  /** Visits to Home in which each title was shown and not opened, by media key. */
  fatigue?: Record<string, number>;
};

/**
 * Impression fatigue: three showings are free, then each visit without opening the title costs
 * 8 % of its score, down to half. Fresh titles get their turn, as on a streaming service's home.
 */
export function fatigueFactor(visits = 0): number {
  return Math.max(0.5, 0.92 ** Math.max(0, visits - 3));
}

/** Scores every candidate against the taste profile; best first. */
export function rank(candidates: Candidate[], seeds: Seed[], taste: Taste, options: RankOptions = {}): Scored[] {
  const now = options.now ?? Date.now();
  const day = Math.floor(now / DAY);
  const jitter = options.jitter ?? 0.025;
  const seedByKey = new Map(seeds.map((seed) => [seed.key, seed]));
  const thisYear = new Date(now).getUTCFullYear();
  const scored = candidates.map((candidate): Omit<Scored, "match"> => {
    const key = mediaKey(candidate.item.type, candidate.item.id);
    let neighbours = 0;
    let negative = 0;
    let bestSeed: { seed: Seed; value: number } | undefined;
    for (const [seedKey, position] of Object.entries(candidate.neighbours ?? {})) {
      const seed = seedByKey.get(seedKey);
      if (!seed) continue;
      const value = seed.weight / (1 + position / 8);
      if (value < 0) negative -= value;
      else {
        neighbours += value;
        if (!bestSeed || value > bestSeed.value) bestSeed = { seed, value };
      }
    }
    neighbours = 1 - Math.exp(-neighbours * 1.4);
    negative = 1 - Math.exp(-negative * 1.4);
    const genreValues = candidate.genres.map((genre) => taste.genres.get(genre) ?? 0);
    const content = genreValues.length ? genreValues.reduce((sum, value) => sum + value, 0) / Math.sqrt(genreValues.length) : 0;
    let people = 0;
    let bestPerson: { name: string; value: number } | undefined;
    for (const person of candidate.people) {
      const value = taste.people.get(person) ?? 0;
      people += value;
      if (value > 0 && (!bestPerson || value > bestPerson.value)) bestPerson = { name: person, value };
    }
    people = Math.min(1, people);
    const good = quality(candidate.rating, candidate.votes);
    const popularity = candidate.popularity ?? 0.3;
    // Fits: what the user tends to watch, from when and in which language.
    const typeShare = taste.types[candidate.item.type];
    const typeFit = taste.strength ? 0.55 + 0.45 * Math.min(1, (typeShare ?? 0) * 1.6) : 1;
    let eraFit = 1;
    if (taste.era && candidate.year) {
      const sigma = Math.max(8, taste.era.spread * 1.5);
      eraFit = 0.8 + 0.2 * Math.exp(-((candidate.year - taste.era.mean) ** 2) / (2 * sigma * sigma));
    }
    let languageFit = 1;
    if (candidate.language && taste.languages.size) languageFit = 0.88 + Math.min(0.3, (taste.languages.get(candidate.language) ?? 0) * 0.4);
    const fresh = candidate.year && candidate.year >= thisYear - 1 ? 0.03 : 0;
    const affinity = 0.4 * neighbours + 0.27 * Math.max(-1, Math.min(1, content)) + 0.11 * people;
    const score =
      fatigueFactor(options.fatigue?.[key]) * typeFit * eraFit * languageFit * (affinity + 0.15 * good + 0.07 * popularity + fresh) -
      0.45 * negative +
      jitter * dailyJitter(key, day);
    let reason: Reason;
    if (bestSeed && bestSeed.value >= 0.15) reason = { kind: "seed", seed: bestSeed.seed.key, name: bestSeed.seed.name, origin: bestSeed.seed.origin };
    else if (bestPerson && bestPerson.value >= 0.5) reason = { kind: "person", name: bestPerson.name };
    else {
      const genre = candidate.genres
        .map((name) => ({ name, value: taste.genres.get(name) ?? 0 }))
        .sort((a, b) => b.value - a.value)[0];
      reason = genre && genre.value > 0.2 ? { kind: "genre", genre: genre.name } : { kind: "quality" };
    }
    return { ...candidate, key, score, reason, parts: { neighbours, content, people, quality: good, popularity, negative } };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = Math.max(1e-9, scored[0]?.score ?? 0);
  return scored.map((item) => ({ ...item, match: Math.round(62 + 36 * Math.max(0, item.score / top) ** 1.4) }));
}

function overlap(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const set = new Set(a);
  const shared = b.filter((value) => set.has(value)).length;
  return shared / (a.length + b.length - shared);
}

/** How alike two titles are, for diversity: genres, people and the seed they come from. */
export function similarity(a: Pick<Scored, "genres" | "people" | "reason">, b: Pick<Scored, "genres" | "people" | "reason">): number {
  const sameSeed = a.reason.kind === "seed" && b.reason.kind === "seed" && a.reason.seed === b.reason.seed ? 1 : 0;
  return 0.6 * overlap(a.genres, b.genres) + 0.2 * Math.min(1, overlap(a.people, b.people) * 3) + 0.2 * sameSeed;
}

/**
 * Maximal marginal relevance: picks the best title, then each next one by its score minus how
 * much it resembles what was already picked. `lambda` 1 is pure score.
 */
export function diversify(items: Scored[], count: number, lambda = 0.65): Scored[] {
  if (!items.length) return [];
  const top = Math.max(1e-9, items[0].score);
  const rest = items.slice(0, Math.max(count * 4, 40));
  const picked: Scored[] = [];
  const closest = new Map<Scored, number>();
  while (picked.length < count && rest.length) {
    let best = 0;
    let bestValue = -Infinity;
    rest.forEach((item, index) => {
      const value = lambda * (item.score / top) - (1 - lambda) * (closest.get(item) ?? 0);
      if (value > bestValue) {
        bestValue = value;
        best = index;
      }
    });
    const [item] = rest.splice(best, 1);
    picked.push(item);
    for (const other of rest) closest.set(other, Math.max(closest.get(other) ?? 0, similarity(item, other)));
  }
  return picked;
}

/** Content similarity of a candidate to one seed, for «Porque viste…» without neighbour data. */
export function seedAffinity(seed: Seed, candidate: Candidate): number {
  const neighbour = candidate.neighbours?.[seed.key];
  const related = neighbour === undefined ? 0 : 1 / (1 + neighbour / 6);
  // Sharing every genre of the smaller list counts as much as identical lists, half way.
  const shared = seed.genres.filter((genre) => candidate.genres.includes(genre)).length;
  const genres = shared ? 0.5 * overlap(seed.genres, candidate.genres) + (0.5 * shared) / Math.min(seed.genres.length, candidate.genres.length) : 0;
  const people = Math.min(1, candidate.people.filter((person) => seed.people.includes(person)).length * 0.5);
  const sameType = seed.type === candidate.item.type ? 1 : 0.6;
  return Math.max(related, sameType * (0.65 * genres + 0.35 * people));
}

export type RowKind = "top" | "seed" | "genre" | "person" | "gems" | "new";
export type Row = { id: string; kind: RowKind; title: string; subtitle?: string; items: Scored[] };
export type HomePage = { hero?: Scored; rows: Row[]; seeds: Seed[]; taste: Taste; ranked: Scored[] };

export type ComposeOptions = RankOptions & {
  /** Neighbour lists of a person, from TMDB: name → candidates. */
  personPools?: Record<string, Candidate[]>;
  rowSize?: number;
};

/**
 * What never shows up: titles already played, rated (a rating means the user knows the title)
 * or hidden. Saved titles that were not played still can, as a service keeps recommending what
 * is on «Mi lista».
 */
export function excluded(library: Record<string, LibraryEntry>, taste: TasteState): Set<string> {
  const keys = new Set<string>([...Object.keys(taste.hidden), ...Object.keys(taste.ratings)]);
  for (const [key, entry] of Object.entries(library)) if (played(entry)) keys.add(key);
  return keys;
}

/** Merges duplicates (the same title from several sources), keeping the richest features. */
export function mergeCandidates(candidates: Candidate[]): Candidate[] {
  const merged = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = mediaKey(candidate.item.type, candidate.item.id);
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, candidate);
      continue;
    }
    const neighbours = { ...previous.neighbours };
    for (const [seed, position] of Object.entries(candidate.neighbours ?? {})) neighbours[seed] = Math.min(position, neighbours[seed] ?? Infinity);
    merged.set(key, {
      ...previous,
      item: {
        ...candidate.item,
        ...previous.item,
        background: previous.item.background ?? candidate.item.background,
        logo: previous.item.logo ?? candidate.item.logo,
        description: previous.item.description ?? candidate.item.description,
      },
      genres: [...new Set([...previous.genres, ...candidate.genres])],
      people: [...new Set([...previous.people, ...candidate.people])],
      year: previous.year ?? candidate.year,
      rating: previous.rating ?? candidate.rating,
      votes: previous.votes ?? candidate.votes,
      popularity: Math.max(previous.popularity ?? 0, candidate.popularity ?? 0) || undefined,
      language: previous.language ?? candidate.language,
      neighbours,
    });
  }
  return [...merged.values()];
}

/**
 * Builds the personalized part of Home. Rows alternate kinds, need a minimum of titles to show,
 * and a title appears in at most two rows (and the billboard title in none but «Elegidos»).
 */
export function composeHome(
  pool: Candidate[],
  library: Record<string, LibraryEntry>,
  tasteState: TasteState,
  baseSeeds: Seed[],
  options: ComposeOptions = {},
): HomePage {
  const now = options.now ?? Date.now();
  const size = options.rowSize ?? 20;
  const skip = excluded(library, tasteState);
  const candidates = mergeCandidates(pool).filter((candidate) => !skip.has(mediaKey(candidate.item.type, candidate.item.id)));
  const seeds = baseSeeds;
  const taste = tasteProfile(seeds, candidates);
  if (taste.strength <= 0 || !candidates.length) return { rows: [], seeds, taste, ranked: [] };
  const ranked = rank(candidates, seeds, taste, options);
  const byKey = new Map(ranked.map((item) => [item.key, item]));
  const shown = new Map<string, number>();
  const rows: Row[] = [];
  const take = (items: Scored[], min: number, limit = size): Scored[] | undefined => {
    const fresh = items.filter((item) => (shown.get(item.key) ?? 0) < 2).slice(0, limit);
    return fresh.length >= min ? fresh : undefined;
  };
  const add = (row: Omit<Row, "items">, items: Scored[] | undefined) => {
    if (!items) return;
    for (const item of items) shown.set(item.key, (shown.get(item.key) ?? 0) + 1);
    rows.push({ ...row, items });
  };

  // Billboard: among the best few with artwork and close to the top score, a different one each day.
  const billboard = ranked
    .slice(0, 12)
    .filter((item) => item.item.background && item.item.description && item.score > 0 && item.score >= ranked[0].score * 0.88);
  const hero = billboard.length ? billboard[Math.floor(now / DAY) % Math.min(3, billboard.length)] : undefined;
  if (hero) shown.set(hero.key, 1);

  // The billboard title is already the first thing on the page.
  const top = diversify(ranked.filter((item) => item.score > 0 && item.key !== hero?.key), size);
  add({ id: "top", kind: "top", title: t("recommend.top") }, take(top, 6));

  const positive = seeds.filter((seed) => seed.weight > 0);
  // Recent, strong seeds lead «Porque viste…»; each one only once.
  const seedRows = positive
    .slice(0, 12)
    .sort((a, b) => b.weight * recency(b.at, now, 30) - a.weight * recency(a.at, now, 30))
    .map((seed) => {
      const best = Math.max(1e-9, ranked[0].score);
      const items = ranked
        .map((item) => ({ item, affinity: seedAffinity(seed, item) }))
        .filter(({ item, affinity }) => affinity >= 0.4 && item.key !== seed.key)
        .map(({ item, affinity }) => ({ item, value: 0.6 * affinity + 0.4 * (item.score / best) }))
        .sort((a, b) => b.value - a.value)
        .map(({ item }) => item);
      return { seed, items };
    });

  const genreRows = [...taste.favourites.entries()]
    .filter(([, value]) => value > 0.25)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([genre]) => ({
      genre,
      // Twice as many as shown: some will already be in two rows.
      items: diversify(
        ranked.filter((item) => item.genres.includes(genre)),
        size * 2,
        0.85,
      ),
    }));

  const pools = options.personPools ?? {};
  const person = followedPerson(taste, (name) => Boolean(pools[name]?.length)) ?? followedPerson(taste);
  const personItems = person
    ? rank(
        mergeCandidates([
          ...(options.personPools?.[person] ?? []),
          ...candidates.filter((candidate) => candidate.people.includes(person)),
        ]).filter((candidate) => !skip.has(mediaKey(candidate.item.type, candidate.item.id))),
        seeds,
        taste,
        options,
      ).map((item) => byKey.get(item.key) ?? item)
    : [];

  const gems = ranked.filter(
    (item) => item.parts.quality >= 0.55 && (item.popularity ?? 0.3) <= 0.4 && item.parts.content > 0.15 && item.score > 0,
  );
  const thisYear = new Date(now).getUTCFullYear();
  const recent = ranked.filter((item) => item.year && item.year >= thisYear - 1 && item.score > 0);

  // Each slot takes the next seed (or genre) that still fills a row once repeats are left out.
  const seedRow = () => {
    while (seedRows.length) {
      const row = seedRows.shift()!;
      const items = take(row.items, 6);
      if (items) return add({ id: `seed:${row.seed.key}`, kind: "seed", title: because(row.seed.origin, row.seed.name) }, items);
    }
  };
  const genreRow = () => {
    while (genreRows.length) {
      const row = genreRows.shift()!;
      const items = take(row.items, 6);
      if (items) return add({ id: `genre:${row.genre}`, kind: "genre", title: t("recommend.becauseGenre", { likes: likesGenre(row.genre) }) }, items);
    }
  };
  seedRow();
  genreRow();
  seedRow();
  add({ id: "gems", kind: "gems", title: t("recommend.gems") }, take(gems, 6));
  if (person) add({ id: `person:${person}`, kind: "person", title: t("recommend.moreFrom", { name: person }) }, take(personItems, 5));
  genreRow();
  add({ id: "new", kind: "new", title: t("recommend.new") }, take(recent, 6));
  seedRow();
  genreRow();
  return { hero, rows, seeds, taste, ranked };
}

function because(origin: SeedOrigin, name: string): string {
  return t(origin === "played" ? "recommend.becauseWatched" : origin === "liked" ? "recommend.becauseLiked" : "recommend.becauseAdded", { name });
}

/** One line on why a title is recommended. */
export function reasonText(reason: Reason): string {
  if (reason.kind === "seed") return because(reason.origin, reason.name);
  if (reason.kind === "person") return t("recommend.becauseLikePerson", { name: reason.name });
  if (reason.kind === "genre") {
    const text = likesGenre(reason.genre);
    return text[0].toUpperCase() + text.slice(1);
  }
  return t("recommend.highlyRated");
}
