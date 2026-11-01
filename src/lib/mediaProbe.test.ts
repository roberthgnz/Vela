import { describe, expect, it } from "vitest";
import { probeFile, sniffContainer, RangeReader } from "./mediaProbe";
import { mediaCapabilities, probeProblems } from "./streamingServer";

describe("damaged media indexes", () => {
  it("rejects oversized and invalid ranges before reading", async () => {
    const file = source(new Uint8Array(8));
    const reader = new RangeReader(file.read);
    await expect(reader.bytes(0, 2 ** 32)).rejects.toThrow("Invalid media range");
    await expect(reader.bytes(-1, 16)).rejects.toThrow("Invalid media range");
    expect(file.calls).toHaveLength(0);
  });

  it("rejects an MP4 with truncated duration instead of reading outside its buffer", async () => {
    const file = source(box("moov", box("mvhd", bytes(0, 0, 0, 0))));
    await expect(probeFile(file.read)).rejects.toThrow("Truncated MP4 duration");
  });
});

/* Matroska: EBML elements with an 8-byte size, which keeps offsets easy to compute. */
function el(id: number, ...body: Uint8Array[]): Uint8Array {
  const idBytes: number[] = [];
  for (let value = id; value > 0; value = Math.floor(value / 256))
    idBytes.unshift(value % 256);
  const length = body.reduce((sum, part) => sum + part.length, 0);
  const size = [
    0x01,
    0,
    0,
    0,
    (length >>> 24) & 255,
    (length >>> 16) & 255,
    (length >>> 8) & 255,
    length & 255,
  ];
  return concat(new Uint8Array([...idBytes, ...size]), ...body);
}
const uint = (id: number, value: number) =>
  el(
    id,
    new Uint8Array(
      Array.from(
        { length: 8 },
        (_, index) => Math.floor(value / 256 ** (7 - index)) % 256,
      ),
    ),
  );
const text = (id: number, value: string) =>
  el(id, new TextEncoder().encode(value));
const float = (id: number, value: number) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value);
  return el(id, bytes);
};
function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function source(bytes: Uint8Array) {
  const calls: [number, number][] = [];
  return {
    calls,
    read: async (start: number, length: number) => {
      calls.push([start, length]);
      return bytes.slice(start, start + length);
    },
  };
}

const track = (type: number, codec: string, ...fields: Uint8Array[]) =>
  el(0xae, uint(0x83, type), text(0x86, codec), ...fields);

/** A Matroska file whose Tracks sit after 300 KiB of padding, found through the SeekHead. */
function matroska(): Uint8Array {
  const tracks = el(
    0x1654ae6b,
    track(1, "V_MPEGH/ISO/HEVC"),
    track(
      2,
      "A_DTS",
      text(0x22b59c, "spa"),
      text(0x536e, "Castellano DTS-HD"),
      el(0xe1, uint(0x9f, 6)),
    ),
    track(2, "A_AAC", el(0xe1, uint(0x9f, 2))),
    track(17, "S_TEXT/ASS", text(0x22b59c, "spa")),
    track(17, "S_HDMV/PGS", text(0x22b59c, "und")),
  );
  const info = el(
    0x1549a966,
    uint(0x2ad7b1, 1_000_000),
    float(0x4489, 5_400_000),
  );
  const padding = el(0xec, new Uint8Array(300 * 1024));
  const seekHead = (position: number) =>
    el(
      0x114d9b74,
      el(0x4dbb, uint(0x53ab, 0x1654ae6b), uint(0x53ac, position)),
    );
  const header = el(0x1a45dfa3, text(0x4282, "matroska"));
  const segmentStart = new Uint8Array([
    0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  ]);
  const seekLength = seekHead(0).length;
  return concat(
    header,
    segmentStart,
    seekHead(seekLength + info.length + padding.length),
    info,
    padding,
    tracks,
  );
}

/* MP4: boxes with 32-bit sizes (and a 64-bit mdat), fields big-endian. */
function box(type: string, ...body: Uint8Array[]): Uint8Array {
  const length = 8 + body.reduce((sum, part) => sum + part.length, 0);
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, length);
  head.set(new TextEncoder().encode(type), 4);
  return concat(head, ...body);
}
const bytes = (...values: number[]) => new Uint8Array(values);
function u16(value: number) {
  return bytes((value >> 8) & 255, value & 255);
}
function u32(value: number) {
  return bytes(
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  );
}
const packedLanguage = (code: string) =>
  u16(
    [...code].reduce(
      (value, char) => (value << 5) | (char.charCodeAt(0) - 0x60),
      0,
    ),
  );

function trak(
  handler: string,
  language: string,
  entry: Uint8Array,
): Uint8Array {
  const mdhd = box(
    "mdhd",
    u32(0),
    u32(0),
    u32(0),
    u32(1000),
    u32(0),
    packedLanguage(language),
    u16(0),
  );
  const hdlr = box(
    "hdlr",
    u32(0),
    u32(0),
    new TextEncoder().encode(handler),
    new Uint8Array(12),
    new TextEncoder().encode("SoundHandler\0"),
  );
  const stsd = box("stsd", u32(0), u32(1), entry);
  return box(
    "trak",
    box("tkhd", new Uint8Array(84)),
    box(
      "mdia",
      mdhd,
      hdlr,
      box("minf", box("stbl", stsd, box("stsz", new Uint8Array(4000)))),
    ),
  );
}
/** Sound sample entry: reserved, data reference, version 0 fields, 2 channels as most muxers write. */
const soundEntry = (format: string, ...children: Uint8Array[]) =>
  box(
    format,
    new Uint8Array(6),
    u16(1),
    new Uint8Array(8),
    u16(2),
    u16(16),
    new Uint8Array(4),
    u32(48000 << 16),
    ...children,
  );

