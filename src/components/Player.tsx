import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
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
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { Episode, MediaItem, ResolvedStream, Subtitle } from "../lib/contracts";
import { getSubtitles } from "../lib/protocol";
import { preferencesStore } from "../lib/store";
import { subtitleUrl as serviceSubtitleUrl } from "../lib/streamingServer";
import { streamQuality } from "../lib/streams";
import { launchExternalPlayer, requestText } from "../lib/transport";
import { clock, errorMessage } from "../lib/utils";
import { anchorFrom, Dialog, useMenu, type MenuItem } from "./Primitives";
import { native, setFullscreen, useWindowState, WindowControls } from "./WindowControls";

export type Playing = {
  meta: MediaItem;
  addonUrl: string;
  videoId: string;
  stream: ResolvedStream;
  url: string;
  /** Original URL and headers for an external player. */
  externalUrl: string;
  headers?: Record<string, string>;
  /** HLS conversion through Stremio Service, when available. */
  transcodeUrl?: string;
  transcodedBecause?: string[];
  resume: number;
  episode?: Episode;
  /** Optional explanation shown while the source is being prepared (for example, a torrent). */
  note?: string;
};

export function toWebVtt(text: string): string {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  return normalized.trimStart().startsWith("WEBVTT")
    ? normalized
    : `WEBVTT\n\n${normalized.replace(/(\d\d:\d\d:\d\d),(\d{3})/g, "$1.$2")}`;
}

const languageNames = (() => {
  try {
    return new Intl.DisplayNames(["es"], { type: "language" });
  } catch {
    return undefined;
  }
})();

const legacyCodes: Record<string, string> = { fre: "fra", ger: "deu", dut: "nld", chi: "zho", cze: "ces", gre: "ell", per: "fas", rum: "ron", slo: "slk", alb: "sqi", arm: "hye", baq: "eus", bur: "mya", geo: "kat", ice: "isl", mac: "mkd", may: "msa", wel: "cym", pob: "pt-BR" };

export function languageLabel(code: string): string {
  const normalized = legacyCodes[code.toLowerCase()] || code;
  try {
    const name = languageNames?.of(normalized);
    if (name && name.toLowerCase() !== normalized.toLowerCase())
      return name.charAt(0).toLocaleUpperCase("es") + name.slice(1);
  } catch {
    /* Unknown codes are shown as provided by the addon. */
  }
  return code;
}

function mediaErrorMessage(error: MediaError | null): string {
  switch (error?.code) {
    case MediaError.MEDIA_ERR_NETWORK:
      return "Se perdió la conexión con la fuente durante la descarga.";
    case MediaError.MEDIA_ERR_DECODE:
      return "WebView2 no puede decodificar este vídeo. Suele ocurrir con HEVC, audio DTS/TrueHD o archivos dañados.";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "La fuente no responde o usa un contenedor o códec que el reproductor integrado no admite (por ejemplo MKV con HEVC o AVI).";
    default:
      return "Esta fuente no se ha podido reproducir.";
  }
}

const volumeKey = "vela.ui.volume";

