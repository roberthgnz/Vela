import type { Episode, MediaItem, ResolvedStream, Subtitle } from "../../lib/contracts";
import { episodeCode } from "../../lib/episodes";
import { t } from "../../lib/i18n";
import { languageLabel, normalizeLanguage } from "../../lib/languages";
import { requestRange } from "../../lib/transport";

/** Everything the player needs to play one video. */
export type Playing = {
  meta: MediaItem;
  addonUrl: string;
  videoId: string;
  stream: ResolvedStream;
  url: string;
  /** Original URL and headers for an external player. */
  externalUrl: string;
  headers?: Record<string, string>;
  mediaProxy?: string;
  /** HLS conversion through Stremio Service, when available. */
  transcodeUrl?: string;
  /** Why the built-in player cannot open the file, known before trying (see `PlaybackTarget`). */
  unsupported?: string[];
  serviceUrl: string;
  resume: number;
  episode?: Episode;
  /** Optional explanation shown while the source is being prepared (for example, a torrent). */
  note?: string;
  /** Which engine streams a torrent source (Vela's own or Stremio's server). */
  torrentEngine?: "vela" | "service";
  /** Size of the torrent's file on Stremio's engine (see `suggestedProfile`). */
  fileSize?: number;
  /** Play with mpv inside Vela's window instead of the built-in player. */
  embedded?: boolean;
  /** Enable mpv's embedded subtitles when explicitly requested from the track panel. */
  embeddedSubtitlesAuto?: boolean;
  /** The file on disk, for downloads (mpv opens it directly). */
  filePath?: string;
};

/** Audio or subtitle choice offered to the user. */
export type Track = {
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

export type Status = "loading" | "buffering" | "playing" | "paused" | "ended";

/** Playback speeds offered in the speed menu and stepped through with < and >. */
export const speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export const volumeKey = "vela.ui.volume";
export const hlsPattern = /\.m3u8(?:$|[?#])/i;
export const assCodecs = new Set(["ass", "ssa"]);

/** The browser's own audio track list (WebView2 with the AudioVideoTracks feature). */
export type NativeAudioTracks = EventTarget & {
  length: number;
  [index: number]: { label: string; language: string; enabled: boolean };
};

export type VideoWithAudioTracks = HTMLVideoElement & { audioTracks?: NativeAudioTracks };

/** Whether a key press belongs to a field where the user types. */
export function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !["range", "checkbox", "radio", "button"].includes(target.type);
}

export function mediaErrorMessage(error: MediaError | null): string {
  switch (error?.code) {
    case MediaError.MEDIA_ERR_NETWORK:
      return t("player.error.network");
    case MediaError.MEDIA_ERR_DECODE:
      return t("player.error.decode");
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return t("player.error.unsupported");
    default:
      return t("player.error.generic");
  }
}

/**
 * Why a source cannot be read at all (an HTTP error, no connection), asking it for its first
 * byte; undefined when it answers (then the problem is the format) or cannot be asked (the
 * browser build, files on disk). The desktop transport words its failures as below.
 */
export async function sourceProblem(
  url: string,
  read: (url: string, start: number, length: number) => Promise<unknown> = requestRange,
): Promise<string | undefined> {
  try {
    await read(url, 0, 1);
    return undefined;
  } catch (cause) {
    const text = cause instanceof Error ? cause.message : String(cause);
    const status = /HTTP (\d{3})/.exec(text)?.[1];
    if (status) return t("player.error.http", { status });
    if (/No se pudo conectar|no respondió a tiempo/i.test(text)) return t("player.error.unreachable");
    return undefined;
  }
}

/** Track names that muxers write by default and say nothing to the viewer. */
const genericTitles = /^(sound|video|subtitle|text)handler$|^core media (audio|video|text)$|^(stereo|mono|surround)$|^track ?\d*$/i;

export function trackName(lang: string, title?: string | null): string {
  const label = lang ? languageLabel(lang) : "";
  const clean = title?.trim() ?? "";
  const named = clean && !genericTitles.test(clean) && normalizeLanguage(clean) !== normalizeLanguage(lang) ? clean : "";
  return [label, named].filter(Boolean).join(" · ") || clean || t("player.track");
}

/** Tells apart tracks that share a label: «Español 1», «Español 2». */
export function numbered<T extends { label: string }>(items: T[]): T[] {
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

export function episodeText(episode?: Episode): string {
  return episode ? `${episodeCode(episode)}${episode.title ? ` · ${episode.title}` : ""}` : "";
}

/** The next speed in the list, going `direction` steps from `rate` (a rate outside the list snaps to the nearest step up). */
export function stepSpeed(rate: number, direction: -1 | 1): number {
  const index = speeds.findIndex((value) => value >= rate);
  return speeds[Math.max(0, Math.min(speeds.length - 1, (index < 0 ? speeds.length - 1 : index) + direction))];
}
