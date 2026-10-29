import type { ResolvedStream } from "./contracts";

export type StreamKind = "direct" | "hls" | "torrent" | "external" | "youtube";

export const kindLabel: Record<StreamKind, string> = {
  direct: "Directo",
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
    warnings.push("Requiere cabeceras HTTP especiales");
  if (stream.behaviorHints?.notWebReady)
    warnings.push("El addon indica que no es compatible con reproductores web");
  return warnings;
}

export function streamHeading(stream: ResolvedStream): string {
  return (
    stream.name?.replace(/\r/g, "").split("\n").filter(Boolean).join(" ") ||
    stream.addonName
  );
}

export function streamDetail(stream: ResolvedStream): string[] {
  return (stream.description || stream.title || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);
}
