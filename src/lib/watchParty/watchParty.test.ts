import { describe, expect, it } from "vitest";
import type { ResolvedStream } from "../contracts";
import { roomUrl } from "./client";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  controlState,
  formatCode,
  initialState,
  newRoomCode,
  normalizeCode,
  parseClientMessage,
  type PlaybackState,
} from "./protocol";
import { mediaId, parsePartyMedia, partyMediaId, pickPartyStream, shareStream, toPartyMedia } from "./share";
import { ClockOffset, correction, differs, expectedPosition, isEmpty } from "./sync";

const hash = "0123456789abcdef0123456789abcdef01234567";

function playingState(position: number, updatedAt: number, rate = 1): PlaybackState {
  return { paused: false, position, rate, updatedAt, seq: 3 };
}

describe("room codes", () => {
  it("are made of the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const code = newRoomCode();
      expect(code).toHaveLength(CODE_LENGTH);
      expect([...code].every((char) => CODE_ALPHABET.includes(char))).toBe(true);
    }
  });

  it("accept dashes, spaces and lower case", () => {
    expect(normalizeCode(" abcde-fghjk ")).toBe("ABCDEFGHJK");
    expect(formatCode("ABCDEFGHJK")).toBe("ABCDE-FGHJK");
  });

  it("reject wrong lengths and look-alike characters", () => {
    expect(normalizeCode("ABCDE")).toBe("");
    expect(normalizeCode("ABCDE-FGHJ0")).toBe("");
    expect(normalizeCode("ABCDE-FGHJI")).toBe("");
  });
});

describe("client messages", () => {
  it("parse the known ones", () => {
    expect(parseClientMessage('{"t":"control","paused":false,"position":12.5,"rate":1}')).toEqual({
      t: "control",
      paused: false,
      position: 12.5,
      rate: 1,
    });
    expect(parseClientMessage('{"t":"hello","v":1,"name":"  Ana\\u0000 "}')).toEqual({ t: "hello", v: 1, name: "Ana", hostKey: undefined });
  });

  it("reject malformed and out-of-range values", () => {
    expect(parseClientMessage("{nope")).toBeUndefined();
    expect(parseClientMessage('{"t":"control","paused":"no","position":1,"rate":1}')).toBeUndefined();
    expect(parseClientMessage('{"t":"control","paused":true,"position":-1,"rate":1}')).toBeUndefined();
    expect(parseClientMessage('{"t":"control","paused":true,"position":1,"rate":40}')).toBeUndefined();
    expect(parseClientMessage('{"t":"media","media":{},"paused":true,"position":1}')).toBeUndefined();
    expect(parseClientMessage('{"t":"chat","text":"   "}')).toBeUndefined();
    expect(parseClientMessage('{"t":"status","status":"dancing"}')).toBeUndefined();
    expect(parseClientMessage('{"t":"admin"}')).toBeUndefined();
  });

  it("cap chat messages", () => {
    const message = parseClientMessage(JSON.stringify({ t: "chat", text: "a".repeat(2000) }));
    expect(message?.t === "chat" && message.text.length).toBe(500);
  });

  it("stamp control changes with the relay's clock and sequence", () => {
    expect(controlState({ ...initialState, seq: 4 }, { paused: false, position: 3, rate: 1.5 }, 1000, "p1")).toEqual({
      paused: false,
      position: 3,
      rate: 1.5,
      updatedAt: 1000,
      seq: 5,
      by: "p1",
    });
  });
});

describe("sync", () => {
  it("advances the room's position while playing", () => {
    expect(expectedPosition(playingState(10, 1000), 3000)).toBe(12);
    expect(expectedPosition(playingState(10, 1000, 2), 3000)).toBe(14);
    expect(expectedPosition({ ...playingState(10, 1000), paused: true }, 9000)).toBe(10);
    expect(expectedPosition(playingState(10, 1000), 100_000, 50)).toBe(50);
  });

  it("does not echo changes that came from the room", () => {
    const state = playingState(10, 1000);
    expect(differs({ paused: false, time: 12.2, rate: 1 }, state, 3000)).toBe(false);
    expect(differs({ paused: true, time: 12, rate: 1 }, state, 3000)).toBe(true);
    expect(differs({ paused: false, time: 40, rate: 1 }, state, 3000)).toBe(true);
    expect(differs({ paused: false, time: 12, rate: 1.25 }, state, 3000)).toBe(true);
  });

  it("corrects a video that drifted, paused or changed speed", () => {
    const state = playingState(10, 1000);
    expect(isEmpty(correction({ paused: false, time: 12.5, rate: 1 }, state, 3000))).toBe(true);
    expect(correction({ paused: false, time: 9, rate: 1 }, state, 3000)).toEqual({ seek: 12 });
    expect(correction({ paused: true, time: 12, rate: 1 }, state, 3000)).toEqual({ play: true });
    expect(correction({ paused: false, time: 12, rate: 2 }, { ...state, paused: true, position: 12 }, 3000)).toEqual({
      rate: 1,
      pause: true,
    });
    // Paused peers stop on the same frame.
    expect(correction({ paused: true, time: 12.5, rate: 1 }, { ...state, paused: true, position: 12 }, 3000)).toEqual({ seek: 12 });
  });

  it("estimates the clock offset from the fastest round trip", () => {
    const clock = new ClockOffset();
    expect(clock.offset).toBe(0);
    clock.add(1000, 6100, 1200); // rtt 200: offset 5000
    clock.add(2000, 7020, 2040); // rtt 40: offset 5000
    clock.add(3000, 9000, 3800); // rtt 800, skewed
    expect(clock.offset).toBe(5000);
  });
});

