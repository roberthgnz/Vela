import {
  children,
  element,
  uint,
  type Element,
  type ReadRange,
} from "./mkvChapters";
import type { Probe } from "./streamingServer";

/**
 * Inspects a media file the way Stremio Service's `/hlsv2/probe` did, without the service: the
 * container, the duration and each audio, video and subtitle track with its codec, language and
 * channels. Only the head of the file is read, plus the index the head points to (Matroska's
 * Tracks when they are not at the start, an MP4's `moov` when it sits at the end), with HTTP Range
 * requests. For a torrent those are the pieces Vela's engine fetches first.
 *
 * Codec names follow FFmpeg's (`h264`, `hevc`, `aac`, `dts`, `truehd`, `subrip`, `ass`…), like the
 * service's answer, so `probeProblems` and the track menus read both alike. Track `id`s count the
 * tracks of each kind in file order, as FFmpeg (and so the service's converter) numbers them.
 *
 * Formats: Matroska https://www.matroska.org/technical/elements.html, ISO BMFF (ISO/IEC 14496-12)
 * and QuickTime for MP4/MOV.
 */

type Stream = Probe["streams"][number];

/** First read: enough for the Matroska header with its tracks, or an MP4's `moov` when it is at the start. */
const HEAD = 256 * 1024;
/** Later reads go in aligned blocks, so walking an index costs few requests. */
const BLOCK = 64 * 1024;
/** The desktop transport reads at most 4 MiB at once (`MAX_RANGE_BYTES`). */
const MAX_READ = 4 * 1024 * 1024;
/** Matroska's Tracks or Info larger than this are not read (a damaged file or not an index). */
const MAX_MATROSKA_INDEX = 4 * 1024 * 1024;

/** Reads a file through ranges, caching aligned blocks; reads past the end return what exists. */
export class RangeReader {
  private blocks = new Map<number, Uint8Array>();
  /** The file ends inside this block (a short read). */
  private lastBlock = Infinity;
  reads = 0;

  constructor(private read: ReadRange) {}

  private async load(first: number, last: number): Promise<void> {
    let index = first;
    while (index <= last && index <= this.lastBlock) {
      if (this.blocks.has(index)) {
        index++;
        continue;
      }
      let end = index;
      while (
        end + 1 <= last &&
        !this.blocks.has(end + 1) &&
        (end + 2 - index) * BLOCK <= MAX_READ
      )
        end++;
      this.reads++;
      const bytes = await this.read(index * BLOCK, (end - index + 1) * BLOCK);
      for (let block = index; block <= end; block++) {
        const part = bytes.subarray(
          (block - index) * BLOCK,
          (block - index + 1) * BLOCK,
        );
        this.blocks.set(block, part);
        if (part.length < BLOCK) {
          this.lastBlock = block;
          break;
        }
      }
      index = end + 1;
    }
  }

  async bytes(start: number, length: number): Promise<Uint8Array> {
    if (length <= 0) return new Uint8Array(0);
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      !Number.isSafeInteger(length) ||
      length > MAX_READ
    )
      throw new Error("Invalid media range");
    const first = Math.floor(start / BLOCK);
    const last = Math.floor((start + length - 1) / BLOCK);
    await this.load(first, last);
    const out = new Uint8Array(length);
    let filled = 0;
    for (let block = first; block <= last; block++) {
      const part = this.blocks.get(block);
      if (!part) break;
      const from = block === first ? start - block * BLOCK : 0;
      const piece = part.subarray(
        from,
        Math.min(part.length, from + length - filled),
      );
      out.set(piece, filled);
      filled += piece.length;
      if (part.length < BLOCK) break;
    }
    return out.subarray(0, filled);
  }
}

/* ---------- Container signatures ---------- */

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

const mp4Boxes = new Set([
  "ftyp",
  "moov",
  "mdat",
  "free",
  "wide",
  "skip",
  "pnot",
  "styp",
]);

