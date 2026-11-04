import { useSyncExternalStore } from "react";
import { log } from "../log";
import { storage } from "../storage";
import {
  initialState,
  MAX_CHAT,
  newHostKey,
  newRoomCode,
  normalizeCode,
  PROTOCOL_VERSION,
  type ChatMessage,
  type ClientMessage,
  type ErrorCode,
  type Peer,
  type PeerStatus,
  type PlaybackState,
  type ServerMessage,
} from "./protocol";
import { parsePartyMedia, type PartyMedia } from "./share";
import { ClockOffset } from "./sync";

export const RELAY_KEY = "vela.party.relay";
export const NAME_KEY = "vela.party.name";

/** Vela's public relay (`relay/`, deployed on Cloudflare Workers). */
export const PUBLIC_RELAY = "wss://vela-party.reliutg.workers.dev";

/**
 * The relay Vela uses unless the watch party panel names another one. `VITE_WATCH_PARTY_RELAY`
 * overrides it at build time; a development build talks to `wrangler dev` (see `relay/`).
 */
export const DEFAULT_RELAY: string =
  import.meta.env.VITE_WATCH_PARTY_RELAY || (import.meta.env.DEV ? "ws://127.0.0.1:8787" : PUBLIC_RELAY);

export function relayAddress(): string {
  return storage.getItem(RELAY_KEY)?.trim() || DEFAULT_RELAY;
}

