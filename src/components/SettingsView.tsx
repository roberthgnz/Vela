import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  Captions,
  Globe,
  House,
  Info,
  Keyboard,
  Languages,
  Play,
  Library,
  MonitorPlay,
  Radio,
  RefreshCw,
  Trash2,
  User,
  Users,
  XCircle,
} from "lucide-react";
import type { PlayerPreferences } from "../lib/contracts";
import { languageLabel, preferredLanguageOptions } from "../lib/languages";
import { preferencesStore, usePreferences } from "../lib/store";
import { ensureService, isLocalService, serviceInstalled, serviceVersion } from "../lib/streamingServer";
import { openExternal } from "../lib/transport";
import { errorMessage, motion } from "../lib/utils";
import { AccountSection } from "./AccountSection";
import { Dialog, Segmented, Spinner, Switch } from "./Primitives";
import { tmdb, useTmdbConfigured } from "../lib/tmdb";
import { updates, useUpdates } from "../lib/updates";
import { native } from "./WindowControls";
import { ProfileSettings } from "./Profiles";
import { CatalogSettings } from "./CatalogSettings";
import { parseKeywords, sourceKeywords, useSourceKeywords } from "../lib/sourceKeywords";

export function shortcutList(seekShort = 5, seekLong = 10): [string, string][] {
  return [
    ["Ctrl K  ·  /", "Buscar y comandos"],
    ["Ctrl 1–4", "Inicio, Películas, Series, Biblioteca"],
    ["Ctrl ,", "Ajustes"],
    ["Ctrl B", "Mostrar u ocultar la barra lateral"],
    ["Alt ←  ·  Alt →", "Atrás y adelante"],
    ["Esc", "Volver desde los detalles o cerrar"],
    ["Mayús F10", "Menú contextual de un título, episodio o fuente"],
    ["Espacio  ·  K", "Reproducir o pausar"],
    ["←  →  ·  J  L", `Retroceder o avanzar ${seekShort} s · ${seekLong} s`],
    ["↑  ↓  ·  M", "Volumen · silenciar"],
    ["F  ·  C  ·  A", "Pantalla completa · subtítulos · audio"],
    ["G  ·  H", "Adelantar o retrasar subtítulos 0,1 s (con Mayús, 1 s)"],
    ["N", "Siguiente episodio"],
    ["0–9", "Saltar a un punto del vídeo"],
  ];
}

