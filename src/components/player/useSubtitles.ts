import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type Hls from "hls.js";
import type JASSUB from "jassub";
import type { PlayerPreferences, Subtitle } from "../../lib/contracts";
import { formatNumber, t } from "../../lib/i18n";
import { languageLabel, normalizeLanguage, pickByLanguage } from "../../lib/languages";
import { log } from "../../lib/log";
import { getSubtitles } from "../../lib/protocol";
import { preferencesStore } from "../../lib/store";
import {
  embeddedAssUrl,
  embeddedSubtitlePlaylist,
  readSubtitleRendition,
  subtitleUrl as serviceSubtitleUrl,
  type Probe,
} from "../../lib/streamingServer";
import { activeCues, decodeSubtitle, dedupeSubtitles, parseSubtitle, type Cue } from "../../lib/subtitles";
import { requestBytes, requestText } from "../../lib/transport";
import { errorMessage } from "../../lib/utils";
import { assCodecs, numbered, trackName, type Playing, type Status, type Track } from "./shared";

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

/**
 * Subtitle tracks (addon files, HLS renditions, tracks inside the file through the conversion),
 * the chosen one, its cues drawn at the current time with the user's delay, ASS rendering with
 * JASSUB when the script has styles, and the automatic choice by language.
 */
export function useSubtitles(options: {
  video: RefObject<HTMLVideoElement | null>;
  hls: RefObject<Hls | null>;
  playing: Playing;
  probe?: Probe;
  status: Status;
  converting: boolean;
  hlsSubtitles: Track[];
  settings: Pick<PlayerPreferences, "subtitlesAuto" | "subtitleLanguage" | "subtitleSecondary">;
  audioTracks: Track[];
  audioKey: string;
  setNotice: (value: string) => void;
  showFlash: (value: string) => void;
}) {
  const { video, hls, playing, probe, status, converting, hlsSubtitles, settings, audioTracks, audioKey, setNotice, showFlash } = options;
  const [fileSubtitles, setFileSubtitles] = useState<Subtitle[]>(() => dedupeSubtitles(playing.stream.subtitles || []));
  const [subtitleKey, setSubtitleKey] = useState("");
  const [cues, setCues] = useState<Cue[]>([]);
  const [shown, setShown] = useState<Cue[]>([]);
  const [delay, setDelay] = useState(0);
  const [assActive, setAssActive] = useState(false);
  const [subtitleBusy, setSubtitleBusy] = useState(false);
  const ass = useRef<JASSUB | null>(null);
  const loading = useRef<AbortController | null>(null);
  const autoChosen = useRef(false);

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

  const clearRenderer = useCallback(() => {
    const renderer = ass.current;
    ass.current = null;
    setAssActive(false);
    void renderer?.destroy().catch(() => {});
  }, []);

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
      setSubtitleBusy(Boolean(track));
      if (!track) return;
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
                if (controller.signal.aborted || !collected.length) return;
                setCues([...collected].sort((a, b) => a.start - b.start || a.end - b.end));
                // The rest of the track keeps arriving in the background (the converter extracts
                // it segment by segment, across the whole file); the button stops spinning as soon
                // as there is something to show.
                setSubtitleBusy(false);
              },
              video.current?.currentTime ?? 0,
              controller.signal,
            );
            if (!collected.length && !controller.signal.aborted) throw new Error(t("player.subs.emptyTrack"));
          }
        }
        if (controller.signal.aborted) return;
        if (raw && video.current) {
          try {
            ass.current = await createAssRenderer(video.current, raw, -delay);
            setAssActive(true);
          } catch (failure) {
            // Styled rendering is optional: the plain cues remain.
            log.warn("player: ASS renderer unavailable", failure);
            setNotice(t("player.subs.assUnavailable"));
          }
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        setSubtitleKey("");
        setNotice(t("player.subs.loadFailed", { reason: errorMessage(cause) }));
      } finally {
        if (loading.current === controller) setSubtitleBusy(false);
      }
    },
    [clearRenderer, converting, delay, hls, playing.serviceUrl, playing.transcodeUrl, setNotice, video],
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
  }, [subtitleKey, video]);

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
  }, [assActive, cues, delay, video]);

  // The preferred language, once, when the video is ready; not when the audio already speaks it.
  useEffect(() => {
    if (autoChosen.current || !settings.subtitlesAuto || status === "loading") return;
    const preferred = pickByLanguage(subtitleTracks, (track) => track.lang, settings.subtitleLanguage, settings.subtitleSecondary);
    const audioLang = audioTracks.find((track) => track.key === audioKey)?.lang;
    if (!preferred || (audioLang && audioLang === normalizeLanguage(settings.subtitleLanguage))) return;
    autoChosen.current = true;
    void chooseSubtitle(preferred);
  }, [audioKey, audioTracks, chooseSubtitle, settings, status, subtitleTracks]);

  const changeDelay = useCallback(
    (value: number) => {
      const next = Math.round(value * 10) / 10;
      setDelay(next);
      showFlash(t("player.subs.delayFlash", { delay: `${next > 0 ? "+" : ""}${formatNumber(next, { minimumFractionDigits: 1 })}` }));
    },
    [showFlash],
  );

  /** The next track in the list, then off again. */
  const cycleSubtitles = useCallback(() => {
    if (!subtitleTracks.length) return;
    const index = subtitleTracks.findIndex((track) => track.key === subtitleKey);
    const nextTrack = subtitleTracks[index + 1] ?? null;
    void chooseSubtitle(nextTrack);
    showFlash(nextTrack ? t("player.subs.flash", { track: nextTrack.label }) : t("player.subs.off"));
  }, [chooseSubtitle, showFlash, subtitleKey, subtitleTracks]);

  const activeSubtitle = subtitleTracks.find((track) => track.key === subtitleKey);

  return { subtitleTracks, subtitleKey, activeSubtitle, cues, shown, delay, subtitleBusy, chooseSubtitle, changeDelay, cycleSubtitles };
}
