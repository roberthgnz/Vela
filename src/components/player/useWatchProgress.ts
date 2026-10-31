import { useCallback, useRef, type RefObject } from "react";
import type { Episode } from "../../lib/contracts";
import { CREDITS_THRESHOLD, preferencesStore, WATCHED_THRESHOLD } from "../../lib/store";
import type { Playing } from "./shared";

/** How often the position is written while playing. */
const SAVE_EVERY = 5000;

/**
 * What the player tells the library: the position (every few seconds and when pausing or
 * leaving), the watched mark (after most of the video was actually watched, seeks excluded, as
 * Stremio counts it) and the end of the video (past the credits: the title points to the next
 * episode or leaves «Seguir viendo»).
 */
export function useWatchProgress(playing: Playing, next: Episode | undefined, video: RefObject<HTMLVideoElement | null>) {
  const lastSave = useRef(0);
  const watchedTime = useRef({ last: -1, total: 0, marked: false });
  const finished = useRef(false);

  const save = useCallback(
    (element: HTMLVideoElement) => {
      if (finished.current || !Number.isFinite(element.duration) || element.duration <= 0) return;
      preferencesStore.updateProgress(playing.meta, playing.addonUrl, {
        videoId: playing.videoId,
        seconds: element.currentTime,
        duration: element.duration,
        updatedAt: Date.now(),
      });
    },
    [playing],
  );

  const markWatched = useCallback(() => {
    if (watchedTime.current.marked) return;
    watchedTime.current.marked = true;
    preferencesStore.setWatched(playing.meta, playing.addonUrl, [playing.videoId], true);
  }, [playing]);

  const finish = useCallback(() => {
    if (finished.current) return;
    markWatched();
    finished.current = true;
    preferencesStore.finishVideo(playing.meta, playing.addonUrl, playing.videoId, next?.id);
  }, [markWatched, next, playing]);

  /** Past the credits, leaving counts as finishing the video (as when it ends). */
  const finishIfDone = useCallback(() => {
    const element = video.current;
    if (element && Number.isFinite(element.duration) && element.currentTime > element.duration * CREDITS_THRESHOLD) finish();
  }, [finish, video]);

  /** Counts the time actually watched and saves the position now and then. */
  const onTimeUpdate = useCallback(
    (element: HTMLVideoElement) => {
      const counter = watchedTime.current;
      const step = element.currentTime - counter.last;
      if (counter.last >= 0 && step > 0 && step < 2 && !element.seeking) counter.total += step;
      counter.last = element.currentTime;
      if (Number.isFinite(element.duration) && counter.total > element.duration * WATCHED_THRESHOLD) markWatched();
      if (Date.now() - lastSave.current > SAVE_EVERY) {
        save(element);
        lastSave.current = Date.now();
      }
    },
    [markWatched, save],
  );

  /** A seek is not watching time; seeking back before the credits reopens a finished video. */
  const onSeeking = useCallback((element: HTMLVideoElement) => {
    watchedTime.current.last = element.currentTime;
    if (finished.current && element.currentTime < element.duration * CREDITS_THRESHOLD) finished.current = false;
  }, []);

  return { save, markWatched, finish, finishIfDone, onTimeUpdate, onSeeking };
}
