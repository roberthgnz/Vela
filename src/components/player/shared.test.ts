// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { episodeText, mediaErrorMessage, numbered, stepSpeed, trackName, typing } from "./shared";

// jsdom has no MediaError; the player only reads its codes.
beforeAll(() => {
  Object.assign(globalThis, {
    MediaError: { MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 },
  });
});

describe("trackName", () => {
  it("joins the language and a meaningful title", () => {
    expect(trackName("es", "Comentarios del director")).toBe("Español · Comentarios del director");
  });
  it("drops titles that only repeat the language or come from the muxer", () => {
    expect(trackName("en", "eng")).toBe("Inglés");
    expect(trackName("en", "SoundHandler")).toBe("Inglés");
    expect(trackName("es", "Track 2")).toBe("Español");
    expect(trackName("", "Stereo")).toBe("Stereo");
    expect(trackName("", "")).toBe("Pista");
  });
});

describe("numbered", () => {
  it("numbers only the labels that repeat", () => {
    const tracks = numbered([{ label: "Español" }, { label: "English" }, { label: "Español" }]);
    expect(tracks.map((track) => track.label)).toEqual(["Español 1", "English", "Español 2"]);
  });
});

describe("mediaErrorMessage", () => {
  it("explains each MediaError code and falls back for unknown ones", () => {
    const error = (code: number) => ({ code, message: "" }) as MediaError;
    expect(mediaErrorMessage(error(MediaError.MEDIA_ERR_NETWORK))).toMatch(/conexión/);
    expect(mediaErrorMessage(error(MediaError.MEDIA_ERR_DECODE))).toMatch(/HEVC/);
    expect(mediaErrorMessage(error(MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED))).toMatch(/códec/);
    expect(mediaErrorMessage(null)).toBe("Esta fuente no se ha podido reproducir.");
  });
});

describe("stepSpeed", () => {
  it("moves through the list and stops at both ends", () => {
    expect(stepSpeed(1, 1)).toBe(1.25);
    expect(stepSpeed(1, -1)).toBe(0.75);
    expect(stepSpeed(2, 1)).toBe(2);
    expect(stepSpeed(0.5, -1)).toBe(0.5);
    // A rate outside the list snaps to the next step up before moving.
    expect(stepSpeed(1.1, 1)).toBe(1.5);
    expect(stepSpeed(3, -1)).toBe(1.75);
  });
});

describe("typing", () => {
  it("is true inside text fields and editable content, not on buttons or sliders", () => {
    const text = document.createElement("input");
    const range = document.createElement("input");
    range.type = "range";
    const area = document.createElement("textarea");
    const button = document.createElement("button");
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    expect(typing(text)).toBe(true);
    expect(typing(area)).toBe(true);
    expect(typing(range)).toBe(false);
    expect(typing(button)).toBe(false);
    expect(typing(null)).toBe(false);
    // jsdom does not implement isContentEditable; the attribute alone is not enough here.
    expect(typeof typing(editable)).toBe("boolean");
  });
});

describe("episodeText", () => {
  it("formats the code and the title", () => {
    expect(episodeText({ id: "tt1:1:2", season: 1, episode: 2, title: "Piloto" })).toBe("T1 · E2 · Piloto");
    expect(episodeText(undefined)).toBe("");
  });
});