/** `wss://host/rooms/CODE` for a relay written as http(s), ws(s) or a bare host. */
export function roomUrl(relay: string, code: string): string {
  let base = relay.trim().replace(/\/+$/, "");
  if (!/^[a-z]+:\/\//i.test(base)) base = `wss://${base}`;
  base = base.replace(/^http(s?):\/\//i, (_, secure: string) => `ws${secure}://`);
  const url = new URL(`${base}/rooms/${code}`);
  if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error("The relay must be a ws(s) or http(s) address.");
  return url.href;
}

export type PartyPhase = "idle" | "connecting" | "connected" | "reconnecting" | "error";

export type PartySnapshot = {
  phase: PartyPhase;
  /** Room code without the dash (see `formatCode`). */
  code?: string;
  host: boolean;
  you?: string;
  peers: Peer[];
  state: PlaybackState;
  media?: PartyMedia;
  chat: ChatMessage[];
  /** Messages that arrived while the chat was closed. */
  unread: number;
  error?: ErrorCode | "network" | "relay";
};

const idle: PartySnapshot = { phase: "idle", host: false, peers: [], state: initialState, chat: [], unread: 0 };

/** Errors after which reconnecting would fail the same way. */
const FATAL: readonly string[] = ["not-found", "full", "version", "bad-request"];

/**
 * The connection to one watch party room. It lives outside React so it survives the player being
 * mounted again for every source and episode; components read it with `useWatchParty`.
 */
class PartyClient {
  private snapshot: PartySnapshot = idle;
  private listeners = new Set<() => void>();
  private socket?: WebSocket;
  private hostKey?: string;
  private name = "";
  private attempts = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private pings?: ReturnType<typeof setInterval>;
  private clock = new ClockOffset();
  private chatOpen = false;
  /** Increases on every connect and leave; events of an older socket are ignored. */
  private generation = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  /** The relay's clock now, in ms. */
  serverNow(): number {
    return Date.now() + this.clock.offset;
  }

  /** Opens a new room as its host and returns its code. */
  create(name: string): string {
    const code = newRoomCode();
    this.hostKey = newHostKey();
    this.open(code, name);
    return code;
  }

  /** Joins a room by its code (with or without the dash). */
  join(input: string, name: string): boolean {
    const code = normalizeCode(input);
    if (!code) return false;
    this.hostKey = undefined;
    this.open(code, name);
    return true;
  }

  leave(): void {
    this.disconnect();
    this.hostKey = undefined;
    this.set(idle);
  }

  control(paused: boolean, position: number, rate: number): void {
    this.send({ t: "control", paused, position, rate });
  }

  share(media: PartyMedia, paused: boolean, position: number, rate: number): void {
    if (!this.snapshot.host) return;
    this.send({ t: "media", media, paused, position, rate });
  }

  status(status: PeerStatus): void {
    const self = this.snapshot.peers.find((peer) => peer.id === this.snapshot.you);
    if (self?.status !== status) this.send({ t: "status", status });
  }

  say(text: string): void {
    const value = text.trim().slice(0, MAX_CHAT);
    if (value) this.send({ t: "chat", text: value });
  }

  /** While the chat is open its messages count as read. */
  setChatOpen(open: boolean): void {
    this.chatOpen = open;
    if (open && this.snapshot.unread) this.set({ ...this.snapshot, unread: 0 });
  }

  private disconnect(): void {
    this.generation++;
    clearTimeout(this.retry);
    clearInterval(this.pings);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "left");
    this.clock.reset();
  }

  private open(code: string, name: string): void {
    this.disconnect();
    this.name = name.trim().slice(0, 32);
    this.attempts = 0;
    this.set({ ...idle, phase: "connecting", code, host: Boolean(this.hostKey) });
    this.connect();
  }

  private connect(): void {
    const code = this.snapshot.code;
    if (!code) return;
    const generation = ++this.generation;
    let url: string;
    try {
      url = roomUrl(relayAddress(), code);
    } catch (error) {
      log.warn("party: relay address", String(error));
      this.set({ ...this.snapshot, phase: "error", error: "relay" });
      return;
    }
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      if (generation !== this.generation) return;
      this.send({ t: "hello", v: PROTOCOL_VERSION, name: this.name, hostKey: this.hostKey });
    };
    socket.onmessage = (event) => {
      if (generation !== this.generation || typeof event.data !== "string") return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      this.receive(message);
    };
    socket.onclose = () => {
      if (generation !== this.generation) return;
      clearInterval(this.pings);
      if (this.snapshot.phase === "error") return;
      // Network drop: keep the room and try again, backing off up to 15 seconds.
      const delay = Math.min(15_000, 1000 * 2 ** this.attempts++);
      this.set({ ...this.snapshot, phase: "reconnecting" });
      this.retry = setTimeout(() => this.connect(), delay);
    };
  }

  private receive(message: ServerMessage): void {
    const now = Date.now();
    switch (message.t) {
      case "welcome":
        this.attempts = 0;
        this.set({
          ...this.snapshot,
          phase: "connected",
          error: undefined,
          you: message.you,
          host: message.host,
          peers: message.peers,
          state: message.state,
          media: parsePartyMedia(message.media),
          chat: message.chat,
        });
        this.startPings();
        return;
      case "peers":
        return this.set({ ...this.snapshot, peers: message.peers });
      case "state":
        if (message.state.seq < this.snapshot.state.seq) return;
        return this.set({ ...this.snapshot, state: message.state });
      case "media":
        return this.set({ ...this.snapshot, media: parsePartyMedia(message.media), state: message.state });
      case "chat":
        return this.set({
          ...this.snapshot,
          chat: [...this.snapshot.chat, message.message].slice(-100),
          unread: this.chatOpen || message.message.from === this.snapshot.you ? 0 : this.snapshot.unread + 1,
        });
      case "pong":
        this.clock.add(message.c, message.s, now);
        return;
      case "error":
        log.warn("party: relay error", message.code);
        if (FATAL.includes(message.code)) this.set({ ...this.snapshot, phase: "error", error: message.code });
        return;
    }
  }

  private startPings(): void {
    clearInterval(this.pings);
    // A burst first for a quick estimate, then a sample every 15 seconds.
    let tick = 0;
    const ping = () => this.send({ t: "ping", c: Date.now() });
    ping();
    this.pings = setInterval(() => {
      tick++;
      if (tick <= 5 || tick % 50 === 0) ping();
    }, 300);
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private set(next: PartySnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

export const party = new PartyClient();

export function useWatchParty(): PartySnapshot {
  return useSyncExternalStore(party.subscribe, party.getSnapshot);
}

export function partyName(fallback: string): string {
  return storage.getItem(NAME_KEY)?.trim() || fallback;
}
