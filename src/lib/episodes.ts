import type { Episode, LibraryEntry, MediaItem, ResolvedStream, VideoState } from "./contracts";
import { bitfieldOrder, decodeWatched } from "./watched";

export function episodeCode(episode: Pick<Episode, "season" | "episode">): string {
  return `T${episode.season ?? 1} · E${episode.episode ?? 1}`;
}

export function isUpcoming(episode: Pick<Episode, "released">, now = Date.now()): boolean {
  return Boolean(episode.released && new Date(episode.released).getTime() > now);
}

/** Episodes in viewing order: seasons ascending with specials (season 0) last, then episode number. */
export function orderedEpisodes(videos: Episode[] = []): Episode[] {
  const season = (value?: number) => (value === 0 ? Number.MAX_SAFE_INTEGER : (value ?? 1));
  return [...videos].sort((a, b) => season(a.season) - season(b.season) || (a.episode ?? 0) - (b.episode ?? 0));
}

/**
 * The episode after `videoId`, following stremio-core's `next_video`: it never crosses from a
 * regular season into specials and skips episodes that have not been released yet.
 */
export function nextEpisode(meta: Pick<MediaItem, "type" | "videos">, videoId: string, now = Date.now()): Episode | undefined {
  if (meta.type !== "series" || !meta.videos?.length) return undefined;
  const list = orderedEpisodes(meta.videos);
  const index = list.findIndex((item) => item.id === videoId);
  const current = list[index];
  const next = list[index + 1];
  if (!current || !next || isUpcoming(next, now)) return undefined;
  if ((next.season ?? 1) === 0 && (current.season ?? 1) !== 0) return undefined;
  return next;
}

/** Ids of episodes considered watched: Stremio's field, overridden by later marks made in Vela. */
export async function watchedEpisodes(entry: LibraryEntry | undefined, videos: Episode[]): Promise<Set<string>> {
  const watched = new Set<string>();
  if (!entry) return watched;
  if (entry.remoteWatched && videos.length) {
    try {
      for (const id of await decodeWatched(entry.remoteWatched, bitfieldOrder(videos))) watched.add(id);
    } catch {
      /* An unreadable remote field leaves only the local marks. */
    }
  }
  const since = entry.remoteWatched ? (entry.remoteWatchedAt ?? 0) : 0;
  for (const [id, video] of Object.entries(entry.videos ?? {})) {
    if (video.watched === undefined || video.updatedAt <= since) continue;
    if (video.watched) watched.add(id);
    else watched.delete(id);
  }
  return watched;
}

/** Fraction of an episode that has been played (0 when unknown). */
export function videoProgress(state: VideoState | undefined): number {
  return state && state.duration > 0 ? Math.min(1, state.seconds / state.duration) : 0;
}

/**
 * Chooses the stream for the next episode: the same `bingeGroup` (the addon's way of saying
 * "same release"), otherwise the same addon, stream name and kind. Returns undefined when no
 * stream is a safe match, so the user picks one.
 */
export function pickNextStream<T extends Pick<ResolvedStream, "addonUrl" | "name" | "behaviorHints" | "url" | "infoHash" | "externalUrl" | "ytId">>(
  streams: T[],
  current: T,
): T | undefined {
  const group = current.behaviorHints?.bingeGroup;
  if (group) {
    const match = streams.find((item) => item.behaviorHints?.bingeGroup === group);
    if (match) return match;
  }
  const kind = (item: T) => (item.infoHash && !item.url ? "torrent" : item.url ? "url" : item.externalUrl ? "external" : "youtube");
  return streams.find(
    (item) => item.addonUrl === current.addonUrl && item.name === current.name && kind(item) === kind(current),
  );
}
