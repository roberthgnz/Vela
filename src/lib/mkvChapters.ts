/**
 * Reads the chapter list of a Matroska file without downloading it: the first bytes hold the
 * segment's SeekHead, which says where the Chapters element is (often right there, sometimes at
 * the end of the file). Stremio's probe does not report chapters, so Vela reads them itself.
 * Format: https://www.matroska.org/technical/elements.html
 */

export type Chapter = { start: number; end?: number; title: string };
export type ReadRange = (start: number, length: number) => Promise<Uint8Array>;

const ID = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  seek: 0x4dbb,
  seekId: 0x53ab,
  seekPosition: 0x53ac,
  chapters: 0x1043a770,
  edition: 0x45b9,
  editionHidden: 0x45bd,
  atom: 0xb6,
  start: 0x91,
  end: 0x92,
  hidden: 0x98,
  enabled: 0x4598,
  display: 0x80,
  string: 0x85,
  cluster: 0x1f43b675,
};

const HEAD = 256 * 1024;
const MAX_CHAPTERS_BYTES = 1024 * 1024;

type Element = { id: number; offset: number; dataStart: number; size: number | undefined; end: number };

/** Variable-length integer at `offset`: its length and value (`id` keeps the marker bits). */
function vint(bytes: Uint8Array, offset: number, id: boolean): { length: number; value: number | undefined } | undefined {
  const first = bytes[offset];
  if (first === undefined || first === 0) return undefined;
  const length = Math.clz32(first) - 23;
  if (length > 8 || offset + length > bytes.length) return undefined;
  let value = id ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let index = 1; index < length; index++) {
    value = value * 256 + bytes[offset + index];
    if (bytes[offset + index] !== 0xff) allOnes = false;
  }
  return { length, value: !id && allOnes ? undefined : value };
}

function element(bytes: Uint8Array, offset: number): Element | undefined {
  const id = vint(bytes, offset, true);
  if (!id) return undefined;
  const size = vint(bytes, offset + id.length, false);
  if (!size) return undefined;
  const dataStart = offset + id.length + size.length;
  return { id: id.value!, offset, dataStart, size: size.value, end: size.value === undefined ? bytes.length : dataStart + size.value };
}

function* children(bytes: Uint8Array, start: number, end: number): Generator<Element> {
  let offset = start;
  while (offset < Math.min(end, bytes.length)) {
    const child = element(bytes, offset);
    if (!child || child.size === undefined) return;
    yield child;
    offset = child.end;
  }
}

function uint(bytes: Uint8Array, item: Element): number {
  let value = 0;
  for (let index = item.dataStart; index < item.end; index++) value = value * 256 + bytes[index];
  return value;
}

/** Chapters of the default (first visible) edition, in seconds. */
export function parseChapters(bytes: Uint8Array, start = 0, end = bytes.length): Chapter[] {
  for (const edition of children(bytes, start, end)) {
    if (edition.id !== ID.edition) continue;
    const chapters: Chapter[] = [];
    let hidden = false;
    for (const child of children(bytes, edition.dataStart, edition.end)) {
      if (child.id === ID.editionHidden && uint(bytes, child)) hidden = true;
      if (child.id !== ID.atom) continue;
      const chapter: Chapter = { start: 0, title: "" };
      let visible = true;
      for (const field of children(bytes, child.dataStart, child.end)) {
        if (field.id === ID.start) chapter.start = uint(bytes, field) / 1e9;
        else if (field.id === ID.end) chapter.end = uint(bytes, field) / 1e9;
        else if ((field.id === ID.hidden && uint(bytes, field)) || (field.id === ID.enabled && !uint(bytes, field))) visible = false;
        else if (field.id === ID.display && !chapter.title)
          for (const text of children(bytes, field.dataStart, field.end))
            if (text.id === ID.string) chapter.title = new TextDecoder().decode(bytes.subarray(text.dataStart, text.end)).trim();
      }
      if (visible) chapters.push(chapter);
    }
    if (!hidden && chapters.length) return chapters.sort((a, b) => a.start - b.start);
  }
  return [];
}

/**
 * Chapters of a Matroska file, reading at most its head and the Chapters element.
 * Returns an empty list for other formats or files without chapters.
 */
export async function readMkvChapters(read: ReadRange): Promise<Chapter[]> {
  const head = await read(0, HEAD);
  const header = element(head, 0);
  if (header?.id !== ID.ebml || header.size === undefined) return [];
  const segment = element(head, header.end);
  if (segment?.id !== ID.segment) return [];
  const base = segment.dataStart;
  let position: number | undefined;
  for (const child of children(head, base, segment.end)) {
    if (child.id === ID.cluster) break;
    if (child.id === ID.chapters) {
      if (child.end <= head.length) return parseChapters(head, child.dataStart, child.end);
      position = child.offset;
      break;
    }
    if (child.id !== ID.seekHead) continue;
    for (const seek of children(head, child.dataStart, child.end)) {
      if (seek.id !== ID.seek) continue;
      let target: number | undefined;
      let at: number | undefined;
      for (const field of children(head, seek.dataStart, seek.end)) {
        if (field.id === ID.seekId) target = uint(head, field);
        else if (field.id === ID.seekPosition) at = uint(head, field);
      }
      if (target === ID.chapters && at !== undefined) position = base + at;
    }
  }
  if (position === undefined) return [];
  const peek = await read(position, 16);
  const chapters = element(peek, 0);
  if (chapters?.id !== ID.chapters || chapters.size === undefined || chapters.size > MAX_CHAPTERS_BYTES) return [];
  const body = await read(position + chapters.dataStart, chapters.size);
  return parseChapters(body);
}
