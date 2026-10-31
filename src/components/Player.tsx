import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ArrowLeft,
  Captions,
  Gauge,
  LoaderCircle,
  Maximize,
  Minimize,
  MonitorPlay,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  RotateCw,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { Episode, MediaItem } from "../lib/contracts";
import { episodeCode, nextEpisode } from "../lib/episodes";
import { externalPlayerName, playExternally } from "../lib/externalPlayback";
import { formatNumber, t } from "../lib/i18n";
import { log } from "../lib/log";
import { readMkvChapters, type Chapter } from "../lib/mkvChapters";
import { activeSegment, skipMarks, skipSegments, useSeriesMarks } from "../lib/skipSegments";
import { storage } from "../lib/storage";
import { preferencesStore, usePreferences } from "../lib/store";
import { describeTorrent } from "../lib/streamingServer";
import { streamQuality } from "../lib/streams";
import { releaseVelaTorrent } from "../lib/torrentEngine";
import { requestRange } from "../lib/transport";
import { clock, errorMessage, safeImage } from "../lib/utils";
import { Dialog } from "./Primitives";
import { native, setFullscreen, useWindowState, WindowControls } from "./WindowControls";
import { SpeedPanel, TrackPanel } from "./player/panels";
import { episodeText, mediaErrorMessage, stepSpeed, volumeKey, type Playing, type Status } from "./player/shared";
import { handleShortcut, usePlayerShortcuts } from "./player/shortcuts";
import { useAudioTracks } from "./player/useAudioTracks";
import { useMediaSource } from "./player/useMediaSource";
import { useNextCountdown } from "./player/useNextCountdown";
import { useOverlay } from "./player/useOverlay";
import { useSubtitles } from "./player/useSubtitles";
import { useSlowWait, useTorrentSwarm } from "./player/useWaiting";
import { useWatchProgress } from "./player/useWatchProgress";

export type { Playing } from "./player/shared";

/**
 * The title's art while a source loads: its backdrop, dimmed, with the logo (or the name) pulsing.
 * The same cover is shown while Vela prepares the source and until the video starts.
 */
function CoverArt({ meta }: { meta: MediaItem }) {
  const [logoFailed, setLogoFailed] = useState(false);
  const background = safeImage(meta.background) ?? safeImage(meta.poster);
  const logo = logoFailed ? undefined : safeImage(meta.logo);
  return (
    <>
      {background && <img className="player-cover-art" src={background} alt="" />}
      {logo ? (
        <img className="player-cover-logo" src={logo} alt={meta.name} onError={() => setLogoFailed(true)} />
      ) : (
        <strong className="player-cover-name">{meta.name}</strong>
      )}
    </>
  );
}

/** The player while Vela resolves the source (torrent metadata, probing): only its cover. */
export function PreparingPlayer({ meta, episode, onClose }: { meta: MediaItem; episode?: Episode; onClose: () => void }) {
  const { fullscreen } = useWindowState();
  return (
    <Dialog title={t("player.preparingTitle", { name: meta.name })} onClose={onClose} className="player-dialog preparing" hideClose>
      <div className="player" data-status="loading">
        <div className="player-loading cover" role="status">
          <CoverArt meta={meta} />
          <span>{t("player.preparingSource")}</span>
        </div>
        <div className="player-top" data-tauri-drag-region>
          <button className="player-icon" aria-label={t("common.back")} title={t("player.backTitle")} onClick={onClose}>
            <ArrowLeft size={20} />
          </button>
          <div className="player-title" data-tauri-drag-region>
            <strong data-tauri-drag-region>{meta.name}</strong>
            {episode && <span data-tauri-drag-region>{episodeText(episode)}</span>}
          </div>
          {!fullscreen && <WindowControls onError={() => undefined} />}
        </div>
      </div>
    </Dialog>
  );
}

/**
 * The integrated player. The pieces live in `./player`: the source and conversion
 * (`useMediaSource`), audio tracks (`useAudioTracks`), subtitles (`useSubtitles`), progress and
 * watched marks (`useWatchProgress`), waits and torrent swarm (`useWaiting`), the next-episode
 * countdown, transient feedback (`useOverlay`), the keyboard (`shortcuts`) and the popovers
 * (`panels`). This component wires them to the video element and draws the controls.
 */
