import { loadManifest } from "../lib/protocol";
import { preferencesStore, usePreferences } from "../lib/store";
import { useTmdbConfigured } from "../lib/tmdb";
import { TMDB_CATALOGS_URL } from "../lib/tmdbCatalogs";
import { Switch } from "./Primitives";

/** Turns Vela's TMDB catalogs on or off (they are a built-in addon, listed in Addons too). */
export function TmdbCatalogsRow() {
  const prefs = usePreferences();
  const configured = useTmdbConfigured();
  const installed = prefs.addons.find((addon) => addon.manifestUrl === TMDB_CATALOGS_URL);
  const on = Boolean(installed?.enabled);
  const toggle = async () => {
    if (!installed) preferencesStore.installAddon(await loadManifest(TMDB_CATALOGS_URL));
    else preferencesStore.toggleAddon(TMDB_CATALOGS_URL);
  };
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-row-label">Catálogos de TMDB</span>
        <p>
          Tendencias, mejor valoradas, lo que hay en cada plataforma en tu país, «Recomendado para ti» según tu biblioteca y
          catálogos infantiles, en el idioma de arriba. Aparecen en Explorar; en Ajustes › Inicio eliges cuáles se ven en Inicio.
          {!configured && " Necesita una clave de TMDB."}
        </p>
      </div>
      <Switch checked={on} label="Catálogos de TMDB" onChange={() => void toggle()} />
    </div>
  );
}
