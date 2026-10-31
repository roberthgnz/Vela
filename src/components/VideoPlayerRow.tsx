import { t } from "../lib/i18n";
import { useEmbeddedLibrary, useVideoPlayer, videoPlayer } from "../lib/embeddedMpv";
import { Segmented } from "./Primitives";

/** Settings › Reproducción: the built-in player (default) or mpv inside Vela's window. */
export function VideoPlayerRow() {
  const choice = useVideoPlayer();
  const library = useEmbeddedLibrary();
  const missing = library === null;
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
      </div>
    </div>
  );
}
