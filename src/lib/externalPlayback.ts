import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { MediaItem, ResolvedStream, Subtitle } from "./contracts";
import { nextEpisode } from "./episodes";
import { normalizeLanguage } from "./languages";
import { getSubtitles } from "./protocol";
import { dedupeSubtitles } from "./subtitles";
import { CREDITS_THRESHOLD, preferencesStore, WATCHED_THRESHOLD } from "./store";
import { type ExternalLaunch, launchExternalPlayer } from "./transport";

/**
 * Follows videos opened in an external player. With MPV, the desktop app reads the position
 * through MPV's JSON IPC and emits `player-progress`; for every player it emits `player-closed`.
 * Progress is saved like in the integrated player, and the title moves to the next episode
 * when the video was finished.
 */

type Session = { meta: MediaItem; addonUrl: string; videoId: string; watched: boolean };
export type ExternalClosed = {
  meta: MediaItem;
  videoId: string;
  ipc: boolean;
  position?: number;
  duration?: number;
  finished: boolean;
};

type Report = {
  session: string;
  position: number | null;
  duration: number | null;
  ended: boolean;
  ipc?: boolean;
};

const sessions = new Map<string, Session>();
const closedListeners = new Set<(event: ExternalClosed) => void>();
let listening: Promise<void> | undefined;

function record(session: Session, report: Report) {
  const { position, duration } = report;
  if (position === null || duration === null || !(duration > 0)) return;
  preferencesStore.updateProgress(session.meta, session.addonUrl, {
    videoId: session.videoId,
    seconds: position,
    duration,
    updatedAt: Date.now(),
  });
  // MPV reports the position, not the time actually watched; the position stands in for it.
  if (!session.watched && (report.ended || position > duration * WATCHED_THRESHOLD)) {
    session.watched = true;
    preferencesStore.setWatched(session.meta, session.addonUrl, [session.videoId], true);
  }
}

async function listenOnce() {
  await listen<Report>("player-progress", ({ payload }) => {
    const session = sessions.get(payload.session);
    if (session) record(session, payload);
  });
  await listen<Report>("player-closed", ({ payload }) => {
    const session = sessions.get(payload.session);
    if (!session) return;
    sessions.delete(payload.session);
    record(session, payload);
    const finished = Boolean(
      payload.ended ||
        (payload.position !== null && payload.duration && payload.position > payload.duration * CREDITS_THRESHOLD),
    );
    if (finished)
      preferencesStore.finishVideo(
        session.meta,
        session.addonUrl,
        session.videoId,
        nextEpisode(session.meta, session.videoId)?.id,
      );
    const event: ExternalClosed = {
      meta: session.meta,
      videoId: session.videoId,
      ipc: Boolean(payload.ipc),
      position: payload.position ?? undefined,
      duration: payload.duration ?? undefined,
      finished,
    };
    for (const listener of [...closedListeners]) listener(event);
  });
}

export function onExternalClosed(listener: (event: ExternalClosed) => void): () => void {
  closedListeners.add(listener);
  return () => {
    closedListeners.delete(listener);
  };
}

/** Files handed to MPV: preferred language first (MPV shows the first one), a few per language. */
export function externalSubtitles(items: Subtitle[], primary: string, secondary: string, limit = 8, perLanguage = 3): string[] {
  const rank = (lang: string) => {
    const code = normalizeLanguage(lang);
    if (code && code === normalizeLanguage(primary)) return 0;
    if (code && code === normalizeLanguage(secondary)) return 1;
    return 2;
  };
  const counts = new Map<string, number>();
  return dedupeSubtitles(items)
    .filter((item) => /^https?:\/\//i.test(item.url))
    .map((item, index) => ({ item, index, rank: rank(item.lang) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .filter(({ item }) => {
      const code = normalizeLanguage(item.lang) || "?";
      const count = counts.get(code) ?? 0;
      counts.set(code, count + 1);
      return count < perLanguage;
    })
    .slice(0, limit)
    .map(({ item }) => item.url);
}

/** Subtitles from the stream and the subtitle addons, without holding the player back for slow addons. */
async function subtitlesFor(meta: MediaItem, videoId: string, stream: ResolvedStream | undefined, extra: Subtitle[]) {
  let fetched: Subtitle[] = [];
  try {
    fetched = await getSubtitles(preferencesStore.getSnapshot().addons, meta.type, videoId, stream, AbortSignal.timeout(6000));
  } catch {
    fetched = stream?.subtitles ?? [];
  }
  return [...extra, ...fetched];
}

/** Name shown in notices about the external player. */
export function externalPlayerName(launch: ExternalLaunch): string {
  return launch.player === "vlc" ? "VLC" : launch.player === "mpv" ? "MPV" : "el reproductor externo";
}

/** Opens a video in the configured player and follows it. Returns whether progress is reported. */
export async function playExternally(
  url: string,
  options: {
    meta: MediaItem;
    addonUrl: string;
    videoId: string;
    headers?: Record<string, string>;
    title?: string;
    start?: number;
    /** The stream, so subtitle addons can match its file. */
    stream?: ResolvedStream;
    /** Subtitles already known (from the torrent or loaded by the integrated player). */
    subtitles?: Subtitle[];
  },
): Promise<ExternalLaunch> {
  const settings = preferencesStore.getSnapshot().player;
  const subtitles = externalSubtitles(
    await subtitlesFor(options.meta, options.videoId, options.stream, options.subtitles ?? []),
    settings.subtitleLanguage,
    settings.subtitleSecondary,
  );
  const session = isTauri() ? crypto.randomUUID() : undefined;
  if (session) {
    listening ??= listenOnce().catch((error) => {
      listening = undefined;
      throw error;
    });
    await listening;
    sessions.set(session, { meta: options.meta, addonUrl: options.addonUrl, videoId: options.videoId, watched: false });
  }
  try {
    return await launchExternalPlayer(url, preferencesStore.getSnapshot().externalPlayerPath, {
      headers: options.headers,
      title: options.title,
      session,
      start: options.start && options.start >= 15 ? options.start : undefined,
      subtitles,
      showSubtitles: settings.subtitlesAuto,
    });
  } catch (error) {
    if (session) sessions.delete(session);
    throw error;
  }
}
