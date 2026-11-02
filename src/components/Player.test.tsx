// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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
vi.mock("../lib/streamingServer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/streamingServer")>();
  return {
    torrentStats: vi.fn(() => Promise.reject(new Error("no service"))),
    probe: vi.fn(() => Promise.reject(new Error("no service"))),
    describeTorrent: () => "",
    embeddedAssUrl: () => "",
    embeddedSubtitlePlaylist: () => "",
    readSubtitleRendition: vi.fn(),
    subtitleUrl: () => "",
    mediaCapabilities: actual.mediaCapabilities,
    probeProblems: actual.probeProblems,
    suggestedProfile: actual.suggestedProfile,
    torrentProfiles: actual.torrentProfiles,
    torrentProfile: vi.fn(() => Promise.reject(new Error("no service"))),
    setTorrentProfile: vi.fn(),
    removeTorrent: vi.fn(),
    prepareTorrent: vi.fn(),
  };
});
vi.mock("../lib/externalPlayback", () => ({
  playExternally: vi.fn(() => Promise.reject(new Error("no player"))),
  externalPlayerName: () => "",
}));
vi.mock("../lib/mkvChapters", () => ({
  readMkvChapters: vi.fn(() => Promise.reject(new Error("not mkv"))),
}));
vi.mock("../lib/mediaProbe", () => ({
  probeFile: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../lib/embeddedMpv", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/embeddedMpv")>()),
  useEmbeddedLibrary: vi.fn(() => null),
  libmpvInfo: vi.fn(async () => ({
    version: "20261101-914a11c30c",
    size: 29_021_126,
    license: "LGPL-2.1-or-later",
    source: "x",
    path: null,
  })),
  installLibmpv: vi.fn(async () => "C:/Vela/libmpv/libmpv-2.dll"),
}));

import type { Episode } from "../lib/contracts";
import { installLibmpv, useEmbeddedLibrary } from "../lib/embeddedMpv";
import { probeFile } from "../lib/mediaProbe";
import { readMkvChapters } from "../lib/mkvChapters";
import { requestRange } from "../lib/transport";
import {
  prepareTorrent,
  probe,
  removeTorrent,
  setTorrentProfile,
  torrentProfile,
} from "../lib/streamingServer";
import { Player, type Playing } from "./Player";

const play = vi.fn(() => Promise.resolve());
const pause = vi.fn();

