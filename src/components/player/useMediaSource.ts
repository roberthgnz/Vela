import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type Hls from "hls.js";
import { normalizeLanguage } from "../../lib/languages";
import { probe as probeMedia, type Probe } from "../../lib/streamingServer";
import { hlsPattern, numbered, trackName, type Playing, type Track } from "./shared";

/**
 * The video element's source: the direct file, an HLS list (native in WebView2, hls.js elsewhere)
 * or Stremio Service's conversion, which the player switches to when the browser cannot decode
 * the file or the user picks an audio track inside it. Also asks Stremio Service which tracks the
 * file has when nothing inspected it before playback.
 */
export function useMediaSource(options: {
  playing: Playing;
  video: RefObject<HTMLVideoElement | null>;
  /** Writes the position before the element is torn down. */
  save: (element: HTMLVideoElement) => void;
  onError: (message: string) => void;
  /** The conversion is about to load: show the loading state again. */
  onSwitching: () => void;
  /** hls.js switched audio tracks (also on its own, at start). */
  onHlsAudioSwitched: (key: string) => void;
}) {
  const { playing, video, save } = options;
  // The callbacks change identity every render; the mount callback must not, or React would
  // tear the element down and set it up again on each render.
  const callbacks = useRef(options);
  callbacks.current = options;

  const [source, setSource] = useState(playing.url);
  const [probe, setProbe] = useState<Probe | undefined>(playing.probe);
  const [hlsAudio, setHlsAudio] = useState<Track[]>([]);
  const [hlsSubtitles, setHlsSubtitles] = useState<Track[]>([]);
  const hls = useRef<Hls | null>(null);
  /** Choices made before switching to the conversion, applied once its tracks are known. */
  const pending = useRef<{ audio?: number }>({});
  // Resuming a few seconds in is not useful; start over instead.
  const resumeAt = useRef(playing.resume >= 15 ? playing.resume : 0);
  const converting = source === playing.transcodeUrl;
  const usingHls = hlsPattern.test(source);

  const mount = useCallback(
    (element: HTMLVideoElement | null) => {
      if (!element) return;
      video.current = element;
      let destroyed = false;
      let dispose: (() => void) | undefined;
      setHlsAudio([]);
      setHlsSubtitles([]);
      // WebView2 plays HLS natively (and exposes its audio renditions as audioTracks). That path is
      // required for Stremio Service: the server sends CORS headers only to Stremio's own origins,
      // so hls.js, which downloads with XHR, cannot read its playlists from Vela.
      if (hlsPattern.test(source) && !element.canPlayType("application/vnd.apple.mpegurl")) {
        void import("hls.js")
          .then(({ default: HlsPlayer }) => {
            if (destroyed) return;
            if (!HlsPlayer.isSupported()) {
              callbacks.current.onError("Este formato necesita un reproductor externo.");
              return;
            }
            const instance = new HlsPlayer({ maxBufferLength: 30, backBufferLength: 30 });
            // Cues are loaded into hidden text tracks and drawn by Vela.
            instance.subtitleDisplay = false;
            hls.current = instance;
            const audioTracks = () =>
              setHlsAudio(
                numbered(
                  instance.audioTracks.map((track, index) => ({
                    key: `hls-audio:${index}`,
                    label: trackName(track.lang ?? "", track.name),
                    lang: normalizeLanguage(track.lang),
                    origin: "hls" as const,
                    index,
                  })),
                ),
              );
            instance.on(HlsPlayer.Events.MANIFEST_PARSED, () => {
              audioTracks();
              setHlsSubtitles(
                numbered(
                  instance.subtitleTracks.map((track, index) => ({
                    key: `hls-sub:${index}`,
                    label: trackName(track.lang ?? "", track.name),
                    lang: normalizeLanguage(track.lang),
                    origin: "hls" as const,
                    index,
                  })),
                ),
              );
            });
            instance.on(HlsPlayer.Events.AUDIO_TRACK_SWITCHED, (_event, data) =>
              callbacks.current.onHlsAudioSwitched(`hls-audio:${data.id}`),
            );
            instance.on(HlsPlayer.Events.ERROR, (_event, data) => {
              if (data.fatal)
                callbacks.current.onError(
                  data.type === HlsPlayer.ErrorTypes.NETWORK_ERROR
                    ? "La lista HLS o sus segmentos no responden. Puede que el servidor exija cabeceras o bloquee la petición."
                    : "No se ha podido decodificar esta lista HLS en el reproductor integrado.",
                );
            });
            instance.loadSource(source);
            instance.attachMedia(element);
            dispose = () => {
              instance.destroy();
              hls.current = null;
            };
          })
          .catch(() => callbacks.current.onError("No se ha podido cargar el reproductor HLS."));
      } else element.src = source;
      return () => {
        destroyed = true;
        save(element);
        dispose?.();
        element.pause();
        element.removeAttribute("src");
        element.load();
      };
    },
    [save, source, video],
  );

  // Without a previous inspection, ask Stremio Service which tracks the file has (in the background).
  useEffect(() => {
    if (probe || !playing.transcodeUrl || hlsPattern.test(playing.url)) return;
    let active = true;
    void probeMedia(playing.serviceUrl, new URL(playing.transcodeUrl).searchParams.get("mediaURL") ?? playing.url)
      .then((result) => {
        if (active) setProbe(result);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [playing, probe]);

  const switchToConversion = useCallback(
    (choice: { audio?: number }) => {
      if (!playing.transcodeUrl) return;
      pending.current = choice;
      resumeAt.current = video.current?.currentTime ?? resumeAt.current;
      callbacks.current.onError("");
      callbacks.current.onSwitching();
      setSource(playing.transcodeUrl);
    },
    [playing.transcodeUrl, video],
  );

  return { source, converting, usingHls, probe, hls, pending, resumeAt, mount, hlsAudio, hlsSubtitles, switchToConversion };
}
