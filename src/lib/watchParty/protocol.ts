/**
 * Messages between Vela and the watch party relay (`relay/`). Both sides import this file, so
 * the desktop app, a browser and the relay agree on one shape. Every message is JSON with a `t`
 * field. The relay only forwards and stamps what clients send; it never sees stream URLs or addon
 * addresses (see `share.ts`).
 */

export const PROTOCOL_VERSION = 1;

/** Alphabet of room codes: none of 0/O, 1/I/L or U, so a code read aloud or typed is hard to get wrong. */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
export const CODE_LENGTH = 10;
export const MAX_PEERS = 12;
export const MAX_NAME = 32;
export const MAX_CHAT = 500;
export const CHAT_HISTORY = 50;
/** Largest message the relay accepts (the shared title, with its episode list, is the big one). */
export const MAX_MESSAGE_BYTES = 96 * 1024;

export type PeerStatus = "idle" | "loading" | "buffering" | "ready";

export type Peer = {
  id: string;
  name: string;
  host: boolean;
  status: PeerStatus;
};

/**
 * Where the room's video is. `position` was true at `updatedAt` (relay clock, ms); while playing it
 * advances at `rate`. `seq` grows with every change so clients can tell a new order from an old one.
 */
export type PlaybackState = {
  paused: boolean;
  position: number;
  rate: number;
  updatedAt: number;
  seq: number;
  /** Peer that made the change. */
  by?: string;
};

export type ChatMessage = {
  id: string;
  from: string;
  name: string;
  text: string;
  at: number;
};

export type ClientMessage =
  | { t: "hello"; v: number; name: string; hostKey?: string }
  | { t: "control"; paused: boolean; position: number; rate: number }
  /** The host shares a new title, with where its own video is (so the room never jumps to 0). */
  | { t: "media"; media: unknown; paused: boolean; position: number; rate: number }
  | { t: "status"; status: PeerStatus }
  | { t: "chat"; text: string }
  | { t: "ping"; c: number };

export type ErrorCode = "not-found" | "full" | "bad-request" | "version" | "forbidden";

export type ServerMessage =
  | {
      t: "welcome";
      v: number;
      you: string;
      host: boolean;
      peers: Peer[];
      state: PlaybackState;
      media: unknown;
      chat: ChatMessage[];
    }
  | { t: "peers"; peers: Peer[] }
  | { t: "state"; state: PlaybackState }
  | { t: "media"; media: unknown; state: PlaybackState }
  | { t: "chat"; message: ChatMessage }
  | { t: "pong"; c: number; s: number }
  | { t: "error"; code: ErrorCode };

export const initialState: PlaybackState = { paused: true, position: 0, rate: 1, updatedAt: 0, seq: 0 };

/** The room's state after `by` played, paused, seeked or changed speed (relay side). */
export function controlState(
  previous: PlaybackState,
  control: { paused: boolean; position: number; rate: number },
  now: number,
  by: string,
): PlaybackState {
  return { paused: control.paused, position: control.position, rate: control.rate, updatedAt: now, seq: previous.seq + 1, by };
}

const STATUSES: readonly PeerStatus[] = ["idle", "loading", "buffering", "ready"];

function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/** Text a person typed: trimmed, without control characters, at most `max` characters. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return [...value.replace(/[\u0000-\u001f\u007f]/g, " ").trim()].slice(0, max).join("");
}

/** The client message in `raw`, or `undefined` when it is not one this protocol defines. */
export function parseClientMessage(raw: string): ClientMessage | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object") return undefined;
  const message = data as Record<string, unknown>;
  switch (message.t) {
    case "hello": {
      if (typeof message.v !== "number") return undefined;
      const hostKey = typeof message.hostKey === "string" && message.hostKey.length <= 128 ? message.hostKey : undefined;
      return { t: "hello", v: message.v, name: cleanText(message.name, MAX_NAME), hostKey };
    }
    case "control":
    case "media": {
      if (
        typeof message.paused !== "boolean" ||
        !finite(message.position, 0, 7 * 24 * 3600) ||
        !finite(message.rate, 0.25, 4)
      )
        return undefined;
      const control = { paused: message.paused, position: message.position, rate: message.rate };
      if (message.t === "control") return { t: "control", ...control };
      return message.media && typeof message.media === "object" ? { t: "media", media: message.media, ...control } : undefined;
    }
    case "status":
      return STATUSES.includes(message.status as PeerStatus) ? { t: "status", status: message.status as PeerStatus } : undefined;
    case "chat": {
      const text = cleanText(message.text, MAX_CHAT);
      return text ? { t: "chat", text } : undefined;
    }
    case "ping":
      return finite(message.c, 0, Number.MAX_SAFE_INTEGER) ? { t: "ping", c: message.c } : undefined;
    default:
      return undefined;
  }
}

/** Upper-case code without separators or look-alike characters, or "" when it cannot be one. */
export function normalizeCode(input: string): string {
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== CODE_LENGTH) return "";
  return [...code].every((char) => CODE_ALPHABET.includes(char)) ? code : "";
}

/** `ABCDE-FGHJK`: the code as people read and share it. */
export function formatCode(code: string): string {
  return code.length === CODE_LENGTH ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
}

function randomFrom(alphabet: string, length: number): string {
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const byte of bytes) {
      if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

/** A new room code (about 49 bits; rooms are short-lived and need the code to join). */
export function newRoomCode(): string {
  return randomFrom(CODE_ALPHABET, CODE_LENGTH);
}

/** The secret that makes its holder the room's host; it never leaves the host's machine but to the relay. */
export function newHostKey(): string {
  return randomFrom("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 32);
}