/** The container from the first bytes, named as FFmpeg names its demuxers. */
export function sniffContainer(head: Uint8Array): string | undefined {
  if (head.length < 12) return undefined;
  if (
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  )
    return "matroska,webm";
  if (mp4Boxes.has(ascii(head, 4, 4))) return "mov,mp4,m4a,3gp,3g2,mj2";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "AVI ")
    return "avi";
  if (ascii(head, 0, 3) === "FLV") return "flv";
  if (ascii(head, 0, 4) === ".RMF") return "rm";
  if (ascii(head, 0, 4) === "OggS") return "ogg";
  if (
    [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11].every(
      (byte, index) => head[index] === byte,
    )
  )
    return "asf";
  if (head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0xba)
    return "mpeg";
  // MPEG-TS: a sync byte every 188 bytes (192 in Blu-ray's M2TS, after a 4-byte timestamp).
  if (
    head.length > 376 &&
    head[0] === 0x47 &&
    head[188] === 0x47 &&
    head[376] === 0x47
  )
    return "mpegts";
  if (
    head.length > 388 &&
    head[4] === 0x47 &&
    head[196] === 0x47 &&
    head[388] === 0x47
  )
    return "mpegts";
  return undefined;
}

/* ---------- Matroska ---------- */

const MKV = {
  docType: 0x4282,
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  seek: 0x4dbb,
  seekId: 0x53ab,
  seekPosition: 0x53ac,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackType: 0x83,
  flagEnabled: 0xb9,
  name: 0x536e,
  language: 0x22b59c,
  languageBcp47: 0x22b59d,
  codecId: 0x86,
  codecPrivate: 0x63a2,
  audio: 0xe1,
  channels: 0x9f,
  cluster: 0x1f43b675,
};

