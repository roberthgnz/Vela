import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * Transient feedback over the video: the short text that confirms a shortcut («+10 s»), the big
 * play/pause icon when playback is toggled, and the idle state that hides the controls while the
 * video plays.
 */
export function useOverlay(video: RefObject<HTMLVideoElement | null>) {
  const [idle, setIdle] = useState(false);
  const [flash, setFlash] = useState("");
  /** `id` restarts the animation when the same icon is shown twice in a row. */
  const [pulse, setPulse] = useState<{ kind: "play" | "pause"; id: number } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const showFlash = useCallback((value: string) => {
    setFlash(value);
    setTimeout(() => setFlash((current) => (current === value ? "" : current)), 900);
  }, []);

  const showPulse = useCallback((kind: "play" | "pause") => {
    const id = Date.now();
    setPulse({ kind, id });
    setTimeout(() => setPulse((current) => (current?.id === id ? null : current)), 700);
  }, []);

  /** Shows the controls and hides them again after a moment of stillness while playing. */
  const wake = useCallback(() => {
    setIdle(false);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!video.current?.paused) setIdle(true);
    }, 2600);
  }, [video]);

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  return { idle, setIdle, flash, showFlash, pulse, showPulse, wake };
}
