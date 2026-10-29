import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Grid2X2,
  Link2,
  LoaderCircle,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { InstalledAddon } from "../lib/contracts";
import { loadManifest } from "../lib/protocol";
import { preferencesStore, usePreferences } from "../lib/store";
import { addonHost, errorMessage } from "../lib/utils";
import { Dialog, EmptyState } from "./Primitives";

export function AddonsView() {
  const prefs = usePreferences();
  const [installOpen, setInstallOpen] = useState(false);
  const [removing, setRemoving] = useState<InstalledAddon | null>(null);
  return (
    <section className="page-view">
      <div className="page-heading">
        <div>
          <span className="eyebrow">HECHO A TU MEDIDA</span>
          <h1>Tu universo, ampliado.</h1>
          <p>Conecta los catálogos y las fuentes que quieres tener cerca.</p>
        </div>
        <button className="button primary" onClick={() => setInstallOpen(true)}>
          <Plus size={17} />
          Añadir addon
        </button>
      </div>
      <div className="addon-summary">
        <div>
          <span className="status-dot" />
          <strong>
            {prefs.addons.filter((addon) => addon.enabled).length}
          </strong>
          addons activos
        </div>
        <span>Tu biblioteca se conserva al desactivar un addon.</span>
      </div>
      <div className="addons-grid">
        {prefs.addons.map((addon) => (
          <article
            className={`addon-card ${!addon.enabled ? "disabled" : ""}`}
            key={addon.manifestUrl}
            aria-label={addon.manifest.name}
          >
            <div className="addon-card-top">
              <span
                className={`addon-avatar ${addon.manifest.id === "com.linvo.cinemeta" ? "cinemeta" : ""}`}
              >
                {addon.manifest.id === "com.linvo.cinemeta" ? (
                  <span>C</span>
                ) : addon.manifestUrl.startsWith("vela:") ? (
                  <img src="/vela.svg" alt="" />
                ) : (
                  <Grid2X2 size={23} />
                )}
              </span>
              <button
                className={`switch ${addon.enabled ? "checked" : ""}`}
                role="switch"
                aria-checked={addon.enabled}
                aria-label={`${addon.enabled ? "Desactivar" : "Activar"} ${addon.manifest.name}`}
                onClick={() => preferencesStore.toggleAddon(addon.manifestUrl)}
              >
                <span />
              </button>
            </div>
            <h2>{addon.manifest.name}</h2>
            <p>
              {addon.manifest.description ||
                "Un nuevo universo de historias para tu Vela."}
            </p>
            <div className="addon-capabilities">
              {addon.manifest.resources
                .map((resource) =>
                  typeof resource === "string" ? resource : resource.name,
                )
                .filter((name) =>
                  ["catalog", "stream", "subtitles", "meta"].includes(name),
                )
                .map((name) => (
                  <span key={name}>
                    {
                      (
                        {
                          catalog: "Catálogo",
                          stream: "Fuentes",
                          subtitles: "Subtítulos",
                          meta: "Detalles",
                        } as Record<string, string>
                      )[name]
                    }
                  </span>
                ))}
            </div>
            <div className="addon-card-footer">
              <span title={addonHost(addon.manifestUrl)}>
                {addonHost(addon.manifestUrl)}
                <small>v{addon.manifest.version}</small>
              </span>
              <button
                className="icon-button danger-hover"
                aria-label={`Eliminar ${addon.manifest.name}`}
                onClick={() => setRemoving(addon)}
              >
                <Trash2 size={16} />
              </button>
            </div>
          </article>
        ))}
      </div>
      {!prefs.addons.length && (
        <EmptyState
          icon={<Grid2X2 size={27} />}
          title="Tu universo empieza con un addon"
          description="Instala un catálogo para descubrir películas, series y nuevas historias."
          action={
            <button
              className="button primary"
              onClick={() => setInstallOpen(true)}
            >
              Añadir mi primer addon
              <Plus size={16} />
            </button>
          }
        />
      )}
      <aside className="info-strip">
        <ShieldCheck size={21} />
        <div>
          <strong>Tú decides qué conectas.</strong>
          <p>
            Los addons los mantienen sus respectivos autores. Su configuración
            se guarda en este dispositivo.
          </p>
        </div>
      </aside>
      {installOpen && <InstallDialog onClose={() => setInstallOpen(false)} />}{" "}
      {removing && (
        <Dialog
          title={`Eliminar ${removing.manifest.name}`}
          onClose={() => setRemoving(null)}
          className="compact-dialog"
        >
          <span className="eyebrow">TUS ADDONS</span>
          <h2>¿Quitamos {removing.manifest.name}?</h2>
          <p>
            Este addon dejará de aparecer en Vela. Las historias de tu
            biblioteca y tu progreso se conservan.
          </p>
          <div className="form-actions">
            <button
              className="button secondary"
              onClick={() => setRemoving(null)}
            >
              Conservar addon
            </button>
            <button
              className="button danger"
              onClick={() => {
                preferencesStore.removeAddon(removing.manifestUrl);
                setRemoving(null);
              }}
            >
              Eliminar addon
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

function InstallDialog({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState("");
  const install = useMutation({
    mutationFn: () => loadManifest(url),
    onSuccess: (addon) => {
      preferencesStore.installAddon(addon);
      onClose();
    },
  });
  return (
    <Dialog title="Añadir addon" onClose={onClose} className="compact-dialog">
      <span className="dialog-emblem">
        <Link2 size={25} />
      </span>
      <span className="eyebrow">ABRE NUEVAS POSIBILIDADES</span>
      <h2>Un enlace. Más historias.</h2>
      <p>
        Pega la URL del addon que quieres instalar. Vela comprobará su
        información antes de añadirlo.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          install.mutate();
        }}
      >
        <label className="field-label" htmlFor="addon-url">
          URL del addon
        </label>
        <input
          id="addon-url"
          type="url"
          autoFocus
          data-autofocus
          autoComplete="off"
          spellCheck={false}
          required
          placeholder="https://tu-addon.com/manifest.json"
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            if (install.isError) install.reset();
          }}
        />
        <span className="field-hint">
          Admite enlaces HTTPS y enlaces de instalación stremio://.
        </span>
        {install.isError && (
          <p className="form-error" role="alert">
            {errorMessage(install.error)}
          </p>
        )}
        <div className="form-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="button primary"
            disabled={install.isPending || !url.trim()}
            type="submit"
          >
            {install.isPending ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Plus size={16} />
            )}
            Instalar addon
          </button>
        </div>
      </form>
      <div className="dialog-footnote">
        <Check size={13} />
        Tu configuración permanece en este dispositivo.
      </div>
    </Dialog>
  );
}