const matroskaCodecs: [RegExp, string][] = [
  [/^V_MPEG4\/ISO\/AVC/, "h264"],
  [/^V_MPEGH\/ISO\/HEVC/, "hevc"],
  [/^V_VP8$/, "vp8"],
  [/^V_VP9$/, "vp9"],
  [/^V_AV1$/, "av1"],
  [/^V_MPEG4\/ISO\//, "mpeg4"],
  [/^V_MPEG4\/MS\/V3/, "msmpeg4v3"],
  [/^V_MPEG2$/, "mpeg2video"],
  [/^V_MPEG1$/, "mpeg1video"],
  [/^V_THEORA$/, "theora"],
  [/^V_PRORES$/, "prores"],
  [/^V_REAL\//, "rv40"],
  [/^A_AAC/, "aac"],
  [/^A_AC3/, "ac3"],
  [/^A_EAC3$/, "eac3"],
  [/^A_DTS/, "dts"],
  [/^A_TRUEHD$/, "truehd"],
  [/^A_MLP$/, "mlp"],
  [/^A_FLAC$/, "flac"],
  [/^A_OPUS$/, "opus"],
  [/^A_VORBIS$/, "vorbis"],
  [/^A_MPEG\/L3$/, "mp3"],
  [/^A_MPEG\/L2$/, "mp2"],
  [/^A_MPEG\/L1$/, "mp1"],
  [/^A_PCM\//, "pcm_s16le"],
  [/^A_ALAC$/, "alac"],
  [/^A_REAL\//, "cook"],
  [/^S_TEXT\/UTF8$/, "subrip"],
  [/^S_TEXT\/ASCII$/, "subrip"],
  [/^S_TEXT\/ASS$/, "ass"],
  [/^S_TEXT\/SSA$/, "ssa"],
  [/^S_ASS$/, "ass"],
  [/^S_SSA$/, "ssa"],
  [/^S_TEXT\/WEBVTT$/, "webvtt"],
  [/^S_HDMV\/PGS$/, "hdmv_pgs_subtitle"],
  [/^S_HDMV\/TEXTST$/, "hdmv_text_subtitle"],
  [/^S_VOBSUB$/, "dvd_subtitle"],
  [/^S_DVBSUB$/, "dvb_subtitle"],
  [/^S_KATE$/, "kate"],
];

/** FourCCs inside `V_MS/VFW/FOURCC` (a BITMAPINFOHEADER) and format tags inside `A_MS/ACM` (a WAVEFORMATEX). */
const vfwCodecs: Record<string, string> = {
  H264: "h264",
  AVC1: "h264",
  X264: "h264",
  HEVC: "hevc",
  H265: "hevc",
  HVC1: "hevc",
  XVID: "mpeg4",
  DIVX: "mpeg4",
  DX50: "mpeg4",
  FMP4: "mpeg4",
  MP4V: "mpeg4",
  DIV3: "msmpeg4v3",
  WMV3: "wmv3",
  WVC1: "vc1",
  MJPG: "mjpeg",
  VP80: "vp8",
  VP90: "vp9",
  AV01: "av1",
};
const acmCodecs: Record<number, string> = {
  0x0001: "pcm_s16le",
  0x0003: "pcm_f32le",
  0x0050: "mp2",
  0x0055: "mp3",
  0x00ff: "aac",
  0x1610: "aac",
  0x2000: "ac3",
  0x2001: "dts",
  0x0161: "wmav2",
  0x0162: "wmapro",
  0xf1ac: "flac",
};

function matroskaCodec(id: string, priv: Uint8Array | undefined): string {
  if (id === "V_MS/VFW/FOURCC" && priv && priv.length >= 20) {
    const fourcc = ascii(priv, 16, 4).toUpperCase();
    return vfwCodecs[fourcc] ?? fourcc.toLowerCase().trim();
  }
  if (id === "A_MS/ACM" && priv && priv.length >= 2) {
    const tag = priv[0] | (priv[1] << 8);
    return acmCodecs[tag] ?? `acm_${tag.toString(16)}`;
  }
  for (const [pattern, name] of matroskaCodecs)
    if (pattern.test(id)) return name;
  return id.toLowerCase();
}

function text(bytes: Uint8Array, item: Element): string {
  return new TextDecoder()
    .decode(bytes.subarray(item.dataStart, item.end))
    .replace(/\0+$/, "")
    .trim();
}

function float(bytes: Uint8Array, item: Element): number {
  if (item.end > bytes.length) return 0;
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + item.dataStart,
    item.end - item.dataStart,
  );
  return item.end - item.dataStart === 4
    ? view.getFloat32(0)
    : item.end - item.dataStart === 8
      ? view.getFloat64(0)
      : 0;
}

const matroskaKinds: Record<number, string> = {
  1: "video",
  2: "audio",
  17: "subtitle",
};

export function parseMatroskaTracks(
  bytes: Uint8Array,
  start = 0,
  end = bytes.length,
): Stream[] {
  const streams: Stream[] = [];
  const counts: Record<string, number> = {};
  for (const entry of children(bytes, start, end)) {
    if (entry.id !== MKV.trackEntry) continue;
    let kind: string | undefined;
    let codecId = "";
    let priv: Uint8Array | undefined;
    // Matroska's default language is English when the element is missing.
    let language = "eng";
    let bcp47: string | undefined;
    let title: string | null = null;
    let channels: number | undefined;
    for (const field of children(bytes, entry.dataStart, entry.end)) {
      if (field.id === MKV.trackType) kind = matroskaKinds[uint(bytes, field)];
      else if (field.id === MKV.codecId) codecId = text(bytes, field);
      else if (field.id === MKV.codecPrivate)
        priv = bytes.subarray(field.dataStart, field.end);
      else if (field.id === MKV.language) language = text(bytes, field);
      else if (field.id === MKV.languageBcp47) bcp47 = text(bytes, field);
      else if (field.id === MKV.name) title = text(bytes, field) || null;
      else if (field.id === MKV.audio)
        for (const setting of children(bytes, field.dataStart, field.end))
          if (setting.id === MKV.channels) channels = uint(bytes, setting);
    }
    if (!kind) continue;
    const id = counts[kind] ?? 0;
    counts[kind] = id + 1;
    const lang = bcp47 || language;
    streams.push({
      id,
      track: kind,
      codec: matroskaCodec(codecId, priv),
      ...(kind === "audio" ? { channels: channels ?? 1 } : {}),
      language: lang && lang !== "und" ? lang : null,
      title,
    });
  }
  return streams;
}

async function probeMatroska(
  head: Uint8Array,
  reader: RangeReader,
): Promise<Probe> {
  const header = element(head, 0);
  if (!header || header.size === undefined)
    throw new Error("Damaged EBML header");
  let docType = "matroska";
  for (const field of children(head, header.dataStart, header.end))
    if (field.id === MKV.docType) docType = text(head, field);
  const segment = element(head, header.end);
  if (segment?.id !== MKV.segment) throw new Error("No Matroska segment");
  const base = segment.dataStart;
  const found: Partial<
    Record<"info" | "tracks", { bytes: Uint8Array; start: number; end: number }>
  > = {};
  const positions: Partial<Record<"info" | "tracks", number>> = {};
  for (const child of children(head, base, segment.end)) {
    if (child.id === MKV.cluster) break;
    const name =
      child.id === MKV.info
        ? "info"
        : child.id === MKV.tracks
          ? "tracks"
          : undefined;
    if (name) {
      if (child.end <= head.length)
        found[name] = { bytes: head, start: child.dataStart, end: child.end };
      else positions[name] = child.offset;
      continue;
    }
    if (child.id !== MKV.seekHead) continue;
    for (const seek of children(head, child.dataStart, child.end)) {
      if (seek.id !== MKV.seek) continue;
      let target: number | undefined;
      let at: number | undefined;
      for (const field of children(head, seek.dataStart, seek.end)) {
        if (field.id === MKV.seekId) target = uint(head, field);
        else if (field.id === MKV.seekPosition) at = uint(head, field);
      }
      if (at === undefined) continue;
      if (target === MKV.info) positions.info ??= base + at;
      if (target === MKV.tracks) positions.tracks ??= base + at;
    }
  }
  // Elements the head does not hold: read them where the SeekHead says.
  for (const name of ["tracks", "info"] as const) {
    const position = positions[name];
    if (found[name] || position === undefined) continue;
    const peek = await reader.bytes(position, 16);
    const item = element(peek, 0);
    if (
      !item ||
      item.id !== (name === "info" ? MKV.info : MKV.tracks) ||
      item.size === undefined ||
      item.size > MAX_MATROSKA_INDEX
    )
      continue;
    const body = await reader.bytes(position + item.dataStart, item.size);
    found[name] = { bytes: body, start: 0, end: body.length };
  }
  if (!found.tracks) throw new Error("No Matroska tracks");
  let duration: number | undefined;
  if (found.info) {
    let scale = 1_000_000;
    let raw: number | undefined;
    for (const field of children(
      found.info.bytes,
      found.info.start,
      found.info.end,
    )) {
      if (field.id === MKV.timecodeScale)
        scale = uint(found.info.bytes, field) || scale;
      else if (field.id === MKV.duration) raw = float(found.info.bytes, field);
    }
    if (raw && raw > 0) duration = (raw * scale) / 1e9;
  }
  return {
    format: {
      name:
        docType === "webm" || docType === "matroska"
          ? "matroska,webm"
          : docType,
      ...(duration ? { duration } : {}),
    },
    streams: parseMatroskaTracks(
      found.tracks.bytes,
      found.tracks.start,
      found.tracks.end,
    ),
  };
}

/* ---------- MP4 / QuickTime ---------- */

type Box = { type: string; start: number; dataStart: number; end: number };

async function boxAt(
  reader: RangeReader,
  offset: number,
  limit: number,
): Promise<Box | undefined> {
  if (offset + 8 > limit) return undefined;
  const header = await reader.bytes(offset, 16);
  if (header.length < 8) return undefined;
  const view = new DataView(header.buffer, header.byteOffset, header.length);
  let size = view.getUint32(0);
  const type = ascii(header, 4, 4);
  let dataStart = offset + 8;
  if (size === 1) {
    if (header.length < 16) return undefined;
    size = Number(view.getBigUint64(8));
    dataStart = offset + 16;
  } else if (size === 0) size = limit - offset;
  if (
    !Number.isSafeInteger(size) ||
    !Number.isSafeInteger(offset + size) ||
    size < dataStart - offset
  )
    return undefined;
  return {
    type,
    start: offset,
    dataStart,
    end: Math.min(offset + size, limit),
  };
}

async function* boxes(
  reader: RangeReader,
  start: number,
  end: number,
  max = 256,
): AsyncGenerator<Box> {
  let offset = start;
  for (let count = 0; count < max && offset < end; count++) {
    const box = await boxAt(reader, offset, end);
    if (!box || box.end <= offset) return;
    yield box;
    offset = box.end;
  }
}

async function find(
  reader: RangeReader,
  parent: Box,
  type: string,
): Promise<Box | undefined> {
  for await (const box of boxes(reader, parent.dataStart, parent.end))
    if (box.type === type) return box;
  return undefined;
}

const mp4Video: Record<string, string> = {
  avc1: "h264",
  avc2: "h264",
  avc3: "h264",
  avc4: "h264",
  hvc1: "hevc",
  hev1: "hevc",
  dvh1: "hevc",
  dvhe: "hevc",
  dva1: "h264",
  dvav: "h264",
  vp08: "vp8",
  vp09: "vp9",
  av01: "av1",
  mp4v: "mpeg4",
  s263: "h263",
  jpeg: "mjpeg",
  mjpa: "mjpeg",
  apcn: "prores",
  apch: "prores",
  apcs: "prores",
  apco: "prores",
  ap4h: "prores",
  mp2v: "mpeg2video",
};
const mp4Audio: Record<string, string> = {
  "ac-3": "ac3",
  "ec-3": "eac3",
  "ac-4": "ac4",
  dtsc: "dts",
  dtsh: "dts",
  dtsl: "dts",
  dtse: "dts",
  dtsx: "dts",
  mlpa: "truehd",
  fLaC: "flac",
  Opus: "opus",
  ".mp3": "mp3",
  alac: "alac",
  lpcm: "pcm_s16le",
  sowt: "pcm_s16le",
  twos: "pcm_s16be",
  ipcm: "pcm_s16le",
  samr: "amr_nb",
  sawb: "amr_wb",
};
const mp4Subtitles: Record<string, string> = {
  tx3g: "mov_text",
  text: "mov_text",
  wvtt: "webvtt",
  stpp: "ttml",
  c608: "eia_608",
};
/** MPEG-4 object types an `esds` names inside `mp4a`. */
const objectTypes: Record<number, string> = {
  0x40: "aac",
  0x66: "aac",
  0x67: "aac",
  0x68: "aac",
  0x69: "mp3",
  0x6b: "mp3",
  0xa5: "ac3",
  0xa6: "eac3",
  0xa9: "dts",
};

const handlerKinds: Record<string, string> = {
  vide: "video",
  soun: "audio",
  sbtl: "subtitle",
  subt: "subtitle",
  text: "subtitle",
  clcp: "subtitle",
};

/**
 * The object type of an `esds` box (its DecoderConfigDescriptor, tag 4) and, for AAC, the channel
 * count of the AudioSpecificConfig inside it (DecoderSpecificInfo, tag 5).
 */
function esdsConfig(bytes: Uint8Array): { object?: number; channels?: number } {
  let offset = 4; // version and flags
  const length = () => {
    let value = 0;
    for (let index = 0; index < 4 && offset < bytes.length; index++) {
      const byte = bytes[offset++];
      value = (value << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const result: { object?: number; channels?: number } = {};
  while (offset < bytes.length) {
    const tag = bytes[offset++];
    const size = length();
    if (tag === 3) {
      // ES_Descriptor: ES_ID, flags, then optional fields before its own descriptors.
      const flags = bytes[offset + 2];
      offset += 3;
      if (flags & 0x80) offset += 2;
      if (flags & 0x40) offset += 1 + bytes[offset];
      if (flags & 0x20) offset += 2;
      continue;
    }
    if (tag === 4) {
      // Object type, stream type, buffer size and two bitrates, then the nested descriptors.
      result.object = bytes[offset];
      offset += 13;
      continue;
    }
    if (tag === 5) {
      result.channels = aacChannels(bytes.subarray(offset, offset + size));
      return result;
    }
    offset += size;
  }
  return result;
}

/** Channels of an AAC AudioSpecificConfig (ISO/IEC 14496-3): object type, frequency index, channel configuration. */
function aacChannels(config: Uint8Array): number | undefined {
  let bit = 0;
  const read = (count: number) => {
    let value = 0;
    for (let index = 0; index < count; index++, bit++)
      value = (value << 1) | ((config[bit >> 3] >> (7 - (bit & 7))) & 1);
    return value;
  };
  if (config.length < 2) return undefined;
  if (read(5) === 31) read(6);
  if (read(4) === 15) read(24);
  const configuration = read(4);
  return configuration >= 1 && configuration <= 6
    ? configuration
    : configuration === 7
      ? 8
      : undefined;
}

/** AC-3 channels from `acmod` and the LFE flag (ATSC A/52 table 5.8). */
function ac3Channels(acmod: number, lfe: number): number {
  return [2, 1, 2, 3, 3, 4, 4, 5][acmod] + lfe;
}

/** E-AC-3 channels from a `dec3` box: the first independent substream and the channels its dependents add. */
function eac3Channels(body: Uint8Array): number {
  // data_rate (13 bits) and num_ind_sub (3), then per substream: fscod 2, bsid 5, reserved 1,
  // asvc 1, bsmod 3, acmod 3, lfeon 1, reserved 3, num_dep_sub 4 and chan_loc 9 when dependents exist.
  const acmod = (body[3] >> 1) & 7;
  const lfe = body[3] & 1;
  const dependents = (body[4] >> 1) & 15;
  let channels = ac3Channels(acmod, lfe);
  if (dependents > 0 && body.length >= 6) {
    const location = ((body[4] & 1) << 8) | body[5];
    // Lc/Rc, Lrs/Rrs, Cs, Ts, Lsd/Rsd, Lw/Rw, Vhl/Vhr, Vhc, LFE2 (most significant bit first).
    const sizes = [2, 2, 1, 1, 2, 2, 2, 1, 1];
    sizes.forEach((size, index) => {
      if (location & (1 << (8 - index))) channels += size;
    });
  }
  return channels;
}

function language(code: number): string | null {
  if (!code || code === 0x7fff) return null;
  const value = String.fromCharCode(
    ((code >> 10) & 31) + 0x60,
    ((code >> 5) & 31) + 0x60,
    (code & 31) + 0x60,
  );
  return /^[a-z]{3}$/.test(value) && value !== "und" ? value : null;
}

async function probeTrak(
  reader: RangeReader,
  trak: Box,
): Promise<Omit<Stream, "id"> | undefined> {
  const mdia = await find(reader, trak, "mdia");
  if (!mdia) return undefined;
  let kind: string | undefined;
  let lang: string | null = null;
  let title: string | null = null;
  let stbl: Box | undefined;
  for await (const box of boxes(reader, mdia.dataStart, mdia.end)) {
    if (box.type === "mdhd") {
      const data = await reader.bytes(
        box.dataStart,
        Math.min(box.end - box.dataStart, 64),
      );
      const offset = data[0] === 1 ? 4 + 8 + 8 + 4 + 8 : 4 + 4 + 4 + 4 + 4;
      if (data.length >= offset + 2)
        lang = language((data[offset] << 8) | data[offset + 1]);
    } else if (box.type === "hdlr") {
      const data = await reader.bytes(
        box.dataStart,
        Math.min(box.end - box.dataStart, 512),
      );
      kind = handlerKinds[ascii(data, 8, 4)];
      const raw = data.subarray(24);
      // QuickTime writes a Pascal string, ISO a C string.
      const name =
        raw.length && raw[0] === raw.length - 1 ? raw.subarray(1) : raw;
      title =
        new TextDecoder().decode(name).replace(/\0.*$/s, "").trim() || null;
    } else if (box.type === "minf") {
      stbl = await find(reader, box, "stbl");
    }
  }
  if (!kind || !stbl) return undefined;
  const stsd = await find(reader, stbl, "stsd");
  if (!stsd) return undefined;
  const data = await reader.bytes(
    stsd.dataStart,
    Math.min(stsd.end - stsd.dataStart, 64 * 1024),
  );
  if (data.length < 16) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.length);
  const entrySize = view.getUint32(8);
  const format = ascii(data, 12, 4);
  const entry = data.subarray(8, 8 + Math.min(entrySize, data.length - 8));
  if (kind === "video")
    return {
      track: kind,
      codec: mp4Video[format] ?? format.trim().toLowerCase(),
      language: lang,
      title,
    };
  if (kind === "subtitle")
    return {
      track: kind,
      codec: mp4Subtitles[format] ?? format.trim().toLowerCase(),
      language: lang,
      title,
    };
  // Sound sample entry: 8 bytes of box header, 6 reserved, data reference index, then version (QuickTime adds fields after it).
  const entryView = new DataView(entry.buffer, entry.byteOffset, entry.length);
  // The entry's own count is often 2 whatever the stream holds: the codec's configuration says better.
  let channels = entry.length >= 26 ? entryView.getUint16(24) : undefined;
  let codec = mp4Audio[format] ?? format.trim().toLowerCase();
  if (format === "mp4a" || format === "enca") codec = "aac";
  const version = entry.length >= 18 ? entryView.getUint16(16) : 0;
  let offset = 36 + (version === 1 ? 16 : version === 2 ? 36 : 0);
  while (offset + 8 <= entry.length) {
    const size = entryView.getUint32(offset);
    const type = ascii(entry, offset + 4, 4);
    if (size < 8) break;
    const body = entry.subarray(offset + 8, offset + size);
    if (type === "esds") {
      const config = esdsConfig(body);
      if (config.object !== undefined)
        codec = objectTypes[config.object] ?? codec;
      if (config.channels) channels = config.channels;
    } else if (type === "dac3" && body.length >= 3) {
      channels = ac3Channels((body[1] >> 3) & 7, (body[1] >> 2) & 1);
    } else if (type === "dec3" && body.length >= 5) {
      channels = eac3Channels(body);
    }
    offset += size;
  }
  return {
    track: kind,
    codec,
    ...(channels ? { channels } : {}),
    language: lang,
    title,
  };
}

async function probeMp4(reader: RangeReader): Promise<Probe> {
  let moov: Box | undefined;
  for await (const box of boxes(reader, 0, Number.MAX_SAFE_INTEGER, 64)) {
    if (box.type === "moov") {
      moov = box;
      break;
    }
  }
  if (!moov) throw new Error("No moov box");
  let duration: number | undefined;
  const streams: Stream[] = [];
  const counts: Record<string, number> = {};
  for await (const box of boxes(reader, moov.dataStart, moov.end)) {
    if (box.type === "mvhd") {
      const data = await reader.bytes(
        box.dataStart,
        Math.min(box.end - box.dataStart, 64),
      );
      if (data.length < (data[0] === 1 ? 32 : 20))
        throw new Error("Truncated MP4 duration");
      const view = new DataView(data.buffer, data.byteOffset, data.length);
      const long = data[0] === 1;
      const scale = long ? view.getUint32(20) : view.getUint32(12);
      const length = long ? Number(view.getBigUint64(24)) : view.getUint32(16);
      if (scale > 0 && length > 0 && length !== 0xffffffff)
        duration = length / scale;
    } else if (box.type === "trak") {
      const stream = await probeTrak(reader, box);
      if (!stream) continue;
      const id = counts[stream.track] ?? 0;
      counts[stream.track] = id + 1;
      streams.push({ id, ...stream });
    }
  }
  return {
    format: {
      name: "mov,mp4,m4a,3gp,3g2,mj2",
      ...(duration ? { duration } : {}),
    },
    streams,
  };
}

/* ---------- Entry point ---------- */

/**
 * The file's container and tracks, or undefined when the container is not recognized. Other
 * containers WebView2 cannot open (AVI, MPEG-TS, FLV…) come back with their name and no tracks,
 * which `probeProblems` reports as a container problem.
 */
export async function probeFile(
  read: ReadRange,
): Promise<(Probe & { reads: number }) | undefined> {
  const reader = new RangeReader(read);
  const head = await reader.bytes(0, HEAD);
  const name = sniffContainer(head);
  if (!name) return undefined;
  const result =
    name === "matroska,webm"
      ? await probeMatroska(head, reader)
      : name.startsWith("mov,")
        ? await probeMp4(reader)
        : { format: { name }, streams: [] };
  return { ...result, reads: reader.reads };
}
