import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
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
import type Hls from "hls.js";
import type JASSUB from "jassub";
import type { Episode, MediaItem, ResolvedStream, Subtitle } from "../lib/contracts";
import { episodeCode, nextEpisode } from "../lib/episodes";
import { playExternally } from "../lib/externalPlayback";
import { languageLabel, normalizeLanguage, pickByLanguage } from "../lib/languages";
import { getSubtitles } from "../lib/protocol";
import { CREDITS_THRESHOLD, preferencesStore, usePreferences, WATCHED_THRESHOLD } from "../lib/store";
import {
  embeddedAssUrl,
  embeddedSubtitlePlaylist,
  probe as probeMedia,
  readSubtitleRendition,
  subtitleUrl as serviceSubtitleUrl,
  describeTorrent,
  torrentStats,
  type Probe,
  type TorrentStats,
} from "../lib/streamingServer";
import { streamQuality } from "../lib/streams";
import { activeCues, decodeSubtitle, dedupeSubtitles, parseSubtitle, type Cue } from "../lib/subtitles";
import { requestBytes, requestText } from "../lib/transport";
import { clock, errorMessage } from "../lib/utils";
import { Dialog } from "./Primitives";
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
  /** Tracks found by Stremio Service before playback. */
  probe?: Probe;
  serviceUrl: string;
  resume: number;
  episode?: Episode;
  /** Optional explanation shown while the source is being prepared (for example, a torrent). */
  note?: string;
};

/** Audio or subtitle choice offered to the user. */
type Track = {
  key: string;
  label: string;
  lang: string;
  detail?: string;
  /** Where it comes from: an addon/torrent file, a track of the HLS stream, the browser, or the file (needs conversion). */
  origin: "file" | "hls" | "native" | "embedded";
  index: number;
  subtitle?: Subtitle;
  codec?: string;
};

type Status = "loading" | "buffering" | "playing" | "paused" | "ended";