beforeAll(() => {
  // jsdom has no media playback and no <dialog>; the player only needs their surface.
  Object.assign(HTMLMediaElement.prototype, {
    play,
    pause,
    load: vi.fn(),
    canPlayType: () => "",
  });
  Object.assign(HTMLDialogElement.prototype, {
    showModal() {
      (this as HTMLDialogElement).setAttribute("open", "");
    },
    close() {
      (this as HTMLDialogElement).removeAttribute("open");
    },
  });
  Object.assign(globalThis, {
    MediaError: {
      MEDIA_ERR_ABORTED: 1,
      MEDIA_ERR_NETWORK: 2,
      MEDIA_ERR_DECODE: 3,
      MEDIA_ERR_SRC_NOT_SUPPORTED: 4,
    },
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
    stream: {
      addonName: "Demo",
      addonUrl: "http://addon.test/manifest.json",
      url,
    },
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

function setup(
  playing: Playing,
  handlers: Partial<Parameters<typeof Player>[0]> = {},
) {
  const props = {
    playing,
    onClose: vi.fn(),
    onStarted: vi.fn(),
    onFailed: vi.fn(),
    ...handlers,
  };
  render(<Player {...props} />);
  const video = document.querySelector("video")!;
  return { ...props, video };
}

describe("Player", () => {
  it("offers embedded subtitles through mpv without inventing server tracks", async () => {
    vi.mocked(useEmbeddedLibrary).mockReturnValue("C:/mpv/libmpv-2.dll");
    vi.mocked(probeFile).mockResolvedValueOnce({ format: { name: "matroska,webm" }, streams: [{ track: "video", codec: "h264" }, { track: "subtitle", codec: "ass", language: "spa" }], reads: 1 });
    try {
      const onEmbedded = vi.fn();
      const { video } = setup(movie(), { onEmbedded });
      await act(async () => {});
      video.currentTime = 23;
      fireEvent.click(screen.getByRole("button", { name: "Audio y subtítulos" }));
      expect(screen.getByText(/Este archivo contiene subtítulos incrustados/)).toBeTruthy();
      expect(screen.queryByText("No hay subtítulos para este vídeo.")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Ver subtítulos incrustados con mpv" }));
      expect(onEmbedded).toHaveBeenCalledWith(23, true);
    } finally {
      vi.mocked(useEmbeddedLibrary).mockReturnValue(null);
    }
  });
  it("shows the title and the loading cover until the video plays", () => {
    const { video } = setup(movie());
    expect(
      screen.getByRole("dialog", { name: "Reproduciendo Big Buck Bunny" }),
    ).toBeTruthy();
    expect(document.querySelector(".player")).toHaveAttribute(
      "data-status",
      "loading",
    );
    expect(screen.getByRole("status").textContent).toContain("Cargando");
    expect(video.getAttribute("src")).toBe("http://media.test/bunny.mp4");
  });

  it("reports the first start and switches to the playing state", () => {
    const { video, onStarted } = setup(movie());
    fireEvent.playing(video);
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".player")).toHaveAttribute(
      "data-status",
      "playing",
    );
    expect(screen.getByRole("button", { name: "Pausar" })).toBeTruthy();
    fireEvent.pause(video);
    fireEvent.playing(video);
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("offers Stremio's fast profile for a file above its limit, and opens the torrent again with it", async () => {
    const service = "http://127.0.0.1:11470";
    const hash = "f015156e0a766402900ae7a006fba36af3a4df0c";
    const url = `${service}/${hash}/3`;
    const base = movie();
    const playing: Playing = {
      ...base,
      stream: {
        addonName: "Demo",
        addonUrl: base.addonUrl,
        infoHash: hash,
        fileIdx: 3,
      },
      url,
      externalUrl: url,
      transcodeUrl: `${service}/hlsv2/x/master.m3u8?mediaURL=${encodeURIComponent(url)}`,
      torrentEngine: "service",
      // 75 GB in 155 minutes: about 7.7 MB/s against the default profile's 3.5.
      fileSize: 75_260_000_000,
    };
    vi.mocked(probe).mockResolvedValueOnce({
      format: { name: "mov,mp4,m4a,3gp,3g2,mj2", duration: 9300 },
      streams: [
        { track: "video", codec: "h264" },
        { track: "audio", codec: "aac" },
      ],
    });
    vi.mocked(torrentProfile).mockResolvedValueOnce("default");
    vi.mocked(setTorrentProfile).mockResolvedValueOnce();
    vi.mocked(removeTorrent).mockResolvedValueOnce();
    vi.mocked(prepareTorrent).mockResolvedValueOnce({
      url,
      fileIdx: 3,
      subtitles: [],
    });
    setup(playing);
    await act(async () => {});
    expect(screen.getByText(/necesita unos 7[.,]7 MB\/s/)).toBeTruthy();
    const loads = vi.mocked(HTMLMediaElement.prototype.load).mock.calls.length;
    fireEvent.click(
      screen.getByRole("button", { name: "Usar el perfil «Rápido»" }),
    );
    await act(async () => {});
    expect(setTorrentProfile).toHaveBeenCalledWith(service, "fast");
    expect(removeTorrent).toHaveBeenCalledWith(service, hash);
    expect(prepareTorrent).toHaveBeenCalledWith(
      service,
      playing.stream,
      undefined,
    );
    expect(
      vi.mocked(HTMLMediaElement.prototype.load).mock.calls.length,
    ).toBeGreaterThan(loads);
    expect(screen.queryByText(/necesita unos/)).toBeNull();
  });

  it("reads the chapters of the file only once it plays", () => {
    vi.mocked(readMkvChapters).mockClear();
    const { video } = setup(movie());
    expect(readMkvChapters).not.toHaveBeenCalled();
    fireEvent.playing(video);
    expect(readMkvChapters).toHaveBeenCalledTimes(1);
    fireEvent.pause(video);
    fireEvent.playing(video);
    expect(readMkvChapters).toHaveBeenCalledTimes(1);
  });

  it("explains a decoding error, offers the alternatives and reports the failure", () => {
    const { video, onFailed } = setup(movie());
    Object.defineProperty(video, "error", {
      value: { code: 3, message: "" },
      configurable: true,
    });
    fireEvent.error(video);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("No se puede reproducir aquí");
    expect(alert.textContent).toContain("HEVC");
    expect(
      screen.getByRole("button", { name: /reproductor externo/ }),
    ).toBeTruthy();
    expect(onFailed).toHaveBeenCalledWith(expect.stringContaining("HEVC"));
    // Without a conversion URL there is nothing to convert with.
    expect(screen.queryByRole("button", { name: /Convertir/ })).toBeNull();
  });

  it("reports a failure once even when reporting it re-renders the parent with a new callback", () => {
    // In the desktop app, recording the failure writes to storage, whose status re-renders the
    // whole app, so the player receives a new `onFailed` on every report. Reporting again on each
    // new callback looped forever and froze the window. Capped so a regression fails instead of hanging.
    const reports = vi.fn();
    function Parent() {
      const [, setWrites] = useState(0);
      return (
        <Player
          playing={movie()}
          onClose={() => {}}
          onFailed={(message) => {
            reports(message);
            if (reports.mock.calls.length < 20) setWrites((count) => count + 1);
          }}
        />
      );
    }
    render(<Parent />);
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "error", {
      value: { code: 4, message: "" },
      configurable: true,
    });
    act(() => {
      fireEvent.error(video);
    });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(reports).toHaveBeenCalledTimes(1);
  });

  it("offers to download mpv when the file cannot be decoded and the machine has no libmpv, then plays with it", async () => {
    const onEmbedded = vi.fn();
    const { video } = setup(movie(), { onEmbedded });
    Object.defineProperty(video, "error", {
      value: { code: 3, message: "" },
      configurable: true,
    });
    video.currentTime = 12;
    fireEvent.error(video);
    expect(
      screen.queryByRole("button", { name: /Reproducir con mpv integrado/ }),
    ).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Descargar mpv y reproducir (29 MB)",
      }),
    );
    await waitFor(() => expect(onEmbedded).toHaveBeenCalledTimes(1));
    expect(installLibmpv).toHaveBeenCalledTimes(1);
    expect(onEmbedded).toHaveBeenCalledWith(12);
  });

  it("hands a file it cannot open to embedded mpv at once, from the saved position, when there is a libmpv", async () => {
    vi.mocked(useEmbeddedLibrary).mockReturnValue("C:/mpv/libmpv-2.dll");
    try {
      const onEmbedded = vi.fn();
      const { video } = setup(
        { ...movie(), resume: 95, unsupported: ["contenedor AVI"] },
        { onEmbedded },
      );
      await act(async () => {});
      expect(onEmbedded).toHaveBeenCalledTimes(1);
      expect(onEmbedded).toHaveBeenCalledWith(95);
      // The file is not loaded in the built-in player meanwhile.
      expect(video.getAttribute("src")).toBeNull();
    } finally {
      vi.mocked(useEmbeddedLibrary).mockReturnValue(null);
    }
  });

  it("without a libmpv or a conversion, explains why and offers to download mpv as the main action", async () => {
    const onEmbedded = vi.fn();
    setup({ ...movie(), unsupported: ["contenedor AVI"] }, { onEmbedded });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("contenedor AVI");
    const download = await screen.findByRole("button", {
      name: "Descargar mpv y reproducir (29 MB)",
    });
    expect(download.className).toContain("primary");
    expect(onEmbedded).not.toHaveBeenCalled();
  });

  it("starts with the conversion when the file cannot be opened and Stremio Service is there", () => {
    const canPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = (type: string) =>
      type.includes("mpegurl") ? "maybe" : "";
    try {
      const transcodeUrl =
        "http://127.0.0.1:11470/hlsv2/x/master.m3u8?mediaURL=a";
      const onEmbedded = vi.fn();
      const { video } = setup(
        { ...movie(), transcodeUrl, unsupported: ["contenedor AVI"] },
        { onEmbedded },
      );
      expect(video.getAttribute("src")).toBe(transcodeUrl);
      expect(document.querySelector(".player-loading")?.textContent).toContain(
        "contenedor AVI",
      );
      expect(onEmbedded).not.toHaveBeenCalled();
    } finally {
      HTMLMediaElement.prototype.canPlayType = canPlayType;
    }
  });

  it("reads the file's tracks itself and hands a DTS-only file to mpv without Stremio Service", async () => {
    vi.mocked(useEmbeddedLibrary).mockReturnValue("C:/mpv/libmpv-2.dll");
    vi.mocked(probeFile).mockResolvedValueOnce({
      format: { name: "matroska,webm", duration: 20 },
      streams: [
        { id: 0, track: "video", codec: "h264" },
        { id: 0, track: "audio", codec: "dts", channels: 6 },
      ],
      reads: 1,
    });
    try {
      const onEmbedded = vi.fn();
      setup({ ...movie(), resume: 40 }, { onEmbedded });
      await act(async () => {});
      expect(probeFile).toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
      expect(onEmbedded).toHaveBeenCalledWith(40);
    } finally {
      vi.mocked(useEmbeddedLibrary).mockReturnValue(null);
    }
  });

  it("inspects a torrent again once the player has read its header, when the first read timed out", async () => {
    vi.mocked(useEmbeddedLibrary).mockReturnValue("C:/mpv/libmpv-2.dll");
    vi.mocked(probeFile)
      .mockRejectedValueOnce(new Error("El addon no respondió a tiempo."))
      .mockResolvedValueOnce({
        format: { name: "matroska,webm" },
        streams: [{ track: "audio", codec: "dts" }],
        reads: 1,
      });
    try {
      const onEmbedded = vi.fn();
      const { video } = setup(movie(), { onEmbedded });
      await act(async () => {});
      expect(onEmbedded).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.loadedMetadata(video);
      });
      expect(probeFile).toHaveBeenCalledTimes(2);
      expect(onEmbedded).toHaveBeenCalledTimes(1);
    } finally {
      vi.mocked(useEmbeddedLibrary).mockReturnValue(null);
    }
  });

  it("replaces an early codec error with a dismissible hint once the video starts", async () => {
    vi.mocked(probeFile).mockResolvedValueOnce({
      format: { name: "matroska,webm" },
      streams: [
        { track: "video", codec: "h264" },
        { track: "audio", codec: "dts" },
      ],
      reads: 1,
    });
    const { video, onStarted } = setup(movie(), { onEmbedded: vi.fn() });
    expect((await screen.findByRole("alert")).textContent).toContain("audio DTS");

    fireEvent.playing(video);
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/no decodifica parte de este archivo/)).toBeTruthy();
    expect(document.querySelector(".player")).toHaveAttribute("data-status", "playing");

    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(screen.queryByText(/no decodifica parte de este archivo/)).toBeNull();
    fireEvent.pause(video);
    fireEvent.playing(video);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/no decodifica parte de este archivo/)).toBeNull();
  });

  it("offers mpv without stopping a file that already plays in silence, when there is no libmpv", async () => {
    let finish: (
      value: Awaited<ReturnType<typeof probeFile>>,
    ) => void = () => {};
    vi.mocked(probeFile).mockReturnValueOnce(
      new Promise((resolve) => (finish = resolve)),
    );
    const { video } = setup(movie(), { onEmbedded: vi.fn() });
    Object.defineProperty(video, "readyState", {
      value: 4,
      configurable: true,
    });
    fireEvent.playing(video);
    await act(async () => {
      finish({
        format: { name: "matroska,webm" },
        streams: [
          { track: "video", codec: "h264" },
          { track: "audio", codec: "truehd" },
        ],
        reads: 1,
      });
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByText(
        /no decodifica parte de este archivo \(audio TRUEHD, ninguna pista de audio compatible\)/,
      ),
    ).toBeTruthy();
    expect(
      await screen.findByRole("button", {
        name: "Descargar mpv y reproducir (29 MB)",
      }),
    ).toBeTruthy();
  });

  it("keeps a file that plays when only an unused track is foreign", async () => {
    vi.mocked(probeFile).mockResolvedValueOnce({
      format: { name: "matroska,webm" },
      streams: [
        { track: "video", codec: "h264" },
        { track: "audio", codec: "aac" },
        { track: "audio", codec: "dts" },
      ],
      reads: 1,
    });
    const onEmbedded = vi.fn();
    const { video } = setup(movie(), { onEmbedded });
    Object.defineProperty(video, "readyState", {
      value: 4,
      configurable: true,
    });
    fireEvent.playing(video);
    await act(async () => {});
    expect(onEmbedded).not.toHaveBeenCalled();
    expect(screen.queryByText(/no decodifica parte/)).toBeNull();
  });

  it("tells a dead link apart from a format problem, and then only offers another source", async () => {
    vi.mocked(requestRange).mockRejectedValueOnce(
      new Error("El addon respondió con HTTP 404."),
    );
    const { video } = setup(movie(), { onEmbedded: vi.fn() });
    Object.defineProperty(video, "error", {
      value: { code: 4, message: "" },
      configurable: true,
    });
    fireEvent.error(video);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("HTTP 404"),
    );
    expect(requestRange).toHaveBeenLastCalledWith(
      "http://media.test/bunny.mp4",
      0,
      1,
    );
    expect(screen.queryByRole("button", { name: /mpv/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /reproductor externo/ }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Elegir otra fuente" }),
    ).toBeTruthy();
  });

  it("does not offer the download where there is no way to switch to mpv", async () => {
    const { video } = setup(movie());
    Object.defineProperty(video, "error", {
      value: { code: 3, message: "" },
      configurable: true,
    });
    fireEvent.error(video);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /Descargar mpv/ })).toBeNull();
  });

  it("starts with the file and switches to the conversion when the inspection finds a track it cannot decode", async () => {
    vi.mocked(probe).mockResolvedValueOnce({
      format: { name: "matroska,webm" },
      streams: [
        { track: "video", codec: "hevc" },
        { track: "audio", codec: "aac" },
      ],
    });
    // WebView2 plays HLS natively, so the conversion becomes the element's source.
    const canPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = (type: string) =>
      type.includes("mpegurl") ? "maybe" : "";
    try {
      const transcodeUrl =
        "http://127.0.0.1:11470/hlsv2/x/master.m3u8?mediaURL=http%3A%2F%2Fmedia.test%2Fbunny.mp4";
      const { video } = setup({ ...movie(), transcodeUrl });
      expect(video.getAttribute("src")).toBe("http://media.test/bunny.mp4");
      await act(async () => {});
      expect(video.getAttribute("src")).toBe(transcodeUrl);
      expect(document.querySelector(".player-loading")?.textContent).toContain(
        "vídeo HEVC",
      );
    } finally {
      HTMLMediaElement.prototype.canPlayType = canPlayType;
    }
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
    expect(
      screen.getByRole("button", { name: "Siguiente episodio: T1 · E2" }),
    ).toBeTruthy();
    fireEvent.keyDown(window, { key: "n" });
    expect(onNext).toHaveBeenCalledWith(episodes[1]);
  });

  it("shows the next-episode card when the video ends", () => {
    const onNext = vi.fn();
    const { video } = setup(series(), { onNext });
    act(() => {
      fireEvent.ended(video);
    });
    expect(document.querySelector(".player")).toHaveAttribute(
      "data-status",
      "ended",
    );
    const card = screen.getByRole("region", { name: "Siguiente episodio" });
    expect(card.textContent).toContain("Segundo");
    fireEvent.click(screen.getByRole("button", { name: /Ver ahora/ }));
    expect(onNext).toHaveBeenCalledWith(episodes[1]);
  });
});
