import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { flushStorage } from "../lib/storage";
import { t } from "../lib/i18n";

export const native = isTauri();

function Glyph({ kind }: { kind: "min" | "max" | "restore" | "close" }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      {kind === "min" && <path d="M0 5.5h10" stroke="currentColor" />}
      {kind === "max" && <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />}
      {kind === "restore" && (
        <>
          <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" />
          <path d="M2.5 2.5V.5h7v7h-2" fill="none" stroke="currentColor" />
        </>
      )}
      {kind === "close" && <path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" />}
    </svg>
  );
}

export function useWindowState() {
  const [state, setState] = useState({ maximized: false, fullscreen: false });
  useEffect(() => {
    if (!native) return;
    const window = getCurrentWindow();
    let disposed = false;
    const refresh = () =>
      void Promise.all([window.isMaximized(), window.isFullscreen()])
        .then(([maximized, fullscreen]) => {
          if (!disposed) setState({ maximized, fullscreen });
        })
        .catch(() => {});
    refresh();
    const unlisten = window.onResized(refresh);
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop());
    };
  }, []);
  return state;
}

/**
 * Rust turns every close request (the close button, Alt+F4, the taskbar) into this event so that
 * pending writes reach the database first; the window is then destroyed from here.
 */
export function useCloseFlush() {
  useEffect(() => {
    if (!native) return;
    let closing = false;
    const unlisten = listen("vela://close-requested", async () => {
      if (closing) return;
      closing = true;
      try {
        await flushStorage();
      } finally {
        await getCurrentWindow().destroy().catch(() => {});
      }
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);
}

export function WindowControls({ onError }: { onError: (message: string) => void }) {
  const { maximized } = useWindowState();
  useCloseFlush();
  if (!native) return null;
  const run = (action: "minimize" | "toggleMaximize" | "close") =>
    void getCurrentWindow()
      [action]()
      .catch(() => onError(t("window.noResponse")));
  return (
    <div className="window-controls">
      <button aria-label={t("window.minimize")} title={t("window.minimize")} tabIndex={-1} onClick={() => run("minimize")}>
        <Glyph kind="min" />
      </button>
      <button
        aria-label={maximized ? t("window.restore") : t("window.maximize")}
        title={maximized ? t("window.restore") : t("window.maximize")}
        tabIndex={-1}
        onClick={() => run("toggleMaximize")}
      >
        <Glyph kind={maximized ? "restore" : "max"} />
      </button>
      <button className="close" aria-label={t("window.closeVela")} title={t("common.close")} tabIndex={-1} onClick={() => run("close")}>
        <Glyph kind="close" />
      </button>
    </div>
  );
}

/** Uses the native window in Tauri and the Fullscreen API in a browser. */
export async function setFullscreen(element: HTMLElement | null, value: boolean) {
  if (native) {
    await getCurrentWindow().setFullscreen(value);
    return;
  }
  if (value && !document.fullscreenElement) await element?.requestFullscreen();
  if (!value && document.fullscreenElement) await document.exitFullscreen();
}
