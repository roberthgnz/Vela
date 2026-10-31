import { useEffect, useState } from "react";

/**
 * Seconds left before the next episode starts on its own once the current one has ended; `null`
 * when there is no countdown (no next episode, dismissed, disabled, or still playing). Reaching
 * zero is the caller's cue to start it.
 */
export function useNextCountdown(options: { ended: boolean; available: boolean; dismissed: boolean; autoNext: boolean; seconds: number }) {
  const { ended, available, dismissed, autoNext, seconds } = options;
  const [countdown, setCountdown] = useState<number | null>(null);
  useEffect(() => {
    if (!ended || !available || dismissed || !autoNext || seconds <= 0) {
      setCountdown(null);
      return;
    }
    setCountdown(seconds);
    const timer = setInterval(() => setCountdown((value) => (value === null ? null : value - 1)), 1000);
    return () => clearInterval(timer);
  }, [autoNext, available, dismissed, ended, seconds]);
  return countdown;
}
