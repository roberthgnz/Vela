import { useSyncExternalStore } from "react";
import { storage } from "./storage";
import { preferencesStore } from "./store";

/**
 * Recent searches, per profile (a child's profile does not see the adults' searches). A search
 * is remembered when one of its results is opened.
 */

export const MAX_SEARCHES = 8;
const prefix = "vela.searchHistory.v1.";
const listeners = new Set<() => void>();
let cache: { profile: string; items: string[] } | null = null;

function key(): string {
  return prefix + preferencesStore.getProfile();
}

function read(): string[] {
  const profile = preferencesStore.getProfile();
  if (cache?.profile === profile) return cache.items;
  let items: string[] = [];
  try {
    const value = JSON.parse(storage.getItem(key()) ?? "[]") as unknown;
    if (Array.isArray(value)) items = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, MAX_SEARCHES);
  } catch {
    /* No history yet. */
  }
  cache = { profile, items };
  return items;
}

function write(items: string[]) {
  cache = { profile: preferencesStore.getProfile(), items };
  try {
    if (items.length) storage.setItem(key(), JSON.stringify(items));
    else storage.removeItem(key());
  } catch {
    /* The history lasts for this session. */
  }
  for (const listener of [...listeners]) listener();
}

/** The newest search first; the same text in another case replaces the older one. */
export function addSearch(list: string[], text: string): string[] {
  const value = text.trim().replace(/\s+/g, " ");
  if (value.length < 2) return list;
  const lower = value.toLocaleLowerCase("es");
  return [value, ...list.filter((item) => item.toLocaleLowerCase("es") !== lower)].slice(0, MAX_SEARCHES);
}

export const searchHistory = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: read,
  add(text: string) {
    const next = addSearch(read(), text);
    if (next !== read()) write(next);
  },
  remove(text: string) {
    write(read().filter((item) => item !== text));
  },
  clear() {
    write([]);
  },
};

export function useSearchHistory(): string[] {
  return useSyncExternalStore(searchHistory.subscribe, searchHistory.getSnapshot, searchHistory.getSnapshot);
}
