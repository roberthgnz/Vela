import { useEffect, useState } from "react";
import { t } from "../lib/i18n";
import {
  libmpvInfo,
  removeLibmpv,
  useEmbeddedLibrary,
  useVideoPlayer,
  videoPlayer,
  type LibmpvInfo,
} from "../lib/embeddedMpv";
import { LibmpvInstall } from "./LibmpvInstall";
import { Segmented } from "./Primitives";

/** Settings › Reproducción: the built-in player (default) or mpv inside Vela's window. */
export function VideoPlayerRow() {
  const choice = useVideoPlayer();
  const library = useEmbeddedLibrary();
  const missing = library === null;
  const [info, setInfo] = useState<LibmpvInfo | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void libmpvInfo().then((value) => active && setInfo(value));
    return () => {
      active = false;
    };
  }, [library]);
  // Only what Vela downloaded can be removed here: never Stremio's or mpv's own library.
  const downloaded = Boolean(info?.path && info.path === library);
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-row-label">{t("mpv.embedded.setting")}</span>
        <p>
          {library === undefined
            ? t("mpv.embedded.settingHint")
            : missing
              ? t("mpv.embedded.missing")
              : t("mpv.embedded.found", { path: library })}
        </p>
        {missing && info && (
          <p>{t("mpv.install.hint", { size: Math.round(info.size / 1e6), license: info.license })}</p>
        )}
        {removeError && (
          <p className="mpv-install-error" role="alert">
            {removeError}
          </p>
        )}
      </div>
      <div className="settings-row-control">
        <Segmented
          label={t("mpv.embedded.setting")}
          value={missing ? "builtin" : choice}
          onChange={(value) => videoPlayer.set(value)}
          options={[
            { value: "builtin", label: <span className="segment-text">{t("mpv.embedded.builtin")}</span>, title: t("mpv.embedded.builtinTitle") },
            {
              value: "mpv",
              label: <span className="segment-text">{t("mpv.embedded.mpv")}</span>,
              title: t("mpv.embedded.mpvTitle"),
              disabled: missing,
            },
          ]}
        />
        {missing && <LibmpvInstall />}
        {downloaded && (
          <button
            className="button secondary small"
            onClick={() => {
              setRemoveError(null);
              if (videoPlayer.get() === "mpv") videoPlayer.set("builtin");
              removeLibmpv().catch((error: unknown) =>
                setRemoveError(error instanceof Error ? error.message : t("mpv.install.unknown")),
              );
            }}
          >
            {t("mpv.install.remove")}
          </button>
        )}
      </div>
    </div>
  );
}
