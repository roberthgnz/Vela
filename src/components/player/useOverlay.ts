import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** The meter shown over the video for a volume change, or the seconds a seek moved. */
export type Hud =
  | { kind: "volume"; value: number; id: number }
  | { kind: "seek"; seconds: number; id: number };

/** How long the player stays paused and untouched before the pause screen covers it. */
export const AWAY_AFTER = 5000;

/**
 * Transient feedback over the video: the short text that confirms a shortcut («Velocidad 1.5×»),
 * the volume and seek meters, the big play/pause icon when playback is toggled, the idle state
 * that hides the controls while the video plays, and `still`, set after a while without any
 * activity (the pause screen uses it).
 */
export function useOverlay(video: RefObject<HTMLVideoElement | null>) {
  const [idle, setIdle] = useState(false);
  const [still, setStill] = useState(false);
  const [flash, setFlash] = useState("");
  const [hud, setHud] = useState<Hud | null>(null);
  /** `id` restarts the animation when the same icon is shown twice in a row. */
  const [pulse, setPulse] = useState<{ kind: "play" | "pause"; id: number } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const stillTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hudTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const showFlash = useCallback((value: string) => {
    setFlash(value);
    setTimeout(() => setFlash((current) => (current === value ? "" : current)), 900);
  }, []);

  /**
   * Shows a meter. Seeks in the same direction add up while the meter is on screen (three taps
   * on → read «+30 s»), the way phones count double taps.
   */
  const showHud = useCallback((next: { kind: "volume"; value: number } | { kind: "seek"; seconds: number }) => {
    setHud((current) => {
      if (
        next.kind === "seek" &&
        current?.kind === "seek" &&
        Math.sign(current.seconds) === Math.sign(next.seconds)
      )
        return { ...current, seconds: current.seconds + next.seconds };
      return { ...next, id: Date.now() };
    });
    clearTimeout(hudTimer.current);
    hudTimer.current = setTimeout(() => setHud(null), 1000);
  }, []);

  const showPulse = useCallback((kind: "play" | "pause") => {
    const id = Date.now();
    setPulse({ kind, id });
    setTimeout(() => setPulse((current) => (current?.id === id ? null : current)), 700);
  }, []);

  /** Shows the controls and hides them again after a moment of stillness while playing. */
  const wake = useCallback(() => {
    setIdle(false);
    setStill(false);
    clearTimeout(hideTimer.current);
    clearTimeout(stillTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!video.current?.paused) setIdle(true);
    }, 2600);
    stillTimer.current = setTimeout(() => setStill(true), AWAY_AFTER);
  }, [video]);

  useEffect(
    () => () => {
      clearTimeout(hideTimer.current);
      clearTimeout(stillTimer.current);
      clearTimeout(hudTimer.current);
    },
    [],
  );

  return { idle, setIdle, still, flash, showFlash, hud, showHud, pulse, showPulse, wake };
}
