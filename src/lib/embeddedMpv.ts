import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "./i18n";
import { normalizeLanguage } from "./languages";
import { storage } from "./storage";
import { preferencesStore } from "./store";

/**
 * mpv inside Vela's window (`embedded_mpv.rs`), using a libmpv that is already on the machine
 * (one next to mpv.exe, Stremio's, or the LGPL build Vela downloads on request, `libmpv.rs`).
 * It plays what WebView2 cannot decode. The built-in player
 * stays the default; «mpv integrado» can be chosen in Settings or from the player's error panel.
 */
export type VideoPlayer = "builtin" | "mpv";

const key = "vela.device.videoPlayer";

let current: VideoPlayer | undefined;
const listeners = new Set<() => void>();

export const videoPlayer = {
  get(): VideoPlayer {
    return (current ??= storage.getItem(key) === "mpv" ? "mpv" : "builtin");
  },
  set(value: VideoPlayer) {
    current = value;
    if (value === "mpv") storage.setItem(key, value);
    else storage.removeItem(key);
    for (const listener of [...listeners]) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function useVideoPlayer(): VideoPlayer {
  return useSyncExternalStore(videoPlayer.subscribe, videoPlayer.get, videoPlayer.get);
}

let library: Promise<string | null> | undefined;

/** The libmpv Vela found, or null. Checked once per session (and again after the player path changes). */
export function embeddedLibrary(): Promise<string | null> {
  if (!isTauri()) return Promise.resolve(null);
  library ??= invoke<string | null>("mpv_embedded_library", {
    playerPath: preferencesStore.getSnapshot().externalPlayerPath || null,
  }).catch(() => null);
  return library;
}

const libraryListeners = new Set<() => void>();

/** The libmpv on the machine may have changed (a download, a removal, another player path). */
export function forgetEmbeddedLibrary() {
  library = undefined;
  for (const listener of [...libraryListeners]) listener();
}

export function useEmbeddedLibrary(): string | null | undefined {
  const [value, setValue] = useState<string | null | undefined>(undefined);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const changed = () => setGeneration((count) => count + 1);
    libraryListeners.add(changed);
    return () => {
      libraryListeners.delete(changed);
    };
  }, []);
  useEffect(() => {
    let active = true;
    void embeddedLibrary().then((found) => active && setValue(found));
    return () => {
      active = false;
    };
  }, [generation]);
  return value;
}

/** The libmpv build Vela can download (`mpv_install_info`), and the one it already did. */
export type LibmpvInfo = { version: string; size: number; license: string; source: string; path: string | null };

export type LibmpvProgress = { stage: "download" | "unpack" | "check"; downloaded: number; total: number };

export function libmpvInfo(): Promise<LibmpvInfo | null> {
  if (!isTauri()) return Promise.resolve(null);
  return invoke<LibmpvInfo>("mpv_install_info").catch(() => null);
}

function failure(error: unknown): Error {
  return new Error(typeof error === "string" ? error : error instanceof Error ? error.message : t("mpv.install.unknown"));
}

/** Downloads the pinned libmpv (checked against its SHA-256) and resolves with where it is. */
export async function installLibmpv(onProgress: (progress: LibmpvProgress) => void): Promise<string> {
  const unlisten = await listen<LibmpvProgress>("mpv-install", (event) => onProgress(event.payload));
  try {
    return await invoke<string>("mpv_install").catch((error: unknown) => {
      throw failure(error);
    });
  } finally {
    unlisten();
    forgetEmbeddedLibrary();
  }
}

export function cancelLibmpvInstall(): void {
  void invoke("mpv_install_cancel").catch(() => {});
}

/** Deletes the libmpv Vela downloaded (never Stremio's or mpv's own). */
export async function removeLibmpv(): Promise<void> {
  try {
    await invoke("mpv_uninstall").catch((error: unknown) => {
      throw failure(error);
    });
  } finally {
    forgetEmbeddedLibrary();
  }
}

/** Whether the next playback should go to mpv: chosen in Settings and a libmpv is available. */
export async function prefersEmbedded(): Promise<boolean> {
  return videoPlayer.get() === "mpv" && Boolean(await embeddedLibrary());
}

