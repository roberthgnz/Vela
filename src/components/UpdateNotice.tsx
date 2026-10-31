import { Download, RefreshCw, X } from "lucide-react";
import { updates, useUpdates } from "../lib/updates";
import { Spinner } from "./Primitives";
import { formatNumber, t } from "../lib/i18n";

function megabytes(bytes: number): string {
  return `${formatNumber(bytes / 1048576, { maximumFractionDigits: 1 })} MB`;
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
    <section className="update-notice" aria-label={t("update.available")} role="status">
      <div className="update-heading">
        <strong>{t("update.title", { version: state.info.version })}</strong>
        {!installing && (
          <button className="icon-button" aria-label={t("update.remindLater")} title={t("update.later")} onClick={() => updates.dismiss()}>
            <X size={14} />
          </button>
        )}
      </div>
      {installing ? (
        <>
          <span className="update-detail">
            {percent === undefined ? t("update.downloading", { size: megabytes(downloaded) }) : t("update.downloadingPercent", { percent, size: megabytes(total!) })}
          </span>
          <span className="update-progress" aria-hidden="true">
            <span style={{ width: `${percent ?? 0}%` }} />
          </span>
          <span className="update-detail">{t("update.restartNotice")}</span>
        </>
      ) : (
        <>
          <span className="update-detail">
            {failed ? state.error : t("update.current", { version: state.info.current })}
          </span>
          <div className="update-actions">
            <button className="button primary small" onClick={() => void (failed ? updates.retry() : updates.install())}>
              {failed ? <RefreshCw size={14} /> : <Download size={14} />}
              {failed ? t("common.retry") : t("update.install")}
            </button>
            <button className="button subtle small" onClick={() => updates.dismiss()}>
              {t("update.later")}
            </button>
          </div>
        </>
      )}
      {installing && percent === undefined && <Spinner size={13} />}
    </section>
  );
}
