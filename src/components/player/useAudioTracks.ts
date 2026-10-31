import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type Hls from "hls.js";
import type { PlayerPreferences } from "../../lib/contracts";
import { normalizeLanguage, pickByLanguage } from "../../lib/languages";
import type { Probe } from "../../lib/streamingServer";
import { numbered, trackName, type Track, type VideoWithAudioTracks } from "./shared";

/**
 * Audio tracks and the chosen one. They come from the browser (direct files and native HLS,
 * when WebView2 exposes `audioTracks`), from hls.js renditions, or from the file itself, which
 * needs Stremio Service's conversion to switch. The preferred language is chosen once.
 */
export function useAudioTracks(options: {
  video: RefObject<HTMLVideoElement | null>;
  hls: RefObject<Hls | null>;
  source: string;
  usingHls: boolean;
  converting: boolean;
  transcodeUrl?: string;
  probe?: Probe;
  hlsAudio: Track[];
  pending: RefObject<{ audio?: number }>;
  settings: Pick<PlayerPreferences, "audioLanguage" | "audioSecondary">;
  switchToConversion: (choice: { audio?: number }) => void;
}) {
  const { video, hls, source, usingHls, converting, transcodeUrl, probe, hlsAudio, pending, settings, switchToConversion } = options;
  const [nativeAudio, setNativeAudio] = useState<Track[]>([]);
  const [audioKey, setAudioKey] = useState("");
  const autoChosen = useRef(false);

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

  // Audio: the HLS renditions, the browser's own tracks, or the file's tracks (through the conversion).
  const audioTracks: Track[] = nativeAudio.length
    ? nativeAudio
    : hlsAudio.length
      ? hlsAudio
      : embeddedAudio.length > 1 && transcodeUrl && !converting
        ? embeddedAudio
        : [];

  // The browser's own audio tracks (direct files and native HLS). WebView2 exposes them when
  // the AudioVideoTracks Blink feature is enabled (see tauri.conf.json).
  useEffect(() => {
    const element = video.current;
    const list = (element as VideoWithAudioTracks | null)?.audioTracks;
    // Browsers without the feature expose nothing (or, like jsdom, a stub that emits no events).
    if (!element || !list || typeof list.addEventListener !== "function") return;
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
  }, [source, video]);

  const chooseAudio = useCallback(
    (track: Track) => {
      if (track.origin === "hls" && hls.current) {
        hls.current.audioTrack = track.index;
        setAudioKey(track.key);
      } else if (track.origin === "native" && video.current) {
        const list = (video.current as VideoWithAudioTracks).audioTracks;
        if (list) for (let index = 0; index < list.length; index++) list[index].enabled = index === track.index;
        setAudioKey(track.key);
      } else if (track.origin === "embedded") switchToConversion({ audio: embeddedAudio.indexOf(track) });
      autoChosen.current = true;
    },
    [embeddedAudio, hls, switchToConversion, video],
  );

  // Pending choices made before switching to the conversion, then automatic choices by language.
  useEffect(() => {
    const wanted = pending.current.audio;
    const list = nativeAudio.length ? nativeAudio : hlsAudio;
    if (!usingHls || wanted === undefined || !list[wanted]) return;
    chooseAudio(list[wanted]);
    pending.current.audio = undefined;
    autoChosen.current = true;
  }, [chooseAudio, hlsAudio, nativeAudio, pending, usingHls]);
  useEffect(() => {
    if (autoChosen.current || !audioTracks.length || !settings.audioLanguage) return;
    const preferred = pickByLanguage(audioTracks, (track) => track.lang, settings.audioLanguage, settings.audioSecondary);
    // Do not switch to the conversion only to change the audio language.
    if (preferred && preferred.origin !== "embedded") {
      autoChosen.current = true;
      if (preferred.key !== audioKey) chooseAudio(preferred);
    }
  }, [audioKey, audioTracks, chooseAudio, settings.audioLanguage, settings.audioSecondary]);

  return { audioTracks, audioKey, setAudioKey, chooseAudio, embeddedAudio };
}
