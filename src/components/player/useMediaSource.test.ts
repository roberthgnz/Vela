// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Probe } from "../../lib/streamingServer";
import { conversionReasons } from "./useMediaSource";

function element(readyState: number): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "readyState", { value: readyState });
  return video;
}

const hevc: Probe = {
  format: { name: "matroska,webm" },
  streams: [
    { track: "video", codec: "hevc" },
    { track: "audio", codec: "aac" },
  ],
};
const dts: Probe = {
  format: { name: "matroska,webm" },
  streams: [
    { track: "video", codec: "h264" },
    { track: "audio", codec: "dts" },
  ],
};
const supported: Probe = {
  format: { name: "mov,mp4,m4a,3gp,3g2,mj2" },
  streams: [
    { track: "video", codec: "h264" },
    { track: "audio", codec: "aac" },
  ],
};

describe("conversionReasons", () => {
  it("converts a file the player is not decoding yet when one of its tracks is not supported", () => {
    expect(conversionReasons(hevc, element(0))).toEqual(["vídeo HEVC"]);
    expect(conversionReasons(hevc, null)).toEqual(["vídeo HEVC"]);
  });

  it("keeps a direct source that already decodes, unless none of its audio tracks can be heard", () => {
    expect(conversionReasons(hevc, element(4))).toEqual([]);
    expect(conversionReasons(dts, element(4))).toEqual(["audio DTS", "ninguna pista de audio compatible"]);
  });

  it("finds nothing to convert in a supported file", () => {
    expect(conversionReasons(supported, element(0))).toEqual([]);
  });
});
