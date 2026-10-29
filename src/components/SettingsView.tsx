import { useEffect, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  Info,
  Keyboard,
  Library,
  MonitorPlay,
  Radio,
  Trash2,
  User,
  XCircle,
} from "lucide-react";
import { preferencesStore, usePreferences } from "../lib/store";
import { openExternal, requestJson } from "../lib/transport";
import { errorMessage } from "../lib/utils";
import { AccountSection } from "./AccountSection";
import { Dialog, Spinner } from "./Primitives";

export const shortcuts: [string, string][] = [
  ["Ctrl K  ·  /", "Buscar y comandos"],
  ["Ctrl 1–4", "Inicio, Películas, Series, Biblioteca"],
  ["Ctrl ,", "Ajustes"],
  ["Ctrl B", "Mostrar u ocultar la barra lateral"],
  ["Alt ←  ·  Alt →", "Atrás y adelante"],
  ["Esc", "Volver desde los detalles o cerrar"],
  ["Mayús F10", "Menú contextual de un título o fuente"],
  ["Espacio  ·  K", "Reproducir o pausar"],
  ["←  →  ·  J  L", "Retroceder o avanzar 5 s · 10 s"],
  ["↑  ↓  ·  M", "Volumen · silenciar"],
  ["F  ·  C", "Pantalla completa · subtítulos"],
  ["0–9", "Saltar a un punto del vídeo"],
];

const sections = [
  { id: "account", label: "Cuenta", icon: User },
  { id: "playback", label: "Reproducción", icon: MonitorPlay },
  { id: "streaming", label: "Streaming", icon: Radio },
  { id: "library", label: "Biblioteca", icon: Library },
  { id: "keyboard", label: "Teclado", icon: Keyboard },
  { id: "about", label: "Acerca de", icon: Info },
] as const;

function Row({
  label,
  description,
  children,
  htmlFor,
  stacked,
}: {
  label: string;
  description?: ReactNode;
  children?: ReactNode;
  htmlFor?: string;
  stacked?: boolean;
}) {
  return (
    <div className={`settings-row ${stacked ? "stacked" : ""}`}>
      <div className="settings-row-text">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span className="settings-row-label">{label}</span>}
        {description && <p>{description}</p>}
      </div>
      {children && <div className="settings-row-control">{children}</div>}
    </div>
  );
}

function validServiceUrl(value: string): string {
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Usa una dirección HTTP o HTTPS sin credenciales ni parámetros.");
  return url.href.replace(/\/$/, "");
}