export function Player({
  playing,
  onClose,
}: {
  playing: Playing;
  onClose: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const lastSave = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const blob = useRef("");
  const menu = useMenu();
  const windowState = useWindowState();
  const [browserFullscreen, setBrowserFullscreen] = useState(false);
  const fullscreen = native ? windowState.fullscreen : browserFullscreen;
  const [status, setStatus] = useState<"loading" | "playing" | "paused">("loading");
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(() => {
    const saved = Number(localStorage.getItem(volumeKey));
    return Number.isFinite(saved) && saved > 0 && saved <= 1 ? saved : 1;
  });
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [error, setError] = useState("");
  const [subtitles, setSubtitles] = useState<Subtitle[]>(playing.stream.subtitles || []);
  const [subtitle, setSubtitle] = useState<Subtitle | null>(null);
  const [subtitleUrl, setSubtitleUrl] = useState("");
  const [subtitleBusy, setSubtitleBusy] = useState(false);
  const [externalBusy, setExternalBusy] = useState(false);
  const [idle, setIdle] = useState(false);
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  const [flash, setFlash] = useState("");
  const [resumed, setResumed] = useState(false);
  const [cue, setCue] = useState("");
  const [source, setSource] = useState(playing.url);
  // Resuming a few seconds in is not useful; start over instead.
  const resumeAt = useRef(playing.resume >= 15 ? playing.resume : 0);
  const converting = source === playing.transcodeUrl;
  // Cues are drawn by Vela so they can move above the controls.
  const trackRef = useCallback((track: HTMLTrackElement | null) => {
    if (!track) return;
    const text = track.track;
    const update = () =>
      setCue(
        [...(text.activeCues ?? [])]
          .map((cue) => (cue as VTTCue).text.replace(/<[^>]+>/g, ""))
          .join("\n"),
      );
    text.mode = "hidden";
    text.addEventListener("cuechange", update);
    return () => {
      text.removeEventListener("cuechange", update);
      setCue("");
    };
  }, []);

  const episodeLine = playing.episode
    ? `T${playing.episode.season ?? 1} · E${playing.episode.episode ?? 1}${playing.episode.title ? ` · ${playing.episode.title}` : ""}`
    : "";
  const save = useCallback(
    (element: HTMLVideoElement) => {
      if (Number.isFinite(element.duration) && element.duration > 0)
        preferencesStore.updateProgress(playing.meta, playing.addonUrl, {
          videoId: playing.videoId,
          seconds: element.currentTime,
          duration: element.duration,
          updatedAt: Date.now(),
        });
    },
    [playing],
  );

  const mount = useCallback(
    (element: HTMLVideoElement | null) => {
      if (!element) return;
      video.current = element;
      let destroyed = false;
      let dispose: (() => void) | undefined;
      if (/\.m3u8(?:$|\?)/i.test(source) && !element.canPlayType("application/vnd.apple.mpegurl")) {
        void import("hls.js")
          .then(({ default: Hls }) => {
            if (destroyed) return;
            if (!Hls.isSupported()) {
              setError("Este formato necesita un reproductor externo.");
              return;
            }
            const hls = new Hls({ maxBufferLength: 30, backBufferLength: 30 });
            hls.loadSource(source);
            hls.attachMedia(element);
            hls.on(Hls.Events.ERROR, (_event, data) => {
              if (data.fatal)
                setError(
                  data.type === Hls.ErrorTypes.NETWORK_ERROR
                    ? "La lista HLS o sus segmentos no responden. Puede que el servidor exija cabeceras o bloquee la petición."
                    : "No se ha podido decodificar esta lista HLS en el reproductor integrado.",
                );
            });
            dispose = () => hls.destroy();
          })
          .catch(() => setError("No se ha podido cargar el reproductor HLS."));
      } else element.src = source;
      void getSubtitles(
        preferencesStore.getSnapshot().addons,
        playing.meta.type,
        playing.videoId,
        playing.stream,
      )
        .then((items) => {
          if (!destroyed) setSubtitles(items);
        })
        .catch(() => {});
      return () => {
        destroyed = true;
        save(element);
        dispose?.();
        element.pause();
        element.removeAttribute("src");
        element.load();
        if (blob.current) URL.revokeObjectURL(blob.current);
      };
    },
    [playing, save, source],
  );

  useEffect(() => {
    if (video.current) {
      video.current.volume = volume;
      video.current.muted = muted;
    }
    try {
      localStorage.setItem(volumeKey, String(volume));
    } catch {
      /* Volume persistence is optional. */
    }
  }, [volume, muted]);

  useEffect(() => {
    const update = () => setBrowserFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", update);
    return () => {
      document.removeEventListener("fullscreenchange", update);
      clearTimeout(hideTimer.current);
      if (native) void setFullscreen(null, false).catch(() => {});
    };
  }, []);

  const wake = useCallback(() => {
    setIdle(false);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!video.current?.paused) setIdle(true);
    }, 2600);
  }, []);

  const showFlash = (value: string) => {
    setFlash(value);
    setTimeout(() => setFlash((current) => (current === value ? "" : current)), 700);
  };
  const toggle = () => {
    const element = video.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => setError("Pulsa reproducir para iniciar el vídeo."));
    else element.pause();
  };
  const seekBy = (seconds: number) => {
    const element = video.current;
    if (!element || !Number.isFinite(element.duration)) return;
    element.currentTime = Math.max(0, Math.min(element.duration, element.currentTime + seconds));
    showFlash(`${seconds > 0 ? "+" : "−"}${Math.abs(seconds)} s`);
    wake();
  };
  const changeVolume = (value: number) => {
    const next = Math.max(0, Math.min(1, Math.round(value * 100) / 100));
    setVolume(next);
    setMuted(next === 0);
    showFlash(`Volumen ${Math.round(next * 100)} %`);
  };
  const toggleFullscreen = () =>
    void setFullscreen(surface.current, !fullscreen).catch(() =>
      setError("No se pudo cambiar a pantalla completa."),
    );
  const external = async () => {
    setExternalBusy(true);
    try {
      await launchExternalPlayer(playing.externalUrl, preferencesStore.getSnapshot().externalPlayerPath, {
        headers: playing.headers,
        title: [playing.meta.name, episodeLine].filter(Boolean).join(" · "),
      });
      video.current?.pause();
      showFlash("Abierto en el reproductor externo");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setExternalBusy(false);
    }
  };
  const chooseSubtitle = async (item: Subtitle | null) => {
    setSubtitleBusy(true);
    try {
      if (blob.current) {
        URL.revokeObjectURL(blob.current);
        blob.current = "";
      }
      setSubtitle(item);
      if (!item) {
        setSubtitleUrl("");
        return;
      }
      let text: string;
      try {
        text = await requestText(item.url);
      } catch (cause) {
        // Stremio Service converts subtitle encodings (for example Windows-1252 SRT) to UTF-8 WebVTT.
        try {
          text = await requestText(serviceSubtitleUrl(preferencesStore.getSnapshot().serviceUrl, item.url));
        } catch {
          throw cause;
        }
      }
      blob.current = URL.createObjectURL(new Blob([toWebVtt(text)], { type: "text/vtt" }));
      setSubtitleUrl(blob.current);
    } catch (cause) {
      setSubtitle(null);
      setError(`No se pudieron cargar los subtítulos. ${errorMessage(cause)}`);
    } finally {
      setSubtitleBusy(false);
    }
  };
  const subtitleMenu = (button: HTMLElement) => {
    const items: MenuItem[] = [
      { label: "Desactivados", checked: !subtitle, onSelect: () => void chooseSubtitle(null) },
    ];
    const counts = new Map<string, number>();
    for (const item of subtitles) {
      const label = languageLabel(item.lang);
      const count = (counts.get(label) || 0) + 1;
      counts.set(label, count);
      items.push({
        label: count > 1 ? `${label} (${count})` : label,
        checked: subtitle?.url === item.url,
        onSelect: () => void chooseSubtitle(item),
      });
    }
    menu.open(anchorFrom(button, "end", true), items, "Subtítulos");
  };
  const speedMenu = (button: HTMLElement) =>
    menu.open(
      anchorFrom(button, "end", true),
      [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((value) => ({
        label: value === 1 ? "Normal" : `${value}×`,
        checked: rate === value,
        onSelect: () => {
          setRate(value);
          if (video.current) video.current.playbackRate = value;
        },
      })),
      "Velocidad",
    );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest(".menu")) return;
    const onRange = target instanceof HTMLInputElement && target.type === "range";
    const key = event.key.toLowerCase();
    let handled = true;
    if (key === "escape") {
      if (fullscreen) toggleFullscreen();
      else onClose();
    } else if (key === " " || key === "k") {
      if (target instanceof HTMLButtonElement && key === " ") handled = false;
      else toggle();
    } else if (!onRange && key === "arrowleft") seekBy(-5);
    else if (!onRange && key === "arrowright") seekBy(5);
    else if (key === "j") seekBy(-10);
    else if (key === "l") seekBy(10);
    else if (!onRange && key === "arrowup") changeVolume(volume + 0.05);
    else if (!onRange && key === "arrowdown") changeVolume(volume - 0.05);
    else if (key === "m") setMuted((value) => !value);
    else if (key === "f") toggleFullscreen();
    else if (key === "c" && subtitles.length) {
      const index = subtitle ? subtitles.indexOf(subtitle) : -1;
      const next = subtitles[index + 1] || null;
      void chooseSubtitle(next);
      showFlash(next ? `Subtítulos: ${languageLabel(next.lang)}` : "Subtítulos desactivados");
    } else if (/^[0-9]$/.test(key) && video.current && Number.isFinite(video.current.duration))
      video.current.currentTime = (Number(key) / 10) * video.current.duration;
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
      wake();
    }
  };

  const percent = duration ? (time / duration) * 100 : 0;
  const quality = streamQuality(playing.stream);
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  return (
    <Dialog
      title={`Reproduciendo ${playing.meta.name}`}
      onClose={onClose}
      className="player-dialog"
      hideClose
    >
      <div
        ref={surface}
        className={`player ${idle && status === "playing" && !menu.isOpen ? "idle" : ""}`}
        onMouseMove={wake}
        onKeyDownCapture={() => wake()}
        onKeyDown={onKeyDown}
      >
        <video
          ref={mount}
          autoPlay
          playsInline
          preload="auto"
          aria-label={`Vídeo: ${playing.meta.name}`}
          onLoadedMetadata={(event) => {
            const element = event.currentTarget;
            element.volume = volume;
            element.playbackRate = rate;
            setDuration(Number.isFinite(element.duration) ? element.duration : 0);
            const resumeTo = resumeAt.current;
            if (resumeTo > 0 && (!Number.isFinite(element.duration) || resumeTo < element.duration - 10)) {
              element.currentTime = resumeTo;
              if (resumeTo === playing.resume) {
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
            setTime(event.currentTarget.currentTime);
            resumeAt.current = event.currentTarget.currentTime;
            if (Date.now() - lastSave.current > 5000) {
              save(event.currentTarget);
              lastSave.current = Date.now();
            }
          }}
          onPlay={() => {
            setStatus("playing");
            wake();
          }}
          onPause={(event) => {
            setStatus("paused");
            setIdle(false);
            save(event.currentTarget);
          }}
          onPlaying={() => setStatus("playing")}
          onCanPlay={() => setStatus(video.current?.paused ? "paused" : "playing")}
          onWaiting={() => setStatus("loading")}
          onEnded={(event) => {
            save(event.currentTarget);
            setStatus("paused");
          }}
          onError={(event) => setError(mediaErrorMessage(event.currentTarget.error))}
          onClick={toggle}
          onDoubleClick={toggleFullscreen}
        >
          {subtitleUrl && (
            <track
              key={subtitleUrl}
              kind="subtitles"
              src={subtitleUrl}
              label={subtitle ? languageLabel(subtitle.lang) : "Subtítulos"}
              srcLang={subtitle?.lang.slice(0, 2) || "und"}
              ref={trackRef}
            />
          )}
        </video>
        {cue && (
          <div className="player-subtitle" aria-live="off">
            {cue.split("\n").map((line, index) => (
              <span key={index}>{line}</span>
            ))}
          </div>
        )}
        <div className="player-top" data-tauri-drag-region>
          <button className="player-icon" aria-label="Volver" title="Volver (Esc)" onClick={onClose}>
            <ArrowLeft size={20} />
          </button>
          <div className="player-title" data-tauri-drag-region>
            <strong data-tauri-drag-region>{playing.meta.name}</strong>
            <span data-tauri-drag-region>
              {[episodeLine, playing.stream.addonName, quality, converting && "Convertido por Stremio Service"]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
          {!fullscreen && <WindowControls onError={setError} />}
        </div>
        {status === "loading" && !error && (
          <div className="player-loading" role="status">
            <LoaderCircle className="spin" size={34} strokeWidth={1.5} />
            <span>
              {converting && !playing.transcodedBecause
                ? "Convirtiendo con Stremio Service"
                : playing.note || "Cargando"}
            </span>
          </div>
        )}
        {flash && <div className="player-flash" aria-live="polite">{flash}</div>}
        {resumed && !error && (
          <div className="player-resume">
            Reanudado en {clock(playing.resume)}
            <button
              className="button small subtle"
              onClick={() => {
                if (video.current) video.current.currentTime = 0;
                setResumed(false);
              }}
            >
              Empezar desde el principio
            </button>
          </div>
        )}
        {error && (
          <div className="player-error" role="alert">
            <h2>No se puede reproducir aquí</h2>
            <p>{error}</p>
            <div>
              {playing.transcodeUrl && !converting && (
                <button
                  className="button primary"
                  onClick={() => {
                    setError("");
                    setStatus("loading");
                    setSource(playing.transcodeUrl!);
                  }}
                >
                  <RefreshCw size={15} />
                  Convertir con Stremio Service
                </button>
              )}
              <button
                className={`button ${playing.transcodeUrl && !converting ? "secondary" : "primary"}`}
                disabled={externalBusy}
                onClick={() => void external()}
              >
                <MonitorPlay size={15} />
                Abrir en reproductor externo
              </button>
              <button className="button secondary" onClick={onClose}>
                Elegir otra fuente
              </button>
            </div>
          </div>
        )}
        <div className="player-controls">
          <div
            className="seek"
            onMouseMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
              setHover({ x: ratio * rect.width, time: ratio * duration });
            }}
            onMouseLeave={() => setHover(null)}
          >
            <div className="seek-track">
              <span className="seek-buffer" style={{ width: `${duration ? (buffered / duration) * 100 : 0}%` }} />
              <span className="seek-fill" style={{ width: `${percent}%` }} />
            </div>
            <input
              aria-label="Posición de reproducción"
              aria-valuetext={`${clock(time)} de ${clock(duration)}`}
              type="range"
              min="0"
              max={duration || 1}
              step="0.1"
              value={time}
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
              aria-label={status === "playing" ? "Pausar" : "Reproducir"}
              title={status === "playing" ? "Pausar (K)" : "Reproducir (K)"}
              onClick={toggle}
            >
              {status === "playing" ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
            </button>
            <button className="player-icon" aria-label="Retroceder 10 segundos" title="Retroceder 10 s (J)" onClick={() => seekBy(-10)}>
              <RotateCcw size={18} />
            </button>
            <button className="player-icon" aria-label="Avanzar 10 segundos" title="Avanzar 10 s (L)" onClick={() => seekBy(10)}>
              <RotateCw size={18} />
            </button>
            <div className="volume">
              <button
                className="player-icon"
                aria-label={muted ? "Activar sonido" : "Silenciar"}
                title={muted ? "Activar sonido (M)" : "Silenciar (M)"}
                onClick={() => setMuted(!muted)}
              >
                <VolumeIcon size={19} />
              </button>
              <input
                type="range"
                aria-label="Volumen"
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
              className={`player-icon ${subtitle ? "active" : ""}`}
              aria-label="Subtítulos"
              aria-haspopup="menu"
              title={subtitles.length ? "Subtítulos (C)" : "No hay subtítulos disponibles"}
              disabled={subtitleBusy || !subtitles.length}
              onClick={(event) => subtitleMenu(event.currentTarget)}
            >
              {subtitleBusy ? <LoaderCircle className="spin" size={18} /> : <Captions size={19} />}
            </button>
            <button
              className={`player-icon ${rate !== 1 ? "active" : ""}`}
              aria-label="Velocidad de reproducción"
              aria-haspopup="menu"
              title="Velocidad"
              onClick={(event) => speedMenu(event.currentTarget)}
            >
              {rate !== 1 ? <span className="rate">{rate}×</span> : <Gauge size={19} />}
            </button>
            <button
              className="player-icon"
              aria-label="Abrir en reproductor externo"
              title="Abrir en reproductor externo"
              disabled={externalBusy}
              onClick={() => void external()}
            >
              <MonitorPlay size={19} />
            </button>
            <button
              className="player-icon"
              aria-label={fullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
              title={fullscreen ? "Salir de pantalla completa (F)" : "Pantalla completa (F)"}
              onClick={toggleFullscreen}
            >
              {fullscreen ? <Minimize size={19} /> : <Maximize size={19} />}
            </button>
          </div>
        </div>
        {menu.element}
      </div>
    </Dialog>
  );
}
