import type { Subtitle } from "./contracts";
import { normalizeLanguage } from "./languages";

/** A timed line drawn by Vela's overlay. `top` places it at the top of the frame (ASS \an7–9, VTT line:0). */
export type Cue = { start: number; end: number; text: string; top?: boolean };
export type SubtitleFormat = "vtt" | "srt" | "ass";
export type ParsedSubtitles = { format: SubtitleFormat; cues: Cue[]; skipped: number; raw: string };

export class SubtitleError extends Error {}

/**
 * Decodes subtitle bytes: byte order marks first, then strict UTF-8, then Windows-1252,
 * which is what most non-UTF-8 SRT files for Western European languages use.
 */
export function decodeSubtitle(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8" };
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
  // UTF-16 without a byte order mark: every other byte of ASCII text is zero.
  const sample = bytes.subarray(0, 200);
  const zeros = (offset: number) => sample.filter((_, index) => index % 2 === offset && sample[index] === 0).length;
  if (sample.length >= 20 && zeros(1) > sample.length / 3) return { text: new TextDecoder("utf-16le").decode(bytes), encoding: "utf-16le" };
  if (sample.length >= 20 && zeros(0) > sample.length / 3) return { text: new TextDecoder("utf-16be").decode(bytes), encoding: "utf-16be" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" };
  }
}

const timing =
  /^\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,:]\d{1,3})?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,:]\d{1,3})?)(.*)$/;

export function detectFormat(text: string): SubtitleFormat | undefined {
  const head = text.replace(/^﻿/, "").trimStart().slice(0, 4096);
  if (/^WEBVTT/.test(head)) return "vtt";
  if (/^\[Script Info\]/im.test(head) || /^\[V4\+? Styles\]/im.test(head) || /^Dialogue:/m.test(head)) return "ass";
  if (head.split(/\r?\n/).some((line) => timing.test(line))) return "srt";
  return undefined;
}

function seconds(value: string): number {
  const parts = value.trim().replace(",", ".").split(":");
  // Some broken SRT files use a colon before the milliseconds (00:00:01:500).
  if (parts.length === 4) parts.splice(2, 2, `${parts[2]}.${parts[3]}`);
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lrm: "", rlm: "" };

/** Strips markup that Vela does not style (font colors, karaoke, VTT classes) and keeps line breaks. */
export function cueText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (match, name: string) => {
      if (name[0] === "#")
        return String.fromCodePoint(name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
      return entities[name.toLowerCase()] ?? match;
    })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function parseBlocks(text: string): { cues: Cue[]; skipped: number } {
  const cues: Cue[] = [];
  let skipped = 0;
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const match = timing.exec(lines[index]);
    if (!match) continue;
    const body: string[] = [];
    let next = index + 1;
    while (next < lines.length && lines[next].trim() !== "" && !timing.test(lines[next])) body.push(lines[next++]);
    // A number right before the next timing line is the next cue's index, not text.
    if (next < lines.length && timing.test(lines[next]) && /^\d+$/.test(body.at(-1)?.trim() ?? "")) body.pop();
    index = next - 1;
    const start = seconds(match[1]);
    const end = seconds(match[2]);
    const content = cueText(body.join("\n"));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !content) {
      skipped++;
      continue;
    }
    cues.push({ start, end, text: content, top: /\bline:\s*0(?:%|\b)/.test(match[3]) || undefined });
  }
  return { cues, skipped };
}

function assTime(value: string): number {
  const [h, m, s] = value.trim().split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/** Converts ASS/SSA dialogue lines to plain cues. Used when the styled renderer is unavailable. */
function parseAss(text: string): { cues: Cue[]; skipped: number } {
  const cues: Cue[] = [];
  let skipped = 0;
  let format: string[] = [];
  const topStyles = new Set<string>();
  let styleFormat: string[] = [];
  let section = "";
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const header = /^\s*\[(.+)\]\s*$/.exec(line);
    if (header) {
      section = header[1].toLowerCase();
      continue;
    }
    const field = /^\s*([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!field) continue;
    const [, key, value] = field;
    if (section.includes("styles")) {
      if (key === "Format") styleFormat = value.split(",").map((item) => item.trim().toLowerCase());
      else if (key === "Style") {
        const values = value.split(",");
        const alignment = Number(values[styleFormat.indexOf("alignment")]);
        if (alignment >= 7 && alignment <= 9) topStyles.add(values[styleFormat.indexOf("name")]?.trim());
      }
    } else if (section === "events") {
      if (key === "Format") format = value.split(",").map((item) => item.trim().toLowerCase());
      else if (key === "Dialogue") {
        const columns = format.length ? format : ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
        const values = value.split(",");
        const textIndex = columns.indexOf("text");
        const get = (name: string) => values[columns.indexOf(name)]?.trim() ?? "";
        const raw = values.slice(textIndex).join(",");
        const start = assTime(get("start"));
        const end = assTime(get("end"));
        const content = cueText(raw.replace(/\\[Nn]/g, "\n").replace(/\\h/g, " "));
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !content) {
          skipped++;
          continue;
        }
        const top = /\{[^}]*\\an[789][^}]*\}/.test(raw) || (!/\\an\d/.test(raw) && topStyles.has(get("style")));
        cues.push({ start, end, text: content, top: top || undefined });
      }
    }
  }
  return { cues: cues.sort((a, b) => a.start - b.start), skipped };
}

export function parseSubtitle(text: string): ParsedSubtitles {
  const format = detectFormat(text);
  if (!format) throw new SubtitleError("El archivo no tiene un formato de subtítulos reconocible (SRT, WebVTT o ASS).");
  const { cues, skipped } = format === "ass" ? parseAss(text) : parseBlocks(text);
  if (!cues.length) throw new SubtitleError("El archivo de subtítulos está vacío o dañado.");
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return { format, cues, skipped, raw: text };
}

/**
 * Cues visible at `time`. Identical lines that overlap (common in files merged from
 * several sources) are shown once, in start order.
 */
export function activeCues(cues: Cue[], time: number): Cue[] {
  let low = 0;
  let high = cues.length;
  // Cues are sorted by start; skip those that start after `time`.
  while (low < high) {
    const middle = (low + high) >> 1;
    if (cues[middle].start <= time) low = middle + 1;
    else high = middle;
  }
  const seen = new Set<string>();
  const result: Cue[] = [];
  // Long cues can start well before shorter ones; scan back a bounded window.
  for (let index = Math.max(0, low - 200); index < low; index++) {
    const cue = cues[index];
    if (cue.end <= time) continue;
    const key = `${cue.top ? 1 : 0}${cue.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cue);
  }
  return result;
}

/**
 * Removes repeated subtitle entries (the same file offered by the stream and by a subtitles
 * addon, or listed twice) and normalizes their language codes for matching.
 */
export function dedupeSubtitles(items: Subtitle[]): Subtitle[] {
  const urls = new Set<string>();
  return items.filter((item) => {
    let key = item.url;
    try {
      key = new URL(item.url).href;
    } catch {
      /* Keep the raw URL as the key. */
    }
    if (urls.has(key)) return false;
    urls.add(key);
    return true;
  });
}

export function subtitleLanguage(item: Pick<Subtitle, "lang">): string {
  return normalizeLanguage(item.lang);
}
