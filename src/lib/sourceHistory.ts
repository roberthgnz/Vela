import { useSyncExternalStore } from "react";
import type { ResolvedStream } from "./contracts";

/**
 * Which sources the user has opened for each video, and how it went, so the source list can
 * show them and «Continuar» can go back to the exact source. Local only: stream URLs can carry
 * addon tokens, so this is never synchronized or exported.
 */

export type SourceOutcome = "opened" | "played" | "failed";
export type SourceMark = { outcome: SourceOutcome; at: number; error?: string };
type Saved = {
  /** By video id, then by source key. */
  videos: Record<string, Record<string, SourceMark>>;
  /** Last source that played, by title key (`type|id`). */
  last: Record<string, { videoId: string; stream: ResolvedStream; at: number }>;
};

const mainKey = "vela.sources.v1";
/** Each profile has its own history; the main profile keeps the original key. */
export const sourcesKey = (profile: string) => (profile === "main" ? mainKey : `vela.sources.${profile}.v1`);
const maxVideos = 300;

/** Stable identity of a source: the addon plus what it points to. */
export function sourceKey(stream: Pick<ResolvedStream, "addonUrl" | "url" | "infoHash" | "fileIdx" | "externalUrl" | "ytId" | "name">): string {
  const target = stream.infoHash
    ? `bt:${stream.infoHash.toLowerCase()}:${stream.fileIdx ?? ""}`
    : stream.url ?? stream.externalUrl ?? (stream.ytId ? `yt:${stream.ytId}` : `name:${stream.name ?? ""}`);
  return `${stream.addonUrl}|${target}`;
}

function titleKey(type: string, id: string): string {
  return `${type}|${id}`;
}

function read(storage: Pick<Storage, "getItem"> | undefined, key: string): Saved {
  try {
    const value = JSON.parse(storage?.getItem(key) ?? "null") as Saved | null;
    if (value && typeof value === "object" && value.videos && value.last) return value;
  } catch {
    /* A damaged history only loses the marks. */
  }
  return { videos: {}, last: {} };
}

export function createSourceHistory(storage?: Pick<Storage, "getItem" | "setItem">) {
  let key = mainKey;
  let state = read(storage, key);
  const listeners = new Set<() => void>();
  const update = (next: Saved) => {
    state = next;
    try {
      storage?.setItem(key, JSON.stringify(state));
    } catch {
      /* Marks are a convenience. */
    }
    for (const listener of [...listeners]) listener();
  };
  return {
    getSnapshot: () => state,
    switchProfile(profile: string) {
      key = sourcesKey(profile);
      state = read(storage, key);
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Records an attempt. "played" also makes it the title's source for «Continuar». */
    mark(type: string, id: string, videoId: string, stream: ResolvedStream, outcome: SourceOutcome, error?: string) {
      const key = sourceKey(stream);
      const current = state.videos[videoId]?.[key];
      // Once a source has played, a later "opened" does not hide that.
      if (outcome === "opened" && current?.outcome === "played") return;
      const videos = { ...state.videos, [videoId]: { ...state.videos[videoId], [key]: { outcome, at: Date.now(), error } } };
      // Keep the history bounded: drop the videos touched longest ago.
      const ids = Object.keys(videos);
      if (ids.length > maxVideos) {
        const age = (id: string) => Math.max(...Object.values(videos[id]).map((mark) => mark.at));
        for (const old of ids.sort((a, b) => age(a) - age(b)).slice(0, ids.length - maxVideos)) delete videos[old];
      }
      const last = outcome === "played" ? { ...state.last, [titleKey(type, id)]: { videoId, stream, at: Date.now() } } : state.last;
      update({ videos, last });
    },
    clear(videoId: string, stream: ResolvedStream) {
      const key = sourceKey(stream);
      if (!state.videos[videoId]?.[key]) return;
      const marks = { ...state.videos[videoId] };
      delete marks[key];
      update({ ...state, videos: { ...state.videos, [videoId]: marks } });
    },
    marks(videoId: string): Record<string, SourceMark> {
      return state.videos[videoId] ?? {};
    },
    /** The last source that played for a title (any episode). */
    last(type: string, id: string) {
      return state.last[titleKey(type, id)];
    },
  };
}

export const sourceHistory = createSourceHistory(typeof localStorage === "undefined" ? undefined : localStorage);

export function useSourceMarks(videoId: string | undefined): Record<string, SourceMark> {
  const state = useSyncExternalStore(sourceHistory.subscribe, sourceHistory.getSnapshot, sourceHistory.getSnapshot);
  return videoId ? (state.videos[videoId] ?? {}) : {};
}
