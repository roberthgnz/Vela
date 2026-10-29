import { useSyncExternalStore } from "react";
import type { Chapter } from "./mkvChapters";

/**
 * Parts of a video the player offers to skip. They come from the file's chapters when they are
 * named (Intro, Opening, Credits…), or from marks the user sets once per series and that apply to
 * all its episodes. Marks stay on this device.
 */
export type SkipKind = "intro" | "credits";
export type SkipSegment = { kind: SkipKind; start: number; end: number; source: "chapters" | "marks" };
/** Intro as start and end; credits as seconds before the end, which suits episodes of different lengths. */
export type SeriesMarks = { intro?: { start: number; end: number }; creditsFromEnd?: number };

const intro = /\b(intro|introduction|opening|op|apertura|cabecera|recap|previously|resumen|title sequence)\b/i;
const credits = /\b(credits?|end credits|ending|ed|outro|créditos|creditos|cierre)\b/i;

export function chapterKind(title: string): SkipKind | undefined {
  if (credits.test(title)) return "credits";
  if (intro.test(title)) return "intro";
  return undefined;
}

/**
 * Skippable segments from chapters. A chapter ends where the next starts; the last runs to the
 * end. Consecutive chapters of the same kind (recap + opening) merge. Segments of a few seconds,
 * or one that covers most of the video, are ignored: those chapters are not what their name says.
 */
export function chapterSegments(chapters: Chapter[], duration: number): SkipSegment[] {
  const segments: SkipSegment[] = [];
  chapters.forEach((chapter, index) => {
    const kind = chapterKind(chapter.title);
    if (!kind) return;
    const end = Math.min(chapters[index + 1]?.start ?? chapter.end ?? duration, duration || Infinity);
    const last = segments.at(-1);
    if (last && last.kind === kind && Math.abs(last.end - chapter.start) < 1) last.end = end;
    else segments.push({ kind, start: chapter.start, end, source: "chapters" });
  });
  return segments.filter((segment) => segment.end - segment.start >= 5 && (!duration || segment.end - segment.start < duration * 0.5));
}

export function markSegments(marks: SeriesMarks | undefined, duration: number): SkipSegment[] {
  const segments: SkipSegment[] = [];
  if (marks?.intro && (!duration || marks.intro.end < duration)) segments.push({ kind: "intro", ...marks.intro, source: "marks" });
  if (marks?.creditsFromEnd && duration > marks.creditsFromEnd)
    segments.push({ kind: "credits", start: duration - marks.creditsFromEnd, end: duration, source: "marks" });
  return segments;
}

/** The file's chapters win; the user's marks fill in the kinds the chapters do not have. */
export function skipSegments(chapters: Chapter[], marks: SeriesMarks | undefined, duration: number): SkipSegment[] {
  const fromChapters = chapterSegments(chapters, duration);
  const kinds = new Set(fromChapters.map((segment) => segment.kind));
  return [...fromChapters, ...markSegments(marks, duration).filter((segment) => !kinds.has(segment.kind))].sort((a, b) => a.start - b.start);
}

export function activeSegment(segments: SkipSegment[], time: number): SkipSegment | undefined {
  // Not in the last second, so the button does not flash when the segment is about to end.
  return segments.find((segment) => time >= segment.start && time < segment.end - 1);
}

const key = "vela.device.skipMarks.v1";
type Saved = Record<string, SeriesMarks>;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function read(): Saved {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, SeriesMarks>;
    const result: Saved = {};
    for (const [id, marks] of Object.entries(value ?? {})) {
      if (id === "__proto__" || typeof marks !== "object" || !marks) continue;
      const clean: SeriesMarks = {};
      if (marks.intro && finite(marks.intro.start) && finite(marks.intro.end) && marks.intro.end > marks.intro.start)
        clean.intro = { start: marks.intro.start, end: marks.intro.end };
      if (finite(marks.creditsFromEnd) && marks.creditsFromEnd > 0) clean.creditsFromEnd = marks.creditsFromEnd;
      if (clean.intro || clean.creditsFromEnd) result[id] = clean;
    }
    return result;
  } catch {
    return {};
  }
}

let saved: Saved | undefined;
const listeners = new Set<() => void>();

export const skipMarks = {
  all(): Saved {
    return (saved ??= read());
  },
  set(seriesId: string, marks: SeriesMarks) {
    const next = { ...skipMarks.all() };
    if (marks.intro || marks.creditsFromEnd) next[seriesId] = marks;
    else delete next[seriesId];
    saved = next;
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* Kept for this session. */
    }
    for (const listener of [...listeners]) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useSeriesMarks(seriesId: string): SeriesMarks | undefined {
  return useSyncExternalStore(skipMarks.subscribe, () => skipMarks.all()[seriesId], () => skipMarks.all()[seriesId]);
}
