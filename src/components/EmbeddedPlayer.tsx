import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, MonitorPlay } from "lucide-react";
import {
  closeEmbedded,
  focusEmbedded,
  mpvKey,
  mpvLanguages,
  onEmbeddedMessage,
  openEmbedded,
  placeEmbedded,
  pressEmbedded,
  rectOf,
} from "../lib/embeddedMpv";
import type { Episode } from "../lib/contracts";
import { nextEpisode } from "../lib/episodes";
import { t } from "../lib/i18n";
import { log } from "../lib/log";
import { getSubtitles } from "../lib/protocol";
import { storage } from "../lib/storage";
import { preferencesStore, usePreferences } from "../lib/store";
import { releaseVelaTorrent } from "../lib/torrentEngine";
import { errorMessage } from "../lib/utils";
import { Dialog } from "./Primitives";
import { setFullscreen, useWindowState, WindowControls } from "./WindowControls";
import { episodeText, volumeKey, type Playing } from "./player/shared";
import { useWatchProgress } from "./player/useWatchProgress";

/**
 * The player with mpv drawing the video (`embedded_mpv.rs`). The page keeps the top bar; the area
 * below it is covered by mpv's native window, whose on-screen controller and keys drive playback.
 * Progress, watched marks and the next episode follow the same rules as the built-in player.
 */
