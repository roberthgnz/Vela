import { execFileSync } from "node:child_process";
import {
  existsSync,
  openSync,
  readdirSync,
  readSync,
  closeSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeFile } from "./mediaProbe";

/**
 * Checks the native reader against FFprobe on the validation media (`node dev/make-validation-media.mjs`).
 * Skipped when the media or FFprobe are missing.
 */
const folder = join(process.cwd(), ".tmp", "media");
const hasFfprobe = (() => {
  try {
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const files = existsSync(folder)
  ? readdirSync(folder).filter((name) => /\.(mp4|mkv|webm|avi)$/.test(name))
  : [];

type FfStream = {
  codec_type: string;
  codec_name: string;
  channels?: number;
  tags?: Record<string, string>;
};

function ffprobe(path: string): {
  format: { format_name: string; duration?: string };
  streams: FfStream[];
} {
  return JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", path],
      { encoding: "utf8" },
    ),
  );
}

function reader(path: string) {
  const size = statSync(path).size;
  let reads = 0;
  let bytes = 0;
  const read = async (start: number, length: number) => {
    reads++;
    const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - start)));
    if (!buffer.length) return new Uint8Array(0);
    const handle = openSync(path, "r");
    try {
      readSync(handle, buffer, 0, buffer.length, start);
    } finally {
      closeSync(handle);
    }
    bytes += buffer.length;
    return new Uint8Array(buffer);
  };
  return { read, stats: () => ({ reads, bytes, size }) };
}

describe.skipIf(!hasFfprobe || !files.length)(
  "native probe against FFprobe",
  () => {
    it.each(files)("%s", async (name) => {
      const path = join(folder, name);
      const expected = ffprobe(path);
      const source = reader(path);
      const result = await probeFile(source.read);
      expect(result).toBeDefined();
      expect(result!.format.name).toBe(expected.format.format_name);
      if (name.endsWith(".avi")) {
        // Containers WebView2 cannot open are reported by name; their tracks are not read.
        expect(result!.streams).toEqual([]);
        return;
      }
      const wanted = expected.streams
        .filter((stream) =>
          ["video", "audio", "subtitle"].includes(stream.codec_type),
        )
        .map((stream) => ({
          track: stream.codec_type,
          codec: stream.codec_name,
          ...(stream.codec_type === "audio"
            ? { channels: stream.channels }
            : {}),
          language:
            stream.tags?.language && stream.tags.language !== "und"
              ? stream.tags.language
              : null,
        }));
      expect(
        result!.streams.map(({ track, codec, channels, language }) => ({
          track,
          codec,
          ...(track === "audio" ? { channels } : {}),
          language,
        })),
      ).toEqual(wanted);
      if (expected.format.duration)
        expect(result!.format.duration).toBeCloseTo(
          Number(expected.format.duration),
          0,
        );
      // Only the head and the index are read, never the whole file.
      const { bytes, size, reads } = source.stats();
      if (process.env.PROBE_STATS)
        console.log(`${name}: ${reads} reads, ${bytes} of ${size} bytes`);
      expect(bytes).toBeLessThanOrEqual(Math.max(512 * 1024, size * 0.6));
    });
  },
);
