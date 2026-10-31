// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/store")>()),
  preferencesStore: { updateProgress: vi.fn(), setWatched: vi.fn(), finishVideo: vi.fn() },
}));

import { preferencesStore } from "../../lib/store";
import type { Playing } from "./shared";
import { useWatchProgress } from "./useWatchProgress";

const store = preferencesStore as unknown as {
  updateProgress: ReturnType<typeof vi.fn>;
  setWatched: ReturnType<typeof vi.fn>;
  finishVideo: ReturnType<typeof vi.fn>;
};

const playing: Playing = {
  meta: { id: "tt1", type: "series", name: "Serie" },
  addonUrl: "http://addon.test/manifest.json",
  videoId: "tt1:1:1",
  stream: { addonName: "Demo", addonUrl: "http://addon.test/manifest.json", url: "http://media.test/e1.mp4" },
  url: "http://media.test/e1.mp4",
  externalUrl: "http://media.test/e1.mp4",
  serviceUrl: "http://127.0.0.1:11470",
  resume: 0,
};
const next = { id: "tt1:1:2", season: 1, episode: 2 };

function element(currentTime: number, duration = 100): HTMLVideoElement {
  return { currentTime, duration, seeking: false } as unknown as HTMLVideoElement;
}

describe("useWatchProgress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    store.updateProgress.mockReset();
    store.setWatched.mockReset();
    store.finishVideo.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  function setup(current = element(0)) {
    const video = { current };
    const { result } = renderHook(() => useWatchProgress(playing, next, video));
    return { result, video };
  }

  it("saves the position with the video's id and duration, not without a duration", () => {
    const { result } = setup();
    result.current.save(element(42));
    expect(store.updateProgress).toHaveBeenCalledWith(playing.meta, playing.addonUrl, {
      videoId: "tt1:1:1",
      seconds: 42,
      duration: 100,
      updatedAt: 100_000,
    });
    result.current.save(element(1, Number.NaN));
    expect(store.updateProgress).toHaveBeenCalledTimes(1);
  });

  it("saves while playing at most every five seconds", () => {
    const { result } = setup();
    result.current.onTimeUpdate(element(1));
    result.current.onTimeUpdate(element(2));
    expect(store.updateProgress).toHaveBeenCalledTimes(1);
    vi.setSystemTime(105_100);
    result.current.onTimeUpdate(element(3));
    expect(store.updateProgress).toHaveBeenCalledTimes(2);
  });

  it("marks the video watched after most of it was actually watched, seeks excluded", () => {
    const { result } = setup();
    // Jumping from 10 s to 80 s is a seek: it adds nothing.
    result.current.onTimeUpdate(element(10));
    result.current.onTimeUpdate(element(80));
    for (let t = 80.25; t <= 95; t += 0.25) result.current.onTimeUpdate(element(t));
    expect(store.setWatched).not.toHaveBeenCalled();
    // Watching 60 more seconds in small steps crosses 70 % of 100 s.
    for (let t = 20; t <= 80; t += 0.25) result.current.onTimeUpdate(element(t));
    expect(store.setWatched).toHaveBeenCalledTimes(1);
    expect(store.setWatched).toHaveBeenCalledWith(playing.meta, playing.addonUrl, ["tt1:1:1"], true);
    // Once is enough.
    for (let t = 80; t <= 99; t += 0.25) result.current.onTimeUpdate(element(t));
    expect(store.setWatched).toHaveBeenCalledTimes(1);
  });

  it("finishes once, pointing at the next episode, and stops saving afterwards", () => {
    const { result } = setup();
    result.current.finish();
    result.current.finish();
    expect(store.setWatched).toHaveBeenCalledTimes(1);
    expect(store.finishVideo).toHaveBeenCalledTimes(1);
    expect(store.finishVideo).toHaveBeenCalledWith(playing.meta, playing.addonUrl, "tt1:1:1", "tt1:1:2");
    result.current.save(element(99));
    expect(store.updateProgress).not.toHaveBeenCalled();
    // Seeking back before the credits reopens the video.
    result.current.onSeeking(element(50));
    result.current.save(element(50));
    expect(store.updateProgress).toHaveBeenCalledTimes(1);
  });

  it("treats leaving during the credits as finishing, but not earlier", () => {
    const early = setup(element(80));
    early.result.current.finishIfDone();
    expect(store.finishVideo).not.toHaveBeenCalled();
    const late = setup(element(95));
    late.result.current.finishIfDone();
    expect(store.finishVideo).toHaveBeenCalledTimes(1);
  });
});
