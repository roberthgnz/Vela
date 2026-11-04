import type { PlaybackState } from "./protocol";

/** While playing, a video this far from the room's position is moved to it. */
export const PLAYING_DRIFT = 1.5;
/** While paused, everyone should stop on the same frame (within this). */
export const PAUSED_DRIFT = 0.3;
/** A local change smaller than this is not a change (timer jitter, decoding latency). */
export const ECHO_TOLERANCE = 0.75;

export type LocalPlayback = { paused: boolean; time: number; rate: number; duration?: number };

/** Where the room's video is at `serverNow` (relay clock, ms), within the video's length. */
export function expectedPosition(state: PlaybackState, serverNow: number, duration?: number): number {
  const elapsed = state.paused ? 0 : Math.max(0, serverNow - state.updatedAt) / 1000;
  const position = state.position + elapsed * state.rate;
  return duration && Number.isFinite(duration) && duration > 0 ? Math.min(position, duration) : position;
}

/**
 * Whether the local video disagrees with the room: the user played, paused, seeked or changed the
 * speed. The echoes of changes applied from the room agree with it and are not sent back.
 */
export function differs(local: LocalPlayback, state: PlaybackState, serverNow: number): boolean {
  if (local.paused !== state.paused || Math.abs(local.rate - state.rate) > 0.01) return true;
  return Math.abs(local.time - expectedPosition(state, serverNow, local.duration)) > ECHO_TOLERANCE;
}

export type Correction = { play?: boolean; pause?: boolean; seek?: number; rate?: number };

/** What to do to the local video so it follows the room (nothing, when it already does). */
export function correction(local: LocalPlayback, state: PlaybackState, serverNow: number): Correction {
  const out: Correction = {};
  if (Math.abs(local.rate - state.rate) > 0.01) out.rate = state.rate;
  if (state.paused && !local.paused) out.pause = true;
  if (!state.paused && local.paused) out.play = true;
  const target = expectedPosition(state, serverNow, local.duration);
  const drift = Math.abs(local.time - target);
  if (drift > (state.paused ? PAUSED_DRIFT : PLAYING_DRIFT)) out.seek = target;
  return out;
}

export function isEmpty(value: Correction): boolean {
  return value.play === undefined && value.pause === undefined && value.seek === undefined && value.rate === undefined;
}

/**
 * Offset between this machine's clock and the relay's, from ping/pong round trips. The sample with
 * the shortest round trip is the most accurate (its one-way delays are the most symmetric).
 */
export class ClockOffset {
  private samples: { rtt: number; offset: number }[] = [];

  /** `sent` and `received` are local times (ms); `server` is the relay's time in its answer. */
  add(sent: number, server: number, received: number): void {
    const rtt = Math.max(0, received - sent);
    this.samples = [...this.samples, { rtt, offset: server - (sent + rtt / 2) }].slice(-8);
  }

  get offset(): number {
    if (!this.samples.length) return 0;
    return this.samples.reduce((best, sample) => (sample.rtt < best.rtt ? sample : best)).offset;
  }

  reset(): void {
    this.samples = [];
  }
}