export function Player({
  playing,
  onClose,
  onNext,
  onStarted,
  onFailed,
}: {
  playing: Playing;
  onClose: () => void;
  /** Starts the next episode; resolves when it is playing or rejects with a reason. */
  onNext?: (episode: Episode) => void;
  /** The source played for the first time / could not be played. */
  onStarted?: () => void;
  onFailed?: (message: string) => void;
}) {
  const prefs = usePreferences();
  const settings = prefs.player;
  const video = useRef<HTMLVideoElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const windowState = useWindowState();
  const [browserFullscreen, setBrowserFullscreen] = useState(false);
  const fullscreen = native ? windowState.fullscreen : browserFullscreen;
  const [status, setStatus] = useState<Status>("loading");
  const [waitingSince, setWaitingSince] = useState(Date.now());
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(() => {
    const saved = Number(storage.getItem(volumeKey));
    return Number.isFinite(saved) && saved > 0 && saved <= 1 ? saved : 1;
  });
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [externalBusy, setExternalBusy] = useState(false);
  /** The open popover (audio and subtitles, or speed), aligned with the button that opened it. */
  const [popover, setPopover] = useState<{ kind: "tracks" | "speed"; right: number } | null>(null);
  const openPopover = (kind: "tracks" | "speed", button: HTMLElement) =>
    setPopover((current) => {
      if (current?.kind === kind) return null;
      const box = surface.current?.getBoundingClientRect();
      const right = box ? Math.max(12, box.right - button.getBoundingClientRect().right) : 12;
      return { kind, right };
    });
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  const [resumed, setResumed] = useState(false);
  const [nextDismissed, setNextDismissed] = useState(false);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const seriesId = playing.meta.type === "series" ? playing.meta.id : "";
  const marks = useSeriesMarks(seriesId);
  const next = useMemo(() => nextEpisode(playing.meta, playing.videoId), [playing.meta, playing.videoId]);
  const episodeLine = episodeText(playing.episode);

  const { idle, setIdle, flash, showFlash, pulse, showPulse, wake } = useOverlay(video);
  const progress = useWatchProgress(playing, next, video);
  const media = useMediaSource({
    playing,
    video,
    save: progress.save,
    onError: setError,
    onSwitching: () => {
      setStatus("loading");
      setWaitingSince(Date.now());
      showFlash(t("player.switchingToConversion"));
    },
    onHlsAudioSwitched: (key) => audio.setAudioKey(key),
  });
  const { source, converting, usingHls, probe, hls, pending, resumeAt, mount, hlsAudio, hlsSubtitles, switchToConversion } = media;
  const audio = useAudioTracks({
    video,
    hls,
    source,
    usingHls,
    converting,
    transcodeUrl: playing.transcodeUrl,
    probe,
    hlsAudio,
    pending,
    settings,
    switchToConversion,
  });
  const { audioTracks, audioKey, chooseAudio } = audio;
  const subs = useSubtitles({
    video,
    hls,
    playing,
    probe,
    status,
    converting,
    hlsSubtitles,
    settings,
    audioTracks,
    audioKey,
    setNotice,
    showFlash,
  });
  const { subtitleTracks, subtitleKey, activeSubtitle, cues, shown, delay, subtitleBusy, chooseSubtitle, changeDelay, cycleSubtitles } = subs;

  /* ---------- Intro and credits ---------- */

  // Chapters come from the original file (not the conversion); only Matroska files are read.
  useEffect(() => {
    const controller = new AbortController();
    setChapters([]);
    readMkvChapters((start, length) => requestRange(playing.url, start, length, controller.signal))
      .then((list) => !controller.signal.aborted && setChapters(list))
      .catch(() => {
        /* No chapters: files that are not MKV, servers without ranges, the browser build. */
      });
    return () => controller.abort();
  }, [playing.url]);

  /* ---------- Window, volume and waits ---------- */

  useEffect(() => {
    if (video.current) {
      video.current.volume = volume;
      video.current.muted = muted;
    }
    try {
      storage.setItem(volumeKey, String(volume));
    } catch {
      /* Volume persistence is optional. */
    }
  }, [volume, muted]);

  useEffect(() => {
    const update = () => setBrowserFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", update);
    return () => {
      document.removeEventListener("fullscreenchange", update);
      if (native) void setFullscreen(null, false).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (error && !started.current) onFailed?.(error);
  }, [error, onFailed]);

  const waiting = status === "loading" || status === "buffering";
  const slow = useSlowWait(waiting, waitingSince);
  const infoHash = playing.stream.infoHash && !playing.stream.url ? playing.stream.infoHash : undefined;
  const { swarm, starved } = useTorrentSwarm(infoHash, playing.serviceUrl, waiting, playing.torrentEngine);
  // Vela's engine deletes a torrent once the player is done with it (after a grace period).
  useEffect(() => {
    if (!infoHash || playing.torrentEngine !== "vela") return;
    return () => releaseVelaTorrent(infoHash);
  }, [infoHash, playing.torrentEngine]);

  /* ---------- Next episode ---------- */

  const countdown = useNextCountdown({
    ended: status === "ended",
    available: Boolean(next && onNext),
    dismissed: nextDismissed,
    autoNext: settings.autoNext,
    seconds: settings.nextCountdown,
  });
  const close = useCallback(() => {
    progress.finishIfDone();
    onClose();
  }, [onClose, progress]);
  const playNext = useCallback(
    (episode: Episode) => {
      progress.finishIfDone();
      onNext?.(episode);
    },
    [onNext, progress],
  );
  useEffect(() => {
    if (countdown === 0 && next) playNext(next);
  }, [countdown, next, playNext]);

  /* ---------- Controls ---------- */

  const toggle = () => {
    const element = video.current;
    if (!element) return;
    const kind = element.paused || element.ended ? "play" : "pause";
    if (kind === "play") void element.play().catch(() => setNotice(t("player.pressPlay")));
    else element.pause();
    showPulse(kind);
  };
  const seekBy = (seconds: number) => {
    const element = video.current;
    if (!element || !Number.isFinite(element.duration)) return;
    element.currentTime = Math.max(0, Math.min(element.duration, element.currentTime + seconds));
    showFlash(`${seconds > 0 ? "+" : "−"}${Math.abs(seconds)} s`);
    wake();
  };
  const changeVolume = (value: number) => {
    const nextVolume = Math.max(0, Math.min(1, Math.round(value * 100) / 100));
    setVolume(nextVolume);
    setMuted(nextVolume === 0);
    showFlash(t("player.volumeFlash", { percent: Math.round(nextVolume * 100) }));
  };
  const toggleFullscreen = () =>
    void setFullscreen(surface.current, !fullscreen).catch(() => setNotice(t("player.fullscreenFailed")));
  const external = async () => {
    setExternalBusy(true);
    try {
      const launch = await playExternally(playing.externalUrl, {
        meta: playing.meta,
        addonUrl: playing.addonUrl,
        videoId: playing.videoId,
        headers: playing.headers,
        title: [playing.meta.name, episodeLine].filter(Boolean).join(" · "),
        start: video.current?.currentTime,
        stream: playing.stream,
      });
      video.current?.pause();
      showFlash(launch.ipc ? t("player.openedIn", { player: externalPlayerName(launch) }) : t("player.openedExternal"));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setExternalBusy(false);
    }
  };
  const changeRate = (value: number) => {
    setRate(value);
    if (video.current) video.current.playbackRate = value;
  };

  const percent = duration ? (time / duration) * 100 : 0;
  const quality = streamQuality(playing.stream);
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const remaining = duration - time;
  const segments = useMemo(() => skipSegments(chapters, marks, duration), [chapters, duration, marks]);
  const segment = activeSegment(segments, time);
  const inCredits = segment?.kind === "credits";
  const showNext = Boolean(
    next &&
      onNext &&
      !nextDismissed &&
      !error &&
      (status === "ended" || inCredits || (duration > 120 && remaining <= 30 && remaining > 0)),
  );
  // With a next episode, its card is how credits are skipped; otherwise a button jumps past them.
  const skip = segment && !(inCredits && showNext) && !error ? segment : undefined;
  const skipSegment = () => {
    const element = video.current;
    if (!element || !skip) return;
    element.currentTime = Math.min(skip.end, Number.isFinite(element.duration) ? element.duration : skip.end);
    showFlash(skip.kind === "intro" ? t("player.introSkipped") : t("player.creditsSkipped"));
    wake();
  };

  usePlayerShortcuts((event) => {
    const element = video.current;
    const handled = handleShortcut(
      event,
      {
        seekShort: settings.seekShort,
        seekLong: settings.seekLong,
        paused: Boolean(element?.paused),
        hasDuration: Boolean(element && Number.isFinite(element.duration)),
        canCycleAudio: audioTracks.length > 1,
        canSkip: Boolean(skip),
        hasNext: Boolean(next && onNext),
      },
      {
        escape: () => {
          if (popover) setPopover(null);
          else if (fullscreen) toggleFullscreen();
          else close();
        },
        togglePlay: toggle,
        seekBy,
        volumeBy: (delta) => changeVolume((muted ? 0 : volume) + delta),
        toggleMute: () => {
          showFlash(muted ? t("player.volumeFlash", { percent: Math.round(volume * 100) }) : t("player.muted"));
          setMuted((value) => !value);
        },
        toStart: () => {
          if (!element) return;
          element.currentTime = 0;
          showFlash(t("player.toStart"));
        },
        toEnd: () => {
          if (element) element.currentTime = Math.max(0, element.duration - 1);
        },
        // Frame by frame while paused (about 24 frames per second).
        frameStep: (direction) => {
          if (element) element.currentTime = Math.max(0, element.currentTime + direction / 24);
        },
        speedStep: (direction) => {
          const nextRate = stepSpeed(rate, direction);
          changeRate(nextRate);
          showFlash(t("player.speedFlash", { rate: formatNumber(nextRate) }));
        },
        toggleFullscreen,
        cycleSubtitles,
        delayBy: (seconds) => changeDelay(delay + seconds),
        cycleAudio: () => {
          const index = audioTracks.findIndex((track) => track.key === audioKey);
          const nextTrack = audioTracks[(index + 1) % audioTracks.length];
          chooseAudio(nextTrack);
          showFlash(t("player.audioFlash", { track: nextTrack.label }));
        },
        nextEpisode: () => {
          if (next) playNext(next);
        },
        skipSegment,
        seekToTenth: (tenth) => {
          if (element) element.currentTime = (tenth / 10) * element.duration;
        },
      },
    );
    if (handled) wake();
  });

  const subtitleStyle = {
    "--subtitle-scale": settings.subtitleSize / 100,
    "--subtitle-opacity": settings.subtitleOpacity,
    "--subtitle-background": settings.subtitleBackground,
    "--subtitle-color": settings.subtitleColor,
  } as CSSProperties;
  const busy = status === "loading" || status === "buffering";
  return (
    <Dialog title={t("player.playingTitle", { name: playing.meta.name })} onClose={close} className="player-dialog" hideClose>
      <div
        ref={surface}
        className={`player ${idle && status === "playing" && !popover ? "idle" : ""}`}
        data-status={status}
        onMouseMove={wake}
        onKeyDownCapture={() => wake()}
      >
        <video
          ref={mount}
          autoPlay
          playsInline
          preload="auto"
          aria-label={t("player.videoLabel", { name: playing.meta.name })}
          onLoadedMetadata={(event) => {
            const element = event.currentTarget;
            element.volume = volume;
            element.playbackRate = rate;
            setDuration(Number.isFinite(element.duration) ? element.duration : 0);
            const resumeTo = resumeAt.current;
            if (resumeTo > 0 && (!Number.isFinite(element.duration) || resumeTo < element.duration - 10)) {
              element.currentTime = resumeTo;
              if (resumeTo === playing.resume && !converting) {
                setResumed(true);
                setTimeout(() => setResumed(false), 6000);
              }
            }
          }}
          onDurationChange={(event) =>
            setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)
          }
          onProgress={(event) => {
            const element = event.currentTarget;
            const ranges = element.buffered;
            for (let index = 0; index < ranges.length; index++)
              if (ranges.start(index) <= element.currentTime && ranges.end(index) >= element.currentTime)
                setBuffered(ranges.end(index));
          }}
          onTimeUpdate={(event) => {
            const element = event.currentTarget;
            setTime(element.currentTime);
            resumeAt.current = element.currentTime;
            progress.onTimeUpdate(element);
          }}
          onPlay={() => wake()}
          onPlaying={() => {
            if (!started.current) {
              started.current = true;
              onStarted?.();
            }
            setStatus("playing");
            setNotice((value) => (value === t("player.pressPlay") ? "" : value));
          }}
          onPause={(event) => {
            const element = event.currentTarget;
            if (element.ended) return;
            setStatus((value) => (value === "loading" && element.readyState < 3 ? value : "paused"));
            setIdle(false);
            progress.save(element);
          }}
          onCanPlay={(event) => {
            // Ready is reported only when playback actually starts; a blocked autoplay stays paused.
            if (event.currentTarget.paused) setStatus((value) => (value === "loading" || value === "buffering" ? "paused" : value));
          }}
          onWaiting={() => {
            setStatus((value) => (value === "loading" ? value : "buffering"));
            setWaitingSince(Date.now());
          }}
          onSeeking={(event) => progress.onSeeking(event.currentTarget)}
          onEnded={() => {
            setStatus("ended");
            setIdle(false);
            progress.finish();
          }}
          onError={(event) => {
            const mediaError = event.currentTarget.error;
            log.warn(`player: media error code ${mediaError?.code ?? "?"}`, mediaError?.message || undefined);
            setError(mediaErrorMessage(mediaError));
          }}
          onClick={() => (popover ? setPopover(null) : toggle())}
          onDoubleClick={toggleFullscreen}
        />
        {shown.length > 0 && (
          <div className="player-subtitles" style={subtitleStyle} aria-live="off">
            {(["top", "bottom"] as const).map((place) => {
              const lines = shown.filter((cue) => Boolean(cue.top) === (place === "top"));
              return lines.length ? (
                <div className={`player-subtitle ${place}`} key={place}>
                  {lines.flatMap((cue) => cue.text.split("\n")).map((line, index) => (
                    <span key={index}>{line}</span>
                  ))}
                </div>
              ) : null;
            })}
          </div>
        )}
        <div className="player-top" data-tauri-drag-region>
          <button className="player-icon" aria-label={t("common.back")} title={t("player.backTitle")} onClick={close}>
            <ArrowLeft size={20} />
          </button>
          <div className="player-title" data-tauri-drag-region>
            <strong data-tauri-drag-region>{playing.meta.name}</strong>
            <span data-tauri-drag-region>
              {[episodeLine, playing.stream.addonName, quality, converting && t("player.convertedByService")]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
          {!fullscreen && <WindowControls onError={setNotice} />}
        </div>
        {busy && !error && (
          <div className={`player-loading${status === "loading" ? " cover" : ""}`} role="status">
            {status === "loading" ? <CoverArt meta={playing.meta} /> : <LoaderCircle className="spin" size={34} strokeWidth={1.5} />}
            <span>
              {status === "buffering"
                ? t("player.loadingMore")
                : converting && !playing.transcodedBecause
                  ? t("player.converting")
                  : playing.note || t("player.loading")}
            </span>
            {swarm && (
              <span
                className="player-swarm"
                title={t("player.swarmHint")}
              >
                {describeTorrent(swarm.stats)}
              </span>
            )}
            {(slow || starved) && (
              <div className="player-slow">
                <p>
                  {starved
                    ? t("player.torrentStarved", { unchoked: swarm!.stats.unchoked, peers: swarm!.stats.peers })
                    : t("player.slowSource")}
                </p>
                <div>
                  {infoHash && (
                    <button className="button small subtle" onClick={onClose}>
                      {t("player.chooseOtherSource")}
                    </button>
                  )}
                  {playing.transcodeUrl && !converting && !infoHash && (
                    <button className="button small subtle" onClick={() => switchToConversion({})}>
                      {t("player.tryService")}
                    </button>
                  )}
                  <button className="button small subtle" disabled={externalBusy} onClick={() => void external()}>
                    {t("player.openExternal")}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {flash && <div className="player-flash" aria-live="polite">{flash}</div>}
        {pulse && (
          <div className="player-pulse" key={pulse.id} aria-hidden="true">
            {pulse.kind === "play" ? <Play size={34} fill="currentColor" /> : <Pause size={34} fill="currentColor" />}
          </div>
        )}
        {notice && !error && (
          <div className="player-notice" role="status">
            <span>{notice}</span>
            <button className="button small subtle" onClick={() => setNotice("")}>
              {t("common.close")}
            </button>
          </div>
        )}
        {resumed && !error && (
          <div className="player-resume">
            {t("player.resumedAt", { time: clock(playing.resume) })}
            <button
              className="button small subtle"
              onClick={() => {
                if (video.current) video.current.currentTime = 0;
                setResumed(false);
              }}
            >
              {t("player.startOver")}
            </button>
          </div>
        )}
        {skip && (
          <button className="button player-skip" onClick={skipSegment} aria-keyshortcuts="S">
            <SkipForward size={15} /> {skip.kind === "intro" ? t("player.skipIntro") : t("player.skipCredits")}
          </button>
        )}
        {showNext && next && (
          <section className="player-next" aria-label={t("player.nextEpisode")}>
            <span className="player-next-label">
              {countdown !== null ? t("player.nextEpisodeIn", { seconds: countdown }) : t("player.nextEpisode")}
            </span>
            <strong>
              {episodeCode(next)}
              {next.title ? ` · ${next.title}` : ""}
            </strong>
            <div>
              <button className="button primary small" data-autofocus onClick={() => playNext(next)}>
                <SkipForward size={14} /> {t("player.watchNow")}
              </button>
              <button className="button small subtle" onClick={() => setNextDismissed(true)}>
                {countdown !== null ? t("common.cancel") : t("player.hide")}
              </button>
            </div>
          </section>
        )}
        {error && (
          <div className="player-error" role="alert">
            <h2>{t("player.cannotPlay")}</h2>
            <p>{error}</p>
            <div>
              {playing.transcodeUrl && !converting && (
                <button className="button primary" onClick={() => switchToConversion({})}>
                  <RefreshCw size={15} />
                  {t("player.convertWithService")}
                </button>
              )}
              <button
                className={`button ${playing.transcodeUrl && !converting ? "secondary" : "primary"}`}
                disabled={externalBusy}
                onClick={() => void external()}
              >
                <MonitorPlay size={15} />
                {t("player.openExternal")}
              </button>
              <button className="button secondary" onClick={onClose}>
                {t("player.chooseOtherSource")}
              </button>
            </div>
          </div>
        )}
        {popover?.kind === "tracks" && (
          <TrackPanel
            right={popover.right}
            audio={audioTracks}
            audioKey={audioKey}
            subtitles={subtitleTracks}
            subtitleKey={subtitleKey}
            preferred={[settings.subtitleLanguage, settings.subtitleSecondary]}
            delay={delay}
            cues={cues}
            time={time}
            onAudio={(track) => chooseAudio(track)}
            onSubtitle={(track) => void chooseSubtitle(track)}
            onDelay={changeDelay}
            look={settings}
            onLook={(value) => preferencesStore.setPlayer(value)}
          />
        )}
        {popover?.kind === "speed" && (
          <SpeedPanel
            right={popover.right}
            rate={rate}
            onChange={changeRate}
            marks={
              seriesId
                ? {
                    value: marks,
                    time,
                    duration,
                    fromChapters: segments.filter((item) => item.source === "chapters").map((item) => item.kind),
                    onChange: (value) => skipMarks.set(seriesId, value),
                  }
                : undefined
            }
          />
        )}
        <div className="player-controls">
          <div
            className="seek"
            onMouseMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
              setHover({ x: Math.min(rect.width - 28, Math.max(28, ratio * rect.width)), time: ratio * duration });
            }}
            onMouseLeave={() => setHover(null)}
          >
            <div className="seek-track">
              <span className="seek-buffer" style={{ width: `${duration ? Math.min(100, (buffered / duration) * 100) : 0}%` }} />
              {duration > 0 &&
                segments.map((item) => (
                  <span
                    key={`${item.kind}-${item.start}`}
                    className="seek-segment"
                    aria-hidden="true"
                    style={{ left: `${(item.start / duration) * 100}%`, width: `${((item.end - item.start) / duration) * 100}%` }}
                  />
                ))}
              <span className="seek-fill" style={{ width: `${percent}%` }} />
            </div>
            <input
              aria-label={t("player.seekPosition")}
              aria-valuetext={t("player.timeOf", { time: clock(time), duration: clock(duration) })}
              type="range"
              min="0"
              max={duration || 1}
              step="0.1"
              value={Math.min(time, duration || 1)}
              disabled={!duration}
              style={{ "--thumb": `${percent}%` } as CSSProperties}
              onChange={(event) => {
                if (video.current) video.current.currentTime = Number(event.target.value);
              }}
            />
            {hover && duration > 0 && (
              <span className="seek-tooltip" style={{ left: hover.x }}>
                {clock(hover.time)}
              </span>
            )}
          </div>
          <div className="player-row">
            <button
              className="player-icon"
              aria-label={status === "playing" || status === "buffering" ? t("player.pause") : t("player.play")}
              title={status === "playing" ? t("player.pauseKey") : t("player.playKey")}
              onClick={toggle}
            >
              {status === "playing" || status === "buffering" ? (
                <Pause size={20} fill="currentColor" />
              ) : (
                <Play size={20} fill="currentColor" />
              )}
            </button>
            <button
              className="player-icon"
              aria-label={t("player.rewindLabel", { seconds: settings.seekLong })}
              title={t("player.rewindTitle", { seconds: settings.seekLong })}
              onClick={() => seekBy(-settings.seekLong)}
            >
              <RotateCcw size={18} />
            </button>
            <button
              className="player-icon"
              aria-label={t("player.forwardLabel", { seconds: settings.seekLong })}
              title={t("player.forwardTitle", { seconds: settings.seekLong })}
              onClick={() => seekBy(settings.seekLong)}
            >
              <RotateCw size={18} />
            </button>
            {next && onNext && (
              <button
                className="player-icon"
                aria-label={t("player.nextEpisodeLabel", { code: episodeCode(next) })}
                title={t("player.nextEpisodeTitle", { code: episodeCode(next) })}
                onClick={() => playNext(next)}
              >
                <SkipForward size={18} />
              </button>
            )}
            <div className="volume">
              <button
                className="player-icon"
                aria-label={muted ? t("player.unmute") : t("player.mute")}
                title={muted ? t("player.unmuteKey") : t("player.muteKey")}
                onClick={() => setMuted(!muted)}
              >
                <VolumeIcon size={19} />
              </button>
              <input
                type="range"
                aria-label={t("player.volume")}
                min="0"
                max="1"
                step="0.05"
                value={muted ? 0 : volume}
                style={{ "--thumb": `${(muted ? 0 : volume) * 100}%` } as CSSProperties}
                onChange={(event) => changeVolume(Number(event.target.value))}
              />
            </div>
            <span className="player-time">
              {clock(time)} <span>/ {clock(duration)}</span>
            </span>
            <span className="player-spacer" />
            <button
              className={`player-icon ${subtitleKey || audioTracks.length > 1 ? "active" : ""} ${popover?.kind === "tracks" ? "pressed" : ""}`}
              aria-label={t("player.audioAndSubtitles")}
              aria-expanded={popover?.kind === "tracks"}
              aria-haspopup="dialog"
              title={
                activeSubtitle
                  ? t("player.subtitlesTitle", { track: activeSubtitle.label })
                  : subtitleTracks.length || audioTracks.length > 1
                    ? t("player.audioAndSubtitlesKey")
                    : t("player.noExtraTracks")
              }
              onClick={(event) => openPopover("tracks", event.currentTarget)}
            >
              {subtitleBusy ? <LoaderCircle className="spin" size={18} /> : <Captions size={19} />}
            </button>
            <button
              className={`player-icon ${rate !== 1 ? "active" : ""} ${popover?.kind === "speed" ? "pressed" : ""}`}
              aria-label={t("player.playbackSpeed")}
              aria-haspopup="dialog"
              aria-expanded={popover?.kind === "speed"}
              title={t("player.speed")}
              onClick={(event) => openPopover("speed", event.currentTarget)}
            >
              {rate !== 1 ? <span className="rate">{rate}×</span> : <Gauge size={19} />}
            </button>
            {native && (
              <button
                className="player-icon"
                aria-label={t("player.openExternal")}
                title={t("player.openExternal")}
                disabled={externalBusy}
                onClick={() => void external()}
              >
                <MonitorPlay size={19} />
              </button>
            )}
            <button
              className="player-icon"
              aria-label={fullscreen ? t("player.exitFullscreen") : t("player.fullscreen")}
              title={fullscreen ? t("player.exitFullscreenKey") : t("player.fullscreenKey")}
              onClick={toggleFullscreen}
            >
              {fullscreen ? <Minimize size={19} /> : <Maximize size={19} />}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
