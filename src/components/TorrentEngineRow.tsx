import { t, type MessageKey } from "../lib/i18n";
import { torrentEngine, torrentEngines, useTorrentEngine, type TorrentEngine } from "../lib/torrentEngine";
import { Segmented } from "./Primitives";

const labels: Record<TorrentEngine, { label: MessageKey; title: MessageKey }> = {
  auto: { label: "torrent.engine.auto", title: "torrent.engine.autoTitle" },
  vela: { label: "torrent.engine.vela", title: "torrent.engine.velaTitle" },
  service: { label: "torrent.engine.service", title: "torrent.engine.serviceTitle" },
};

/** Settings › Streaming: which engine opens torrent sources. */
export function TorrentEngineRow() {
  const engine = useTorrentEngine();
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-row-label">{t("torrent.engine.label")}</span>
        <p>{t("torrent.engine.hint")}</p>
      </div>
      <div className="settings-row-control">
        <Segmented
          label={t("torrent.engine.label")}
          value={engine}
          onChange={(value) => torrentEngine.set(value)}
          options={torrentEngines.map((value) => ({
            value,
            label: <span className="segment-text">{t(labels[value].label)}</span>,
            title: t(labels[value].title),
          }))}
        />
      </div>
    </div>
  );
}
