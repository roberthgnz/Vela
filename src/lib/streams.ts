import type { ResolvedStream } from "./contracts";
import { locale, t } from "./i18n";

export type StreamKind = "direct" | "hls" | "torrent" | "external" | "youtube";

export const kindLabel: Record<StreamKind, string> = {
  direct: t("streams.kind.direct"),
  hls: "HLS",
  torrent: "Torrent",
  external: "Web",
  youtube: "YouTube",
};

export function streamKind(stream: ResolvedStream): StreamKind {
  if (stream.ytId) return "youtube";
  if (stream.externalUrl) return "external";
  if (stream.infoHash && !stream.url) return "torrent";
  if (stream.url && /\.m3u8(?:$|[?#])/i.test(stream.url)) return "hls";
  return "direct";
}

function haystack(stream: ResolvedStream): string {
  return [
    stream.name,
    stream.title,
    stream.description,
    stream.behaviorHints?.filename,
  ]
    .filter(Boolean)
    .join(" ");
}

export function streamQuality(stream: ResolvedStream): string | undefined {
  const match = haystack(stream).match(
    /\b(2160p|4k|uhd|1440p|1080p|720p|576p|480p|360p)\b/i,
  );
  if (!match) return undefined;
  const value = match[1].toLowerCase();
  return value === "4k" || value === "uhd" || value === "2160p"
    ? "4K"
    : value;
}

/** Compact, factual chips derived from addon text and behavior hints. */
export function streamTags(stream: ResolvedStream): string[] {
  const text = haystack(stream);
  const tags: string[] = [];
  if (/\b(hevc|x265|h\.?265)\b/i.test(text)) tags.push("HEVC");
  if (/\b(hdr10\+?|hdr|dolby ?vision|dv)\b/i.test(text)) tags.push("HDR");
  if (/\.mkv\b|\bmkv\b/i.test(text)) tags.push("MKV");
  const size = text.match(/\b(\d+(?:[.,]\d+)?\s?(?:GB|MB|GiB|MiB))\b/i);
  if (size) tags.push(size[1].replace(",", "."));
  return tags;
}

/** Reasons why the integrated WebView2 player may not handle a stream. */
export function streamWarnings(stream: ResolvedStream): string[] {
  const warnings: string[] = [];
  if (Object.keys(stream.behaviorHints?.proxyHeaders?.request || {}).length)
    warnings.push(t("streams.warning.headers"));
  if (stream.behaviorHints?.notWebReady)
    warnings.push(t("streams.warning.notWebReady"));
  return warnings;
}

export function streamHeading(stream: ResolvedStream): string {
  return (
    stream.name?.replace(/\r/g, "").split("\n").filter(Boolean).join(" ") ||
    stream.addonName
  );
}

const flagPattern = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;
const metadataLine = /👤|💾|⚙/u;

/** Torrent addons such as Torrentio mark audio languages with country flags. */
const flagLanguages: Record<string, string> = {
  GB: t("streams.lang.english"), US: t("streams.lang.english"), ES: t("streams.lang.spanishSpain"), MX: t("streams.lang.spanishLatam"), AR: t("streams.lang.spanishLatam"),
  FR: t("streams.lang.french"), DE: t("streams.lang.german"), IT: t("streams.lang.italian"), PT: t("streams.lang.portuguese"), BR: t("languages.portugueseBrazil"), RU: t("streams.lang.russian"), UA: t("streams.lang.ukrainian"),
  JP: t("streams.lang.japanese"), KR: t("streams.lang.korean"), CN: t("streams.lang.chinese"), TW: t("streams.lang.chineseTaiwan"), HK: t("streams.lang.chineseHongKong"), IN: t("streams.lang.hindi"),
  NL: t("streams.lang.dutch"), PL: t("streams.lang.polish"), TR: t("streams.lang.turkish"), SE: t("streams.lang.swedish"), NO: t("streams.lang.norwegian"), DK: t("streams.lang.danish"), FI: t("streams.lang.finnish"), CZ: t("streams.lang.czech"),
  HU: t("streams.lang.hungarian"), GR: t("streams.lang.greek"), RO: t("streams.lang.romanian"), BG: t("streams.lang.bulgarian"), RS: t("streams.lang.serbian"), HR: t("streams.lang.croatian"), IL: t("streams.lang.hebrew"), SA: t("streams.lang.arabic"),
  TH: t("streams.lang.thai"), VN: t("streams.lang.vietnamese"), ID: t("streams.lang.indonesian"), MY: t("streams.lang.malay"), PH: t("streams.lang.filipino"), IR: t("streams.lang.persian"), LT: t("streams.lang.lithuanian"),
  LV: t("streams.lang.latvian"), EE: t("streams.lang.estonian"), SK: t("streams.lang.slovak"), SI: t("streams.lang.slovenian"),
};

const regionNames = (() => {
  try {
    return new Intl.DisplayNames([locale()], { type: "region" });
  } catch {
    return undefined;
  }
})();

export type StreamLanguage = { flag: string; code: string; label: string };

export function regionCode(flag: string): string {
  return [...flag].map((char) => String.fromCharCode(char.codePointAt(0)! - 0x1f1e6 + 65)).join("");
}

export function languageOfFlag(flag: string): StreamLanguage {
  const code = regionCode(flag);
  return { flag, code, label: flagLanguages[code] ?? regionNames?.of(code) ?? code };
}

function text(stream: ResolvedStream): string {
  return [stream.title, stream.description].filter(Boolean).join("\n");
}

export function streamLanguages(stream: ResolvedStream): StreamLanguage[] {
  return [...new Set(text(stream).match(flagPattern) ?? [])].map(languageOfFlag);
}

/** Seeders, provider and multi-audio notes that torrent addons put in the description. */
export function streamFacts(stream: ResolvedStream): { seeders?: number; provider?: string; multiAudio: boolean } {
  const source = text(stream);
  const seeders = /👤\s*(\d+)/u.exec(source)?.[1];
  const provider = /⚙️?\s*([^\n👤💾]+)/u.exec(source)?.[1]?.trim();
  return {
    seeders: seeders === undefined ? undefined : Number(seeders),
    provider: provider || undefined,
    multiAudio: /\b(multi|dual)[ -]?audio\b/i.test(source),
  };
}

export function streamDetail(stream: ResolvedStream): string[] {
  return (stream.description || stream.title || "")
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => !metadataLine.test(line))
    .map((line) =>
      line
        .replace(flagPattern, "")
        .replace(/\b(multi|dual)[ -]?audio\b/gi, "")
        .replace(/^[\s/|·-]+|[\s/|·-]+$/g, "")
        .trim(),
    )
    .filter(Boolean)
    .slice(0, 3);
}

export type QualityTier = "4K" | "1080p" | "720p" | "SD" | "?";
export const qualityTiers: QualityTier[] = ["4K", "1080p", "720p", "SD", "?"];

/** Resolution group for filtering: 4K, 1080p (including 1440p), 720p, SD, or unknown. */
export function qualityTier(stream: ResolvedStream): QualityTier {
  const quality = streamQuality(stream);
  if (!quality) return "?";
  if (quality === "4K") return "4K";
  if (quality === "1440p" || quality === "1080p") return "1080p";
  if (quality === "720p") return "720p";
  return "SD";
}

/** Size in bytes, from the behavior hints or the "4.82 GB" text torrent addons show. */
export function streamSize(stream: ResolvedStream): number | undefined {
  if (stream.behaviorHints?.videoSize) return stream.behaviorHints.videoSize;
  const match = /\b(\d+(?:[.,]\d+)?)\s?(GB|MB|GiB|MiB)\b/i.exec(haystack(stream));
  if (!match) return undefined;
  const value = Number(match[1].replace(",", "."));
  return value * (/^g/i.test(match[2]) ? 1024 ** 3 : 1024 ** 2);
}

export type SourceOrder = "addon" | "seeders" | "largest" | "smallest";

/** Sorts sources; those without the value stay after the rest, in the addon's order. */
export function sortSources<T extends ResolvedStream>(streams: T[], order: SourceOrder): T[] {
  if (order === "addon") return streams;
  const value = (stream: T) =>
    order === "seeders" ? streamFacts(stream).seeders : streamSize(stream);
  const sign = order === "smallest" ? 1 : -1;
  return streams
    .map((stream, index) => ({ stream, index, value: value(stream) }))
    .sort((a, b) =>
      a.value === undefined || b.value === undefined
        ? (a.value === undefined ? 1 : 0) - (b.value === undefined ? 1 : 0) || a.index - b.index
        : sign * (a.value - b.value) || a.index - b.index,
    )
    .map(({ stream }) => stream);
}
