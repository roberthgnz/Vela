// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AWAY_AFTER, useOverlay } from "./useOverlay";

function setup(paused = false) {
  const video = { current: { paused } as HTMLVideoElement };
  return renderHook(() => useOverlay(video));
}

describe("useOverlay", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("adds up seeks in the same direction while the meter is on screen", () => {
    const { result } = setup();
    act(() => result.current.showHud({ kind: "seek", seconds: 10 }));
    act(() => result.current.showHud({ kind: "seek", seconds: 10 }));
    act(() => result.current.showHud({ kind: "seek", seconds: 10 }));
    expect(result.current.hud).toMatchObject({ kind: "seek", seconds: 30 });
    // Changing direction starts a new count.
    act(() => result.current.showHud({ kind: "seek", seconds: -5 }));
    expect(result.current.hud).toMatchObject({ kind: "seek", seconds: -5 });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.hud).toBeNull();
  });

  it("starts a new count once the meter has gone", () => {
    const { result } = setup();
    act(() => result.current.showHud({ kind: "seek", seconds: 10 }));
    act(() => vi.advanceTimersByTime(1000));
    act(() => result.current.showHud({ kind: "seek", seconds: 10 }));
    expect(result.current.hud).toMatchObject({ seconds: 10 });
  });

  it("replaces a seek count with the volume meter", () => {
    const { result } = setup();
    act(() => result.current.showHud({ kind: "seek", seconds: 10 }));
    act(() => result.current.showHud({ kind: "volume", value: 0.4 }));
    expect(result.current.hud).toMatchObject({ kind: "volume", value: 0.4 });
  });

  it("hides the controls while playing and reports stillness after a while, until woken", () => {
    const { result } = setup();
    act(() => result.current.wake());
    act(() => vi.advanceTimersByTime(2600));
    expect(result.current.idle).toBe(true);
    expect(result.current.still).toBe(false);
    act(() => vi.advanceTimersByTime(AWAY_AFTER - 2600));
    expect(result.current.still).toBe(true);
    act(() => result.current.wake());
    expect(result.current).toMatchObject({ idle: false, still: false });
  });

  it("keeps the controls while paused, but still reports stillness", () => {
    const { result } = setup(true);
    act(() => result.current.wake());
    act(() => vi.advanceTimersByTime(AWAY_AFTER));
    expect(result.current).toMatchObject({ idle: false, still: true });
  });
});
