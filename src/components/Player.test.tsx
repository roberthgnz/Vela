// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The player's collaborators that reach the network or the desktop: none answer in this test.
vi.mock("../lib/transport", () => ({
  requestRange: vi.fn(() => Promise.reject(new Error("no ranges"))),
  requestBytes: vi.fn(() => Promise.reject(new Error("offline"))),
  requestText: vi.fn(() => Promise.reject(new Error("offline"))),
}));
vi.mock("../lib/protocol", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/protocol")>()),
  getSubtitles: vi.fn(() => Promise.resolve([])),
}));
vi.mock("../lib/streamingServer", () => ({
  torrentStats: vi.fn(() => Promise.reject(new Error("no service"))),
  probe: vi.fn(() => Promise.reject(new Error("no service"))),
  describeTorrent: () => "",
  embeddedAssUrl: () => "",
  embeddedSubtitlePlaylist: () => "",
  readSubtitleRendition: vi.fn(),
  subtitleUrl: () => "",
}));
vi.mock("../lib/externalPlayback", () => ({
  playExternally: vi.fn(() => Promise.reject(new Error("no player"))),
  externalPlayerName: () => "",
}));
vi.mock("../lib/mkvChapters", () => ({ readMkvChapters: vi.fn(() => Promise.reject(new Error("not mkv"))) }));

import type { Episode } from "../lib/contracts";
import { Player, type Playing } from "./Player";

const play = vi.fn(() => Promise.resolve());
const pause = vi.fn();

beforeAll(() => {
  // jsdom has no media playback and no <dialog>; the player only needs their surface.
  Object.assign(HTMLMediaElement.prototype, { play, pause, load: vi.fn(), canPlayType: () => "" });
  Object.assign(HTMLDialogElement.prototype, {
    showModal() {
      (this as HTMLDialogElement).setAttribute("open", "");
    },
    close() {
      (this as HTMLDialogElement).removeAttribute("open");
    },
  });
  Object.assign(globalThis, {
    MediaError: { MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 },
  });
});

beforeEach(() => {
  play.mockClear();
  pause.mockClear();
});
afterEach(cleanup);

const episodes: Episode[] = [
  { id: "tt1:1:1", season: 1, episode: 1, title: "Piloto" },
  { id: "tt1:1:2", season: 1, episode: 2, title: "Segundo" },
];

function movie(): Playing {
  const url = "http://media.test/bunny.mp4";
  return {
    meta: { id: "bbb", type: "movie", name: "Big Buck Bunny" },
    addonUrl: "http://addon.test/manifest.json",
    videoId: "bbb",
    stream: { addonName: "Demo", addonUrl: "http://addon.test/manifest.json", url },
    url,
    externalUrl: url,
    serviceUrl: "http://127.0.0.1:11470",
    resume: 0,
  };
}

function series(): Playing {
  const base = movie();
  return {
    ...base,
    meta: { id: "tt1", type: "series", name: "La serie", videos: episodes },
    videoId: "tt1:1:1",
    episode: episodes[0],
  };
}

function setup(playing: Playing, handlers: Partial<Parameters<typeof Player>[0]> = {}) {
  const props = { playing, onClose: vi.fn(), onStarted: vi.fn(), onFailed: vi.fn(), ...handlers };
  render(<Player {...props} />);
  const video = document.querySelector("video")!;
  return { ...props, video };
}

describe("Player", () => {
  it("shows the title and the loading cover until the video plays", () => {
    const { video } = setup(movie());
    expect(screen.getByRole("dialog", { name: "Reproduciendo Big Buck Bunny" })).toBeTruthy();
    expect(document.querySelector(".player")).toHaveAttribute("data-status", "loading");
    expect(screen.getByRole("status").textContent).toContain("Cargando");
    expect(video.getAttribute("src")).toBe("http://media.test/bunny.mp4");
  });

  it("reports the first start and switches to the playing state", () => {
    const { video, onStarted } = setup(movie());
    fireEvent.playing(video);
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".player")).toHaveAttribute("data-status", "playing");
    expect(screen.getByRole("button", { name: "Pausar" })).toBeTruthy();
    fireEvent.pause(video);
    fireEvent.playing(video);
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("explains a decoding error, offers the alternatives and reports the failure", () => {
    const { video, onFailed } = setup(movie());
    Object.defineProperty(video, "error", { value: { code: 3, message: "" }, configurable: true });
    fireEvent.error(video);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("No se puede reproducir aquí");
    expect(alert.textContent).toContain("HEVC");
    expect(screen.getByRole("button", { name: /reproductor externo/ })).toBeTruthy();
    expect(onFailed).toHaveBeenCalledWith(expect.stringContaining("HEVC"));
    // Without a conversion URL there is nothing to convert with.
    expect(screen.queryByRole("button", { name: /Convertir/ })).toBeNull();
  });

  it("answers the keyboard wherever the focus is: K plays, Escape closes", () => {
    const { onClose } = setup(movie());
    fireEvent.keyDown(window, { key: "k" });
    expect(play).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers the next episode of a series and starts it with N", () => {
    const onNext = vi.fn();
    setup(series(), { onNext });
    expect(screen.getByRole("button", { name: "Siguiente episodio: T1 · E2" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "n" });
    expect(onNext).toHaveBeenCalledWith(episodes[1]);
  });

  it("shows the next-episode card when the video ends", () => {
    const onNext = vi.fn();
    const { video } = setup(series(), { onNext });
    act(() => {
      fireEvent.ended(video);
    });
    expect(document.querySelector(".player")).toHaveAttribute("data-status", "ended");
    const card = screen.getByRole("region", { name: "Siguiente episodio" });
    expect(card.textContent).toContain("Segundo");
    fireEvent.click(screen.getByRole("button", { name: /Ver ahora/ }));
    expect(onNext).toHaveBeenCalledWith(episodes[1]);
  });
});
