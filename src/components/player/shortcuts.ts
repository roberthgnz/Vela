import { useEffect, useRef } from "react";
import { typing } from "./shared";

/** What the player can do from the keyboard; the component binds these to its state. */
export type ShortcutActions = {
  /** Escape: close the open panel, leave fullscreen, or close the player (in that order). */
  escape: () => void;
  togglePlay: () => void;
  seekBy: (seconds: number) => void;
  volumeBy: (delta: number) => void;
  toggleMute: () => void;
  toStart: () => void;
  toEnd: () => void;
  /** One frame back or forward while paused. */
  frameStep: (direction: -1 | 1) => void;
  speedStep: (direction: -1 | 1) => void;
  toggleFullscreen: () => void;
  cycleSubtitles: () => void;
  delayBy: (seconds: number) => void;
  cycleAudio: () => void;
  nextEpisode: () => void;
  skipSegment: () => void;
  /** 0–9: jump to that tenth of the video. */
  seekToTenth: (tenth: number) => void;
};

export type ShortcutContext = {
  seekShort: number;
  seekLong: number;
  paused: boolean;
  hasDuration: boolean;
  /** More than one audio track to cycle through. */
  canCycleAudio: boolean;
  canSkip: boolean;
  hasNext: boolean;
};

/**
 * YouTube-style shortcuts. They work wherever the focus is while the player is open (after a
 * click on the video the focus is on the dialog, not inside the player); on the seek and volume
 * sliders the arrows keep their player meaning instead of moving the slider by a hair. Inside a
 * popover, Space, Enter and the arrows stay with the focused control. Returns whether the key
 * was handled.
 */
export function handleShortcut(event: KeyboardEvent, context: ShortcutContext, actions: ShortcutActions): boolean {
  const target = event.target as HTMLElement | null;
  if (event.ctrlKey || event.altKey || event.metaKey || typing(target)) return false;
  const inPanel = Boolean(target?.closest?.(".player-popover"));
  const key = event.key.toLowerCase();
  if (key === "escape") actions.escape();
  else if (inPanel && (key === " " || key === "enter" || key.startsWith("arrow"))) return false;
  else if (key === "enter") return false;
  else if (key === " " || key === "k") actions.togglePlay();
  else if (key === "arrowleft") actions.seekBy(-context.seekShort);
  else if (key === "arrowright") actions.seekBy(context.seekShort);
  else if (key === "j") actions.seekBy(-context.seekLong);
  else if (key === "l") actions.seekBy(context.seekLong);
  else if (key === "arrowup") actions.volumeBy(0.05);
  else if (key === "arrowdown") actions.volumeBy(-0.05);
  else if (key === "m") actions.toggleMute();
  else if (key === "home") actions.toStart();
  else if (key === "end" && context.hasDuration) actions.toEnd();
  else if ((key === "," || key === ".") && context.paused) actions.frameStep(key === "," ? -1 : 1);
  else if (key === "<" || key === ">") actions.speedStep(key === "<" ? -1 : 1);
  else if (key === "f") actions.toggleFullscreen();
  else if (key === "c") actions.cycleSubtitles();
  else if (key === "g") actions.delayBy(-(event.shiftKey ? 1 : 0.1));
  else if (key === "h") actions.delayBy(event.shiftKey ? 1 : 0.1);
  else if (key === "a" && context.canCycleAudio) actions.cycleAudio();
  else if (key === "n" && context.hasNext) actions.nextEpisode();
  else if (key === "s" && context.canSkip) actions.skipSegment();
  else if (/^[0-9]$/.test(key) && context.hasDuration) actions.seekToTenth(Number(key));
  else return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

/** Listens for keys on the window in the capture phase: the player's keys win over the app's while it is open. */
export function usePlayerShortcuts(onKeyDown: (event: KeyboardEvent) => void) {
  const keys = useRef(onKeyDown);
  keys.current = onKeyDown;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);
}
