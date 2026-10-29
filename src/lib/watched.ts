import type { Episode } from "./contracts";

/**
 * Stremio's per-episode watched state (`LibraryItem.state.watched`), as implemented by
 * stremio-core's `stremio-watched-bitfield` crate (branch development, checked 2026-10-29):
 *
 *   "<anchorVideoId>:<anchorLength>:<base64(zlib(bitfield))>"
 *
 * Bit `i` (LSB first in each byte) marks the i-th video of the series, ordered by season,
 * episode and release date (`LibraryItemState::watched_bitfield`). The anchor is the last
 * watched video and its 1-based position, which lets a client realign the bits when the
 * episode list grows or shifts. Video ids may contain colons (`tt123:1:5`).
 */

export type WatchedField = { anchor: string; anchorLength: number; values: Uint8Array };

/** Video ids in the order stremio-core uses for the bitfield. */
export function bitfieldOrder(videos: Pick<Episode, "id" | "season" | "episode" | "released">[]): string[] {
  const key = (value: number | undefined) => (value === undefined ? Number.NEGATIVE_INFINITY : value);
  const released = (value?: string) => {
    const time = value ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
  };
  return videos
    .map((video, index) => ({ video, index }))
    .sort(
      (a, b) =>
        key(a.video.season) - key(b.video.season) ||
        key(a.video.episode) - key(b.video.episode) ||
        released(a.video.released) - released(b.video.released) ||
        a.index - b.index,
    )
    .map(({ video }) => video.id);
}

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const output = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(output).arrayBuffer());
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function parseWatched(serialized: string): Promise<WatchedField> {
  const components = serialized.split(":");
  if (components.length < 3) throw new Error("Not enough components");
  const packed = components.pop()!;
  const anchorLength = Number(components.pop());
  if (!Number.isInteger(anchorLength) || anchorLength < 0) throw new Error("Invalid anchor length");
  // "deflate" in the Compression Streams API is the zlib format used by flate2's ZlibEncoder.
  const values = await transform(fromBase64(packed), new DecompressionStream("deflate"));
  return { anchor: components.join(":"), anchorLength, values };
}

const bit = (values: Uint8Array, index: number) => ((values[index >> 3] ?? 0) >> (index & 7)) & 1;

/** Watched video ids according to a serialized field, realigned to `videoIds` like `construct_with_videos`. */
export async function decodeWatched(serialized: string, videoIds: string[]): Promise<Set<string>> {
  const field = await parseWatched(serialized);
  const anchorIndex = videoIds.indexOf(field.anchor);
  const watched = new Set<string>();
  if (anchorIndex < 0) return watched;
  const offset = field.anchorLength - anchorIndex - 1;
  // stremio-core sizes the stored bits to the current number of videos before realigning.
  const length = videoIds.length;
  videoIds.forEach((id, index) => {
    const previous = index + offset;
    if (previous >= 0 && previous < length && bit(field.values, previous)) watched.add(id);
  });
  return watched;
}

/** Serializes the watched state of `videoIds`, as `WatchedBitField`'s `Display` implementation does. */
export async function encodeWatched(videoIds: string[], watched: ReadonlySet<string>): Promise<string> {
  const values = new Uint8Array(Math.ceil(videoIds.length / 8));
  let last = -1;
  videoIds.forEach((id, index) => {
    if (!watched.has(id)) return;
    values[index >> 3] |= 1 << (index & 7);
    last = index;
  });
  const packed = toBase64(await transform(values, new CompressionStream("deflate")));
  const anchor = last >= 0 ? videoIds[last] : (videoIds[0] ?? "undefined");
  return `${anchor}:${Math.max(last, 0) + 1}:${packed}`;
}
