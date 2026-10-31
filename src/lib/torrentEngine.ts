import { useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Episode, ResolvedStream, Subtitle } from "./contracts";
import { t } from "./i18n";
import { storage } from "./storage";
import type { TorrentStats } from "./streamingServer";

/**
 * Which engine opens torrent sources. Vela has its own (librqbit, see `torrent.rs`); Stremio's
 * streaming server, when installed, also offers HLS conversion and probing of the file's tracks.
 * «auto» keeps using Stremio's server when it answers (or can be started) and falls back to
 * Vela's engine otherwise, so nothing changes for people who already have Stremio.
 */
export type TorrentEngine = "auto" | "vela" | "service";
export const torrentEngines: TorrentEngine[] = ["auto", "vela", "service"];

const key = "vela.device.torrentEngine";
/** Vela's engine exists only in the desktop app. */
export const velaEngineAvailable = isTauri();

function read(): TorrentEngine {
  const value = storage.getItem(key);
  return value === "vela" || value === "service" ? value : "auto";
}

let current: TorrentEngine | undefined;
const listeners = new Set<() => void>();

export const torrentEngine = {
  get(): TorrentEngine {
    return (current ??= read());
  },
  set(value: TorrentEngine) {
    current = value;
    if (value === "auto") storage.removeItem(key);
    else storage.setItem(key, value);
    for (const listener of [...listeners]) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function useTorrentEngine(): TorrentEngine {
  return useSyncExternalStore(torrentEngine.subscribe, torrentEngine.get, torrentEngine.get);
}

type Prepared = { base: string; fileIdx: number; fileName: string; files: { name: string; length: number }[] };

/** Opens a torrent with Vela's engine and returns the local URL of the chosen file. */
export async function prepareVelaTorrent(
  stream: Pick<ResolvedStream, "infoHash" | "fileIdx" | "sources">,
  episode?: Pick<Episode, "season" | "episode">,
): Promise<{ url: string; fileIdx: number; fileName: string; subtitles: Subtitle[] }> {
  if (!velaEngineAvailable) throw new Error(t("torrent.engine.desktopOnly"));
  const prepared = await invoke<Prepared>("torrent_prepare", {
    infoHash: stream.infoHash!.toLowerCase(),
    fileIdx: stream.fileIdx !== undefined && Number.isInteger(stream.fileIdx) ? stream.fileIdx : null,
    sources: stream.sources ?? [],
    season: episode?.season ?? null,
    episode: episode?.episode ?? null,
  }).catch((error: unknown) => {
    throw new Error(typeof error === "string" ? error : error instanceof Error ? error.message : t("torrent.engine.failed"));
  });
  const subtitles = prepared.files.flatMap((item, index) => {
    if (!/\.(srt|vtt)$/i.test(item.name)) return [];
    const code = /\.([a-z]{2,3}(?:-[a-z]{2})?)\.(?:srt|vtt)$/i.exec(item.name)?.[1];
    return [{ id: `torrent:${index}`, lang: code || item.name, url: `${prepared.base}/${index}` }];
  });
  return { url: `${prepared.base}/${prepared.fileIdx}`, fileIdx: prepared.fileIdx, fileName: prepared.fileName, subtitles };
}

/** Swarm state in the same shape as Stremio's server reports it. */
export function velaTorrentStats(infoHash: string): Promise<TorrentStats> {
  return invoke<TorrentStats>("torrent_stats", { infoHash: infoHash.toLowerCase() });
}

/** The player is done with a torrent: Vela deletes it after a short grace period. */
export function releaseVelaTorrent(infoHash: string): void {
  if (velaEngineAvailable) void invoke("torrent_release", { infoHash: infoHash.toLowerCase() }).catch(() => {});
}
