// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { handleShortcut, type ShortcutActions, type ShortcutContext } from "./shortcuts";

function actions(): ShortcutActions {
  return {
    escape: vi.fn(),
    togglePlay: vi.fn(),
    seekBy: vi.fn(),
    volumeBy: vi.fn(),
    toggleMute: vi.fn(),
    toStart: vi.fn(),
    toEnd: vi.fn(),
    frameStep: vi.fn(),
    speedStep: vi.fn(),
    toggleFullscreen: vi.fn(),
    cycleSubtitles: vi.fn(),
    delayBy: vi.fn(),
    cycleAudio: vi.fn(),
    nextEpisode: vi.fn(),
    skipSegment: vi.fn(),
    seekToTenth: vi.fn(),
  };
}

const context: ShortcutContext = {
  seekShort: 5,
  seekLong: 10,
  paused: false,
  hasDuration: true,
  canCycleAudio: true,
  canSkip: true,
  hasNext: true,
};

function press(key: string, init: KeyboardEventInit = {}, target: Element = document.body): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...init });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

describe("handleShortcut", () => {
  it.each<[string, keyof ShortcutActions, unknown[]]>([
    ["Escape", "escape", []],
    [" ", "togglePlay", []],
    ["k", "togglePlay", []],
    ["K", "togglePlay", []],
    ["ArrowLeft", "seekBy", [-5]],
    ["ArrowRight", "seekBy", [5]],
    ["j", "seekBy", [-10]],
    ["l", "seekBy", [10]],
    ["ArrowUp", "volumeBy", [0.05]],
    ["ArrowDown", "volumeBy", [-0.05]],
    ["m", "toggleMute", []],
    ["Home", "toStart", []],
    ["End", "toEnd", []],
    ["<", "speedStep", [-1]],
    [">", "speedStep", [1]],
    ["f", "toggleFullscreen", []],
    ["c", "cycleSubtitles", []],
    ["g", "delayBy", [-0.1]],
    ["h", "delayBy", [0.1]],
    ["a", "cycleAudio", []],
    ["n", "nextEpisode", []],
    ["s", "skipSegment", []],
    ["0", "seekToTenth", [0]],
    ["7", "seekToTenth", [7]],
  ])("%s → %s", (key, action, args) => {
    const bound = actions();
    const event = press(key);
    expect(handleShortcut(event, context, bound)).toBe(true);
    expect(bound[action]).toHaveBeenCalledWith(...args);
    expect(event.defaultPrevented).toBe(true);
  });

  it("moves a whole second with Shift+G / Shift+H", () => {
    const bound = actions();
    handleShortcut(press("G", { shiftKey: true }), context, bound);
    handleShortcut(press("H", { shiftKey: true }), context, bound);
    expect(bound.delayBy).toHaveBeenNthCalledWith(1, -1);
    expect(bound.delayBy).toHaveBeenNthCalledWith(2, 1);
  });

  it("steps frames only while paused", () => {
    const bound = actions();
    expect(handleShortcut(press(","), context, bound)).toBe(false);
    expect(handleShortcut(press("."), { ...context, paused: true }, bound)).toBe(true);
    expect(bound.frameStep).toHaveBeenCalledWith(1);
  });

  it("ignores keys that need something the player does not have", () => {
    const bound = actions();
    const none = { ...context, hasDuration: false, canCycleAudio: false, canSkip: false, hasNext: false };
    for (const key of ["End", "a", "n", "s", "5"]) expect(handleShortcut(press(key), none, bound)).toBe(false);
    expect(bound.toEnd).not.toHaveBeenCalled();
    expect(bound.seekToTenth).not.toHaveBeenCalled();
  });

  it("leaves modified keys, Enter and text fields alone", () => {
    const bound = actions();
    expect(handleShortcut(press("k", { ctrlKey: true }), context, bound)).toBe(false);
    expect(handleShortcut(press("f", { altKey: true }), context, bound)).toBe(false);
    expect(handleShortcut(press("Enter"), context, bound)).toBe(false);
    const field = document.createElement("input");
    expect(handleShortcut(press(" ", {}, field), context, bound)).toBe(false);
    expect(bound.togglePlay).not.toHaveBeenCalled();
    expect(bound.toggleFullscreen).not.toHaveBeenCalled();
  });

  it("lets Space, Enter and the arrows reach the controls inside a popover, but not the letters", () => {
    const panel = document.createElement("div");
    panel.className = "player-popover";
    const option = document.createElement("button");
    panel.append(option);
    document.body.append(panel);
    const bound = actions();
    expect(handleShortcut(press(" ", {}, option), context, bound)).toBe(false);
    expect(handleShortcut(press("ArrowDown", {}, option), context, bound)).toBe(false);
    expect(handleShortcut(press("Enter", {}, option), context, bound)).toBe(false);
    expect(handleShortcut(press("k", {}, option), context, bound)).toBe(true);
    expect(handleShortcut(press("Escape", {}, option), context, bound)).toBe(true);
    expect(bound.volumeBy).not.toHaveBeenCalled();
    expect(bound.togglePlay).toHaveBeenCalledTimes(1);
    panel.remove();
  });
});
