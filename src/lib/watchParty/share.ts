import type { Episode, MediaItem, ResolvedStream } from "../contracts";
import { safeImage } from "../utils";

/**
 * What the host tells the room about its source. Never its URL or its addon's address: those carry
 * debrid keys and addon settings (`/realdebrid=KEY/manifest.json`). A torrent's hash is public, and
 * the rest only helps each guest find the same release among their own addons.
 */
export type SharedStream = {
  name?: string;
  title?: string;
  description?: string;
  infoHash?: string;
  fileIdx?: number;
  /** Trackers and DHT hints of a torrent (`tracker:<url>`, `dht:<hash>`). */
  sources?: string[];
  filename?: string;
  videoSize?: number;
  bingeGroup?: string;
};

/** The title the room is watching. */
export type PartyMedia = {
  meta: MediaItem;
  videoId: string;
  episode?: Episode;
  stream: SharedStream;
};

/** Identifies one video across peers. */
export function mediaId(type: string, id: string, videoId: string): string {
  return JSON.stringify([type, id, videoId]);
}

export function partyMediaId(media: PartyMedia): string {
  return mediaId(media.meta.type, media.meta.id, media.videoId);
}

const MAX_VIDEOS = 400;

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.slice(0, max) : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 1e6 ? value : undefined;
}

function episode(value: unknown): Episode | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const id = text(item.id, 300);
  if (!id) return undefined;
  return {
    id,
    title: text(item.title, 200),
    season: count(item.season),
    episode: count(item.episode),
    released: text(item.released, 40),
  };
}

/** The shareable part of a title: its art and names, and the episodes of the season being watched. */
function shareMeta(meta: MediaItem, current?: Episode): MediaItem {
  const season = current?.season;
  const videos = meta.videos
    ?.filter((video) => season === undefined || video.season === season)
    .slice(0, MAX_VIDEOS)
    .map((video) => episode(video))
    .filter((video): video is Episode => Boolean(video));
  return {
    id: meta.id,
    type: meta.type,
    name: meta.name,
    poster: meta.poster,
    background: meta.background,
    logo: meta.logo,
    releaseInfo: meta.releaseInfo,
    videos: videos?.length ? videos : undefined,
  };
}

export function shareStream(stream: ResolvedStream): SharedStream {
  return {
    name: stream.name?.slice(0, 200),
    title: stream.title?.slice(0, 500),
    description: stream.description?.slice(0, 500),
    infoHash: stream.infoHash,
    fileIdx: stream.fileIdx,
    sources: stream.sources?.filter((source) => /^(tracker|dht):/.test(source)).slice(0, 40),
    filename: stream.behaviorHints?.filename,
    videoSize: stream.behaviorHints?.videoSize,
    bingeGroup: stream.behaviorHints?.bingeGroup,
  };
}

export function toPartyMedia(playing: { meta: MediaItem; videoId: string; episode?: Episode; stream: ResolvedStream }): PartyMedia {
  return {
    meta: shareMeta(playing.meta, playing.episode),
    videoId: playing.videoId,
    episode: playing.episode ? episode(playing.episode) : undefined,
    stream: shareStream(playing.stream),
  };
}

/**
 * The room's title as another peer sent it, or `undefined` when it is not a usable one. Everything is
 * checked: it comes from whoever holds the room's host key.
 */
