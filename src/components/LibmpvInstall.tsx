import { Download, MonitorPlay } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  cancelLibmpvInstall,
  installLibmpv,
  libmpvInfo,
  type LibmpvInfo,
  type LibmpvProgress,
} from "../lib/embeddedMpv";
import { t } from "../lib/i18n";

/**
 * Downloads the libmpv that embedded mpv needs, when the machine has none. The button is the
 * user's consent; the file is checked against the SHA-256 pinned in the app before it is used.
 * `play` is the variant in the player's error panel: it carries on with mpv once it is there.
 */
export function LibmpvInstall({ play = false, onDone }: { play?: boolean; onDone?: () => void }) {
  const [info, setInfo] = useState<LibmpvInfo | null>(null);
  const [progress, setProgress] = useState<LibmpvProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void libmpvInfo().then((value) => mounted.current && setInfo(value));
    return () => {
      mounted.current = false;
    };
  }, []);

  if (!info) return null;
  const megabytes = Math.round(info.size / 1e6);

  const start = () => {
    cancelled.current = false;
    setError(null);
    setProgress({ stage: "download", downloaded: 0, total: info.size });
    installLibmpv((value) => mounted.current && setProgress(value)).then(
      () => {
        if (!mounted.current) return;
        setProgress(null);
        onDone?.();
      },
      (failure: unknown) => {
        if (!mounted.current) return;
        setProgress(null);
        if (!cancelled.current) setError(failure instanceof Error ? failure.message : t("mpv.install.unknown"));
      },
    );
  };

  if (progress) {
    const percent = progress.total > 0 ? Math.min(100, (progress.downloaded / progress.total) * 100) : 0;
    const label =
      progress.stage === "download"
        ? t("mpv.install.downloading", { percent: Math.floor(percent) })
        : progress.stage === "unpack"
          ? t("mpv.install.unpacking")
          : t("mpv.install.checking");
    return (
      <div className="mpv-install">
        <div
          className="download-bar"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress.stage === "download" ? Math.round(percent) : undefined}
        >
          <span style={{ width: `${progress.stage === "download" ? percent : 100}%` }} />
        </div>
        <span className="mpv-install-status">{label}</span>
        {progress.stage === "download" && (
          <button
            className="button subtle small"
            onClick={() => {
              cancelled.current = true;
              cancelLibmpvInstall();
            }}
          >
            {t("common.cancel")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mpv-install">
      <button className={`button ${play ? "primary" : "secondary"} small`} onClick={start}>
        {play ? <MonitorPlay size={14} /> : <Download size={14} />}
        {play ? t("mpv.install.getAndPlay", { size: megabytes }) : t("mpv.install.button", { size: megabytes })}
      </button>
      {error && (
        <p className="mpv-install-error" role="alert">
          {t("mpv.install.failed", { error })}
        </p>
      )}
    </div>
  );
}
