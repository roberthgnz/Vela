import { describe, expect, it } from 'vitest';

import { readMkvChapters } from './mkvChapters';

/** EBML element with an 8-byte size, which keeps offsets easy to compute. */
function el(id: number, ...body: Uint8Array[]): Uint8Array {
  const idBytes: number[] = [];
  for (let value = id; value > 0; value = Math.floor(value / 256)) idBytes.unshift(value % 256);
  const length = body.reduce((sum, part) => sum + part.length, 0);
  const size = [0x01, 0, 0, 0, (length >>> 24) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255];
  return concat(new Uint8Array([...idBytes, ...size]), ...body);
}
const uint = (id: number, value: number) =>
  el(id, new Uint8Array(Array.from({ length: 8 }, (_, index) => Math.floor(value / 256 ** (7 - index)) % 256)));
const text = (id: number, value: string) => el(id, new TextEncoder().encode(value));
function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
const atom = (start: number, title: string, hidden = 0) =>
  el(0xb6, uint(0x91, start * 1e9), uint(0x98, hidden), el(0x80, text(0x85, title)));

function file(chaptersAtEnd: boolean): Uint8Array {
  const chapters = el(0x1043a770, el(0x45b9, atom(0, 'Opening'), atom(90, 'Hidden', 1), atom(95, 'Part A'), atom(1300, 'Ending')));
  const seekHead = (position: number) => el(0x114d9b74, el(0x4dbb, uint(0x53ab, 0x1043a770), uint(0x53ac, position)));
  const padding = el(0xec, new Uint8Array(300 * 1024));
  const header = el(0x1a45dfa3, uint(0x4286, 1));
  // Segment with unknown size, as live-written files have.
  const segmentStart = new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const seekLength = seekHead(0).length;
  const body = chaptersAtEnd ? [seekHead(seekLength + padding.length), padding, chapters] : [chapters, padding];
  return concat(header, segmentStart, ...body);
}

async function read(bytes: Uint8Array) {
  const calls: number[] = [];
  const chapters = await readMkvChapters(async (start, length) => {
    calls.push(start);
    return bytes.slice(start, start + length);
  });
  return { chapters, calls };
}

describe('mkv chapters', () => {
  it('reads chapters from the head of the file in one request', async () => {
    const { chapters, calls } = await read(file(false));
    expect(chapters.map((chapter) => [chapter.start, chapter.title])).toEqual([[0, 'Opening'], [95, 'Part A'], [1300, 'Ending']]);
    expect(calls).toEqual([0]);
  });

  it('follows the SeekHead to chapters beyond the first read', async () => {
    const { chapters, calls } = await read(file(true));
    expect(chapters.map((chapter) => chapter.title)).toEqual(['Opening', 'Part A', 'Ending']);
    expect(calls).toHaveLength(3);
  });

  it('returns nothing for other formats', async () => {
    expect((await read(new TextEncoder().encode('....ftypisom'))).chapters).toEqual([]);
  });
});