const sections = [
  { id: "account", label: "Cuenta", icon: User },
  { id: "profiles", label: "Perfiles", icon: Users },
  { id: "metadata", label: "Información", icon: Globe },
  { id: "home", label: "Inicio", icon: House },
  { id: "subtitles", label: "Subtítulos", icon: Captions },
  { id: "audio", label: "Audio", icon: Languages },
  { id: "playback", label: "Reproducción", icon: Play },
  ...(native ? [{ id: "external", label: "Reproductor externo", icon: MonitorPlay }] : []),
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
  const [playerPath, setPlayerPath] = useState(prefs.externalPlayerPath);
  const setPlayer = (value: Partial<PlayerPreferences>) => preferencesStore.setPlayer(value);
  const [clearing, setClearing] = useState(false);
  const probe = useMutation({
    mutationFn: async () => {
      const url = validServiceUrl(service);
      if (!(await ensureService(url)))
        throw new Error(
          !isLocalService(url)
            ? "Sin respuesta. Comprueba la dirección y que el servidor esté abierto."
            : (await serviceInstalled())
              ? "Vela inició el servidor de Stremio, pero no respondió. Prueba a abrir Stremio."
              : "Sin respuesta y Stremio no está instalado. Instala Stremio o abre Stremio Service.",
        );
      return { url, version: await serviceVersion(url).catch(() => undefined) };
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
    if (playerPath.trim() !== prefs.externalPlayerPath) {
      preferencesStore.setExternalPlayerPath(playerPath);
      notify(playerPath.trim() ? "Ruta del reproductor guardada." : "Vela buscará MPV automáticamente.");
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
  const count = Object.values(prefs.library).filter((entry) => entry.saved).length;
  const withProgress = Object.values(prefs.library).filter((entry) => entry.progress || entry.videos).length;
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
              document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: motion(), block: "start" });
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

          <section id="settings-profiles" className="settings-group" aria-labelledby="settings-profiles-title">
            <h2 id="settings-profiles-title">Perfiles</h2>
            <ProfileSettings notify={notify} />
          </section>

          <section id="settings-metadata" className="settings-group" aria-labelledby="settings-metadata-title">
            <h2 id="settings-metadata-title">Información</h2>
            <MetadataSettings notify={notify} />
          </section>

          <section id="settings-home" className="settings-group" aria-labelledby="settings-home-title">
            <h2 id="settings-home-title">Inicio</h2>
            <CatalogSettings />
          </section>

          <section id="settings-subtitles" className="settings-group" aria-labelledby="settings-subtitles-title">
            <h2 id="settings-subtitles-title">Subtítulos</h2>
            <div className="settings-card">
              <Row label="Idioma principal" htmlFor="subtitle-language" description="Se elige primero al activar subtítulos de un idioma.">
                <LanguageSelect id="subtitle-language" value={prefs.player.subtitleLanguage} onChange={(value) => setPlayer({ subtitleLanguage: value })} />
              </Row>
              <Row label="Idioma secundario" htmlFor="subtitle-secondary" description="Se usa si no hay subtítulos en el idioma principal.">
                <LanguageSelect id="subtitle-secondary" value={prefs.player.subtitleSecondary} onChange={(value) => setPlayer({ subtitleSecondary: value })} />
              </Row>
              <Row
                label="Activar automáticamente"
                description="Al empezar un vídeo, muestra los primeros subtítulos en tus idiomas, salvo que el audio ya esté en el idioma principal."
              >
                <Switch
                  checked={prefs.player.subtitlesAuto}
                  label="Activar subtítulos automáticamente"
                  onChange={() => setPlayer({ subtitlesAuto: !prefs.player.subtitlesAuto })}
                />
              </Row>
              <Row label="Tamaño">
                <Segmented
                  label="Tamaño de los subtítulos"
                  value={String(prefs.player.subtitleSize)}
                  onChange={(value) => setPlayer({ subtitleSize: Number(value) })}
                  options={[75, 100, 125, 150, 200].map((value) => ({ value: String(value), label: <span className="segment-text">{value} %</span>, title: `${value} %` }))}
                />
              </Row>
              <Row label="Opacidad del texto">
                <Segmented
                  label="Opacidad del texto"
                  value={String(prefs.player.subtitleOpacity)}
                  onChange={(value) => setPlayer({ subtitleOpacity: Number(value) })}
                  options={[1, 0.75, 0.5].map((value) => ({ value: String(value), label: <span className="segment-text">{value * 100} %</span>, title: `${value * 100} %` }))}
                />
              </Row>
              <Row label="Fondo">
                <Segmented
                  label="Opacidad del fondo"
                  value={String(prefs.player.subtitleBackground)}
                  onChange={(value) => setPlayer({ subtitleBackground: Number(value) })}
                  options={[0, 0.25, 0.5, 0.75, 1].map((value) => ({
                    value: String(value),
                    label: <span className="segment-text">{value ? `${value * 100} %` : "Sin fondo"}</span>,
                    title: value ? `Fondo al ${value * 100} %` : "Sin fondo",
                  }))}
                />
              </Row>
              <div className="subtitle-preview" aria-hidden="true" style={{
                "--subtitle-scale": prefs.player.subtitleSize / 100,
                "--subtitle-opacity": prefs.player.subtitleOpacity,
                "--subtitle-background": prefs.player.subtitleBackground,
              } as CSSProperties}>
                <div className="player-subtitle bottom">
                  <span>Así se verán los subtítulos</span>
                </div>
              </div>
              <Row
                label="Desfase"
                description="Se ajusta durante la reproducción desde Audio y subtítulos, o con G y H. Los subtítulos ASS conservan sus propios estilos."
              />
            </div>
          </section>

          <section id="settings-audio" className="settings-group" aria-labelledby="settings-audio-title">
            <h2 id="settings-audio-title">Audio</h2>
            <div className="settings-card">
              <Row label="Idioma preferido" htmlFor="audio-language" description="Si el vídeo tiene varias pistas, Vela elige esta al empezar.">
                <LanguageSelect id="audio-language" value={prefs.player.audioLanguage} empty="Original del vídeo" onChange={(value) => setPlayer({ audioLanguage: value })} />
              </Row>
              <Row label="Idioma alternativo" htmlFor="audio-secondary" description="Se usa si no hay pista en el idioma preferido.">
                <LanguageSelect id="audio-secondary" value={prefs.player.audioSecondary} disabled={!prefs.player.audioLanguage} onChange={(value) => setPlayer({ audioSecondary: value })} />
              </Row>
            </div>
          </section>

          <section id="settings-playback" className="settings-group" aria-labelledby="settings-playback-title">
            <h2 id="settings-playback-title">Reproducción</h2>
            <div className="settings-card">
              <Row
                label="Reproductor integrado"
                description="Reproduce MP4, WebM y MKV con H.264, VP9 o AV1 y listas HLS, con varias pistas de audio. HEVC, DTS o TrueHD necesitan la conversión de Stremio Service o un reproductor externo."
              />
              <Row label="Salto corto" description="Flechas izquierda y derecha.">
                <Segmented
                  label="Salto corto"
                  value={String(prefs.player.seekShort)}
                  onChange={(value) => setPlayer({ seekShort: Number(value) })}
                  options={[5, 10, 15, 30].map((value) => ({ value: String(value), label: <span className="segment-text">{value} s</span>, title: `${value} segundos` }))}
                />
              </Row>
              <Row label="Salto largo" description="J y L, y los botones del reproductor.">
                <Segmented
                  label="Salto largo"
                  value={String(prefs.player.seekLong)}
                  onChange={(value) => setPlayer({ seekLong: Number(value) })}
                  options={[10, 15, 30, 60, 85].map((value) => ({ value: String(value), label: <span className="segment-text">{value} s</span>, title: `${value} segundos` }))}
                />
              </Row>
              <Row label="Siguiente episodio" description="Al terminar un episodio, propone el siguiente con una fuente del mismo grupo.">
                <Switch
                  checked={prefs.player.autoNext}
                  label="Proponer el siguiente episodio"
                  onChange={() => setPlayer({ autoNext: !prefs.player.autoNext })}
                />
              </Row>
              {prefs.player.autoNext && (
                <Row label="Empezar automáticamente" description="Cuenta atrás antes de reproducirlo. Sin cuenta atrás, espera a que lo elijas.">
                  <Segmented
                    label="Cuenta atrás del siguiente episodio"
                    value={String(prefs.player.nextCountdown)}
                    onChange={(value) => setPlayer({ nextCountdown: Number(value) })}
                    options={[0, 5, 10, 20].map((value) => ({
                      value: String(value),
                      label: <span className="segment-text">{value ? `${value} s` : "No"}</span>,
                      title: value ? `Tras ${value} segundos` : "Esperar",
                    }))}
                  />
                </Row>
              )}
            </div>
          </section>

          {native && (
            <section id="settings-external" className="settings-group" aria-labelledby="settings-external-title">
              <h2 id="settings-external-title">Reproductor externo</h2>
              <div className="settings-card">
                <Row
                  label="Ruta de MPV"
                  htmlFor="player-path"
                  description="Opcional. Si la dejas vacía, Vela busca mpv.exe en el PATH, en Programas y en Program Files. Con MPV, Vela pasa las cabeceras de la fuente, reanuda donde lo dejaste y guarda el progreso al cerrarlo."
                  stacked
                >
                  <input
                    id="player-path"
                    className="input"
                    value={playerPath}
                    onChange={(event) => setPlayerPath(event.target.value)}
                    onBlur={commitPlayer}
                    onKeyDown={(event) => event.key === "Enter" && commitPlayer()}
                    placeholder="C:\Program Files\mpv\mpv.exe"
                    spellCheck={false}
                  />
                </Row>
              </div>
            </section>
          )}

          <section id="settings-streaming" className="settings-group" aria-labelledby="settings-streaming-title">
            <h2 id="settings-streaming-title">Streaming</h2>
            <div className="settings-card">
              <Row
                label="Stremio Service"
                htmlFor="service-url"
                description="Servidor local necesario para reproducir fuentes torrent. No se incluye con Vela: si Stremio está instalado, Vela inicia su servidor cuando hace falta."
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
                      <XCircle size={14} /> {errorMessage(probe.error)}
                    </span>
                  ) : (
                    <span className="status">Sin comprobar</span>
                  )}
                </div>
              </Row>
              <KeywordRows />
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
              <ShortcutTable seekShort={prefs.player.seekShort} seekLong={prefs.player.seekLong} />
            </div>
          </section>

          <section id="settings-about" className="settings-group" aria-labelledby="settings-about-title">
            <h2 id="settings-about-title">Acerca de</h2>
            <div className="settings-card">
              <Row label={`Vela ${__APP_VERSION__}`} description="Cliente de escritorio independiente compatible con el protocolo de addons de Stremio. No es una aplicación oficial de Stremio." />
              {updates.supported() && <UpdateRows />}
              <Row
                label="Privacidad"
                description="Tu biblioteca se guarda localmente. Cada addon recibe las consultas que le haces; Vela no envía datos a otros servicios."
              />
              <Row
                label="TMDB"
                description="Las traducciones de títulos, sinopsis y episodios usan la API de TMDB, pero Vela no está respaldada ni certificada por TMDB."
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

export function ShortcutTable({ seekShort, seekLong }: { seekShort?: number; seekLong?: number }) {
  return (
    <dl className="shortcut-table">
      {shortcutList(seekShort, seekLong).map(([keys, label]) => (
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

/** Keyword filter for sources, stored on this device only. */
function KeywordRows() {
  const keywords = useSourceKeywords();
  const field = (kind: "include" | "exclude", label: string, description: string, placeholder: string) => (
    <Row label={label} htmlFor={`keywords-${kind}`} description={description} stacked>
      <input
        id={`keywords-${kind}`}
        className="input"
        // Re-created when the stored list changes so the field shows its normalized form.
        key={keywords[kind].join(",")}
        defaultValue={keywords[kind].join(", ")}
        placeholder={placeholder}
        spellCheck={false}
        onBlur={(event) => sourceKeywords.set({ ...keywords, [kind]: parseKeywords(event.currentTarget.value) })}
        onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
      />
    </Row>
  );
  return (
    <>
      {field(
        "include",
        "Fuentes con estas palabras",
        "Si escribes alguna, solo se muestran las fuentes que contengan al menos una. Separadas por comas. Solo en este equipo.",
        "castellano, 1080p",
      )}
      {field("exclude", "Ocultar fuentes con estas palabras", "Se ocultan las que contengan cualquiera. Solo en este equipo.", "cam, hdcam, ts")}
    </>
  );
}

function UpdateRows() {
  const state = useUpdates();
  const automatic = updates.automatic();
  const busy = state.status === "checking" || state.status === "installing";
  return (
    <>
      <Row label="Buscar actualizaciones al iniciar" description="Vela consulta las versiones publicadas en GitHub y avisa cuando hay una nueva. Nada se instala sin tu confirmación.">
        <Switch checked={automatic} label="Buscar actualizaciones al iniciar" onChange={() => updates.setAutomatic(!automatic)} />
      </Row>
      <Row
        label="Actualizaciones"
        description={
          <span aria-live="polite">
            {state.status === "checking"
              ? "Comprobando…"
              : state.status === "current"
                ? "Tienes la última versión."
                : state.status === "available" && state.info
                  ? `Vela ${state.info.version} está disponible.`
                  : state.status === "installing"
                    ? "Instalando la actualización…"
                    : state.status === "error"
                      ? state.error
                      : "Sin comprobar en esta sesión."}
          </span>
        }
      >
        {state.status === "available" ? (
          <button className="button primary" onClick={() => void updates.install()}>
            <Download size={14} /> Instalar y reiniciar
          </button>
        ) : (
          <button className="button secondary" disabled={busy} onClick={() => void updates.check()}>
            {state.status === "checking" ? <Spinner /> : <RefreshCw size={14} />} Buscar ahora
          </button>
        )}
      </Row>
    </>
  );
}

function LanguageSelect({
  id,
  value,
  onChange,
  empty = "Ninguno",
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  empty?: string;
  disabled?: boolean;
}) {
  const options = preferredLanguageOptions
    .map((code) => ({ code, label: languageLabel(code) }))
    .sort((a, b) => a.label.localeCompare(b.label, "es"));
  return (
    <label className="select">
      <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        <option value="">{empty}</option>
        {options.map((option) => (
          <option key={option.code} value={option.code}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const metadataLanguages = [
  ["es-ES", "Español (España)"],
  ["es-MX", "Español (Latinoamérica)"],
  ["ca-ES", "Catalán"],
  ["eu-ES", "Euskera"],
  ["gl-ES", "Gallego"],
  ["en-US", "Inglés"],
  ["fr-FR", "Francés"],
  ["de-DE", "Alemán"],
  ["it-IT", "Italiano"],
  ["pt-PT", "Portugués"],
  ["pt-BR", "Portugués (Brasil)"],
] as const;

function MetadataSettings({ notify }: { notify: (message: string) => void }) {
  const prefs = usePreferences();
  const configured = useTmdbConfigured();
  const [value, setValue] = useState("");
  useEffect(() => {
    void tmdb.key();
  }, []);
  const save = useMutation({
    mutationFn: () => tmdb.save(value),
    onSuccess: () => {
      setValue("");
      notify("Clave de TMDB guardada. La información se mostrará traducida.");
    },
  });
  return (
    <div className="settings-card">
      <Row label="Idioma de la información" htmlFor="metadata-language" description="Títulos, sinopsis, géneros y episodios.">
        <label className="select">
          <select
            id="metadata-language"
            value={prefs.metadataLanguage}
            onChange={(event) => preferencesStore.setMetadataLanguage(event.target.value)}
          >
            {metadataLanguages.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
            <option value="">Original del addon</option>
          </select>
        </label>
      </Row>
      <Row
        label="Clave de TMDB"
        htmlFor="tmdb-key"
        stacked
        description={
          <>
            Cinemeta solo ofrece la información en inglés. Con una clave gratuita de TMDB (la «clave de API», no el token de
            lectura) Vela la traduce y usa Cinemeta cuando falta algo. Se guarda en el Administrador de credenciales de Windows y
            solo se envía a TMDB.
          </>
        }
      >
        {configured ? (
          <div className="input-group">
            <span className="status ok">
              <CheckCircle2 size={14} /> Clave guardada
            </span>
            <button
              className="button subtle"
              onClick={() =>
                void tmdb
                  .remove()
                  .then(() => notify("Clave de TMDB eliminada."))
                  .catch((error) => notify(errorMessage(error)))
              }
            >
              Quitar
            </button>
          </div>
        ) : (
          <>
            <div className="input-group">
              <input
                id="tmdb-key"
                className="input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="32 caracteres"
                value={value}
                aria-invalid={save.isError}
                onChange={(event) => {
                  setValue(event.target.value);
                  save.reset();
                }}
                onKeyDown={(event) => event.key === "Enter" && value.trim() && save.mutate()}
              />
              <button className="button secondary" disabled={!value.trim() || save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? <Spinner /> : null} Guardar
              </button>
            </div>
            <div className="field-status" aria-live="polite">
              {save.isError ? (
                <span className="status error">
                  <XCircle size={14} /> {errorMessage(save.error)}
                </span>
              ) : (
                <button
                  className="link-button"
                  onClick={() =>
                    void openExternal("https://www.themoviedb.org/settings/api").catch((error) => notify(errorMessage(error)))
                  }
                >
                  Obtener una clave en themoviedb.org <ExternalLink size={12} />
                </button>
              )}
            </div>
          </>
        )}
      </Row>
    </div>
  );
}
