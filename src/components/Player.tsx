import { useCallback, useRef, useState } from "react";
import {
  ArrowLeft,
  Expand,
  ExternalLink,
  LoaderCircle,
  Pause,
  Play,
  Settings2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { MediaItem, ResolvedStream, Subtitle } from "../lib/contracts";
import { getSubtitles } from "../lib/protocol";
import { preferencesStore } from "../lib/store";
import { launchExternalPlayer, requestText } from "../lib/transport";
import { clock, errorMessage } from "../lib/utils";
import { Dialog } from "./Primitives";

export type Playing = {
  meta: MediaItem;
  addonUrl: string;
  videoId: string;
  stream: ResolvedStream;
  url: string;
  resume: number;
};

function toWebVtt(text: string): string {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  return normalized.trimStart().startsWith("WEBVTT")
    ? normalized
    : `WEBVTT\n\n${normalized.replace(/(\d\d:\d\d:\d\d),(\d{3})/g, "$1.$2")}`;
}

export function Player({
  playing,
  onClose,
}: {
  playing: Playing;
  onClose: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const lastSave = useRef(0);
  const [status, setStatus] = useState<"loading" | "playing" | "paused">(
    "loading",
  );
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState("");
  const [subtitles, setSubtitles] = useState<Subtitle[]>(
    playing.stream.subtitles || [],
  );
  const [subtitleUrl, setSubtitleUrl] = useState("");
  const [subtitleBusy, setSubtitleBusy] = useState(false);
  const [externalBusy, setExternalBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const blob = useRef("");

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
      if (
        /\.m3u8(?:$|\?)/i.test(playing.url) &&
        !element.canPlayType("application/vnd.apple.mpegurl")
      ) {
        void import("hls.js")
          .then(({ default: Hls }) => {
            if (destroyed) return;
            if (!Hls.isSupported()) {
              setError("Este formato necesita un reproductor externo.");
              return;
            }
            const hls = new Hls({ maxBufferLength: 30, backBufferLength: 30 });
            hls.loadSource(playing.url);
            hls.attachMedia(element);
            hls.on(Hls.Events.ERROR, (_event, data) => {
              if (data.fatal)
                setError(
                  "No se ha podido reproducir esta fuente. Prueba otra o abre el reproductor externo.",
                );
            });
            dispose = () => hls.destroy();
          })
          .catch(() => setError("No se ha podido cargar el reproductor HLS."));
      } else element.src = playing.url;
      void getSubtitles(
        preferencesStore.getSnapshot().addons,
        playing.meta.type,
        playing.videoId,
        playing.stream,
      )
        .then((items) => {
          if (!destroyed)
            setSubtitles(items);
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
    [playing, save],
  );

  const external = async () => {
    setExternalBusy(true);
    try {
      await launchExternalPlayer(
        playing.url,
        preferencesStore.getSnapshot().externalPlayerPath,
      );
      video.current?.pause();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setExternalBusy(false);
    }
  };
  const chooseSubtitle = async (url: string) => {
    setSubtitleBusy(true);
    try {
      if (blob.current) {
        URL.revokeObjectURL(blob.current);
        blob.current = "";
      }
      if (!url) {
        setSubtitleUrl("");
        return;
      }
      const text = await requestText(url);
      blob.current = URL.createObjectURL(
        new Blob([toWebVtt(text)], { type: "text/vtt" }),
      );
      setSubtitleUrl(blob.current);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSubtitleBusy(false);
    }
  };

  return (
    <Dialog
      title={`Reproduciendo ${playing.meta.name}`}
      onClose={onClose}
      className="player-dialog"
    >
      <div className="player-surface">
        <video
          ref={mount}
          autoPlay
          playsInline
          preload="metadata"
          aria-label={`Vídeo: ${playing.meta.name}`}
          onLoadedMetadata={(event) => {
            const el = event.currentTarget;
            setDuration(Number.isFinite(el.duration) ? el.duration : 0);
            if (playing.resume > 0 && playing.resume < el.duration - 10)
              el.currentTime = playing.resume;
          }}
          onTimeUpdate={(event) => {
            setTime(event.currentTarget.currentTime);
            if (Date.now() - lastSave.current > 5000) {
              save(event.currentTarget);
              lastSave.current = Date.now();
            }
          }}
          onPlay={() => setStatus("playing")}
          onPause={() => setStatus("paused")}
          onCanPlay={() =>
            setStatus(video.current?.paused ? "paused" : "playing")
          }
          onWaiting={() => setStatus("loading")}
          onEnded={(event) => {
            save(event.currentTarget);
            setStatus("paused");
          }}
          onError={() =>
            setError(
              "Esta fuente no está disponible o usa un formato incompatible. Prueba otra fuente o un reproductor externo.",
            )
          }
          onClick={() =>
            video.current?.paused
              ? void video.current.play().catch(() => {})
              : video.current?.pause()
          }
        >
          {subtitleUrl && (
            <track
              key={subtitleUrl}
              kind="subtitles"
              src={subtitleUrl}
              label="Subtítulos"
              srcLang="es"
              default
            />
          )}
        </video>
        <div className="player-top">
          <button className="player-back" onClick={onClose}>
            <ArrowLeft size={20} />
            Volver
          </button>
          <div>
            <strong>{playing.meta.name}</strong>
            <span>{playing.stream.addonName}</span>
          </div>
          <span className="player-quality">VELA PLAYER</span>
        </div>
        {status === "loading" && !error && (
          <div className="player-loading">
            <LoaderCircle className="spin" size={30} />
            <span>Preparando tu historia</span>
          </div>
        )}
        {error && (
          <div className="player-error" role="alert">
            <h3>Probemos otra forma</h3>
            <p>{error}</p>
            <div>
              <button
                className="button primary"
                disabled={externalBusy}
                onClick={() => void external()}
              >
                <ExternalLink size={16} />
                Abrir en reproductor externo
              </button>
              <button className="button ghost" onClick={onClose}>
                Elegir otra fuente
              </button>
            </div>
          </div>
        )}
        <div className="player-controls">
          <input
            className="player-seek"
            aria-label="Posición de reproducción"
            type="range"
            min="0"
            max={duration || 1}
            step="0.1"
            value={time}
            onChange={(event) => {
              if (video.current)
                video.current.currentTime = Number(event.target.value);
            }}
          />
          <div className="player-control-row">
            <button
              className="icon-button"
              aria-label={status === "playing" ? "Pausar" : "Reproducir"}
              onClick={() =>
                video.current?.paused
                  ? void video.current
                      .play()
                      .catch(() =>
                        setError("Pulsa reproducir para iniciar el vídeo."),
                      )
                  : video.current?.pause()
              }
            >
              {status === "playing" ? (
                <Pause size={22} fill="currentColor" />
              ) : (
                <Play size={22} fill="currentColor" />
              )}
            </button>
            <button
              className="icon-button"
              aria-label={muted ? "Activar sonido" : "Silenciar"}
              onClick={() => {
                if (video.current) {
                  video.current.muted = !muted;
                  setMuted(!muted);
                }
              }}
            >
              {muted ? <VolumeX size={20} /> : <Volume2 size={20} />}
            </button>
            <span className="player-time">
              {clock(time)} <span>/ {clock(duration)}</span>
            </span>
            <div className="player-controls-spacer" />
            <button
              className="icon-button"
              aria-label="Opciones de reproducción"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen(!settingsOpen)}
            >
              <Settings2 size={20} />
            </button>
            <button
              className="icon-button"
              aria-label="Abrir en reproductor externo"
              disabled={externalBusy}
              onClick={() => void external()}
            >
              <ExternalLink size={18} />
            </button>
            <button
              className="icon-button"
              aria-label="Pantalla completa"
              onClick={() => {
                const container = video.current?.parentElement;
                if (document.fullscreenElement) void document.exitFullscreen();
                else void container?.requestFullscreen().catch(() => {});
              }}
            >
              <Expand size={20} />
            </button>
          </div>
          {settingsOpen && (
            <div className="player-settings">
              <div>
                <strong>Tu forma de verlo</strong>
                <button
                  className="icon-button"
                  aria-label="Cerrar opciones"
                  onClick={() => setSettingsOpen(false)}
                >
                  <X size={15} />
                </button>
              </div>
              <label>
                Velocidad
                <select
                  defaultValue="1"
                  onChange={(event) => {
                    if (video.current)
                      video.current.playbackRate = Number(event.target.value);
                  }}
                >
                  {[0.75, 1, 1.25, 1.5, 2].map((value) => (
                    <option key={value} value={value}>
                      {value}×
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Subtítulos
                <select
                  aria-label="Subtítulos"
                  disabled={subtitleBusy}
                  defaultValue=""
                  onChange={(event) => void chooseSubtitle(event.target.value)}
                >
                  <option value="">Desactivados</option>
                  {subtitles.map((subtitle, index) => (
                    <option
                      key={`${subtitle.id}-${index}`}
                      value={subtitle.url}
                    >
                      {subtitle.lang}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
