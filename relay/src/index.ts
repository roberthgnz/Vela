import { DurableObject } from "cloudflare:workers";
import {
  CHAT_HISTORY,
  controlState,
  initialState,
  MAX_MESSAGE_BYTES,
  MAX_PEERS,
  normalizeCode,
  parseClientMessage,
  PROTOCOL_VERSION,
  type ChatMessage,
  type ErrorCode,
  type Peer,
  type PeerStatus,
  type PlaybackState,
  type ServerMessage,
} from "../../src/lib/watchParty/protocol.ts";

type Env = { ROOMS: DurableObjectNamespace<PartyRoom> };

/** What the room keeps between messages; it survives the object being evicted while idle. */
type RoomData = {
  /** SHA-256 of the host's key; a room without it was never created and cannot be joined. */
  hostKeyHash?: string;
  state: PlaybackState;
  media: unknown;
  chat: ChatMessage[];
};

/** Kept on each socket, so the peer list survives hibernation. */
type Attachment = { id: string; joined: boolean; name: string; host: boolean; status: PeerStatus };

/** An empty room is forgotten this long after its last peer leaves. */
const IDLE_TTL_MS = 2 * 60 * 60 * 1000;
/** Messages per second a peer may send (with a burst of twice as many). */
const RATE = 20;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * One watch party. Clients connect with a WebSocket (hibernation API: an idle room costs nothing);
 * the room relays play, pause, seek and speed changes stamped with its own clock, the title the host
 * shares, the peer list and the chat.
 */
export class PartyRoom extends DurableObject<Env> {
  private data: RoomData = { state: initialState, media: null, chat: [] };
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<RoomData>("room");
      if (saved) this.data = saved;
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected a WebSocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    const attachment: Attachment = { id: crypto.randomUUID().slice(0, 8), joined: false, name: "", host: false, status: "idle" };
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE_BYTES) return this.fail(ws, "bad-request");
    const self = ws.deserializeAttachment() as Attachment;
    if (!this.allowed(self.id)) return;
    const message = parseClientMessage(raw);
    if (!message) return this.fail(ws, "bad-request");

    if (!self.joined) {
      if (message.t !== "hello") return this.fail(ws, "bad-request");
      if (message.v !== PROTOCOL_VERSION) return this.fail(ws, "version");
      if (this.peers().length >= MAX_PEERS) return this.fail(ws, "full");
      const keyHash = message.hostKey ? await sha256(message.hostKey) : undefined;
      if (!this.data.hostKeyHash) {
        // Only the host creates a room: a mistyped code does not open an empty one.
        if (!keyHash) return this.fail(ws, "not-found");
        this.data.hostKeyHash = keyHash;
        await this.persist();
      }
      const joined: Attachment = {
        ...self,
        joined: true,
        name: message.name || "Guest",
        host: keyHash === this.data.hostKeyHash,
      };
      ws.serializeAttachment(joined);
      await this.ctx.storage.deleteAlarm();
      this.send(ws, {
        t: "welcome",
        v: PROTOCOL_VERSION,
        you: joined.id,
        host: joined.host,
        peers: this.peers(),
        state: this.data.state,
        media: this.data.media,
        chat: this.data.chat,
      });
      this.broadcast({ t: "peers", peers: this.peers() }, ws);
      return;
    }

    switch (message.t) {
      case "hello":
        return;
      case "ping":
        return this.send(ws, { t: "pong", c: message.c, s: Date.now() });
      case "control":
        this.data.state = controlState(this.data.state, message, Date.now(), self.id);
        await this.persist();
        return this.broadcast({ t: "state", state: this.data.state });
      case "media":
        if (!self.host) return this.send(ws, { t: "error", code: "forbidden" });
        this.data.media = message.media;
        this.data.state = controlState(this.data.state, message, Date.now(), self.id);
        await this.persist();
        return this.broadcast({ t: "media", media: this.data.media, state: this.data.state });
      case "status":
        if (self.status === message.status) return;
        ws.serializeAttachment({ ...self, status: message.status });
        return this.broadcast({ t: "peers", peers: this.peers() });
      case "chat": {
        const chat: ChatMessage = { id: crypto.randomUUID().slice(0, 8), from: self.id, name: self.name, text: message.text, at: Date.now() };
        this.data.chat = [...this.data.chat, chat].slice(-CHAT_HISTORY);
        await this.persist();
        return this.broadcast({ t: "chat", message: chat });
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {
      // Already closed.
    }
    await this.left(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.left(ws);
  }

  async alarm(): Promise<void> {
    if (this.open().length === 0) {
      await this.ctx.storage.deleteAll();
      this.data = { state: initialState, media: null, chat: [] };
    }
  }

  private async left(ws: WebSocket): Promise<void> {
    const self = ws.deserializeAttachment() as Attachment | null;
    if (self) this.buckets.delete(self.id);
    this.broadcast({ t: "peers", peers: this.peers(ws) }, ws);
    if (this.open(ws).length === 0) await this.ctx.storage.setAlarm(Date.now() + IDLE_TTL_MS);
  }

  private open(except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => socket !== except && socket.readyState === WebSocket.OPEN);
  }

  private peers(except?: WebSocket): Peer[] {
    return this.open(except)
      .map((socket) => socket.deserializeAttachment() as Attachment)
      .filter((peer) => peer.joined)
      .map(({ id, name, host, status }) => ({ id, name, host, status }));
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // The socket closed meanwhile; its close handler updates the others.
    }
  }

  private broadcast(message: ServerMessage, except?: WebSocket): void {
    const text = JSON.stringify(message);
    for (const socket of this.open(except)) {
      if (!(socket.deserializeAttachment() as Attachment).joined) continue;
      try {
        socket.send(text);
      } catch {
        // See `send`.
      }
    }
  }

  private fail(ws: WebSocket, code: ErrorCode): void {
    this.send(ws, { t: "error", code });
    try {
      ws.close(4000, code);
    } catch {
      // Already closed.
    }
  }

  /** Token bucket per peer: floods are dropped instead of relayed to everyone. */
  private allowed(id: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(id) ?? { tokens: RATE * 2, at: now };
    bucket.tokens = Math.min(RATE * 2, bucket.tokens + ((now - bucket.at) / 1000) * RATE);
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    this.buckets.set(id, bucket);
    return true;
  }

  private persist(): Promise<void> {
    return this.ctx.storage.put("room", this.data);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response("Vela watch party relay\n", { headers: { "content-type": "text/plain" } });
    const match = /^\/rooms\/([^/]+)$/.exec(url.pathname);
    const code = match ? normalizeCode(decodeURIComponent(match[1]!)) : "";
    if (!code) return new Response("Not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected a WebSocket", { status: 426 });
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
