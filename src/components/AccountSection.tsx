import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, KeyRound, Link2, LogOut, RefreshCw, ShieldCheck } from "lucide-react";
import { account, useAccount } from "../lib/account";
import { createLink, readLink, type LinkCode } from "../lib/stremioApi";
import { openExternal } from "../lib/transport";
import { errorMessage } from "../lib/utils";
import { Segmented, Spinner } from "./Primitives";

function relative(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "hace un momento";
  if (minutes < 60) return `hace ${minutes} min`;
  return new Date(at).toLocaleString("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function LinkSignIn({ notify }: { notify: (message: string) => void }) {
  const [code, setCode] = useState<LinkCode | null>(null);
  const [status, setStatus] = useState<"idle" | "waiting" | "expired" | "error">("idle");
  const [error, setError] = useState("");
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
            notify("Cuenta de Stremio vinculada.");
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
          <img src={code.qrcode} alt={`Código QR para ${code.link}`} width={112} height={112} />
          <div>
            <span className="settings-row-label">Aprueba el acceso en el navegador</span>
            <p>
              Se ha abierto <strong>{code.link}</strong>. Inicia sesión allí con tu cuenta de Stremio o escanea el código con el móvil. Vela detectará la aprobación automáticamente.
            </p>
            <div className="link-actions">
              <span className="status">
                <Spinner size={13} /> Esperando aprobación · código <strong>{code.code}</strong>
              </span>
              <button className="button subtle small" onClick={() => void openExternal(code.link)}>
                Abrir de nuevo <ExternalLink size={12} />
              </button>
              <button className="button subtle small" onClick={() => { setCode(null); setStatus("idle"); }}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="link-start">
          <p>
            Recomendado. Abre la página oficial de Stremio en tu navegador; tu contraseña no pasa por Vela.
          </p>
          <button className="button primary" onClick={() => void start()}>
            <Link2 size={15} /> Vincular con el navegador
          </button>
          {status === "expired" && <span className="status error">El código caducó. Genera uno nuevo.</span>}
          {status === "error" && <span className="status error">{error}</span>}
        </div>
      )}
    </div>
  );
}

function PasswordSignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const submit = useMutation({ mutationFn: () => account.signInWithPassword(email, password) });
  return (
    <form
      className="account-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit.mutate();
      }}
    >
      <label className="field-label" htmlFor="stremio-email">Correo electrónico</label>
      <input
        id="stremio-email"
        className="input"
        type="email"
        autoComplete="username"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <label className="field-label" htmlFor="stremio-password">Contraseña</label>
      <input
        id="stremio-password"
        className="input"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      {submit.isError && <p className="form-error" role="alert">{errorMessage(submit.error)}</p>}
      <div>
        <button className="button primary" type="submit" disabled={submit.isPending || !email || !password}>
          {submit.isPending ? <Spinner /> : <KeyRound size={15} />} Iniciar sesión
        </button>
      </div>
      <p className="field-hint">
        Se envía solo a api.strem.io. Vela guarda la clave de sesión en el Administrador de credenciales de Windows, nunca la contraseña.
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
          <span className="status"><Spinner size={13} /> Comprobando la sesión</span>
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
            <p>Cuenta de Stremio conectada. La sesión se guarda en el Administrador de credenciales de Windows.</p>
          </div>
          <button
            className="button subtle"
            onClick={() =>
              void account.signOut().then(
                () => notify("Sesión cerrada. Tu biblioteca local se conserva."),
                (error) => notify(errorMessage(error)),
              )
            }
          >
            <LogOut size={14} /> Cerrar sesión
          </button>
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-label">Biblioteca y progreso</span>
            <p>
              Se combinan en ambos sentidos: para cada título gana el cambio más reciente. Al iniciar Vela y al cerrar el reproductor se sincroniza automáticamente.
            </p>
            <div className="field-status" aria-live="polite">
              {state.syncing ? (
                <span className="status"><Spinner size={13} /> Sincronizando…</span>
              ) : state.error ? (
                <span className="status error">{state.error}</span>
              ) : last ? (
                <span className="status ok">
                  <CheckCircle2 size={14} /> Sincronizado {relative(last.at)} · {last.pulled} recibidos · {last.pushed} enviados
                  {last.removed ? ` · ${last.removed} eliminados` : ""}
                </span>
              ) : (
                <span className="status">Aún no sincronizado</span>
              )}
            </div>
          </div>
          <button className="button secondary" disabled={state.syncing} onClick={() => void account.sync()}>
            <RefreshCw size={14} className={state.syncing ? "spin" : ""} /> Sincronizar ahora
          </button>
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-label">Addons de la cuenta</span>
            <p>Puedes instalar en Vela los addons de tu cuenta desde la sección Addons, pestaña «Cuenta Stremio». Vela no modifica la colección de addons de tu cuenta.</p>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="settings-card">
      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-row-label">Modo local</span>
          <p>La biblioteca, el progreso y los addons se guardan solo en este equipo. Conecta tu cuenta de Stremio para sincronizar biblioteca y progreso.</p>
          {state.error && <span className="status error">{state.error}</span>}
        </div>
      </div>
      <div className="settings-row stacked">
        <Segmented
          label="Método de inicio de sesión"
          value={method}
          onChange={setMethod}
          options={[
            { value: "link", label: <span className="segment-text"><ShieldCheck size={14} /> Navegador</span> },
            { value: "password", label: <span className="segment-text"><KeyRound size={14} /> Correo y contraseña</span> },
          ]}
        />
        {method === "link" ? <LinkSignIn notify={notify} /> : <PasswordSignIn />}
      </div>
    </div>
  );
}
