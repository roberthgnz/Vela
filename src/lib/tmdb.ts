import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Episode, MediaItem } from "./contracts";
import { storage } from "./storage";
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
  meta: Pick<MediaItem, "id" | "type" | "videos" | "tmdbId">,
  language: string,
  apiKey: string,
  fetchJson: (url: string) => Promise<unknown> = requestJson,
): Promise<Translation | null> {
  const imdb = /^tt\d+/.exec(meta.id)?.[0];
  if (!imdb) return null;
  const series = meta.type === "series";
  // Cinemeta's catalogs carry the TMDB id: then TMDB need not be searched first.
  let id = meta.tmdbId;
  if (!id) {
    const found = (await fetchJson(url(`/find/${imdb}`, { external_source: "imdb_id", language }, apiKey))) as FindResult;
    id = (series ? found.tv_results : found.movie_results)?.[0]?.id;
  }
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

/**
 * Translated titles, synopses and genres, kept on this computer (by title and language) so a title
 * opens already translated the next time. Episodes are not kept: they arrive with the details.
 */
type Heading = Pick<Translation, "name" | "description" | "genres">;
const headingsKey = "vela.translations.v1";
const HEADINGS_MAX = 2000;
const HEADING_TTL = 30 * 24 * 60 * 60_000;
let headings: Record<string, { at: number; value: Heading | null }> | undefined;
let headingsTimer: ReturnType<typeof setTimeout> | undefined;

function savedHeadings() {
  if (!headings) {
    try {
      headings = JSON.parse(storage.getItem(headingsKey) ?? "{}") ?? {};
    } catch {
      headings = {};
    }
  }
  return headings!;
}

function headingId(meta: Pick<MediaItem, "type" | "id">, language: string) {
  return `${language}|${meta.type}|${meta.id}`;
}

function savedHeading(id: string) {
  const entry = savedHeadings()[id];
  return entry && Date.now() - entry.at < HEADING_TTL ? entry : undefined;
}

function saveHeading(id: string, translation: Translation | null) {
  const all = savedHeadings();
  all[id] = {
    at: Date.now(),
    value: translation ? { name: translation.name, description: translation.description, genres: translation.genres } : null,
  };
  clearTimeout(headingsTimer);
  headingsTimer = setTimeout(() => {
    const kept = Object.entries(all)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, HEADINGS_MAX);
    headings = Object.fromEntries(kept);
    try {
      storage.setItem(headingsKey, JSON.stringify(headings));
    } catch {
      /* Translations are looked up again next time. */
    }
  }, 1000);
}

/** Whether a title in this language can be translated through TMDB. */
function translatable(meta: Pick<MediaItem, "id">, language: string) {
  return Boolean(language) && !/^en\b/i.test(language) && /^tt\d+/.test(meta.id);
}

async function fetchHeading(meta: Pick<MediaItem, "id" | "type" | "tmdbId">, language: string) {
  const apiKey = await tmdb.key();
  if (!apiKey) return null;
  const translation = await translate({ id: meta.id, type: meta.type, tmdbId: meta.tmdbId }, language, apiKey);
  saveHeading(headingId(meta, language), translation);
  return translation;
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
      key = (await Promise.resolve()
        .then(() => getSecret(secretName))
        .catch(() => null)) ?? null;
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

/** «unknown» until the key has been read from the credential store. */
function useTmdbKeyState(): "unknown" | "none" | "set" {
  const read = () => (key === undefined ? "unknown" : key ? "set" : "none");
  return useSyncExternalStore(tmdb.subscribe, read, read);
}

// The key is read as soon as Vela starts, so a title opened right away is translated right away.
void tmdb.key().catch(() => undefined);

/** Starts translating a title before it is opened (on hover or focus of its card). */
export function usePrefetchTranslation(): (meta: MediaItem) => void {
  const client = useQueryClient();
  const language = usePreferences().metadataLanguage;
  return useCallback(
    (meta: MediaItem) => {
      if (!key || !translatable(meta, language) || savedHeading(headingId(meta, language))) return;
      void client.prefetchQuery({
        queryKey: ["tmdb-heading", meta.type, meta.id, language],
        queryFn: () => fetchHeading(meta, language),
        staleTime: 7 * 24 * 60 * 60_000,
      });
    },
    [client, language],
  );
}

/** How long a title waits for its translation before showing the addon's text. */
const TRANSLATION_WAIT = 2500;

/**
 * The title in the language chosen in Settings, when a TMDB key is configured. `pending` is true
 * while a translation is expected and has not arrived (up to a couple of seconds): the detail page
 * holds its text then instead of showing English and switching. Title, synopsis and genres come
 * first (and are kept on disk); episode titles follow without changing them.
 */
export function useTranslatedMeta<T extends MediaItem>(meta: T): { meta: T; translated: boolean; pending: boolean } {
  const language = usePreferences().metadataLanguage;
  const keyState = useTmdbKeyState();
  const expected = keyState !== "none" && translatable(meta, language);
  const saved = expected ? savedHeading(headingId(meta, language)) : undefined;
  const heading = useQuery({
    queryKey: ["tmdb-heading", meta.type, meta.id, language],
    queryFn: () => fetchHeading(meta, language),
    enabled: keyState === "set" && expected,
    initialData: saved ? (saved.value as Translation | null) : undefined,
    initialDataUpdatedAt: saved?.at,
    staleTime: 7 * 24 * 60 * 60_000,
    gcTime: 24 * 60 * 60_000,
    retry: 1,
  });
  const series = meta.type === "series" && Boolean(meta.videos?.length);
  const episodes = useQuery({
    queryKey: ["tmdb-episodes", meta.type, meta.id, language, meta.videos?.length ?? 0],
    queryFn: async () => {
      const apiKey = await tmdb.key();
      return apiKey ? ((await translate(meta, language, apiKey))?.episodes ?? null) : null;
    },
    enabled: keyState === "set" && expected && series,
    placeholderData: keepPreviousData,
    staleTime: 24 * 60 * 60_000,
    gcTime: 24 * 60 * 60_000,
    retry: 1,
  });
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    setWaited(false);
    const timer = setTimeout(() => setWaited(true), TRANSLATION_WAIT);
    return () => clearTimeout(timer);
  }, [meta.id, language]);
  const pending = expected && heading.data === undefined && !heading.isError && !waited;
  return useMemo(() => {
    const translation = heading.data || episodes.data ? { ...(heading.data ?? {}), episodes: episodes.data ?? undefined } : null;
    return { meta: applyTranslation(meta, translation), translated: Boolean(heading.data), pending };
  }, [meta, heading.data, episodes.data, pending]);
}