/** ISO 639-2 preference codes as mpv language lists (`spa,es`), preferred first. */
export function mpvLanguages(...codes: string[]): string {
  const two: Record<string, string> = {
    spa: "es", eng: "en", fra: "fr", deu: "de", ita: "it", por: "pt", rus: "ru", jpn: "ja", kor: "ko", zho: "zh",
    nld: "nl", pol: "pl", tur: "tr", ara: "ar", swe: "sv", dan: "da", fin: "fi", nob: "nb", ces: "cs", ell: "el",
    hun: "hu", ron: "ro", heb: "he", cat: "ca", eus: "eu", glg: "gl", ukr: "uk", vie: "vi", tha: "th", ind: "id",
  };
  const list: string[] = [];
  for (const raw of codes) {
    const code = normalizeLanguage(raw);
    if (!code) continue;
    for (const value of [code, two[code]]) if (value && !list.includes(value)) list.push(value);
  }
  return list.join(",");
}

export type Rect = { x: number; y: number; width: number; height: number };

/** The element's box in physical pixels of the window (the WebView fills the window). */
export function rectOf(element: Element): Rect {
  const box = element.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  return {
    x: Math.round(box.left * scale),
    y: Math.round(box.top * scale),
    width: Math.max(1, Math.round(box.width * scale)),
    height: Math.max(1, Math.round(box.height * scale)),
  };
}

export type EmbeddedOpen = {
  url: string;
  headers?: Record<string, string>;
  title?: string;
  start?: number;
  subtitles?: string[];
  audioLanguages?: string;
  subtitleLanguages?: string;
  subtitlesAuto?: boolean;
  volume?: number;
  rect: Rect;
};

export function openEmbedded(options: EmbeddedOpen): Promise<string> {
  return invoke<string>("mpv_embedded_open", {
    options: { ...options, playerPath: preferencesStore.getSnapshot().externalPlayerPath || null },
  });
}

/** Subtitles found after mpv was opened: mpv adds them once the file is loaded. */
export function addEmbeddedSubtitles(urls: string[]): Promise<void> {
  return invoke("mpv_embedded_subtitles", { urls });
}

export function placeEmbedded(rect: Rect): Promise<void> {
  return invoke("mpv_embedded_place", { rect });
}

export function focusEmbedded(): Promise<void> {
  return invoke("mpv_embedded_focus");
}

export function controlEmbedded(action: "pause" | "play" | "toggle"): Promise<void> {
  return invoke("mpv_embedded_command", { action, key: null });
}

const namedKeys: Record<string, string> = {
  " ": "SPACE",
  ArrowLeft: "LEFT",
  ArrowRight: "RIGHT",
  ArrowUp: "UP",
  ArrowDown: "DOWN",
  Home: "HOME",
  End: "END",
  PageUp: "PGUP",
  PageDown: "PGDWN",
  Enter: "ENTER",
};

/** mpv's name for a key the page received, or undefined for keys mpv should not see. */
export function mpvKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey">): string | undefined {
  if (event.ctrlKey || event.altKey || event.metaKey) return undefined;
  if (namedKeys[event.key]) return namedKeys[event.key];
  return event.key.length === 1 && /^[\x21-\x7e]$/.test(event.key) ? event.key : undefined;
}

/** Runs a key through mpv's bindings (the page has the focus, not mpv's window). */
export function pressEmbedded(key: string): Promise<void> {
  return invoke("mpv_embedded_command", { action: "key", key });
}

export function closeEmbedded(): Promise<void> {
  return invoke("mpv_embedded_close");
}

export type EmbeddedMessage =
  | { kind: "progress"; time: number; duration: number; paused: boolean }
  | { kind: "ended" }
  | { kind: "error"; message: string }
  | { kind: "action"; name: string }
  | { kind: "closed"; time: number; duration: number };

export function onEmbeddedMessage(handler: (message: EmbeddedMessage) => void): () => void {
  const stop = listen<EmbeddedMessage>("mpv-embedded", (event) => handler(event.payload));
  return () => void stop.then((unlisten) => unlisten());
}