const torrent: ResolvedStream = {
  name: "Torrentio\n1080p",
  title: "Movie.2024.1080p.WEB",
  infoHash: hash,
  fileIdx: 2,
  sources: ["tracker:udp://tracker.example:1337", "https://evil.example/x"],
  behaviorHints: { filename: "Movie.2024.1080p.mkv", videoSize: 123, bingeGroup: `torrentio|1080p|${hash}` },
  addonName: "Torrentio",
  addonUrl: "https://torrentio.example/realdebrid=SECRETKEY/manifest.json",
};

describe("shared title", () => {
  it("never carries URLs or addon addresses", () => {
    const media = toPartyMedia({
      meta: { id: "tt1", type: "movie", name: "Movie", poster: "https://img.example/p.jpg", description: "long" },
      videoId: "tt1",
      stream: { ...torrent, url: "https://debrid.example/dl/SECRET" },
    });
    const text = JSON.stringify(media);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("torrentio.example");
    expect(media.stream.sources).toEqual(["tracker:udp://tracker.example:1337"]);
    expect(media.meta.description).toBeUndefined();
  });

  it("keeps only the season being watched", () => {
    const videos = Array.from({ length: 30 }, (_, index) => ({ id: `tt2:${Math.floor(index / 10) + 1}:${(index % 10) + 1}`, season: Math.floor(index / 10) + 1, episode: (index % 10) + 1 }));
    const episode = videos[12]!;
    const media = toPartyMedia({ meta: { id: "tt2", type: "series", name: "Show", videos }, videoId: episode.id, episode, stream: torrent });
    expect(media.meta.videos).toHaveLength(10);
    expect(media.meta.videos!.every((video) => video.season === 2)).toBe(true);
  });

  it("validates what other peers send", () => {
    expect(parsePartyMedia(null)).toBeUndefined();
    expect(parsePartyMedia({ meta: { id: "tt1", type: "movie" }, videoId: "tt1" })).toBeUndefined();
    const media = parsePartyMedia({
      meta: { id: "tt1", type: "movie", name: "Movie", poster: "javascript:alert(1)", background: "https://img.example/b.jpg" },
      videoId: "tt1",
      stream: { infoHash: "not-a-hash", sources: ["tracker:udp://x", 5, "file:///etc"] },
    });
    expect(media?.meta.poster).toBeUndefined();
    expect(media?.meta.background).toBe("https://img.example/b.jpg");
    expect(media?.stream.infoHash).toBeUndefined();
    expect(media?.stream.sources).toEqual(["tracker:udp://x"]);
    expect(partyMediaId(media!)).toBe(mediaId("movie", "tt1", "tt1"));
  });
});

describe("guest source", () => {
  const shared = shareStream(torrent);
  const own = (stream: Partial<ResolvedStream>): ResolvedStream => ({ addonName: "Mine", addonUrl: "https://mine.example/manifest.json", ...stream });

  it("prefers the guest's own link for the same torrent", () => {
    const debrid = own({ url: "https://debrid.example/mine", behaviorHints: { bingeGroup: `torrentio|1080p|${hash}` } });
    expect(pickPartyStream([own({ url: "https://other.example" }), debrid], shared, true)).toBe(debrid);
  });

  it("matches the same file by name", () => {
    const file = own({ url: "https://files.example/movie", behaviorHints: { filename: "Movie.2024.1080p.mkv", videoSize: 123 } });
    expect(pickPartyStream([file], shared, false)).toBe(file);
  });

  it("falls back to the host's torrent only where torrents play", () => {
    const fallback = pickPartyStream([], shared, true);
    expect(fallback).toMatchObject({ infoHash: hash, fileIdx: 2, addonUrl: "" });
    expect(fallback?.url).toBeUndefined();
    expect(pickPartyStream([], shared, false)).toBeUndefined();
  });

  it("matches a plain link by the addon's name and title", () => {
    const link = own({ name: "Open Cinema", title: "Trailer MP4", url: "https://cdn.example/trailer.mp4" });
    expect(pickPartyStream([own({ name: "Open Cinema", title: "Other", url: "https://x" }), link], { name: "Open Cinema", title: "Trailer MP4" }, false)).toBe(link);
    const described = own({ name: "Open Cinema", description: "CC BY 3.0", url: "https://cdn.example/b.mp4" });
    expect(pickPartyStream([described], shareStream(described), false)).toBe(described);
  });

  it("leaves the choice to the guest without a match", () => {
    expect(pickPartyStream([own({ url: "https://other.example" })], { name: "Some addon" }, true)).toBeUndefined();
  });
});

describe("relay address", () => {
  it("accepts http(s), ws(s) and bare hosts", () => {
    expect(roomUrl("https://vela-party.example.workers.dev/", "ABCDEFGHJK")).toBe("wss://vela-party.example.workers.dev/rooms/ABCDEFGHJK");
    expect(roomUrl("vela-party.example.workers.dev", "ABCDEFGHJK")).toBe("wss://vela-party.example.workers.dev/rooms/ABCDEFGHJK");
    expect(roomUrl("ws://127.0.0.1:8787", "ABCDEFGHJK")).toBe("ws://127.0.0.1:8787/rooms/ABCDEFGHJK");
    expect(() => roomUrl("ftp://x", "ABCDEFGHJK")).toThrow();
  });
});
