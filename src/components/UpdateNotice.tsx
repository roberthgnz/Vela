import { Download, RefreshCw, X } from "lucide-react";
import { updates, useUpdates } from "../lib/updates";
import { Spinner } from "./Primitives";

function megabytes(bytes: number): string {
  return `${(bytes / 1048576).toLocaleString("es", { maximumFractionDigits: 1 })} MB`;
}

/** Announces a new version and shows the download while it installs. */
export function UpdateNotice() {
  const state = useUpdates();
  const installing = state.status === "installing";
  const failed = state.status === "error" && state.info;
  if (!state.info || (state.status !== "available" && !installing && !failed)) return null;
  if (state.status === "available" && state.dismissed === state.info.version) return null;
  const { downloaded = 0, total } = state.progress ?? {};
  const percent = total ? Math.min(100, Math.round((downloaded / total) * 100)) : undefined;
  return (
    <section className="update-notice" aria-label="Actualización disponible" role="status">
      <div className="update-heading">
        <strong>Vela {state.info.version} disponible</strong>
        {!installing && (
          <button className="icon-button" aria-label="Recordar más tarde" title="Más tarde" onClick={() => updates.dismiss()}>
            <X size={14} />
          </button>
        )}
      </div>
      {installing ? (
        <>
          <span className="update-detail">
            {percent === undefined ? `Descargando… ${megabytes(downloaded)}` : `Descargando… ${percent} % de ${megabytes(total!)}`}
          </span>
          <span className="update-progress" aria-hidden="true">
            <span style={{ width: `${percent ?? 0}%` }} />
          </span>
          <span className="update-detail">Vela se cerrará para instalarla y se abrirá de nuevo.</span>
        </>
      ) : (
        <>
          <span className="update-detail">
            {failed ? state.error : `Tienes la ${state.info.current}. La descarga se verifica con la firma de Vela antes de instalarse.`}
          </span>
          <div className="update-actions">
            <button className="button primary small" onClick={() => void (failed ? updates.retry() : updates.install())}>
              {failed ? <RefreshCw size={14} /> : <Download size={14} />}
              {failed ? "Reintentar" : "Instalar y reiniciar"}
            </button>
            <button className="button subtle small" onClick={() => updates.dismiss()}>
              Más tarde
            </button>
          </div>
        </>
      )}
      {installing && percent === undefined && <Spinner size={13} />}
    </section>
  );
}