type NativeAudioTracks = EventTarget & {
  length: number;
  [index: number]: { label: string; language: string; enabled: boolean };
};

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
const hlsPattern = /\.m3u8(?:$|[?#])/i;
const assCodecs = new Set(["ass", "ssa"]);

/** Track names that muxers write by default and say nothing to the viewer. */
const genericTitles = /^(sound|video|subtitle|text)handler$|^core media (audio|video|text)$|^(stereo|mono|surround)$|^track ?\d*$/i;

function trackName(lang: string, title?: string | null): string {
  const label = lang ? languageLabel(lang) : "";
  const clean = title?.trim() ?? "";
  const named = clean && !genericTitles.test(clean) && normalizeLanguage(clean) !== normalizeLanguage(lang) ? clean : "";
  return [label, named].filter(Boolean).join(" · ") || clean || "Pista";
}

function numbered<T extends { label: string }>(items: T[]): T[] {
  const totals = new Map<string, number>();
  for (const item of items) totals.set(item.label, (totals.get(item.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  return items.map((item) => {
    if ((totals.get(item.label) ?? 0) < 2) return item;
    const count = (seen.get(item.label) ?? 0) + 1;
    seen.set(item.label, count);
    return { ...item, label: `${item.label} ${count}` };
  });
}

/** Loads a subtitle file: raw bytes with encoding detection, then Stremio Service's conversion as a fallback. */
async function loadSubtitleFile(url: string, serviceUrl: string) {
  let failure: unknown;
  try {
    return parseSubtitle(decodeSubtitle(await requestBytes(url)).text);
  } catch (error) {
    failure = error;
  }
  // The service converts other encodings and formats (for example MicroDVD) to WebVTT.
  try {
    return parseSubtitle(await requestText(serviceSubtitleUrl(serviceUrl, url)));
  } catch {
    throw failure;
  }
}

async function createAssRenderer(video: HTMLVideoElement, content: string, timeOffset: number): Promise<JASSUB> {
  const [{ default: Renderer }, workerUrl, wasmUrl, modernWasmUrl] = await Promise.all([
    import("jassub"),
    import("jassub/dist/worker/worker.js?worker&url").then((module) => module.default),
    import("jassub/dist/wasm/jassub-worker.wasm?url").then((module) => module.default),
    import("jassub/dist/wasm/jassub-worker-modern.wasm?url").then((module) => module.default),
  ]);
  const renderer = new Renderer({ video, subContent: content, workerUrl, wasmUrl, modernWasmUrl, queryFonts: false, timeOffset });
  await renderer.ready;
  return renderer;
}

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
  const hls = useRef<Hls | null>(null);
  const ass = useRef<JASSUB | null>(null);
  const lastSave = useRef(0);
  const watchedTime = useRef({ last: -1, total: 0, marked: false });
  const finished = useRef(false);
  const started = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<{ audio?: number }>({});
  const autoChosen = useRef({ audio: false, subtitle: false });
  const windowState = useWindowState();
  const [browserFullscreen, setBrowserFullscreen] = useState(false);
  const fullscreen = native ? windowState.fullscreen : browserFullscreen;
  const [status, setStatus] = useState<Status>("loading");
  const [waitingSince, setWaitingSince] = useState(Date.now());
  const [slow, setSlow] = useState(false);
  const [swarm, setSwarm] = useState<{ stats: TorrentStats; stalledSince?: number } | null>(null);
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
  const [notice, setNotice] = useState("");
  const [fileSubtitles, setFileSubtitles] = useState<Subtitle[]>(() => dedupeSubtitles(playing.stream.subtitles || []));
  const [hlsAudio, setHlsAudio] = useState<Track[]>([]);
  const [hlsSubtitles, setHlsSubtitles] = useState<Track[]>([]);
  const [nativeAudio, setNativeAudio] = useState<Track[]>([]);
  const [audioKey, setAudioKey] = useState("");
  const [subtitleKey, setSubtitleKey] = useState("");
  const [cues, setCues] = useState<Cue[]>([]);
  const [shown, setShown] = useState<Cue[]>([]);
  const [delay, setDelay] = useState(0);
  const [assActive, setAssActive] = useState(false);
  const [subtitleBusy, setSubtitleBusy] = useState(false);
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
  const [idle, setIdle] = useState(false);
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  const [flash, setFlash] = useState("");
  const [resumed, setResumed] = useState(false);
  const [source, setSource] = useState(playing.url);
  const [probe, setProbe] = useState<Probe | undefined>(playing.probe);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [nextDismissed, setNextDismissed] = useState(false);
  // Resuming a few seconds in is not useful; start over instead.
  const resumeAt = useRef(playing.resume >= 15 ? playing.resume : 0);
  const converting = source === playing.transcodeUrl;
  const usingHls = hlsPattern.test(source);
  const next = useMemo(() => nextEpisode(playing.meta, playing.videoId), [playing.meta, playing.videoId]);

  const episodeLine = playing.episode
    ? `${episodeCode(playing.episode)}${playing.episode.title ? ` · ${playing.episode.title}` : ""}`
    : "";

  const showFlash = useCallback((value: string) => {
    setFlash(value);
    setTimeout(() => setFlash((current) => (current === value ? "" : current)), 900);
  }, []);

  /* ---------- Progress, watched marks and the next episode ---------- */

  const save = useCallback(
    (element: HTMLVideoElement) => {
      if (finished.current || !Number.isFinite(element.duration) || element.duration <= 0) return;
      preferencesStore.updateProgress(playing.meta, playing.addonUrl, {
        videoId: playing.videoId,
        seconds: element.currentTime,
        duration: element.duration,
        updatedAt: Date.now(),
      });
    },
    [playing],
  );
  const markWatched = useCallback(() => {
    if (watchedTime.current.marked) return;
    watchedTime.current.marked = true;
    preferencesStore.setWatched(playing.meta, playing.addonUrl, [playing.videoId], true);
  }, [playing]);
  /** Past the credits: the title points to the next episode (or leaves «Seguir viendo»). */
  const finish = useCallback(() => {
    if (finished.current) return;
    markWatched();
    finished.current = true;
    preferencesStore.finishVideo(playing.meta, playing.addonUrl, playing.videoId, next?.id);
  }, [markWatched, next, playing]);

  /* ---------- Source: direct file, HLS (hls.js) and the conversion ---------- */

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
              setError("Este formato necesita un reproductor externo.");
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
            instance.on(HlsPlayer.Events.AUDIO_TRACK_SWITCHED, (_event, data) => setAudioKey(`hls-audio:${data.id}`));
            instance.on(HlsPlayer.Events.ERROR, (_event, data) => {
              if (data.fatal)
                setError(
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
          .catch(() => setError("No se ha podido cargar el reproductor HLS."));
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
    [save, source],
  );

  // Addon subtitles for this video, merged with the stream's own and without duplicates.
  useEffect(() => {
    let active = true;
    void getSubtitles(preferencesStore.getSnapshot().addons, playing.meta.type, playing.videoId, playing.stream)
      .then((items) => {
        if (active) setFileSubtitles(dedupeSubtitles(items));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [playing]);

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

  const embeddedAudio: Track[] = useMemo(
    () =>
      numbered(
        (probe?.streams ?? [])
          .filter((stream) => stream.track === "audio")
          .map((stream, index) => ({
            key: `file-audio:${index}`,
            label: trackName(stream.language ?? "", stream.title),
            lang: normalizeLanguage(stream.language),
            detail: [stream.codec.toUpperCase(), stream.channels ? `${stream.channels} canales` : ""].filter(Boolean).join(" · "),
            origin: "embedded" as const,
            index: stream.id ?? index,
            codec: stream.codec,
          })),
      ),
    [probe],
  );
  const embeddedSubtitles: Track[] = useMemo(
    () =>
      numbered(
        (probe?.streams ?? [])
          .filter((stream) => stream.track === "subtitle")
          .map((stream, index) => ({
            key: `file-sub:${index}`,
            label: trackName(stream.language ?? "", stream.title),
            lang: normalizeLanguage(stream.language),
            detail: assCodecs.has(stream.codec) ? "ASS" : stream.codec === "subrip" ? "SRT" : stream.codec.toUpperCase(),
            origin: "embedded" as const,
            index: stream.id ?? index,
            codec: stream.codec,
          })),
      ),
    [probe],
  );

  // Audio: the HLS renditions, the browser's own tracks, or the file's tracks (through the conversion).
  const audioTracks: Track[] = nativeAudio.length
    ? nativeAudio
    : hlsAudio.length
      ? hlsAudio
      : embeddedAudio.length > 1 && playing.transcodeUrl && !converting
        ? embeddedAudio
        : [];
  const subtitleTracks: Track[] = useMemo(() => {
    // Tracks inside the file are read through Stremio Service's converter; renditions of other
    // HLS streams played with hls.js come from the playlist.
    const embedded = playing.transcodeUrl ? embeddedSubtitles : hlsSubtitles;
    const files = numbered(
      fileSubtitles.map((item, index) => ({
        key: `ext:${item.url}`,
        label: languageLabel(item.lang),
        lang: normalizeLanguage(item.lang),
        detail: item.id.startsWith("torrent:") ? "Torrent" : undefined,
        origin: "file" as const,
        index,
        subtitle: item,
      })),
    );
    return [...embedded, ...files];
  }, [embeddedSubtitles, fileSubtitles, hlsSubtitles, playing.transcodeUrl]);

  const switchToConversion = useCallback(
    (choice: { audio?: number }) => {
      if (!playing.transcodeUrl) return;
      pending.current = choice;
      resumeAt.current = video.current?.currentTime ?? resumeAt.current;
      setError("");
      setStatus("loading");
      setWaitingSince(Date.now());
      setSource(playing.transcodeUrl);
      showFlash("Cambiando a la conversión de Stremio Service");
    },
    [playing.transcodeUrl, showFlash],
  );

  /* ---------- Audio ---------- */

  // The browser's own audio tracks (direct files and native HLS). WebView2 exposes them when
  // the AudioVideoTracks Blink feature is enabled (see tauri.conf.json).
  useEffect(() => {
    const element = video.current;
    const list = (element as (HTMLVideoElement & { audioTracks?: NativeAudioTracks }) | null)?.audioTracks;
    if (!element || !list) return;
    const read = () => {
      const tracks: Track[] = [];
      let enabled = "";
      for (let index = 0; index < list.length; index++) {
        tracks.push({
          key: `native:${index}`,
          label: trackName(list[index].language, list[index].label),
          lang: normalizeLanguage(list[index].language),
          origin: "native",
          index,
        });
        if (list[index].enabled) enabled = `native:${index}`;
      }
      setNativeAudio(tracks.length > 1 ? numbered(tracks) : []);
      if (enabled) setAudioKey(enabled);
    };
    read();
    list.addEventListener("addtrack", read);
    list.addEventListener("removetrack", read);
    list.addEventListener("change", read);
    return () => {
      list.removeEventListener("addtrack", read);
      list.removeEventListener("removetrack", read);
      list.removeEventListener("change", read);
    };
  }, [source]);

  const chooseAudio = useCallback(
    (track: Track) => {
      if (track.origin === "hls" && hls.current) {
        hls.current.audioTrack = track.index;
        setAudioKey(track.key);
      } else if (track.origin === "native" && video.current) {
        const list = (video.current as HTMLVideoElement & { audioTracks?: NativeAudioTracks }).audioTracks;
        if (list) for (let index = 0; index < list.length; index++) list[index].enabled = index === track.index;
        setAudioKey(track.key);
      } else if (track.origin === "embedded") switchToConversion({ audio: embeddedAudio.indexOf(track) });
      autoChosen.current.audio = true;
    },
    [embeddedAudio, switchToConversion],
  );

  /* ---------- Subtitles ---------- */

  const clearRenderer = useCallback(() => {
    const renderer = ass.current;
    ass.current = null;
    setAssActive(false);
    void renderer?.destroy().catch(() => {});
  }, []);

  const loading = useRef<AbortController | null>(null);
  const chooseSubtitle = useCallback(
    async (track: Track | null) => {
      loading.current?.abort();
      const controller = new AbortController();
      loading.current = controller;
      setNotice("");
      clearRenderer();
      setCues([]);
      setShown([]);
      if (hls.current) hls.current.subtitleTrack = track?.origin === "hls" ? track.index : -1;
      setSubtitleKey(track?.key ?? "");
      if (!track) return;
      setSubtitleBusy(true);
      try {
        let raw: string | undefined;
        if (track.origin === "file" && track.subtitle) {
          const parsed = await loadSubtitleFile(track.subtitle.url, playing.serviceUrl);
          setCues(parsed.cues);
          if (parsed.format === "ass") raw = parsed.raw;
        } else if (track.origin === "embedded" && playing.transcodeUrl) {
          // The converter must exist before it serves tracks: asking for its playlist creates it
          // (it only inspects the file; nothing is transcoded until video segments are requested).
          if (!converting) await requestText(playing.transcodeUrl);
          if (track.codec && assCodecs.has(track.codec)) {
            // ASS/SSA keep their styles: the converter serves the original script.
            const parsed = parseSubtitle(decodeSubtitle(await requestBytes(embeddedAssUrl(playing.transcodeUrl, track.index))).text);
            setCues(parsed.cues);
            raw = parsed.raw;
          } else {
            const collected: Cue[] = [];
            await readSubtitleRendition(
              embeddedSubtitlePlaylist(playing.transcodeUrl, track.index),
              (url) => requestText(url),
              (text) => {
                try {
                  collected.push(...parseSubtitle(text).cues);
                } catch {
                  return; // Segments without cues are normal.
                }
                if (!controller.signal.aborted)
                  setCues([...collected].sort((a, b) => a.start - b.start || a.end - b.end));
              },
              video.current?.currentTime ?? 0,
              controller.signal,
            );
            if (!collected.length && !controller.signal.aborted) throw new Error("La pista no contiene subtítulos.");
          }
        }
        if (controller.signal.aborted) return;
        if (raw && video.current) {
          try {
            ass.current = await createAssRenderer(video.current, raw, -delay);
            setAssActive(true);
          } catch (failure) {
            // Styled rendering is optional: the plain cues remain.
            console.warn("ASS renderer unavailable", failure);
            setNotice("Los estilos ASS no están disponibles; se muestran como texto.");
          }
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        setSubtitleKey("");
        setNotice(`No se pudieron cargar los subtítulos. ${errorMessage(cause)}`);
      } finally {
        setSubtitleBusy(false);
      }
    },
    [clearRenderer, converting, delay, playing.serviceUrl, playing.transcodeUrl],
  );

  // HLS renditions: hls.js loads cues into a hidden text track; Vela draws them with its own styles.
  useEffect(() => {
    const element = video.current;
    if (!element || !subtitleKey.startsWith("hls-sub:")) return;
    const collect = () => {
      const track = [...element.textTracks].find((item) => item.mode === "hidden" && item.kind === "subtitles");
      if (!track?.cues) return;
      const list: Cue[] = [];
      for (const cue of track.cues) list.push({ start: cue.startTime, end: cue.endTime, text: (cue as VTTCue).text.replace(/<[^>]+>/g, "") });
      setCues((current) => (current.length === list.length ? current : list.sort((a, b) => a.start - b.start)));
    };
    const timer = setInterval(collect, 1000);
    collect();
    return () => clearInterval(timer);
  }, [subtitleKey]);

  useEffect(() => {
    if (ass.current) ass.current.timeOffset = -delay;
  }, [delay]);
  useEffect(() => clearRenderer, [clearRenderer]);

  // Draws the cues at the current time, shifted by the user's delay.
  useEffect(() => {
    const element = video.current;
    if (!element || assActive || !cues.length) {
      setShown([]);
      return;
    }
    let frame = 0;
    let previous = "";
    const tick = () => {
      const list = activeCues(cues, element.currentTime - delay);
      const key = list.map((cue) => cue.text).join("\u0000");
      if (key !== previous) {
        previous = key;
        setShown(list);
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [assActive, cues, delay]);

  // Pending choices made before switching to the conversion, then automatic choices by language.
  useEffect(() => {
    const wanted = pending.current.audio;
    const list = nativeAudio.length ? nativeAudio : hlsAudio;
    if (!usingHls || wanted === undefined || !list[wanted]) return;
    chooseAudio(list[wanted]);
    pending.current.audio = undefined;
    autoChosen.current.audio = true;
  }, [chooseAudio, hlsAudio, nativeAudio, usingHls]);
  useEffect(() => {
    if (autoChosen.current.audio || !audioTracks.length || !settings.audioLanguage) return;
    const preferred = pickByLanguage(audioTracks, (track) => track.lang, settings.audioLanguage, settings.audioSecondary);
    // Do not switch to the conversion only to change the audio language.
    if (preferred && preferred.origin !== "embedded") {
      autoChosen.current.audio = true;
      if (preferred.key !== audioKey) chooseAudio(preferred);
    }
  }, [audioKey, audioTracks, chooseAudio, settings.audioLanguage, settings.audioSecondary]);
  useEffect(() => {
    if (autoChosen.current.subtitle || !settings.subtitlesAuto || status === "loading") return;
    const candidates = subtitleTracks;
    const preferred = pickByLanguage(candidates, (track) => track.lang, settings.subtitleLanguage, settings.subtitleSecondary);
    // An audio track in the preferred subtitle language makes subtitles unnecessary.
    const audioLang = audioTracks.find((track) => track.key === audioKey)?.lang;
    if (!preferred || (audioLang && audioLang === normalizeLanguage(settings.subtitleLanguage))) return;
    autoChosen.current.subtitle = true;
    void chooseSubtitle(preferred);
  }, [audioKey, audioTracks, chooseSubtitle, settings, status, subtitleTracks]);

  /* ---------- Window, volume and controls ---------- */

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

  useEffect(() => {
    if (error && !started.current) onFailed?.(error);
  }, [error, onFailed]);

  // Long waits get an explanation and alternatives instead of an endless spinner.
  useEffect(() => {
    setSlow(false);
    if (status !== "loading" && status !== "buffering") return;
    const timer = setTimeout(() => setSlow(true), 15_000);
    return () => clearTimeout(timer);
  }, [status, waitingSince]);

  // Torrents: show the swarm while loading, and say so when no data arrives.
  const infoHash = playing.stream.infoHash && !playing.stream.url ? playing.stream.infoHash : undefined;
  useEffect(() => {
    if (!infoHash || (status !== "loading" && status !== "buffering")) return;
    let active = true;
    const read = () =>
      void torrentStats(playing.serviceUrl, infoHash)
        .then((stats) => {
          if (!active) return;
          setSwarm((previous) => {
            const moving = stats.speed > 0 || stats.downloaded > (previous?.stats.downloaded ?? 0);
            return { stats, stalledSince: moving ? undefined : (previous?.stalledSince ?? Date.now()) };
          });
        })
        .catch(() => {});
    read();
    const timer = setInterval(read, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [infoHash, playing.serviceUrl, status]);
  const starved = Boolean(swarm?.stalledSince && Date.now() - swarm.stalledSince > 20_000);

  // Countdown to the next episode once the current one has ended.
  useEffect(() => {
    if (status !== "ended" || !next || !onNext || nextDismissed || !settings.autoNext || settings.nextCountdown <= 0) {
      setCountdown(null);
      return;
    }
    setCountdown(settings.nextCountdown);
    const timer = setInterval(() => setCountdown((value) => (value === null ? null : value - 1)), 1000);
    return () => clearInterval(timer);
  }, [next, nextDismissed, onNext, settings.autoNext, settings.nextCountdown, status]);

  /** Past the credits, leaving counts as finishing the video (as when it ends). */
  const finishIfDone = useCallback(() => {
    const element = video.current;
    if (element && Number.isFinite(element.duration) && element.currentTime > element.duration * CREDITS_THRESHOLD) finish();
  }, [finish]);
  const close = useCallback(() => {
    finishIfDone();
    onClose();
  }, [finishIfDone, onClose]);
  const playNext = useCallback(
    (episode: Episode) => {
      finishIfDone();
      onNext?.(episode);
    },
    [finishIfDone, onNext],
  );
  useEffect(() => {
    if (countdown === 0 && next) playNext(next);
  }, [countdown, next, playNext]);

  const wake = useCallback(() => {
    setIdle(false);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!video.current?.paused) setIdle(true);
    }, 2600);
  }, []);

  const toggle = () => {
    const element = video.current;
    if (!element) return;
    if (element.paused || element.ended) void element.play().catch(() => setNotice("Pulsa reproducir para iniciar el vídeo."));
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
  const changeDelay = (value: number) => {
    const next = Math.round(value * 10) / 10;
    setDelay(next);
    showFlash(`Desfase de subtítulos ${next > 0 ? "+" : ""}${next.toLocaleString("es", { minimumFractionDigits: 1 })} s`);
  };
  const toggleFullscreen = () =>
    void setFullscreen(surface.current, !fullscreen).catch(() => setNotice("No se pudo cambiar a pantalla completa."));
  const external = async () => {
    setExternalBusy(true);
    try {
      const { ipc } = await playExternally(playing.externalUrl, {
        meta: playing.meta,
        addonUrl: playing.addonUrl,
        videoId: playing.videoId,
        headers: playing.headers,
        title: [playing.meta.name, episodeLine].filter(Boolean).join(" · "),
        start: video.current?.currentTime,
      });
      video.current?.pause();
      showFlash(ipc ? "Abierto en MPV · Vela guardará el progreso" : "Abierto en el reproductor externo");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setExternalBusy(false);
    }
  };
  const cycleSubtitles = () => {
    const usable = subtitleTracks;
    if (!usable.length) return;
    const index = usable.findIndex((track) => track.key === subtitleKey);
    const nextTrack = usable[index + 1] ?? null;
    void chooseSubtitle(nextTrack);
    showFlash(nextTrack ? `Subtítulos: ${nextTrack.label}` : "Subtítulos desactivados");
  };
  const changeRate = (value: number) => {
    setRate(value);
    if (video.current) video.current.playbackRate = value;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const onRange = target instanceof HTMLInputElement && target.type === "range";
    const inPanel = Boolean(target.closest(".player-popover"));
    const key = event.key.toLowerCase();
    let handled = true;
    if (key === "escape") {
      if (popover) setPopover(null);
      else if (fullscreen) toggleFullscreen();
      else close();
    } else if (inPanel && (key === " " || key === "enter" || key.startsWith("arrow"))) handled = false;
    else if (key === " " || key === "k") {
      if (target instanceof HTMLButtonElement && key === " ") handled = false;
      else toggle();
    } else if (!onRange && key === "arrowleft") seekBy(-settings.seekShort);
    else if (!onRange && key === "arrowright") seekBy(settings.seekShort);
    else if (key === "j") seekBy(-settings.seekLong);
    else if (key === "l") seekBy(settings.seekLong);
    else if (!onRange && key === "arrowup") changeVolume(volume + 0.05);
    else if (!onRange && key === "arrowdown") changeVolume(volume - 0.05);
    else if (key === "m") setMuted((value) => !value);
    else if (key === "f") toggleFullscreen();
    else if (key === "c") cycleSubtitles();
    else if (key === "g") changeDelay(delay - (event.shiftKey ? 1 : 0.1));
    else if (key === "h") changeDelay(delay + (event.shiftKey ? 1 : 0.1));
    else if (key === "a" && audioTracks.length > 1) {
      const index = audioTracks.findIndex((track) => track.key === audioKey);
      const nextTrack = audioTracks[(index + 1) % audioTracks.length];
      chooseAudio(nextTrack);
      showFlash(`Audio: ${nextTrack.label}`);
    } else if (key === "n" && next && onNext) playNext(next);
    else if (/^[0-9]$/.test(key) && video.current && Number.isFinite(video.current.duration))
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
  const remaining = duration - time;
  const showNext = Boolean(
    next && onNext && !nextDismissed && !error && (status === "ended" || (duration > 120 && remaining <= 30 && remaining > 0)),
  );
  const subtitleStyle = {
    "--subtitle-scale": settings.subtitleSize / 100,
    "--subtitle-opacity": settings.subtitleOpacity,
    "--subtitle-background": settings.subtitleBackground,
  } as CSSProperties;
  const busy = status === "loading" || status === "buffering";
  const activeSubtitle = subtitleTracks.find((track) => track.key === subtitleKey);
  return (
    <Dialog title={`Reproduciendo ${playing.meta.name}`} onClose={close} className="player-dialog" hideClose>
      <div
        ref={surface}
        className={`player ${idle && status === "playing" && !popover ? "idle" : ""}`}
        data-status={status}
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
            // Time actually watched (seeks excluded), as Stremio counts it for the watched mark.
            const counter = watchedTime.current;
            const step = element.currentTime - counter.last;
            if (counter.last >= 0 && step > 0 && step < 2 && !element.seeking) counter.total += step;
            counter.last = element.currentTime;
            if (Number.isFinite(element.duration) && counter.total > element.duration * WATCHED_THRESHOLD) markWatched();
            if (Date.now() - lastSave.current > 5000) {
              save(element);
              lastSave.current = Date.now();
            }
          }}
          onPlay={() => wake()}
          onPlaying={() => {
            if (!started.current) {
              started.current = true;
              onStarted?.();
            }
            setStatus("playing");
            setNotice((value) => (value === "Pulsa reproducir para iniciar el vídeo." ? "" : value));
          }}
          onPause={(event) => {
            const element = event.currentTarget;
            if (element.ended) return;
            setStatus((value) => (value === "loading" && element.readyState < 3 ? value : "paused"));
            setIdle(false);
            save(element);
          }}
          onCanPlay={(event) => {
            // Ready is reported only when playback actually starts; a blocked autoplay stays paused.
            if (event.currentTarget.paused) setStatus((value) => (value === "loading" || value === "buffering" ? "paused" : value));
          }}
          onWaiting={() => {
            setStatus((value) => (value === "loading" ? value : "buffering"));
            setWaitingSince(Date.now());
          }}
          onSeeking={(event) => {
            watchedTime.current.last = event.currentTarget.currentTime;
            if (finished.current && event.currentTarget.currentTime < event.currentTarget.duration * CREDITS_THRESHOLD) finished.current = false;
          }}
          onEnded={() => {
            setStatus("ended");
            setIdle(false);
            finish();
          }}
          onError={(event) => setError(mediaErrorMessage(event.currentTarget.error))}
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
          <button className="player-icon" aria-label="Volver" title="Volver (Esc)" onClick={close}>
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
          {!fullscreen && <WindowControls onError={setNotice} />}
        </div>
        {busy && !error && (
          <div className="player-loading" role="status">
            <LoaderCircle className="spin" size={34} strokeWidth={1.5} />
            <span>
              {status === "buffering"
                ? "Cargando más vídeo…"
                : converting && !playing.transcodedBecause
                  ? "Convirtiendo con Stremio Service"
                  : playing.note || "Cargando"}
            </span>
            {swarm && (
              <span
                className="player-swarm"
                title="Pares que aceptaron la conexión, de los que han encontrado los trackers y la DHT. Muchos de los anunciados no responden, y Stremio Service mantiene como mucho unas decenas de conexiones a la vez."
              >
                {describeTorrent(swarm.stats)}
              </span>
            )}
            {(slow || starved) && (
              <div className="player-slow">
                <p>
                  {starved
                    ? `El torrent no está recibiendo datos (${swarm!.stats.unchoked} de ${swarm!.stats.peers} pares envían). Puede que no tenga fuentes suficientes; prueba otra.`
                    : "La fuente está tardando en responder."}
                </p>
                <div>
                  {infoHash && (
                    <button className="button small subtle" onClick={onClose}>
                      Elegir otra fuente
                    </button>
                  )}
                  {playing.transcodeUrl && !converting && !infoHash && (
                    <button className="button small subtle" onClick={() => switchToConversion({})}>
                      Probar con Stremio Service
                    </button>
                  )}
                  <button className="button small subtle" disabled={externalBusy} onClick={() => void external()}>
                    Abrir en reproductor externo
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {flash && <div className="player-flash" aria-live="polite">{flash}</div>}
        {notice && !error && (
          <div className="player-notice" role="status">
            <span>{notice}</span>
            <button className="button small subtle" onClick={() => setNotice("")}>
              Cerrar
            </button>
          </div>
        )}
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
        {showNext && next && (
          <section className="player-next" aria-label="Siguiente episodio">
            <span className="player-next-label">
              {countdown !== null ? `Siguiente episodio en ${countdown} s` : "Siguiente episodio"}
            </span>
            <strong>
              {episodeCode(next)}
              {next.title ? ` · ${next.title}` : ""}
            </strong>
            <div>
              <button className="button primary small" data-autofocus onClick={() => playNext(next)}>
                <SkipForward size={14} /> Ver ahora
              </button>
              <button className="button small subtle" onClick={() => setNextDismissed(true)}>
                {countdown !== null ? "Cancelar" : "Ocultar"}
              </button>
            </div>
          </section>
        )}
        {error && (
          <div className="player-error" role="alert">
            <h2>No se puede reproducir aquí</h2>
            <p>{error}</p>
            <div>
              {playing.transcodeUrl && !converting && (
                <button className="button primary" onClick={() => switchToConversion({})}>
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
        {popover?.kind === "tracks" && (
          <TrackPanel
            right={popover.right}
            audio={audioTracks}
            audioKey={audioKey}
            subtitles={subtitleTracks}
            subtitleKey={subtitleKey}
            preferred={[settings.subtitleLanguage, settings.subtitleSecondary]}
            delay={delay}
            onAudio={(track) => chooseAudio(track)}
            onSubtitle={(track) => void chooseSubtitle(track)}
            onDelay={changeDelay}
          />
        )}
        {popover?.kind === "speed" && <SpeedPanel right={popover.right} rate={rate} onChange={changeRate} />}
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
              <span className="seek-fill" style={{ width: `${percent}%` }} />
            </div>
            <input
              aria-label="Posición de reproducción"
              aria-valuetext={`${clock(time)} de ${clock(duration)}`}
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
              aria-label={status === "playing" || status === "buffering" ? "Pausar" : "Reproducir"}
              title={status === "playing" ? "Pausar (K)" : "Reproducir (K)"}
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
              aria-label={`Retroceder ${settings.seekLong} segundos`}
              title={`Retroceder ${settings.seekLong} s (J)`}
              onClick={() => seekBy(-settings.seekLong)}
            >
              <RotateCcw size={18} />
            </button>
            <button
              className="player-icon"
              aria-label={`Avanzar ${settings.seekLong} segundos`}
              title={`Avanzar ${settings.seekLong} s (L)`}
              onClick={() => seekBy(settings.seekLong)}
            >
              <RotateCw size={18} />
            </button>
            {next && onNext && (
              <button
                className="player-icon"
                aria-label={`Siguiente episodio: ${episodeCode(next)}`}
                title={`Siguiente episodio (N) · ${episodeCode(next)}`}
                onClick={() => playNext(next)}
              >
                <SkipForward size={18} />
              </button>
            )}
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
              className={`player-icon ${subtitleKey || audioTracks.length > 1 ? "active" : ""} ${popover?.kind === "tracks" ? "pressed" : ""}`}
              aria-label="Audio y subtítulos"
              aria-expanded={popover?.kind === "tracks"}
              aria-haspopup="dialog"
              title={
                activeSubtitle
                  ? `Subtítulos: ${activeSubtitle.label} (C)`
                  : subtitleTracks.length || audioTracks.length > 1
                    ? "Audio y subtítulos (C)"
                    : "No hay pistas adicionales"
              }
              onClick={(event) => openPopover("tracks", event.currentTarget)}
            >
              {subtitleBusy ? <LoaderCircle className="spin" size={18} /> : <Captions size={19} />}
            </button>
            <button
              className={`player-icon ${rate !== 1 ? "active" : ""} ${popover?.kind === "speed" ? "pressed" : ""}`}
              aria-label="Velocidad de reproducción"
              aria-haspopup="dialog"
              aria-expanded={popover?.kind === "speed"}
              title="Velocidad"
              onClick={(event) => openPopover("speed", event.currentTarget)}
            >
              {rate !== 1 ? <span className="rate">{rate}×</span> : <Gauge size={19} />}
            </button>
            {native && (
              <button
                className="player-icon"
                aria-label="Abrir en reproductor externo"
                title="Abrir en reproductor externo"
                disabled={externalBusy}
                onClick={() => void external()}
              >
                <MonitorPlay size={19} />
              </button>
            )}
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
      </div>
    </Dialog>
  );
}

function Option({
  checked,
  label,
  detail,
  title,
  onSelect,
}: {
  checked: boolean;
  label: string;
  detail?: string;
  title?: string;
  onSelect: () => void;
}) {
  return (
    <button role="radio" aria-checked={checked} className="track-option" title={title} onClick={onSelect}>
      <span>{label}</span>
      {detail && <small>{detail}</small>}
    </button>
  );
}

/** Speed choices, in the same popover as audio and subtitles. */
function SpeedPanel({ right, rate, onChange }: { right: number; rate: number; onChange: (value: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[aria-checked=true]")?.focus();
  }, []);
  return (
    <div className="player-popover speed-panel" role="dialog" aria-label="Velocidad" ref={ref} style={{ right }}>
      <section>
        <h3>Velocidad</h3>
        <div role="radiogroup" aria-label="Velocidad de reproducción">
          {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((value) => (
            <Option key={value} checked={rate === value} label={value === 1 ? "Normal" : `${value}×`} onSelect={() => onChange(value)} />
          ))}
        </div>
      </section>
    </div>
  );
}

/**
 * Audio and subtitle choices. Subtitles are grouped by language, with the preferred languages
 * first; choosing a language selects its first subtitle and «Versión» lists the others.
 */
function TrackPanel({
  right,
  audio,
  audioKey,
  subtitles,
  subtitleKey,
  preferred,
  delay,
  onAudio,
  onSubtitle,
  onDelay,
}: {
  right: number;
  audio: Track[];
  audioKey: string;
  subtitles: Track[];
  subtitleKey: string;
  preferred: string[];
  delay: number;
  onAudio: (track: Track) => void;
  onSubtitle: (track: Track | null) => void;
  onDelay: (value: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const selected = subtitles.find((track) => track.key === subtitleKey);
  const langOf = (track: Track) => track.lang || "und";
  const selectedLang = selected ? langOf(selected) : undefined;
  const all = [...new Set(subtitles.map(langOf))];
  const wanted = preferred.map((code) => normalizeLanguage(code)).filter(Boolean);
  const label = (lang: string) => (lang === "und" ? "Idioma no indicado" : languageLabel(lang));
  const top = all.filter((lang) => wanted.includes(lang) || lang === selectedLang)
    .sort((a, b) => (wanted.indexOf(a) + 1 || 99) - (wanted.indexOf(b) + 1 || 99));
  const others = all.filter((lang) => !top.includes(lang)).sort((a, b) => label(a).localeCompare(label(b), "es"));
  const variants = selected ? subtitles.filter((track) => langOf(track) === selectedLang) : [];
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(".track-languages [aria-checked=true]")?.focus();
  }, []);
  const conversionHint = (track: Track) =>
    track.origin === "embedded" && track.key.startsWith("file-audio") ? "Cambia a la conversión de Stremio Service" : undefined;
  const language = (lang: string) => {
    const first = subtitles.find((track) => langOf(track) === lang)!;
    const count = subtitles.filter((track) => langOf(track) === lang).length;
    return (
      <Option
        key={lang}
        checked={selectedLang === lang}
        label={label(lang)}
        detail={count > 1 ? String(count) : undefined}
        onSelect={() => onSubtitle(selected && selectedLang === lang ? selected : first)}
      />
    );
  };
  return (
    <div className="player-popover track-panel" role="dialog" aria-label="Audio y subtítulos" ref={ref} style={{ right }}>
      <section className="track-languages">
        <h3>Subtítulos</h3>
        <div role="radiogroup" aria-label="Idioma de los subtítulos" className="track-scroll">
          <Option checked={!selected} label="Desactivados" onSelect={() => onSubtitle(null)} />
          {top.map(language)}
          {others.length > 0 && top.length > 0 && <hr className="track-divider" aria-hidden="true" />}
          {others.map(language)}
          {!subtitles.length && <p className="track-empty">No hay subtítulos para este vídeo.</p>}
        </div>
      </section>
      <div className="track-side">
        {audio.length > 1 && (
          <section>
            <h3>Audio</h3>
            <div role="radiogroup" aria-label="Pista de audio">
              {audio.map((track) => (
                <Option
                  key={track.key}
                  checked={track.key === audioKey}
                  label={track.label}
                  detail={track.detail}
                  title={conversionHint(track)}
                  onSelect={() => onAudio(track)}
                />
              ))}
            </div>
          </section>
        )}
        {variants.length > 1 && (
          <section>
            <h3>Versión</h3>
            <div role="radiogroup" aria-label="Versión de los subtítulos" className="track-scroll">
              {variants.map((track) => (
                <Option
                  key={track.key}
                  checked={track.key === subtitleKey}
                  label={track.label}
                  detail={[track.origin === "file" ? "Externo" : "Del archivo", track.detail].filter(Boolean).join(" · ")}
                  onSelect={() => onSubtitle(track)}
                />
              ))}
            </div>
          </section>
        )}
        <section className="track-delay">
          <h3 id="subtitle-delay">Desfase</h3>
          <div className="stepper" role="group" aria-labelledby="subtitle-delay">
            <button className="button small subtle" aria-label="Adelantar subtítulos 0,1 s" title="Adelantar (G)" disabled={!selected} onClick={() => onDelay(delay - 0.1)}>
              −0,1
            </button>
            <output aria-live="polite">{`${delay > 0 ? "+" : ""}${delay.toLocaleString("es", { minimumFractionDigits: 1 })} s`}</output>
            <button className="button small subtle" aria-label="Retrasar subtítulos 0,1 s" title="Retrasar (H)" disabled={!selected} onClick={() => onDelay(delay + 0.1)}>
              +0,1
            </button>
            <button className="button small subtle" disabled={!delay} onClick={() => onDelay(0)}>
              Restablecer
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
