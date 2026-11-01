import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type Hls from "hls.js";
import { t } from "../../lib/i18n";
import { normalizeLanguage } from "../../lib/languages";
import { mediaCapabilities, probe as probeMedia, probeProblems, type Probe } from "../../lib/streamingServer";
import { hlsPattern, numbered, trackName, type Playing, type Track } from "./shared";

/** `HTMLMediaElement.HAVE_CURRENT_DATA`: the element is decoding the source. */
const DECODING = 2;

/**
 * Why a file needs Stremio Service's conversion, from its inspection. Once the direct source is
 * decoding, only a file without a playable audio track switches: its video already plays (the
 * conversion would only cost quality), but WebView2 plays it in silence when it cannot decode
 * any of its audio tracks.
 */
export function conversionReasons(result: Probe, element: HTMLVideoElement | null): string[] {
  const capabilities = mediaCapabilities();
  const problems = probeProblems(result, capabilities);
  if (!problems.length || (element?.readyState ?? 0) < DECODING) return problems;
  const audio = result.streams.filter((stream) => stream.track === "audio");
  const silent = audio.length > 0 && !audio.some((stream) => capabilities.audioCodecs.includes(stream.codec));
  return silent ? problems : [];
}

/**
 * The video element's source: the direct file, an HLS list (native in WebView2, hls.js elsewhere)
 * or Stremio Service's conversion, which the player switches to when the browser cannot decode
 * the file or the user picks an audio track inside it. Stremio Service inspects the file in the
 * background while the direct source starts: the track menus use what it finds, and a file that
 * may need it (`convertIfNeeded`) switches to the conversion when a track cannot be decoded.
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
  /**
   * The built-in player cannot decode the file and there is no conversion to switch to: the
   * player hands it to embedded mpv (or offers to download it).
   */
  onUnsupported: (reasons: string[]) => void;
}) {
  const { playing, video, save } = options;
  // The callbacks change identity every render; the mount callback must not, or React would
  // tear the element down and set it up again on each render.
  const callbacks = useRef(options);
  callbacks.current = options;

  // A file known not to open (its container) starts with the conversion when there is one, and is
  // not loaded at all otherwise: it goes to mpv.
  const known = playing.unsupported?.length ? playing.unsupported : undefined;
  const [source, setSource] = useState(known ? (playing.transcodeUrl ?? "") : playing.url);
  const current = useRef(source);
  current.current = source;
  const [probe, setProbe] = useState<Probe | undefined>();
  /** Why the player switched to the conversion by itself (before or after the inspection), if it did. */
  const [convertedBecause, setConvertedBecause] = useState<string[] | undefined>(
    known && playing.transcodeUrl ? known : undefined,
  );
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
      if (!source) return;
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
              callbacks.current.onError(t("player.hls.needsExternal"));
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
                    ? t("player.hls.network")
                    : t("player.hls.decode"),
                );
            });
            instance.loadSource(source);
            instance.attachMedia(element);
            dispose = () => {
              instance.destroy();
              hls.current = null;
            };
          })
          .catch(() => callbacks.current.onError(t("player.hls.loadFailed")));
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

  /** Loads the source again from where it was (after the server opened the torrent again). */
  const reload = useCallback(() => {
    const element = video.current;
    if (!element) return;
    if (element.currentTime > 0) resumeAt.current = element.currentTime;
    element.load();
  }, [video]);

  // Known before loading: there is no conversion, so mpv takes over.
  useEffect(() => {
    if (known && !playing.transcodeUrl) callbacks.current.onUnsupported(known);
  }, [known, playing.transcodeUrl]);

  // Stremio Service inspects the file in the background (for a torrent it waits for the first
  // pieces, which the direct source is fetching anyway).
  useEffect(() => {
    if (probe || !playing.transcodeUrl || hlsPattern.test(playing.url)) return;
    let active = true;
    void probeMedia(playing.serviceUrl, new URL(playing.transcodeUrl).searchParams.get("mediaURL") ?? playing.url)
      .then((result) => {
        if (!active) return;
        setProbe(result);
        if (!playing.convertIfNeeded || current.current === playing.transcodeUrl) return;
        const reasons = conversionReasons(result, video.current);
        if (!reasons.length) return;
        setConvertedBecause(reasons);
        switchToConversion({});
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [playing, probe, switchToConversion, video]);

  return {
    source,
    converting,
    convertedBecause,
    usingHls,
    probe,
    hls,
    pending,
    resumeAt,
    mount,
    hlsAudio,
    hlsSubtitles,
    switchToConversion,
    reload,
  };
}