/** An MP4 with its index after a large mdat (64-bit size), as files not prepared for streaming are. */
function mp4(): Uint8Array {
  const mvhd = box(
    "mvhd",
    u32(0),
    u32(0),
    u32(0),
    u32(1000),
    u32(5_400_000),
    new Uint8Array(80),
  );
  const video = trak("vide", "und", box("hvc1", new Uint8Array(78)));
  // AC-3 5.1: dac3 with acmod 7 (3/2) and the LFE flag.
  const ac3 = trak(
    "soun",
    "fra",
    soundEntry("ac-3", box("dac3", bytes(0x10, 0x3d, 0xe0))),
  );
  // AAC stereo inside mp4a: esds with a DecoderSpecificInfo (object 2, 48 kHz, 2 channels).
  const esds = box(
    "esds",
    u32(0),
    bytes(0x03, 0x19, 0, 1, 0),
    bytes(0x04, 0x11, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
    bytes(0x05, 0x02, 0x11, 0x90),
  );
  const aac = trak("soun", "eng", soundEntry("mp4a", esds));
  const text = trak("sbtl", "spa", box("tx3g", new Uint8Array(40)));
  const mdatLength = 600 * 1024;
  const mdat = concat(
    u32(1),
    new TextEncoder().encode("mdat"),
    new Uint8Array(4),
    u32(16 + mdatLength),
    new Uint8Array(mdatLength),
  );
  return concat(
    box("ftyp", new TextEncoder().encode("isom"), u32(512)),
    mdat,
    box("moov", mvhd, video, ac3, aac, text),
  );
}

describe("sniffContainer", () => {
  it("names containers as FFmpeg does", () => {
    const head = (...values: number[]) => {
      const out = new Uint8Array(1024);
      out.set(values);
      return out;
    };
    const asciiHead = (value: string, at = 0) => {
      const out = new Uint8Array(1024);
      out.set(new TextEncoder().encode(value), at);
      return out;
    };
    expect(sniffContainer(head(0x1a, 0x45, 0xdf, 0xa3))).toBe("matroska,webm");
    expect(sniffContainer(asciiHead("ftypisom", 4))).toBe(
      "mov,mp4,m4a,3gp,3g2,mj2",
    );
    expect(
      sniffContainer(
        concat(asciiHead("RIFF").subarray(0, 8), asciiHead("AVI LIST")),
      ),
    ).toBe("avi");
    expect(sniffContainer(asciiHead("FLV"))).toBe("flv");
    const ts = new Uint8Array(1024);
    ts[0] = ts[188] = ts[376] = 0x47;
    expect(sniffContainer(ts)).toBe("mpegts");
    expect(sniffContainer(asciiHead("<html>"))).toBeUndefined();
  });
});

describe("probeFile", () => {
  it("reads Matroska tracks the SeekHead points to beyond the head, with FFmpeg codec names", async () => {
    const file = source(matroska());
    const result = await probeFile(file.read);
    expect(result?.format).toEqual({ name: "matroska,webm", duration: 5400 });
    expect(result?.streams).toEqual([
      { id: 0, track: "video", codec: "hevc", language: "eng", title: null },
      {
        id: 0,
        track: "audio",
        codec: "dts",
        channels: 6,
        language: "spa",
        title: "Castellano DTS-HD",
      },
      {
        id: 1,
        track: "audio",
        codec: "aac",
        channels: 2,
        language: "eng",
        title: null,
      },
      { id: 0, track: "subtitle", codec: "ass", language: "spa", title: null },
      {
        id: 1,
        track: "subtitle",
        codec: "hdmv_pgs_subtitle",
        language: null,
        title: null,
      },
    ]);
    // The head, the Tracks header and its body: never the padding in between.
    expect(file.calls.length).toBeLessThanOrEqual(3);
  });

  it("finds an MP4 index after the media data and reads channels from the codec configuration", async () => {
    const file = source(mp4());
    const result = await probeFile(file.read);
    expect(result?.format).toEqual({
      name: "mov,mp4,m4a,3gp,3g2,mj2",
      duration: 5400,
    });
    expect(result?.streams).toEqual([
      {
        id: 0,
        track: "video",
        codec: "hevc",
        language: null,
        title: "SoundHandler",
      },
      {
        id: 0,
        track: "audio",
        codec: "ac3",
        channels: 6,
        language: "fra",
        title: "SoundHandler",
      },
      {
        id: 1,
        track: "audio",
        codec: "aac",
        channels: 2,
        language: "eng",
        title: "SoundHandler",
      },
      {
        id: 0,
        track: "subtitle",
        codec: "mov_text",
        language: "spa",
        title: "SoundHandler",
      },
    ]);
    expect(file.calls.length).toBeLessThanOrEqual(3);
  });

  it("reports a container WebView2 cannot open as a problem, without reading tracks", async () => {
    const avi = new Uint8Array(4096);
    avi.set(new TextEncoder().encode("RIFF\0\0\0\0AVI LIST"));
    const result = await probeFile(source(avi).read);
    expect(result).toEqual({ format: { name: "avi" }, streams: [], reads: 1 });
    expect(probeProblems(result!, mediaCapabilities())).toEqual([
      "contenedor AVI",
    ]);
  });

  it("gives up on what it does not recognize", async () => {
    expect(
      await probeFile(
        source(new TextEncoder().encode("<html>not a video</html>")).read,
      ),
    ).toBeUndefined();
  });
});