export function parsePartyMedia(raw: unknown): PartyMedia | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as Record<string, unknown>;
  const meta = data.meta as Record<string, unknown> | undefined;
  const stream = (data.stream ?? {}) as Record<string, unknown>;
  const videoId = text(data.videoId, 300);
  const id = text(meta?.id, 300);
  const type = text(meta?.type, 40);
  const name = text(meta?.name, 300);
  if (!meta || !videoId || !id || !type || !name) return undefined;
  const infoHash = typeof stream.infoHash === "string" && /^[a-f0-9]{40}$/i.test(stream.infoHash) ? stream.infoHash.toLowerCase() : undefined;
  return {
    meta: {
      id,
      type,
      name,
      poster: safeImage(text(meta.poster, 2000)),
      background: safeImage(text(meta.background, 2000)),
      logo: safeImage(text(meta.logo, 2000)),
      releaseInfo: text(meta.releaseInfo, 40),
      videos: Array.isArray(meta.videos)
        ? meta.videos.slice(0, MAX_VIDEOS).map(episode).filter((video): video is Episode => Boolean(video))
        : undefined,
    },
    videoId,
    episode: episode(data.episode),
    stream: {
      name: text(stream.name, 200),
      title: text(stream.title, 500),
      description: text(stream.description, 500),
      infoHash,
      fileIdx: count(stream.fileIdx),
      sources: Array.isArray(stream.sources)
        ? stream.sources.filter((source): source is string => typeof source === "string" && /^(tracker|dht):/.test(source) && source.length < 500).slice(0, 40)
        : undefined,
      filename: text(stream.filename, 500),
      videoSize: typeof stream.videoSize === "number" && stream.videoSize > 0 ? stream.videoSize : undefined,
      bingeGroup: text(stream.bingeGroup, 300),
    },
  };
}

/** Name shown for a source that a guest plays straight from the host's torrent. */
export const PARTY_ADDON = "Watch party";

/**
 * The guest's source for the host's video: the same torrent or file among the guest's own addons
 * (a debrid addon may serve it as a link), then the same release group, and finally the torrent
 * itself when this Vela can stream torrents. `undefined` when the guest has to choose.
 */
export function pickPartyStream(
  streams: ResolvedStream[],
  shared: SharedStream,
  canTorrent: boolean,
): ResolvedStream | undefined {
  const playable = streams.filter((stream) => stream.url || stream.infoHash);
  const hash = shared.infoHash;
  const sameFile = (stream: ResolvedStream) =>
    stream.fileIdx === undefined || shared.fileIdx === undefined || stream.fileIdx === shared.fileIdx;
  if (hash) {
    const byHash = playable.find((stream) => stream.infoHash?.toLowerCase() === hash && sameFile(stream) && stream.url);
    if (byHash) return byHash;
    // Debrid addons usually drop the hash but keep it in their release group.
    const inGroup = playable.find((stream) => stream.url && stream.behaviorHints?.bingeGroup?.toLowerCase().includes(hash));
    if (inGroup) return inGroup;
  }
  if (shared.filename) {
    const byName = playable.find(
      (stream) =>
        stream.behaviorHints?.filename === shared.filename &&
        (!shared.videoSize || !stream.behaviorHints?.videoSize || stream.behaviorHints.videoSize === shared.videoSize),
    );
    if (byName && (byName.url || canTorrent)) return byName;
  }
  if (hash && canTorrent) {
    const torrent = playable.find((stream) => stream.infoHash?.toLowerCase() === hash && sameFile(stream));
    if (torrent) return torrent;
  }
  if (shared.bingeGroup) {
    const group = playable.find((stream) => stream.behaviorHints?.bingeGroup === shared.bingeGroup && (stream.url || canTorrent));
    if (group) return group;
  }
  // Direct links without hints (Open Cinema, many HTTP addons): the same entry of the same addon.
  const label = (stream: { title?: string; description?: string }) => stream.title || stream.description;
  if (shared.name && label(shared)) {
    const same = playable.find((stream) => stream.url && stream.name === shared.name && label(stream) === label(shared));
    if (same) return same;
  }
  if (hash && canTorrent)
    return {
      name: shared.name ?? PARTY_ADDON,
      title: shared.title,
      infoHash: hash,
      fileIdx: shared.fileIdx,
      sources: shared.sources,
      behaviorHints: { filename: shared.filename, videoSize: shared.videoSize, bingeGroup: shared.bingeGroup },
      addonName: PARTY_ADDON,
      addonUrl: "",
    };
  return undefined;
}
