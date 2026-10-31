// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/streamingServer", () => ({ torrentStats: vi.fn() }));

import { torrentStats } from "../../lib/streamingServer";
import { useSlowWait, useTorrentSwarm } from "./useWaiting";

const stats = (downloaded: number, speed: number) => ({ downloaded, speed, peers: 4, unchoked: 1, uploaded: 0, uploadSpeed: 0 });

describe("useSlowWait", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports a long wait and resets when the wait restarts or ends", () => {
    const { result, rerender } = renderHook(({ waiting, since }: { waiting: boolean; since: number }) => useSlowWait(waiting, since), {
      initialProps: { waiting: true, since: 1 },
    });
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(15_000));
    expect(result.current).toBe(true);
    rerender({ waiting: true, since: 2 });
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(14_000));
    expect(result.current).toBe(false);
    rerender({ waiting: false, since: 2 });
    act(() => vi.advanceTimersByTime(20_000));
    expect(result.current).toBe(false);
  });
});

describe("useTorrentSwarm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(torrentStats).mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("polls while waiting and flags a swarm that stops sending data", async () => {
    vi.mocked(torrentStats).mockResolvedValue(stats(100, 0) as never);
    const { result } = renderHook(() => useTorrentSwarm("abc", "http://127.0.0.1:11470", true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    // First reading: data arrived (downloaded grew from nothing), so not stalled.
    expect(result.current.swarm?.stats.downloaded).toBe(100);
    expect(result.current.starved).toBe(false);
    // The same total again and again: stalled, and after 20 s starved.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.swarm?.stalledSince).toBeDefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_100);
    });
    expect(result.current.starved).toBe(true);
    // Data again: no longer stalled.
    vi.mocked(torrentStats).mockResolvedValue(stats(900, 5000) as never);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.starved).toBe(false);
    expect(vi.mocked(torrentStats).mock.calls.length).toBeGreaterThan(5);
  });

  it("does nothing without a torrent or once the video plays", () => {
    const { rerender } = renderHook(
      ({ hash, waiting }: { hash?: string; waiting: boolean }) => useTorrentSwarm(hash, "http://127.0.0.1:11470", waiting),
      { initialProps: { hash: undefined as string | undefined, waiting: true } },
    );
    act(() => vi.advanceTimersByTime(5000));
    rerender({ hash: "abc", waiting: false });
    act(() => vi.advanceTimersByTime(5000));
    expect(torrentStats).not.toHaveBeenCalled();
  });
});
