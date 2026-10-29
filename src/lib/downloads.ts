import { useSyncExternalStore } from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Episode, MediaItem, ResolvedStream } from "./contracts";
import { episodeCode } from "./episodes";
import { resolvePlayback } from "./playback";
import { streamQuality } from "./streams";
import { errorMessage } from "./utils";

/**
 * Downloaded videos, desktop only. Rust moves the bytes (see `downloads.rs`); this list says
 * what each download is so it can be played offline. Kept on this device; source URLs can carry
 * addon tokens, so the list is never synchronized or exported.
 */
export type DownloadStatus = "downloading" | "paused" | "failed" | "done";
export type Download = {
  id: string;
  meta: MediaItem;
  addonUrl: string;
  videoId: string;
  episode?: Episode;
  stream: ResolvedStream;
  /** What to fetch and how: the source's direct or Stremio Service URL. */
  url: string;
  headers?: Record<string, string>;
  name: string;
  status: DownloadStatus;
  received: number;
  total?: number;
  /** Bytes per second, measured while downloading. */
  speed?: number;
  path?: string;
  error?: string;
  addedAt: number;
};

const key = "vela.downloads.v1";
export const downloadsAvailable = isTauri();

function read(): Download[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]") as Download[];
    if (!Array.isArray(value)) return [];
    // A download that was running when Vela closed is paused; its .part file resumes it.
    return value
      .filter((item) => item && typeof item.id === "string" && typeof item.url === "string" && item.meta)
      .map((item) => (item.status === "downloading" ? { ...item, status: "paused", speed: undefined } : item));
  } catch {
    return [];
  }
}

let items: Download[] | undefined;
const listeners = new Set<() => void>();
const samples = new Map<string, { at: number; received: number }>();

function all(): Download[] {
  return (items ??= read());
}

function commit(next: Download[]) {
  items = next;
  try {
    localStorage.setItem(key, JSON.stringify(next.map(({ speed: _speed, ...item }) => item)));
  } catch {
    /* Kept for this session. */
  }
  for (const listener of [...listeners]) listener();
}

function patch(id: string, change: Partial<Download>) {
  if (!all().some((item) => item.id === id)) return;
  commit(all().map((item) => (item.id === id ? { ...item, ...change } : item)));
}

/** File name: the addon's when it gives one, else the title, episode and quality. */
export function downloadName(meta: MediaItem, stream: ResolvedStream, episode?: Episode): string {
  const hinted = stream.behaviorHints?.filename?.split(/[\\/]/).pop()?.trim();
  if (hinted) return hinted;
  const quality = streamQuality(stream);
  return [meta.name, episode ? episodeCode(episode) : "", quality ? `(${quality})` : ""].filter(Boolean).join(" ");
}

let listening = false;
function listenOnce() {
  if (listening || !downloadsAvailable) return;
  listening = true;
  void listen<{ id: string; received: number; total: number | null }>("download-progress", ({ payload }) => {
    const now = Date.now();
    const last = samples.get(payload.id);
    let speed = all().find((item) => item.id === payload.id)?.speed;
    if (last && now > last.at && payload.received >= last.received) {
      const current = ((payload.received - last.received) * 1000) / (now - last.at);
      speed = speed === undefined ? current : speed * 0.7 + current * 0.3;
    }
    samples.set(payload.id, { at: now, received: payload.received });
    patch(payload.id, { status: "downloading", received: payload.received, total: payload.total ?? undefined, speed });
  });
  void listen<{ id: string; path: string; size: number }>("download-finished", ({ payload }) => {
    samples.delete(payload.id);
    patch(payload.id, { status: "done", path: payload.path, received: payload.size, total: payload.size, speed: undefined, error: undefined });
  });
  void listen<{ id: string; error: string; cancelled: boolean }>("download-failed", ({ payload }) => {
    samples.delete(payload.id);
    patch(payload.id, payload.cancelled ? { status: "paused", speed: undefined } : { status: "failed", error: payload.error, speed: undefined });
  });
}

function begin(item: Download) {
  listenOnce();
  samples.delete(item.id);
  return invoke("download_start", { id: item.id, url: item.url, name: item.name, headers: item.headers ?? null }).catch((error) => {
    patch(item.id, { status: "failed", error: errorMessage(error) });
    throw error;
  });
}

export const downloads = {
  subscribe(listener: () => void) {
    listenOnce();
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  all,
  /** The finished download of a video, if any. */
  find(type: string, id: string, videoId: string): Download | undefined {
    return all().find((item) => item.status === "done" && item.meta.type === type && item.meta.id === id && item.videoId === videoId);
  },
  async start(input: {
    meta: MediaItem;
    addonUrl: string;
    videoId: string;
    stream: ResolvedStream;
    episode?: Episode;
    serviceUrl: string;
  }): Promise<Download> {
    if (!downloadsAvailable) throw new Error("Las descargas necesitan la aplicación de escritorio.");
    if (input.stream.externalUrl || input.stream.ytId) throw new Error("Esta fuente se abre en el navegador y no se puede descargar.");
    // Same resolution as an external player: the original URL (or Stremio Service's, for
    // torrents) and the headers the source needs.
    const target = await resolvePlayback(input.meta, input.stream, input.serviceUrl, { episode: input.episode, external: true });
    const { videos: _videos, ...meta } = input.meta;
    const item: Download = {
      id: crypto.randomUUID(),
      meta,
      addonUrl: input.addonUrl,
      videoId: input.videoId,
      episode: input.episode,
      stream: input.stream,
      url: target.externalUrl,
      headers: target.headers,
      name: downloadName(input.meta, input.stream, input.episode),
      status: "downloading",
      received: 0,
      addedAt: Date.now(),
    };
    commit([item, ...all()]);
    await begin(item);
    return item;
  },
  pause(id: string) {
    void invoke("download_cancel", { id });
  },
  resume(id: string) {
    const item = all().find((entry) => entry.id === id);
    if (!item || item.status === "downloading" || item.status === "done") return;
    patch(id, { status: "downloading", error: undefined });
    void begin(item).catch(() => {});
  },
  /** Stops the download and deletes its file (or partial file). */
  async remove(id: string) {
    const item = all().find((entry) => entry.id === id);
    if (!item) return;
    if (item.status === "downloading") {
      await invoke("download_cancel", { id });
      // Let the transfer close its partial file before it is deleted.
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    commit(all().filter((entry) => entry.id !== id));
    await invoke("download_remove", { id, path: item.path ?? null });
  },
  reveal(path?: string) {
    return invoke("download_reveal", { path: path ?? null });
  },
  /** URL the integrated player can open (Tauri's asset protocol, scoped to the downloads folder). */
  playableUrl(item: Download): string {
    return convertFileSrc(item.path!);
  },
};

export function useDownloads(): Download[] {
  return useSyncExternalStore(downloads.subscribe, all, all);
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString("es", { maximumFractionDigits: value < 10 && unit > 0 ? 1 : 0 })} ${units[unit]}`;
}