export function EmbeddedPlayer({
  playing,
  onClose,
  onNext,
  onStarted,
  onFailed,
}: {
  playing: Playing;
  onClose: () => void;
  onNext?: (episode: Episode) => void;
  onStarted?: () => void;
  onFailed?: (message: string) => void;
}) {
  const prefs = usePreferences();
  const settings = prefs.player;
  const area = useRef<HTMLDivElement>(null);
  const { fullscreen } = useWindowState();
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(true);
  const next = useMemo(() => nextEpisode(playing.meta, playing.videoId), [playing.meta, playing.videoId]);
  /** What mpv last reported, in the shape the progress rules read from a video element. */
  const position = useRef({ currentTime: playing.resume, duration: 0, seeking: false });
  const element = position.current as unknown as HTMLVideoElement;
  const video = useMemo(() => ({ current: element }), [element]);
  const progress = useWatchProgress(playing, next, video);
  const started = useRef(false);
  const closed = useRef(false);
  const infoHash = playing.stream.infoHash && !playing.stream.url ? playing.stream.infoHash : undefined;

  const leave = useCallback(
    (then: () => void) => {
      if (closed.current) return;
      closed.current = true;
      progress.save(element);
      progress.finishIfDone();
      void closeEmbedded().finally(then);
    },
    [element, progress],
  );
  const close = useCallback(() => leave(onClose), [leave, onClose]);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Opens mpv once, with the addon subtitles (fetched first, briefly) and the user's languages.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const box = area.current;
      if (!box) return;
      const subtitles = await Promise.race([
        getSubtitles(preferencesStore.getSnapshot().addons, playing.meta.type, playing.videoId, playing.stream).catch(() => []),
        new Promise<never[]>((resolve) => setTimeout(() => resolve([]), 4000)),
      ]);
      if (cancelled) return;
      const urls = [...new Set([...(playing.stream.subtitles ?? []), ...subtitles].map((item) => item.url))];
      const saved = Number(storage.getItem(volumeKey));
      try {
        await openEmbedded({
          url: playing.filePath ?? playing.externalUrl,
          headers: playing.headers,
          title: [playing.meta.name, episodeText(playing.episode)].filter(Boolean).join(" · "),
          start: playing.resume >= 15 ? playing.resume : undefined,
          subtitles: urls,
          audioLanguages: mpvLanguages(settings.audioLanguage, settings.audioSecondary),
          subtitleLanguages: mpvLanguages(settings.subtitleLanguage, settings.subtitleSecondary),
          subtitlesAuto: settings.subtitlesAuto,
          volume: Number.isFinite(saved) && saved > 0 && saved <= 1 ? saved : 1,
          rect: rectOf(box),
        });
        if (cancelled) void closeEmbedded();
      } catch (cause) {
        if (cancelled) return;
        const message = errorMessage(cause);
        log.warn("embedded mpv could not start", message);
        setError(message);
        onFailed?.(message);
      } finally {
        if (!cancelled) setStarting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // The player is keyed by the source in App: one open per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Messages from mpv: progress, the end, errors and the keys bound to Vela's actions.
  const handlers = useRef({ close, leave, onNext, onStarted, onFailed, next, settings });
  handlers.current = { close, leave, onNext, onStarted, onFailed, next, settings };
  useEffect(
    () =>
      onEmbeddedMessage((message) => {
        const current = handlers.current;
        if (message.kind === "progress") {
          position.current.currentTime = message.time;
          position.current.duration = message.duration;
          if (message.duration > 0 && !started.current) {
            started.current = true;
            current.onStarted?.();
          }
          progress.onTimeUpdate(element);
        } else if (message.kind === "ended") {
          progress.finish();
          if (current.next && current.onNext && current.settings.autoNext) {
            const upcoming = current.next;
            current.leave(() => current.onNext?.(upcoming));
          } else current.close();
        } else if (message.kind === "closed") {
          // mpv ended by itself (its own quit key, a crash): leave instead of a black rectangle.
          if (!closed.current) {
            closed.current = true;
            progress.save(element);
            progress.finishIfDone();
            void closeEmbedded().finally(onCloseRef.current);
          }
        } else if (message.kind === "error") {
          setError(message.message);
          if (!started.current) current.onFailed?.(message.message);
        } else if (message.kind === "action") {
          if (message.name === "close") current.close();
          else if (message.name === "fullscreen") void setFullscreen(area.current, !fullscreenRef.current);
          else if (message.name === "next" && current.next && current.onNext) {
            const upcoming = current.next;
            current.leave(() => current.onNext?.(upcoming));
          }
        }
      }),
    [element, progress],
  );
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;

  // Keys reach the page when mpv's window does not have the focus: Escape closes, F toggles
  // fullscreen, N plays the next episode, and the rest go through mpv's bindings.
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const current = handlers.current;
      if (event.key === "Escape") current.close();
      else if (event.key.toLowerCase() === "f" && !event.ctrlKey && !event.altKey && !event.metaKey)
        void setFullscreen(area.current, !fullscreenRef.current);
      else if (event.key.toLowerCase() === "n" && current.next && current.onNext) {
        const upcoming = current.next;
        current.leave(() => current.onNext?.(upcoming));
      } else {
        const key = mpvKey(event);
        if (!key) return;
        void pressEmbedded(key).catch(() => {});
      }
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);

  // Keeps mpv's window over the video area when the window or the layout changes.
  useEffect(() => {
    const box = area.current;
    if (!box) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => void placeEmbedded(rectOf(box)).catch(() => {}));
    };
    const observer = new ResizeObserver(update);
    observer.observe(box);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  // Leaving the player in any other way (the app closes it, a new source) also closes mpv.
  useEffect(
    () => () => {
      if (!closed.current) void closeEmbedded();
      if (infoHash && playing.torrentEngine === "vela") releaseVelaTorrent(infoHash);
    },
    [infoHash, playing.torrentEngine],
  );

  return (
    <Dialog title={t("player.playingTitle", { name: playing.meta.name })} onClose={close} className="player-dialog" hideClose>
      <div className="player embedded" data-status={error ? "error" : starting ? "loading" : "playing"}>
        <div className="player-top embedded-top" data-tauri-drag-region>
          <button className="player-icon" aria-label={t("common.back")} title={t("player.backTitle")} onClick={close}>
            <ArrowLeft size={20} />
          </button>
          <div className="player-title" data-tauri-drag-region>
            <strong data-tauri-drag-region>{playing.meta.name}</strong>
            <span data-tauri-drag-region>
              {[episodeText(playing.episode), playing.stream.addonName, t("mpv.embedded.badge")].filter(Boolean).join(" · ")}
            </span>
          </div>
          {!fullscreen && <WindowControls onError={setError} />}
        </div>
        <div
          ref={area}
          className="embedded-area"
          onMouseDown={() => void focusEmbedded().catch(() => {})}
          role="presentation"
        >
          {starting && !error && (
            <div className="player-loading" role="status">
              <span>{t("mpv.embedded.starting")}</span>
            </div>
          )}
          {error && (
            <div className="player-error" role="alert">
              <h2>{t("player.cannotPlay")}</h2>
              <p>{error}</p>
              <div>
                <button className="button secondary" onClick={close}>
                  <MonitorPlay size={15} />
                  {t("player.chooseOtherSource")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
