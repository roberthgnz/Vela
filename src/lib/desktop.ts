import { useEffect, useRef, useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "./i18n";
import { log } from "./log";
import { normalizeManifestUrl } from "./protocol";
import { storage } from "./storage";

/**
 * Windows integration from the page's side (`desktop.rs`): the tray icon with «close to tray»,
 * and links (`vela://…`, and `stremio://…` when the user lets Vela take them) that open the
 * add-on install dialog with the manifest filled in.
 */
const trayKey = "vela.device.tray";

let tray: boolean | undefined;
const listeners = new Set<() => void>();

function applyTray(enabled: boolean) {
  if (!isTauri()) return Promise.resolve();
  return invoke("tray_set", { enabled, show: t("tray.show"), quit: t("tray.quit") }).catch((error: unknown) =>
    log.warn("tray could not be set", error),
  );
}

export const trayIcon = {
  get(): boolean {
    return (tray ??= storage.getItem(trayKey) === "on");
  },
  set(enabled: boolean) {
    tray = enabled;
    if (enabled) storage.setItem(trayKey, "on");
    else storage.removeItem(trayKey);
    void applyTray(enabled);
    for (const listener of [...listeners]) listener();
  },
  /** Shows the icon at start when the user turned it on. */
  restore() {
    if (trayIcon.get()) void applyTray(true);
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function useTrayIcon(): boolean {
  return useSyncExternalStore(trayIcon.subscribe, trayIcon.get, trayIcon.get);
}

/** The add-on manifest a `vela://` or `stremio://` link points to, or undefined. */
export function manifestFromLink(link: string): string | undefined {
  const raw = link.trim();
  const https = /^vela:\/\//i.test(raw) ? raw.replace(/^vela:\/\//i, "https://") : /^stremio:\/\//i.test(raw) ? raw : undefined;
  // Only add-on links: Stremio also uses stremio://detail/…, stremio:///search… and others.
  if (!https || !/^[a-z]+:\/\/[^/?#]+\/(?:[^?#]*\/)?manifest\.json(?:[?#]|$)/i.test(raw)) return undefined;
  try {
    const url = normalizeManifestUrl(https);
    return /\/manifest\.json$/i.test(new URL(url).pathname) ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Calls `onManifest` for the link Vela was opened with and for links that arrive later. */
export function useLinks(onManifest: (url: string) => void) {
  const handler = useRef(onManifest);
  handler.current = onManifest;
  useEffect(() => {
    if (!isTauri()) return;
    const take = (link: string | null | undefined) => {
      if (!link) return;
      const manifest = manifestFromLink(link);
      if (manifest) handler.current(manifest);
      else log.warn("ignored a link that is not an add-on manifest");
    };
    void invoke<string | null>("link_pending").then(take, () => {});
    const stop = listen<string>("vela://link", (event) => take(event.payload));
    return () => void stop.then((unlisten) => unlisten());
  }, []);
}

export function stremioLinks(): Promise<boolean> {
  return isTauri() ? invoke<boolean>("stremio_links_get") : Promise.resolve(false);
}

export function setStremioLinks(enabled: boolean): Promise<void> {
  return invoke("stremio_links_set", { enabled });
}
