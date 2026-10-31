import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Episode, MediaItem } from "./contracts";
import { preferencesStore, usePreferences } from "./store";
import { provideTmdbContext } from "./tmdbCatalogs";
import { deleteSecret, getSecret, requestJson, setSecret } from "./transport";
import { t } from "./i18n";

/**
 * Translated metadata from The Movie Database (TMDB API v3), looked up by IMDb id.
 * Cinemeta only serves English; with the user's own TMDB API key Vela shows titles, synopses,
 * genres and episodes in the chosen language and keeps Cinemeta's data as the fallback.
 * The key lives in the Windows credential store and travels only in requests to TMDB.
 * API reference: https://developer.themoviedb.org/reference/find-by-id
 */

const API = "https://api.themoviedb.org/3";
const secretName = "tmdb-api-key";

export type Translation = Partial<Pick<MediaItem, "name" | "description" | "genres">> & {
  /** Episode titles and synopses, by video id. */
  episodes?: Record<string, Pick<Episode, "title" | "overview">>;
};

type FindResult = { movie_results?: { id: number }[]; tv_results?: { id: number }[] };
type Details = {
  title?: string;
  name?: string;
  overview?: string;
  genres?: { name: string }[];
  seasons?: { season_number: number }[];
};
type Season = { episodes?: { episode_number: number; name?: string; overview?: string }[] };

let key: string | null | undefined;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of [...listeners]) listener();
};

function url(path: string, params: Record<string, string>, apiKey: string): string {
  return `${API}${path}?${new URLSearchParams({ ...params, api_key: apiKey })}`;
}

function clean(value?: string): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}

/** TMDB v3 keys are 32 hexadecimal characters (the long "read access token" is a different credential). */
export function validTmdbKey(value: string): boolean {
  return /^[a-f0-9]{32}$/i.test(value.trim());
}

/**
 * Builds the translation of a title from TMDB responses. Exported for tests; `fetchJson` is the
 * transport (Rust in the desktop app).
 */
export async function translate(
  meta: Pick<MediaItem, "id" | "type" | "videos">,
  language: string,
  apiKey: string,
  fetchJson: (url: string) => Promise<unknown> = requestJson,
): Promise<Translation | null> {
  const imdb = /^tt\d+/.exec(meta.id)?.[0];
  if (!imdb) return null;
  const found = (await fetchJson(url(`/find/${imdb}`, { external_source: "imdb_id", language }, apiKey))) as FindResult;
  const series = meta.type === "series";
  const id = (series ? found.tv_results : found.movie_results)?.[0]?.id;
  if (!id) return null;
  const details = (await fetchJson(url(`/${series ? "tv" : "movie"}/${id}`, { language }, apiKey))) as Details;
  const result: Translation = {
    name: clean(series ? details.name : details.title),
    description: clean(details.overview),
    genres: details.genres?.map((genre) => genre.name).filter(Boolean),
  };
  if (series && meta.videos?.length) {
    // Only the seasons the addon lists are requested, a few at a time.
    const seasons = [...new Set(meta.videos.map((video) => video.season).filter((value): value is number => value !== undefined))];
    const episodes: NonNullable<Translation["episodes"]> = {};
    for (let index = 0; index < seasons.length; index += 4) {
      await Promise.all(
        seasons.slice(index, index + 4).map(async (season) => {
          let data: Season;
          try {
            data = (await fetchJson(url(`/tv/${id}/season/${season}`, { language }, apiKey))) as Season;
          } catch {
            return; // A missing season keeps the addon's episode titles.
          }
          for (const item of data.episodes ?? []) {
            const video = meta.videos!.find((entry) => entry.season === season && entry.episode === item.episode_number);
            if (!video) continue;
            const title = clean(item.name);
            // TMDB fills untranslated episodes with "Episodio 3"; keep the addon's title then.
            episodes[video.id] = {
              title: title && !/^(episodio|episode|capítulo)\s+\d+$/i.test(title) ? title : undefined,
              overview: clean(item.overview),
            };
          }
        }),
      );
    }
    result.episodes = episodes;
  }
  return result;
}

/** Applies a translation, keeping the addon's values where TMDB has none. */
export function applyTranslation<T extends MediaItem>(meta: T, translation: Translation | null | undefined): T {
  if (!translation) return meta;
  return {
    ...meta,
    name: translation.name ?? meta.name,
    description: translation.description ?? meta.description,
    genres: translation.genres?.length ? translation.genres : meta.genres,
    videos: meta.videos?.map((video) => {
      const episode = translation.episodes?.[video.id];
      return episode ? { ...video, title: episode.title ?? video.title, overview: episode.overview ?? video.overview } : video;
    }),
  };
}

export const tmdb = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** The stored key, read once from the credential store. */
  async key(): Promise<string | null> {
    if (key === undefined) {
      key = await getSecret(secretName).catch(() => null);
      notify();
    }
    return key;
  },
  configured: () => Boolean(key),
  /** Checks the key against TMDB and stores it. */
  async save(value: string) {
    const trimmed = value.trim();
    if (!validTmdbKey(trimmed))
      throw new Error(t("lib.tmdb.keyFormat"));
    try {
      await requestJson(url("/configuration", {}, trimmed));
    } catch {
      throw new Error(t("lib.tmdb.keyRejected"));
    }
    await setSecret(secretName, trimmed);
    key = trimmed;
    notify();
  },
  async remove() {
    await deleteSecret(secretName);
    key = null;
    notify();
  },
};

provideTmdbContext(async () => {
  const apiKey = await tmdb.key();
  if (!apiKey) return null;
  const state = preferencesStore.getSnapshot();
  // Saved or started titles, most recent first: the seeds of «Recomendado para ti».
  const library = Object.values(state.library)
    .filter((entry) => entry.saved || entry.progress || entry.watchedAt)
    .sort((a, b) => Math.max(b.addedAt, b.progress?.updatedAt ?? 0) - Math.max(a.addedAt, a.progress?.updatedAt ?? 0))
    .map((entry) => ({ id: entry.meta.id, type: entry.meta.type }));
  return { apiKey, language: state.metadataLanguage || "es-ES", library };
});

export function useTmdbConfigured(): boolean {
  return useSyncExternalStore(tmdb.subscribe, () => Boolean(key), () => Boolean(key));
}

/**
 * The title in the language chosen in Settings, when a TMDB key is configured. Returns the
 * addon's data unchanged otherwise, or while the translation loads.
 */
export function useTranslatedMeta<T extends MediaItem>(meta: T): { meta: T; translated: boolean } {
  const language = usePreferences().metadataLanguage;
  const configured = useTmdbConfigured();
  useEffect(() => {
    void tmdb.key();
  }, []);
  const query = useQuery({
    queryKey: ["tmdb", meta.type, meta.id, language, meta.videos?.length ?? 0],
    queryFn: async () => {
      const apiKey = await tmdb.key();
      return apiKey ? translate(meta, language, apiKey) : null;
    },
    enabled: configured && Boolean(language) && /^tt\d+/.test(meta.id),
    staleTime: 24 * 60 * 60_000,
    gcTime: 24 * 60 * 60_000,
    retry: 1,
  });
  return useMemo(
    () => ({ meta: applyTranslation(meta, query.data), translated: Boolean(query.data) }),
    [meta, query.data],
  );
}
