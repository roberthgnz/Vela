// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNextCountdown } from "./useNextCountdown";

const base = { ended: true, available: true, dismissed: false, autoNext: true, seconds: 3 };

describe("useNextCountdown", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("counts down from the configured seconds once the video has ended", () => {
    const { result } = renderHook(() => useNextCountdown(base));
    expect(result.current).toBe(3);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(2);
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current).toBe(0);
  });

  it("is null while playing, when dismissed, disabled or without a next episode", () => {
    for (const options of [
      { ...base, ended: false },
      { ...base, dismissed: true },
      { ...base, autoNext: false },
      { ...base, available: false },
      { ...base, seconds: 0 },
    ]) {
      const { result, unmount } = renderHook(() => useNextCountdown(options));
      expect(result.current).toBeNull();
      unmount();
    }
  });

  it("stops when the user dismisses it mid-way", () => {
    const { result, rerender } = renderHook((options: typeof base) => useNextCountdown(options), { initialProps: base });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(2);
    rerender({ ...base, dismissed: true });
    expect(result.current).toBeNull();
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBeNull();
  });
});
