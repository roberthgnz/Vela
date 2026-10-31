import { useEffect, useMemo, useSyncExternalStore } from "react";
import { storage } from "./storage";
import { fitsLimit, lookupRating, type TitleRating } from "./ageRating";
import type { InstalledAddon, MediaItem } from "./contracts";
import { profiles, useProfiles, type Profile } from "./profiles";
import { setAddonFilter } from "./protocol";
import { tmdb, useTmdbConfigured } from "./tmdb";
import { requestJson } from "./transport";

/**
 * What each profile may see: addons and titles marked for adults, and an age limit from TMDB's
 * ratings. Ratings are looked up once per title (two TMDB requests) and kept on this computer.
 */

/** Content category of a title: «sfw» is rated under 18 and not for adults; «nsfw» is the rest. */
export type ContentCategory = "all" | "sfw" | "nsfw";

const storageKey = "vela.ratings.v1";
const MAX_STORED = 4000;
const TTL = 30 * 24 * 60 * 60_000;
/**
 * Ratings are one request each with a TMDB id, and a request takes about a second; 32 at a time
 * stays under TMDB's limit of about 50 requests per second.
 */
const CONCURRENCY = 32;
const RETRY_AFTER = 10 * 60_000;

type Stored = TitleRating & { at: number };

let ratings = new Map<string, Stored>();
try {
  const saved = JSON.parse(storage.getItem(storageKey) ?? "{}") as Record<string, Stored>;
  const now = Date.now();
  for (const [key, value] of Object.entries(saved))
    if (value && typeof value.at === "number" && now - value.at < TTL && typeof value.adult === "boolean")
      ratings.set(key, { adult: value.adult, age: typeof value.age === "number" ? value.age : null, at: value.at });
} catch {
  ratings = new Map();
}

const queue: { key: string; id: string; type: string; tmdbId?: number }[] = [];
const queued = new Set<string>();
const failed = new Map<string, number>();
let running = 0;
let version = 0;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

const keyOf = (meta: Pick<MediaItem, "type" | "id">) => `${meta.type}:${meta.id}`;
/** Only IMDb ids can be looked up in TMDB. */
const rateable = (meta: Pick<MediaItem, "id">) => /^tt\d+$/.test(meta.id);

function changed() {
  version++;
  for (const listener of [...listeners]) listener();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const entries = [...ratings.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_STORED);
    try {
      storage.setItem(storageKey, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      /* Ratings are looked up again next time. */
    }
  }, 1000);
}

async function pump() {
  while (running < CONCURRENCY && queue.length) {
    const next = queue.shift()!;
    running++;
    void (async () => {
      try {
        const apiKey = await tmdb.key();
        if (!apiKey) return;
        const rating = await lookupRating(next, (path, params = {}) =>
          requestJson(`https://api.themoviedb.org/3${path}?${new URLSearchParams({ ...params, api_key: apiKey })}`),
        );
        ratings.set(next.key, { ...rating, at: Date.now() });
        changed();
      } catch {
        failed.set(next.key, Date.now());
        changed();
      } finally {
        queued.delete(next.key);
        running--;
        void pump();
      }
    })();
  }
}

function request(items: Pick<MediaItem, "type" | "id" | "tmdbId">[]) {
  const now = Date.now();
  for (const meta of items) {
    const key = keyOf(meta);
    if (!rateable(meta) || ratings.has(key) || queued.has(key) || now - (failed.get(key) ?? 0) < RETRY_AFTER) continue;
    queued.add(key);
    queue.push({ key, id: meta.id, type: meta.type, tmdbId: meta.tmdbId });
  }
  void pump();
}

/** The rating of a title: known, «unrated» (cannot be looked up) or undefined while it loads. */
function ratingOf(meta: Pick<MediaItem, "type" | "id">, canLookUp: boolean): TitleRating | undefined {
  const known = ratings.get(keyOf(meta));
  if (known) return known;
  if (!canLookUp || !rateable(meta)) return { adult: false, age: null };
  const failure = failed.get(keyOf(meta));
  if (failure && Date.now() - failure < RETRY_AFTER) return { adult: false, age: null };
  return undefined;
}

export function categoryOf(rating: TitleRating): Exclude<ContentCategory, "all"> {
  return rating.adult || (rating.age ?? 0) >= 18 ? "nsfw" : "sfw";
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a profile may see adult addons and titles. */
export function allowsAdult(profile: Profile | undefined): boolean {
  return Boolean(profile?.showAdult && !profile.kids);
}

// Catalogs and streams of adult addons are left out for profiles that do not allow them.
setAddonFilter((addon: InstalledAddon) => {
  if (!addon.manifest.behaviorHints?.adult) return true;
  const state = profiles.getSnapshot();
  return allowsAdult(state.profiles.find((item) => item.id === state.active));
});

function useActiveProfile(): Profile | undefined {
  const state = useProfiles();
  return state.profiles.find((item) => item.id === state.active);
}

/**
 * Filters titles for the active profile and, optionally, by content category. While ratings
 * load, titles that need one stay hidden (they appear as soon as their rating arrives).
 */
export function useContentFilter<T>(
  items: T[],
  metaOf: (item: T) => MediaItem,
  category: ContentCategory = "all",
): { visible: T[]; pending: number; limited: boolean } {
  const profile = useActiveProfile();
  const configured = useTmdbConfigured();
  useSyncExternalStore(subscribe, () => version, () => version);
  useEffect(() => {
    void tmdb.key();
  }, []);
  const limit = { maxAge: profile?.maxAge, hideUnrated: profile?.hideUnrated };
  const needsRatings = limit.maxAge !== undefined || category !== "all";
  const showAdult = allowsAdult(profile);
  const metas = items.map(metaOf);
  const wanted = needsRatings && configured ? metas.filter((meta) => !ratings.has(keyOf(meta))) : [];
  const wantedKey = wanted.map(keyOf).join("|");
  useEffect(() => {
    if (wanted.length) request(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey]);
  let pending = 0;
  const visible = items.filter((item, index) => {
    const meta = metas[index];
    const rating = ratingOf(meta, configured);
    if (!rating) {
      if (!needsRatings) return true;
      pending++;
      return false;
    }
    if (rating.adult && !showAdult) return false;
    if (!fitsLimit({ ...rating, adult: false }, limit)) return false;
    return category === "all" || categoryOf(rating) === category;
  });
  return { visible, pending, limited: limit.maxAge !== undefined };
}

/** Whether the active profile may open a title: «pending» while its rating loads. */
export function useTitleAllowed(meta: MediaItem): "allowed" | "blocked" | "pending" {
  const single = useMemo(() => [meta], [meta]);
  const { visible, pending } = useContentFilter(single, (item) => item);
  return visible.length ? "allowed" : pending ? "pending" : "blocked";
}

/** Whether the active profile offers the SFW/NSFW filter: adult profiles, with a TMDB key. */
export function useContentCategories(): boolean {
  const profile = useActiveProfile();
  const configured = useTmdbConfigured();
  return configured && !profile?.kids && profile?.maxAge === undefined;
}
