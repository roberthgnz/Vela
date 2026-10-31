import { useSyncExternalStore } from "react";
import { storage } from "./storage";
import type { MediaItem } from "./contracts";
import { MAIN_PROFILE, mediaKey, preferencesStore } from "./store";

/**
 * What the user told Vela about titles, for the recommendations: «Me gusta», «No me gusta» and
 * «No me interesa» (hidden from the recommendations). Each profile has its own; local only.
 * Rated titles keep the few details the recommendations need, so a liked title counts even if
 * it never entered the library.
 */

export type Rating = "like" | "dislike";
export type RatedMeta = Pick<MediaItem, "id" | "type" | "name" | "poster" | "genres" | "cast" | "director" | "releaseInfo">;
export type RatingMark = { value: Rating; at: number; meta: RatedMeta };
export type TasteState = {
  /** By media key. */
  ratings: Record<string, RatingMark>;
  /** Titles left out of the recommendations, by media key, with when. */
  hidden: Record<string, number>;
  /**
   * Recommendations shown without being opened: how many visits to Home and the last one. A title
   * offered again and again and never opened is wearing out; opening it clears the count.
   */
  seen?: Record<string, SeenMark>;
};
export type SeenMark = { count: number; at: number };

/** Showing a title again within this time is the same visit. */
const VISIT = 6 * 60 * 60_000;

const mainKey = "vela.taste.v1";
export const tasteKey = (profile: string) => (profile === MAIN_PROFILE ? mainKey : `vela.taste.${profile}.v1`);
const maxMarks = 500;

function read(storage: Pick<Storage, "getItem"> | undefined, key: string): TasteState {
  try {
    const value = JSON.parse(storage?.getItem(key) ?? "null") as TasteState | null;
    if (value && typeof value === "object" && value.ratings && value.hidden) return value;
  } catch {
    /* A damaged file only loses the ratings. */
  }
  return { ratings: {}, hidden: {} };
}

function rated(meta: MediaItem): RatedMeta {
  return {
    id: meta.id,
    type: meta.type,
    name: meta.name,
    poster: meta.poster,
    genres: meta.genres?.slice(0, 6),
    cast: meta.cast?.slice(0, 6),
    director: meta.director?.slice(0, 3),
    releaseInfo: meta.releaseInfo,
  };
}

/** Keeps the newest `maxMarks` entries of a record of timestamps. */
function bounded<T>(record: Record<string, T>, at: (value: T) => number): Record<string, T> {
  const keys = Object.keys(record);
  if (keys.length <= maxMarks) return record;
  const kept = keys.sort((a, b) => at(record[b]) - at(record[a])).slice(0, maxMarks);
  return Object.fromEntries(kept.map((key) => [key, record[key]]));
}

export function createTaste(storage?: Pick<Storage, "getItem" | "setItem">, profile = MAIN_PROFILE) {
  let key = tasteKey(profile);
  let state = read(storage, key);
  const listeners = new Set<() => void>();
  const update = (next: TasteState) => {
    state = next;
    try {
      storage?.setItem(key, JSON.stringify(state));
    } catch {
      /* Ratings are a convenience. */
    }
    for (const listener of [...listeners]) listener();
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    switchProfile(next: string) {
      if (tasteKey(next) === key) return;
      key = tasteKey(next);
      state = read(storage, key);
      for (const listener of [...listeners]) listener();
    },
    rating(type: string, id: string): Rating | undefined {
      return state.ratings[mediaKey(type, id)]?.value;
    },
    /** Rates a title, or clears its rating (`null`). Rating it also brings it back if it was hidden. */
    rate(meta: MediaItem, value: Rating | null) {
      const item = mediaKey(meta.type, meta.id);
      const ratings = { ...state.ratings };
      if (value) ratings[item] = { value, at: Date.now(), meta: rated(meta) };
      else delete ratings[item];
      const hidden = { ...state.hidden };
      if (value === "like") delete hidden[item];
      update({ ...state, ratings: bounded(ratings, (mark) => mark.at), hidden });
    },
    /** Counts one more visit for each title shown (at most one per visit). */
    markSeen(keys: string[], now = Date.now()) {
      const seen = { ...state.seen };
      let changed = false;
      for (const key of keys) {
        const mark = seen[key];
        if (mark && now - mark.at < VISIT) continue;
        seen[key] = { count: (mark?.count ?? 0) + 1, at: now };
        changed = true;
      }
      if (changed) update({ ...state, seen: bounded(seen, (mark) => mark.at) });
    },
    /** The user opened a title: it is not wearing out. */
    opened(type: string, id: string) {
      const key = mediaKey(type, id);
      if (!state.seen?.[key]) return;
      const seen = { ...state.seen };
      delete seen[key];
      update({ ...state, seen });
    },
    hide(type: string, id: string) {
      update({ ...state, hidden: bounded({ ...state.hidden, [mediaKey(type, id)]: Date.now() }, (at) => at) });
    },
    clearHidden() {
      update({ ...state, hidden: {} });
    },
  };
}

export const taste = createTaste(storage, preferencesStore.getProfile());

// Follows the active profile without the profile code having to know about ratings.
preferencesStore.subscribe(() => taste.switchProfile(preferencesStore.getProfile()));

export function useTaste(): TasteState {
  return useSyncExternalStore(taste.subscribe, taste.getSnapshot, taste.getSnapshot);
}
