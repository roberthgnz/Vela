import { useCallback, useEffect, useRef, type RefObject } from "react";
import { party, useWatchParty, type PartySnapshot } from "../../lib/watchParty/client";
import { mediaId, partyMediaId, toPartyMedia } from "../../lib/watchParty/share";
import { correction, differs, expectedPosition } from "../../lib/watchParty/sync";
import type { Playing, Status } from "./shared";

/** How long a local change is trusted over the room's state until the relay confirms it. */
const CONFIRM_MS = 1500;

/**
 * Keeps the built-in player in step with the watch party room. The room holds one playback state;
 * any peer's play, pause, seek or speed change replaces it, and every peer moves its video to it.
 *
 * - The host shares its video (title and release, never the URL) once it starts playing.
 * - A peer watching the room's video follows it: no autoplay, the room's position instead of the
 *   saved one, and a check every second that corrects drift.
 * - The element's own events tell what the user did; changes applied from the room agree with it
 *   and are not sent back (see `differs`).
 */
export function useWatchPartySync({
  video,
  playing,
  status,
  begun,
  setRate,
  onBlocked,
}: {
  video: RefObject<HTMLVideoElement | null>;
  playing: Playing;
  status: Status;
  begun: boolean;
  setRate: (rate: number) => void;
  onBlocked: () => void;
}) {
  const snapshot = useWatchParty();
  const key = mediaId(playing.meta.type, playing.meta.id, playing.videoId);
  const isActive = useCallback(
    (state: PartySnapshot) => state.phase === "connected" && Boolean(state.media) && partyMediaId(state.media!) === key,
    [key],
  );
  const active = isActive(snapshot);
  /** The room's video is this one since the player opened: it follows the room from the start. */
  const followsFromStart = useRef(active);
  const synced = useRef(false);
  const pendingUntil = useRef(0);
  const appliedSeq = useRef(-1);
  const callbacks = useRef({ setRate, onBlocked });
  callbacks.current = { setRate, onBlocked };

  // The host shares what it plays as soon as the video starts.
  const connected = snapshot.phase === "connected";
  const roomKey = snapshot.media ? partyMediaId(snapshot.media) : undefined;
  useEffect(() => {
    if (!connected || !snapshot.host || !begun || roomKey === key) return;
    const element = video.current;
    party.share(toPartyMedia(playing), element?.paused ?? false, element?.currentTime ?? 0, element?.playbackRate ?? 1);
    synced.current = true;
    pendingUntil.current = performance.now() + CONFIRM_MS;
  }, [connected, snapshot.host, begun, roomKey, key, playing, video]);

  const reconcile = useCallback(() => {
    const element = video.current;
    const current = party.getSnapshot();
    if (!element || !isActive(current) || element.readyState < 1 || element.seeking) return;
    if (performance.now() < pendingUntil.current) return;
    const state = current.state;
    const now = party.serverNow();
    const duration = Number.isFinite(element.duration) ? element.duration : undefined;
    const fix = correction(
      { paused: element.paused, time: element.currentTime, rate: element.playbackRate, duration },
      state,
      now,
    );
    const order = state.seq !== appliedSeq.current;
    appliedSeq.current = state.seq;
    // A finished video stays finished while the room is at its end too.
    if (element.ended && duration && expectedPosition(state, now, duration) >= duration - 1) {
      synced.current = true;
      return;
    }
    // Drift while this video waits for data is the network's, not an order: seeking would only
    // restart the wait. A new order (play, pause, seek) is applied anyway.
    if (!order && element.readyState < 3 && !element.paused) delete fix.seek;
    if (fix.rate !== undefined) {
      element.playbackRate = fix.rate;
      callbacks.current.setRate(fix.rate);
    }
    if (fix.seek !== undefined) element.currentTime = fix.seek;
    if (fix.pause) element.pause();
    if (fix.play) void element.play().catch(() => callbacks.current.onBlocked());
    synced.current = true;
  }, [isActive, video]);

  // New orders from the room, and a drift check every second.
  const seq = snapshot.state.seq;
  const confirmed = snapshot.state.by !== undefined && snapshot.state.by === snapshot.you;
  useEffect(() => {
    if (confirmed) pendingUntil.current = 0;
    if (active) reconcile();
  }, [active, seq, confirmed, reconcile]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(reconcile, 1000);
    return () => clearInterval(timer);
  }, [active, reconcile]);

  // What the user does to this video goes to the room.
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const onLocal = () => {
      const current = party.getSnapshot();
      if (!isActive(current) || !synced.current || element.ended || element.readyState < 1) return;
      const local = {
        paused: element.paused,
        time: element.currentTime,
        rate: element.playbackRate,
        duration: Number.isFinite(element.duration) ? element.duration : undefined,
      };
      if (!differs(local, current.state, party.serverNow())) return;
      party.control(local.paused, local.time, local.rate);
      pendingUntil.current = performance.now() + CONFIRM_MS;
    };
    const events = ["play", "pause", "seeked", "ratechange"] as const;
    for (const name of events) element.addEventListener(name, onLocal);
    element.addEventListener("canplay", reconcile);
    element.addEventListener("loadedmetadata", reconcile);
    return () => {
      for (const name of events) element.removeEventListener(name, onLocal);
      element.removeEventListener("canplay", reconcile);
      element.removeEventListener("loadedmetadata", reconcile);
    };
  }, [isActive, reconcile, video]);

  // Everyone sees who is still loading or buffering.
  useEffect(() => {
    if (!active) return;
    party.status(status === "loading" ? "loading" : status === "buffering" ? "buffering" : "ready");
  }, [active, status]);
  useEffect(
    () => () => {
      if (party.getSnapshot().phase === "connected") party.status("idle");
    },
    [],
  );

  return {
    /** Connected to a room that is watching this video. */
    active,
    /** The room decides when this video plays (no autoplay of its own). */
    following: active && followsFromStart.current,
    /** Where to start when the room is watching this video, instead of the saved position. */
    startPosition(): number | undefined {
      const current = party.getSnapshot();
      if (!isActive(current) || !followsFromStart.current) return undefined;
      return expectedPosition(current.state, party.serverNow());
    },
  };
}
