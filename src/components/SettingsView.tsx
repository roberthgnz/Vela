import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Check,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  HardDrive,
  LoaderCircle,
  Monitor,
  Play,
  Radio,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { preferencesStore, usePreferences } from "../lib/store";
import { openExternal, requestJson } from "../lib/transport";
import { errorMessage } from "../lib/utils";

export function SettingsView({
  notify,
}: {
  notify: (message: string) => void;
}) {
  const prefs = usePreferences();
  const [service, setService] = useState(prefs.serviceUrl);
  const [player, setPlayer] = useState(prefs.externalPlayerPath);
  const [saveError, setSaveError] = useState("");
  const probe = useMutation({
    mutationFn: async () => {
      const url = new URL(service);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("Usa una dirección HTTP o HTTPS válida.");
      return requestJson(
        new URL("settings", url.href.replace(/\/?$/, "/")).href,
      );
    },
  });
  const save = () => {
    try {
      const url = new URL(service);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(
          "Usa una dirección HTTP o HTTPS sin credenciales ni parámetros.",
        );
      preferencesStore.setServiceUrl(url.href.replace(/\/$/, ""));
      preferencesStore.setExternalPlayerPath(player.trim());
      setSaveError("");
      notify("Tus ajustes ya están guardados.");
    } catch (error) {
      setSaveError(errorMessage(error));
    }
  };
  const exportLibrary = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            version: 1,
            exportedAt: new Date().toISOString(),
            library: prefs.library,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `vela-biblioteca-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify("Copia de tu biblioteca preparada.");
  };
  return (
    <section className="page-view settings-view">
      <div className="page-heading">
        <div>
          <span className="eyebrow">EL ESPACIO ES TUYO</span>
          <h1>Así te gusta verlo.</h1>
          <p>Pequeños ajustes para una experiencia más tuya.</p>
        </div>
        <button className="button primary" onClick={save}>
          <Check size={16} />
          Guardar cambios
        </button>
      </div>
      <div className="settings-layout">
        <section className="settings-card">
          <div className="settings-card-title">
            <Radio size={20} />
            <div>
              <h2>Streaming local</h2>
              <p>
                Conecta un servicio compatible para reproducir fuentes torrent.
              </p>
            </div>
          </div>
          <label className="field-label" htmlFor="service-url">
            Dirección del servicio
          </label>
          <div className="input-with-action">
            <input
              id="service-url"
              value={service}
              onChange={(event) => {
                setService(event.target.value);
                probe.reset();
              }}
              type="url"
              spellCheck={false}
            />
            <button
              className="button secondary"
              disabled={probe.isPending}
              onClick={() => probe.mutate()}
            >
              {probe.isPending ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Radio size={15} />
              )}
              Probar conexión
            </button>
          </div>
          <div className="service-status" aria-live="polite">
            {probe.isSuccess ? (
              <>
                <CheckCircle2 size={15} />
                <span>
                  Servicio disponible. Ya puedes guardar esta dirección.
                </span>
              </>
            ) : probe.isError ? (
              <>
                <XCircle size={15} />
                <span>
                  No se ha podido conectar. Comprueba que el servicio esté
                  abierto y la dirección sea correcta.
                </span>
              </>
            ) : (
              <>
                <span className="status-dot neutral" />
                <span>La conexión se comprueba cuando tú lo decides.</span>
              </>
            )}
          </div>
          <button
            className="text-button"
            onClick={() =>
              void openExternal("https://www.stremio.com/downloads").catch(
                (error) => notify(errorMessage(error)),
              )
            }
          >
            Obtener Stremio Service <ExternalLink size={13} />
          </button>
        </section>
        <section className="settings-card">
          <div className="settings-card-title">
            <Play size={20} />
            <div>
              <h2>Reproductor externo</h2>
              <p>
                Una alternativa para formatos que el reproductor integrado no
                admita.
              </p>
            </div>
          </div>
          <label className="field-label" htmlFor="player-path">
            Ruta de MPV <span>opcional</span>
          </label>
          <input
            id="player-path"
            value={player}
            onChange={(event) => setPlayer(event.target.value)}
            placeholder="C:\\Programas\\mpv\\mpv.exe"
            spellCheck={false}
          />
          <p className="field-hint">
            En la app de escritorio, Vela puede buscar MPV si ya está instalado.
            El reproductor integrado abre enlaces MP4 y HLS compatibles.
          </p>
        </section>
        <section className="settings-card">
          <div className="settings-card-title">
            <HardDrive size={20} />
            <div>
              <h2>Tu biblioteca, aquí</h2>
              <p>
                {Object.keys(prefs.library).length} historias guardadas en este
                dispositivo.
              </p>
            </div>
          </div>
          <div className="settings-fact">
            <span>Cuenta</span>
            <strong>Espacio local</strong>
          </div>
          <div className="settings-fact">
            <span>Sincronización</span>
            <strong>Sin conectar</strong>
          </div>
          <button className="button secondary" onClick={exportLibrary}>
            Exportar biblioteca <ChevronRight size={15} />
          </button>
        </section>
        <aside className="settings-aside">
          <img src="/vela.svg" alt="" />
          <h2>
            Menos ruido.
            <br />
            Más historias.
          </h2>
          <p>Vela 0.1.0</p>
          <div>
            <ShieldCheck size={16} />
            <span>
              Tu biblioteca se guarda localmente. Los addons y sus servidores
              reciben las consultas que les haces.
            </span>
          </div>
          <div>
            <Monitor size={16} />
            <span>
              Las películas abiertas de demostración son tráileres de Blender
              Foundation, distribuidos bajo Creative Commons BY.
            </span>
          </div>
          <button
            className="text-button"
            onClick={() =>
              void openExternal(
                "https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md",
              ).catch((error) => notify(errorMessage(error)))
            }
          >
            Compatible con el protocolo de addons <ExternalLink size={12} />
          </button>
        </aside>
      </div>
      {saveError && (
        <p className="form-error" role="alert">
          {saveError}
        </p>
      )}
    </section>
  );
}
