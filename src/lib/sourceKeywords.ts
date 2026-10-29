import { useSyncExternalStore } from "react";
import type { ResolvedStream } from "./contracts";

/**
 * Words that sources must or must not contain. Kept on this device only (like Stremio's
 * per-device setting): it is never synchronized with the account or shared between profiles.
 */
export type SourceKeywords = { include: string[]; exclude: string[] };

const key = "vela.device.sourceKeywords.v1";
const empty: SourceKeywords = { include: [], exclude: [] };

/** Lowercase, without accents, words separated by single spaces: «WEB-DL» and «web.dl» are alike. */
function normalize(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Keywords from free text: one per comma or line, normalized and without repeats. */
export function parseKeywords(text: string): string[] {
  return [...new Set(text.split(/[,\n]/).map((item) => item.trim()).filter((item) => normalize(item)))].slice(0, 50);
}

/**
 * Whether a source passes the filter. Keywords match whole words of the addon's name, title,
 * description and file name; with include words, a source needs at least one of them.
 */
export function matchesKeywords(stream: ResolvedStream, filter: SourceKeywords): boolean {
  if (!filter.include.length && !filter.exclude.length) return true;
  const text = ` ${normalize([stream.name, stream.title, stream.description, stream.behaviorHints?.filename].filter(Boolean).join(" "))} `;
  const has = (word: string) => {
    const needle = normalize(word);
    return Boolean(needle) && text.includes(` ${needle} `);
  };
  if (filter.exclude.some(has)) return false;
  return !filter.include.length || filter.include.some(has);
}

function read(): SourceKeywords {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<SourceKeywords> | null;
    const list = (items: unknown) => (Array.isArray(items) ? parseKeywords(items.filter((item) => typeof item === "string").join(",")) : []);
    return value && typeof value === "object" ? { include: list(value.include), exclude: list(value.exclude) } : empty;
  } catch {
    return empty;
  }
}

let current: SourceKeywords | undefined;
const listeners = new Set<() => void>();

export const sourceKeywords = {
  get(): SourceKeywords {
    return (current ??= read());
  },
  set(value: SourceKeywords) {
    current = { include: parseKeywords(value.include.join(",")), exclude: parseKeywords(value.exclude.join(",")) };
    try {
      localStorage.setItem(key, JSON.stringify(current));
    } catch {
      /* Kept for this session. */
    }
    for (const listener of [...listeners]) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useSourceKeywords(): SourceKeywords {
  return useSyncExternalStore(sourceKeywords.subscribe, sourceKeywords.get, sourceKeywords.get);
}
