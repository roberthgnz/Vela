import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, Eye, EyeOff, KeyRound, Link2, LogOut, RefreshCw, ShieldCheck } from "lucide-react";
import { account, useAccount } from "../lib/account";
import { createLink, readLink, type LinkCode } from "../lib/stremioApi";
import { openExternal } from "../lib/transport";
import { errorMessage } from "../lib/utils";
import { Segmented, Spinner } from "./Primitives";
import { formatDateTime, t } from "../lib/i18n";

function relative(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return t("account.justNow");
  if (minutes < 60) return t("account.minutesAgo", { minutes });
  return formatDateTime(at, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function LinkSignIn({ notify }: { notify: (message: string) => void }) {
  const [code, setCode] = useState<LinkCode | null>(null);
  const [status, setStatus] = useState<"idle" | "waiting" | "expired" | "error">("idle");
  const [error, setError] = useState("");
  const startButton = useRef<HTMLButtonElement>(null);
  const cancelled = useRef(false);
  // After cancelling, focus returns to the button that starts the link.
  useEffect(() => {
    if (!code && cancelled.current) {
      cancelled.current = false;
      startButton.current?.focus();
    }
  }, [code]);
  useEffect(() => {
    if (!code) return;
    let stopped = false;
    const started = Date.now();
    const poll = async () => {
      while (!stopped && Date.now() - started < 10 * 60_000) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        if (stopped) return;
        try {
          const key = await readLink(code.code);
          if (key && !stopped) {
            await account.signInWithKey(key);
            notify(t("account.linked"));
            return;
          }
        } catch (cause) {
          if (!stopped) {
            setStatus("error");
            setError(errorMessage(cause));
          }
          return;
        }
      }
      if (!stopped) setStatus("expired");
    };
    void poll();
    return () => {
      stopped = true;
    };
  }, [code, notify]);
  const start = async () => {
    setError("");
    try {
      const created = await createLink();
      setCode(created);
      setStatus("waiting");
      await openExternal(created.link).catch(() => {});
    } catch (cause) {
      setStatus("error");
      setError(errorMessage(cause));
    }
  };
  return (
    <div className="link-signin">
      {code && status === "waiting" ? (
        <div className="link-code">
          <img src={code.qrcode} alt={t("account.qrAlt", { link: code.link })} width={112} height={112} />
          <div>
            <span className="settings-row-label">{t("account.approve")}</span>
            <p>
              {t("account.opened")} <strong>{code.link}</strong>. {t("account.openedHint")}
            </p>
            <div className="link-actions">
              <span className="status">
                <Spinner size={13} /> {t("account.waiting")} <strong>{code.code}</strong>
              </span>
              <button className="button subtle small" onClick={() => void openExternal(code.link)}>
                {t("account.openAgain")} <ExternalLink size={12} />
              </button>
              <button
                className="button subtle small"
                onClick={() => {
                  cancelled.current = true;
                  setCode(null);
                  setStatus("idle");
                }}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="link-start">
          <p>
            {t("account.linkIntro")}
          </p>
          <button className="button primary" ref={startButton} onClick={() => void start()}>
            <Link2 size={15} /> {t("account.linkButton")}
          </button>
          {status === "expired" && <span className="status error">{t("account.expired")}</span>}
          {status === "error" && <span className="status error">{error}</span>}
        </div>
      )}
    </div>
  );
}

function PasswordSignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const submit = useMutation({ mutationFn: () => account.signInWithPassword(email, password) });
  return (
    <form
      className="account-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit.mutate();
      }}
    >
      <label className="field-label" htmlFor="stremio-email">{t("account.email")}</label>
      <input
        id="stremio-email"
        className="input"
        type="email"
        autoComplete="username"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <label className="field-label" htmlFor="stremio-password">{t("account.password")}</label>
      <div className="input-with-action">
        <input
          id="stremio-password"
          className="input"
          type={visible ? "text" : "password"}
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button
          type="button"
          className="icon-button"
          aria-label={visible ? t("account.hidePassword") : t("account.showPassword")}
          aria-pressed={visible}
          title={visible ? t("account.hidePassword") : t("account.showPassword")}
          onClick={() => setVisible(!visible)}
        >
          {visible ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
      {submit.isError && <p className="form-error" role="alert">{errorMessage(submit.error)}</p>}
      <div>
        <button className="button primary" type="submit" disabled={submit.isPending || !email || !password}>
          {submit.isPending ? <Spinner /> : <KeyRound size={15} />} {t("account.signIn")}
        </button>
      </div>
      <p className="field-hint">
        {t("account.passwordHint")}
      </p>
    </form>
  );
}

export function AccountSection({ notify }: { notify: (message: string) => void }) {
  const state = useAccount();
  const [method, setMethod] = useState<"link" | "password">("link");
  if (state.status === "loading")
    return (
      <div className="settings-card">
        <div className="settings-row">
          <span className="status"><Spinner size={13} /> {t("account.checking")}</span>
        </div>
      </div>
    );
  if (state.status === "signed-in" && state.user) {
    const last = state.lastSync;
    return (
      <div className="settings-card">
        <div className="settings-row">
          <span className="account-avatar connected large">{state.user.email.charAt(0).toUpperCase()}</span>
          <div className="settings-row-text">
            <span className="settings-row-label">{state.user.email}</span>
            <p>{t("account.connected")}</p>
          </div>
          <button
            className="button subtle"
            onClick={() =>
              void account.signOut().then(
                () => notify(t("account.signedOut")),
                (error) => notify(errorMessage(error)),
              )
            }
          >
            <LogOut size={14} /> {t("account.signOut")}
          </button>
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-label">{t("account.sync")}</span>
            <p>
              {t("account.syncHint")}
            </p>
            <div className="field-status" aria-live="polite">
              {state.syncing ? (
                <span className="status"><Spinner size={13} /> {t("account.syncing")}</span>
              ) : state.error ? (
                <span className="status error">{state.error}</span>
              ) : last ? (
                <span className="status ok">
                  <CheckCircle2 size={14} /> {t("account.synced", { when: relative(last.at), pulled: last.pulled, pushed: last.pushed })}
                  {last.removed ? t("account.syncedRemoved", { count: last.removed }) : ""}
                </span>
              ) : (
                <span className="status">{t("account.neverSynced")}</span>
              )}
            </div>
          </div>
          <button className="button secondary" disabled={state.syncing} onClick={() => void account.sync()}>
            <RefreshCw size={14} className={state.syncing ? "spin" : ""} /> {t("account.syncNow")}
          </button>
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-label">{t("account.addons")}</span>
            <p>{t("account.addonsHint")}</p>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="settings-card">
      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-row-label">{t("account.local")}</span>
          <p>{t("account.localHint")}</p>
          {state.error && <span className="status error">{state.error}</span>}
        </div>
      </div>
      <div className="settings-row stacked">
        <Segmented
          label={t("account.method")}
          value={method}
          onChange={setMethod}
          options={[
            { value: "link", label: <span className="segment-text"><ShieldCheck size={14} /> {t("account.methodBrowser")}</span> },
            { value: "password", label: <span className="segment-text"><KeyRound size={14} /> {t("account.methodPassword")}</span> },
          ]}
        />
        {method === "link" ? <LinkSignIn notify={notify} /> : <PasswordSignIn />}
      </div>
    </div>
  );
}
