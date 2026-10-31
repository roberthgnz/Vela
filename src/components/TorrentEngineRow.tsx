import { torrentEngine, torrentEngines, useTorrentEngine, type TorrentEngine } from "../lib/torrentEngine";
import { Segmented } from "./Primitives";

const labels: Record<TorrentEngine, { label: string; title: string }> = {
  auto: { label: "Automático", title: "Stremio Service si está instalado; si no, el motor de Vela" },
  vela: { label: "Vela", title: "El motor propio de Vela: no necesita instalar nada" },
  service: { label: "Stremio Service", title: "Siempre el servidor de Stremio (ofrece conversión de formatos)" },
};

/** Settings › Streaming: which engine opens torrent sources. */
export function TorrentEngineRow() {
  const engine = useTorrentEngine();
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-row-label">Motor de torrents</span>
        <p>
          Vela abre los torrents con su propio motor cuando Stremio Service no está instalado. Stremio Service añade la
          conversión de formatos que el reproductor integrado no admite; el motor de Vela borra los datos al terminar.
        </p>
      </div>
      <div className="settings-row-control">
        <Segmented
          label="Motor de torrents"
          value={engine}
          onChange={(value) => torrentEngine.set(value)}
          options={torrentEngines.map((value) => ({
            value,
            label: <span className="segment-text">{labels[value].label}</span>,
            title: labels[value].title,
          }))}
        />
      </div>
    </div>
  );
}
