import type { LibraryEntry, VideoState } from './contracts';
import { mediaKey, parseLibraryImportEntry, preferencesStore } from './store';

export const MAX_LIBRARY_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 50_000;
export type ParsedLibraryImport = { entries: LibraryEntry[]; exportedAt?: string };
export type LibraryImportSummary = { added: number; updated: number; unchanged: number; total: number };
export type LibraryImportErrorCode = 'invalid' | 'unsupported' | 'tooLarge';

export class LibraryImportError extends Error {
  constructor(public readonly code: LibraryImportErrorCode) {
    super(code);
    this.name = 'LibraryImportError';
  }
}

const fail = (): never => { throw new LibraryImportError('invalid'); };
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** JSON.parse discards duplicate object keys before a reviver sees them. Scan the valid JSON's
 * structure as well so duplicate/crafted keys cannot hide a second history record or field. */
function checkKeys(text: string): void {
  const stack: ({ keys: Set<string>; expectsKey: boolean } | null)[] = [];
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === '"') {
      const begin = at++;
      for (; at < text.length; at++) {
        if (text[at] === '\\') at++;
        else if (text[at] === '"') break;
      }
      const scope = stack.at(-1);
      if (scope?.expectsKey) {
        const key = JSON.parse(text.slice(begin, at + 1)) as string;
        if (scope.keys.has(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) fail();
        scope.keys.add(key);
        scope.expectsKey = false;
      }
    } else if (char === '{' || char === '[') {
      stack.push(char === '{' ? { keys: new Set(), expectsKey: true } : null);
      if (stack.length > 128) fail();
    } else if (char === '}' || char === ']') stack.pop();
    else if (char === ',') {
      const scope = stack.at(-1);
      if (scope) scope.expectsKey = true;
    }
  }
}

/** Reads only Vela's version-1 library export, never preferences, addons or account state. */
export function parseLibraryExport(text: string): ParsedLibraryImport {
  if (text.length > MAX_LIBRARY_IMPORT_BYTES || new TextEncoder().encode(text).length > MAX_LIBRARY_IMPORT_BYTES)
    throw new LibraryImportError('tooLarge');
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail(); }
  if (!record(value)) return fail();
  checkKeys(text);
  if (value.version !== 1) throw new LibraryImportError('unsupported');
  if (!record(value.library)) return fail();
  if (value.exportedAt !== undefined && (typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt)))) return fail();
  const entries = Object.entries(value.library);
  if (entries.length > MAX_ENTRIES) throw new LibraryImportError('tooLarge');
  const parsed: LibraryEntry[] = [];
  for (const [key, entry] of entries) {
    const item = parseLibraryImportEntry(entry);
    if (!item || key !== mediaKey(item.meta.type, item.meta.id)) return fail();
    parsed.push(item);
  }
  return { entries: parsed, ...(typeof value.exportedAt === 'string' ? { exportedAt: value.exportedAt } : {}) };
}

function pointerAt(entry: LibraryEntry): number {
  return entry.progress?.updatedAt ?? entry.changedAt ?? entry.addedAt;
}

function watchedAt(entry: LibraryEntry): number {
  return entry.watchedAt || entry.videos?.[entry.meta.id]?.updatedAt || entry.changedAt || entry.addedAt;
}

/** Equal timestamps keep the current data. Newer per-episode records win individually, while
 * metadata and the source addon of an existing title stay local. No timestamps are invented. */
function mergeEntry(local: LibraryEntry, incoming: LibraryEntry): LibraryEntry {
  const merged: LibraryEntry = { ...local };
  if ((incoming.changedAt ?? incoming.addedAt) > (local.changedAt ?? local.addedAt)) {
    merged.saved = incoming.saved;
    merged.changedAt = incoming.changedAt ?? incoming.addedAt;
  }
  if (pointerAt(incoming) > pointerAt(local)) {
    if (incoming.progress) merged.progress = incoming.progress;
    else delete merged.progress;
  }
  const videos: Record<string, VideoState> = { ...local.videos };
  for (const [id, video] of Object.entries(incoming.videos ?? {})) {
    const previous = videos[id];
    if (!previous || video.updatedAt > previous.updatedAt) {
      videos[id] = { ...video };
      if (video.watched === undefined && previous?.watched !== undefined) videos[id].watched = previous.watched;
    }
  }
  if (Object.keys(videos).length) merged.videos = videos;
  if (incoming.watchedAt !== undefined && (local.watchedAt === undefined || watchedAt(incoming) > watchedAt(local)))
    merged.watchedAt = incoming.watchedAt;
  if (incoming.remoteWatched && (!local.remoteWatched || (incoming.remoteWatchedAt ?? 0) > (local.remoteWatchedAt ?? 0))) {
    merged.remoteWatched = incoming.remoteWatched;
    if (incoming.remoteWatchedAt !== undefined) merged.remoteWatchedAt = incoming.remoteWatchedAt;
    else delete merged.remoteWatchedAt;
  }
  // The episode list is needed to interpret imported watched marks; don't replace richer local metadata.
  if (!local.meta.videos?.length && incoming.meta.videos?.length) merged.meta = { ...local.meta, videos: incoming.meta.videos };
  return merged;
}

function planLibraryImport(parsed: ParsedLibraryImport, library: Record<string, LibraryEntry>) {
  const summary: LibraryImportSummary = { added: 0, updated: 0, unchanged: 0, total: parsed.entries.length };
  const changes: LibraryEntry[] = [];
  const seen = new Set<string>();
  for (const value of parsed.entries) {
    const incoming = parseLibraryImportEntry(value);
    if (!incoming) return fail();
    const key = mediaKey(incoming.meta.type, incoming.meta.id);
    if (seen.has(key)) return fail();
    seen.add(key);
    const local = library[key];
    if (!local) {
      summary.added++;
      changes.push(incoming);
    } else {
      const merged = mergeEntry(local, incoming);
      if (JSON.stringify(merged) === JSON.stringify(local)) summary.unchanged++;
      else {
        summary.updated++;
        changes.push(merged);
      }
    }
  }
  return { summary, changes };
}

export function previewLibraryImport(parsed: ParsedLibraryImport, library: Record<string, LibraryEntry>): LibraryImportSummary {
  return planLibraryImport(parsed, library).summary;
}

type ImportStore = Pick<typeof preferencesStore, 'getSnapshot' | 'mergeLibrary'>;

/** Replan at confirmation time: playback or synchronization may have advanced since preview.
 * The caller must bind confirmation to its selected profile and snapshot the data first. */
export function applyLibraryImport(parsed: ParsedLibraryImport, store: ImportStore = preferencesStore): LibraryImportSummary {
  const { summary, changes } = planLibraryImport(parsed, store.getSnapshot().library);
  if (changes.length) store.mergeLibrary(changes);
  return summary;
}
