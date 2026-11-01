// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { EmbeddedPlayer } from "./EmbeddedPlayer";
import { openEmbedded, closeEmbedded } from "../lib/embeddedMpv";
import type { Playing } from "./player/shared";

vi.mock("../lib/embeddedMpv", async (original) => ({
  ...(await original<typeof import("../lib/embeddedMpv")>()),
  openEmbedded: vi.fn(async () => {}),
  closeEmbedded: vi.fn(async () => {}),
  onEmbeddedMessage: () => () => {},
  placeEmbedded: vi.fn(async () => {}),
  focusEmbedded: vi.fn(async () => {}),
}));
vi.mock("../lib/protocol", async (original) => ({
  ...(await original<typeof import("../lib/protocol")>()),
  getSubtitles: vi.fn(async () => []),
}));
vi.mock("./WindowControls", () => ({
  useWindowState: () => ({ fullscreen: false }),
  WindowControls: () => null,
  setFullscreen: vi.fn(),
}));

afterEach(cleanup);

it("opens one native session under StrictMode and closes it only on actual unmount", async () => {
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); },
    close(this: HTMLDialogElement) { this.removeAttribute("open"); },
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const playing: Playing = {
    meta: { id: "test", type: "movie", name: "Test" },
    stream: { url: "https://media.test/video.mkv", addonUrl: "https://addon.test/manifest.json", addonName: "Test" },
    addonUrl: "https://addon.test/manifest.json",
    videoId: "test", url: "https://media.test/video.mkv", externalUrl: "https://media.test/video.mkv", serviceUrl: "http://127.0.0.1:11999", resume: 0,
  };
  const view = render(<StrictMode><EmbeddedPlayer playing={playing} onClose={() => {}} /></StrictMode>);
  await act(async () => {});
  expect(openEmbedded).toHaveBeenCalledTimes(1);
  expect(closeEmbedded).not.toHaveBeenCalled();
  view.unmount();
  expect(closeEmbedded).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals();
});