export function SettingsView({ notify }: { notify: (message: string) => void }) {
  const prefs = usePreferences();
  const [service, setService] = useState(prefs.serviceUrl);
  const [serviceError, setServiceError] = useState("");
  const [player, setPlayer] = useState(prefs.externalPlayerPath);
  const [clearing, setClearing] = useState(false);
  const probe = useMutation({
    mutationFn: async () => {
      const url = validServiceUrl(service);
      const settings = await requestJson(`${url}/settings`);
      const values = (settings as { values?: Record<string, unknown> })?.values;
      return {
        url,
        version: typeof values?.serverVersion === "string" ? values.serverVersion : undefined,
      };
    },
    onSuccess: ({ url }) => {
      preferencesStore.setServiceUrl(url);
      setServiceError("");
    },
  });
  const commitService = () => {
    try {
      const url = validServiceUrl(service);
      if (url !== prefs.serviceUrl) {
        preferencesStore.setServiceUrl(url);
        notify("Dirección del servicio guardada.");
        probe.reset();
      }
      setServiceError("");
    } catch (error) {
      setServiceError(error instanceof TypeError ? "Escribe una dirección válida, por ejemplo http://127.0.0.1:11470" : errorMessage(error));
    }
  };
  const commitPlayer = () => {
    if (player.trim() !== prefs.externalPlayerPath) {
      preferencesStore.setExternalPlayerPath(player);
      notify(player.trim() ? "Ruta del reproductor guardada." : "Vela buscará MPV automáticamente.");
    }
  };
  const exportLibrary = () => {
    const blob = new Blob(
      [JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), library: prefs.library }, null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `vela-biblioteca-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify("Exportación de la biblioteca preparada.");
  };
  const [current, setCurrent] = useState<string>(sections[0].id);
  useEffect(() => {
    const nodes = sections
      .map(({ id }) => document.getElementById(`settings-${id}`))
      .filter((node): node is HTMLElement => Boolean(node));
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting);
        if (visible.length) setCurrent(visible[0].target.id.replace("settings-", ""));
      },
      { rootMargin: "-80px 0px -60% 0px" },
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);
  const count = Object.keys(prefs.library).length;
  const withProgress = Object.values(prefs.library).filter((entry) => entry.progress).length;
  return (
    <div className="page settings-page">
      <header className="page-header">
        <h1>Ajustes</h1>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Secciones de ajustes">
          {sections.map(({ id, label, icon: Icon }) => (
            <a
              key={id}
              href={`#settings-${id}`}
              aria-current={current === id ? "true" : undefined}
              onClick={(event) => {
              event.preventDefault();
              document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}>
              <Icon size={15} /> {label}
            </a>
          ))}
        </nav>
        <div className="settings-content">
          <section id="settings-account" className="settings-group" aria-labelledby="settings-account-title">
            <h2 id="settings-account-title">Cuenta</h2>
            <AccountSection notify={notify} />
          </section>

          <section id="settings-playback" className="settings-group" aria-labelledby="settings-playback-title">
            <h2 id="settings-playback-title">Reproducción</h2>
            <div className="settings-card">
              <Row
                label="Reproductor integrado"
                description="WebView2 reproduce MP4/WebM con H.264, VP9 o AV1 y listas HLS. MKV, HEVC, DTS o TrueHD suelen necesitar un reproductor externo."
              />
              <Row
                label="Ruta de MPV"
                htmlFor="player-path"
                description="Opcional. Si la dejas vacía, Vela busca mpv.exe en el PATH, en Programas y en Program Files."
                stacked
              >
                <input
                  id="player-path"
                  className="input"
                  value={player}
                  onChange={(event) => setPlayer(event.target.value)}
                  onBlur={commitPlayer}
                  onKeyDown={(event) => event.key === "Enter" && commitPlayer()}
                  placeholder="C:\Program Files\mpv\mpv.exe"
                  spellCheck={false}
                />
              </Row>
            </div>
          </section>

          <section id="settings-streaming" className="settings-group" aria-labelledby="settings-streaming-title">
            <h2 id="settings-streaming-title">Streaming</h2>
            <div className="settings-card">
              <Row
                label="Stremio Service"
                htmlFor="service-url"
                description="Servidor local necesario para reproducir fuentes torrent. No se incluye con Vela."
                stacked
              >
                <div className="input-group">
                  <input
                    id="service-url"
                    className="input"
                    value={service}
                    aria-invalid={Boolean(serviceError)}
                    onChange={(event) => {
                      setService(event.target.value);
                      probe.reset();
                    }}
                    onBlur={commitService}
                    onKeyDown={(event) => event.key === "Enter" && commitService()}
                    type="url"
                    spellCheck={false}
                  />
                  <button className="button secondary" disabled={probe.isPending} onClick={() => probe.mutate()}>
                    {probe.isPending ? <Spinner /> : <Radio size={14} />}
                    Probar conexión
                  </button>
                </div>
                <div className="field-status" aria-live="polite">
                  {serviceError ? (
                    <span className="status error"><XCircle size={14} /> {serviceError}</span>
                  ) : probe.isPending ? (
                    <span className="status">
                      <Spinner size={13} /> Comprobando…
                    </span>
                  ) : probe.isSuccess ? (
                    <span className="status ok">
                      <CheckCircle2 size={14} /> Conectado{probe.data.version ? ` · servidor ${probe.data.version}` : ""}
                    </span>
                  ) : probe.isError ? (
                    <span className="status error">
                      <XCircle size={14} /> Sin respuesta. Abre Stremio o Stremio Service y comprueba la dirección.
                    </span>
                  ) : (
                    <span className="status">Sin comprobar</span>
                  )}
                </div>
              </Row>
              <Row label="Descargar Stremio Service" description="Página oficial de descargas de Stremio.">
                <button
                  className="button subtle"
                  onClick={() => void openExternal("https://www.stremio.com/downloads").catch((error) => notify(errorMessage(error)))}
                >
                  Abrir <ExternalLink size={13} />
                </button>
              </Row>
            </div>
          </section>

          <section id="settings-library" className="settings-group" aria-labelledby="settings-library-title">
            <h2 id="settings-library-title">Biblioteca</h2>
            <div className="settings-card">
              <Row
                label="Almacenamiento local"
                description={`${count} títulos guardados, ${withProgress} con progreso. Se guardan en este equipo.`}
              />
              <Row label="Exportar biblioteca" description="Descarga un archivo JSON con tus títulos y progreso.">
                <button className="button secondary" onClick={exportLibrary} disabled={!count}>
                  <Download size={14} /> Exportar
                </button>
              </Row>
              <Row label="Vaciar biblioteca" description="Elimina todos los títulos y su progreso de este equipo.">
                <button className="button danger-outline" onClick={() => setClearing(true)} disabled={!count}>
                  <Trash2 size={14} /> Vaciar
                </button>
              </Row>
            </div>
          </section>

          <section id="settings-keyboard" className="settings-group" aria-labelledby="settings-keyboard-title">
            <h2 id="settings-keyboard-title">Teclado</h2>
            <div className="settings-card">
              <ShortcutTable />
            </div>
          </section>

          <section id="settings-about" className="settings-group" aria-labelledby="settings-about-title">
            <h2 id="settings-about-title">Acerca de</h2>
            <div className="settings-card">
              <Row label="Vela 0.2.0" description="Cliente de escritorio independiente compatible con el protocolo de addons de Stremio. No es una aplicación oficial de Stremio." />
              <Row
                label="Privacidad"
                description="Tu biblioteca se guarda localmente. Cada addon recibe las consultas que le haces; Vela no envía datos a otros servicios."
              />
              <Row
                label="Contenido de demostración"
                description="Los tráileres de Open Cinema son de Blender Foundation, alojados por W3C, bajo Creative Commons BY 3.0."
              />
              <Row label="Protocolo de addons" description="Documentación oficial del SDK de addons.">
                <button
                  className="button subtle"
                  onClick={() =>
                    void openExternal("https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md").catch((error) =>
                      notify(errorMessage(error)),
                    )
                  }
                >
                  Abrir <ExternalLink size={13} />
                </button>
              </Row>
            </div>
          </section>
        </div>
      </div>
      {clearing && (
        <Dialog title="Vaciar biblioteca" onClose={() => setClearing(false)} className="compact-dialog" hideClose>
          <h2>¿Vaciar la biblioteca?</h2>
          <p>Se eliminarán {count} títulos y su progreso de este equipo. Esta acción no se puede deshacer; exporta antes si quieres conservar una copia.</p>
          <div className="form-actions">
            <button className="button secondary" data-autofocus onClick={() => setClearing(false)}>
              Cancelar
            </button>
            <button
              className="button danger"
              onClick={() => {
                preferencesStore.clearLibrary();
                setClearing(false);
                notify("Biblioteca vaciada.");
              }}
            >
              Vaciar biblioteca
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

export function ShortcutTable() {
  return (
    <dl className="shortcut-table">
      {shortcuts.map(([keys, label]) => (
        <div key={label}>
          <dt>
            {keys.split("  ·  ").map((group, index) => (
              <span key={group}>
                {index > 0 && <span className="or">o</span>}
                {group.split(" ").filter(Boolean).map((key, keyIndex) => (
                  <kbd key={`${key}${keyIndex}`}>{key}</kbd>
                ))}
              </span>
            ))}
          </dt>
          <dd>{label}</dd>
        </div>
      ))}
    </dl>
  );
}
