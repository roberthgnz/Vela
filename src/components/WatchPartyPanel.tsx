import { useEffect, useRef, useState, type FormEvent } from "react";
import { Copy, Crown, LogOut, Send, Users } from "lucide-react";
import { t, type MessageKey } from "../lib/i18n";
import { storage } from "../lib/storage";
import { useProfiles } from "../lib/profiles";
import { formatCode, normalizeCode, type PeerStatus } from "../lib/watchParty/protocol";
import {
  DEFAULT_RELAY,
  NAME_KEY,
  party,
  partyName,
  RELAY_KEY,
  relayAddress,
  useWatchParty,
  type PartySnapshot,
} from "../lib/watchParty/client";
import { episodeText } from "./player/shared";

const statusKey: Record<PeerStatus, MessageKey> = {
  idle: "party.status.idle",
  loading: "party.status.loading",
  buffering: "party.status.buffering",
  ready: "party.status.ready",
};

function errorText(error: PartySnapshot["error"]): string {
  switch (error) {
    case "not-found":
      return t("party.error.notFound");
    case "full":
      return t("party.error.full");
    case "version":
      return t("party.error.version");
    case "relay":
      return t("party.error.relay");
    default:
      return t("party.error.generic");
  }
}

/** The name people see: the one used last time, or the profile's. */
function useDefaultName(): string {
  const state = useProfiles();
  const profile = state.profiles.find((item) => item.id === state.active);
  return partyName(profile?.name ?? "");
}

/**
 * Creating or joining a watch party, and the room once inside: its code, who is in it, what it is
 * watching and the chat. Shown in a dialog from the sidebar and in a popover inside the player.
 */
export function WatchPartyPanel({ onCopied }: { onCopied?: (message: string) => void }) {
  const snapshot = useWatchParty();
  return snapshot.phase === "idle" ? <PartyStart /> : <PartyRoom snapshot={snapshot} onCopied={onCopied} />;
}

function PartyStart() {
  const defaultName = useDefaultName();
  const [name, setName] = useState(defaultName);
  const [code, setCode] = useState("");
  const [relay, setRelay] = useState(() => storage.getItem(RELAY_KEY) ?? "");
  const [invalid, setInvalid] = useState(false);
  const needsRelay = !relayAddress() && !relay.trim();
  const remember = () => {
    const value = name.trim();
    if (value) storage.setItem(NAME_KEY, value);
    if (relay.trim()) storage.setItem(RELAY_KEY, relay.trim());
    else storage.removeItem(RELAY_KEY);
  };
  const join = (event: FormEvent) => {
    event.preventDefault();
    if (!normalizeCode(code)) return setInvalid(true);
    remember();
    party.join(code, name || t("party.guest"));
  };
  return (
    <div className="party-panel">
      <p className="party-lead">{t("party.lead")}</p>
      <label className="party-field">
        <span>{t("party.yourName")}</span>
        <input
          className="input"
          value={name}
          maxLength={32}
          placeholder={t("party.guest")}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <button
        className="button primary"
        disabled={needsRelay}
        onClick={() => {
          remember();
          party.create(name || t("party.guest"));
        }}
      >
        <Users size={15} /> {t("party.create")}
      </button>
      <div className="party-or">{t("party.or")}</div>
      <form className="party-join" onSubmit={join}>
        <input
          className="input"
          value={code}
          aria-label={t("party.code")}
          aria-invalid={invalid || undefined}
          placeholder="ABCDE-FGHJK"
          spellCheck={false}
          autoCapitalize="characters"
          onChange={(event) => {
            setCode(event.target.value);
            setInvalid(false);
          }}
        />
        <button className="button secondary" type="submit" disabled={needsRelay || !code.trim()}>
          {t("party.join")}
        </button>
      </form>
      {invalid && <p className="party-error">{t("party.error.code")}</p>}
      <details className="party-relay" open={needsRelay}>
        <summary>{t("party.relay")}</summary>
        <input
          className="input"
          value={relay}
          placeholder={DEFAULT_RELAY || "wss://vela-party.example.workers.dev"}
          spellCheck={false}
          onChange={(event) => setRelay(event.target.value)}
        />
        <p>{needsRelay ? t("party.relayMissing") : t("party.relayHint")}</p>
      </details>
    </div>
  );
}

function PartyRoom({ snapshot, onCopied }: { snapshot: PartySnapshot; onCopied?: (message: string) => void }) {
  const [text, setText] = useState("");
  const list = useRef<HTMLOListElement>(null);
  const code = snapshot.code ? formatCode(snapshot.code) : "";
  useEffect(() => {
    party.setChatOpen(true);
    return () => party.setChatOpen(false);
  }, []);
  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [snapshot.chat.length]);

  if (snapshot.phase === "error")
    return (
      <div className="party-panel">
        <p className="party-error" role="alert">{errorText(snapshot.error)}</p>
        <button className="button secondary" onClick={() => party.leave()}>
          {t("common.back")}
        </button>
      </div>
    );

  const media = snapshot.media;
  const send = (event: FormEvent) => {
    event.preventDefault();
    party.say(text);
    setText("");
  };
  return (
    <div className="party-panel">
      <div className="party-code">
        <div>
          <span>{snapshot.host ? t("party.youHost") : t("party.youGuest")}</span>
          <strong>{code}</strong>
        </div>
        <button
          className="player-icon party-copy"
          aria-label={t("party.copyCode")}
          title={t("party.copyCode")}
          onClick={() =>
            void navigator.clipboard.writeText(code).then(
              () => onCopied?.(t("party.copied")),
              () => undefined,
            )
          }
        >
          <Copy size={16} />
        </button>
      </div>
      {snapshot.phase !== "connected" ? (
        <p className="party-lead" role="status">
          {snapshot.phase === "reconnecting" ? t("party.reconnecting") : t("party.connecting")}
        </p>
      ) : (
        <p className="party-lead">
          {media
            ? t("party.watching", {
                name: [media.meta.name, episodeText(media.episode)].filter(Boolean).join(" · "),
              })
            : snapshot.host
              ? t("party.hostPick")
              : t("party.waitingHost")}
        </p>
      )}
      <ul className="party-peers" aria-label={t("party.people")}>
        {snapshot.peers.map((peer) => (
          <li key={peer.id} data-status={peer.status}>
            <span className="party-dot" aria-hidden="true" />
            <span className="party-name">
              {peer.name}
              {peer.id === snapshot.you ? ` (${t("party.you")})` : ""}
            </span>
            {peer.host && <Crown size={12} aria-label={t("party.host")} />}
            <span className="party-peer-status">{t(statusKey[peer.status])}</span>
          </li>
        ))}
      </ul>
      <ol className="party-chat" ref={list} aria-label={t("party.chat")} aria-live="polite">
        {snapshot.chat.map((message) => (
          <li key={message.id} className={message.from === snapshot.you ? "own" : ""}>
            <strong>{message.name}</strong> <span>{message.text}</span>
          </li>
        ))}
      </ol>
      <form className="party-say" onSubmit={send}>
        <input
          className="input"
          value={text}
          maxLength={500}
          aria-label={t("party.message")}
          placeholder={t("party.messagePlaceholder")}
          disabled={snapshot.phase !== "connected"}
          onChange={(event) => setText(event.target.value)}
        />
        <button className="player-icon" type="submit" aria-label={t("party.send")} disabled={!text.trim() || snapshot.phase !== "connected"}>
          <Send size={16} />
        </button>
      </form>
      <button className="button subtle party-leave" onClick={() => party.leave()}>
        <LogOut size={14} /> {t("party.leave")}
      </button>
    </div>
  );
}
