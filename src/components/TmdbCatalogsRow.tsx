import { loadManifest } from "../lib/protocol";
import { preferencesStore, usePreferences } from "../lib/store";
import { useTmdbConfigured } from "../lib/tmdb";
import { TMDB_CATALOGS_URL } from "../lib/tmdbCatalogs";
import { Switch } from "./Primitives";
import { t } from "../lib/i18n";

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
        <span className="settings-row-label">{t("home.tmdbCatalogs")}</span>
        <p>
          {t("home.tmdbCatalogsDescription")}
          {!configured && ` ${t("home.tmdbNeedsKey")}`}
        </p>
      </div>
      <Switch checked={on} label={t("home.tmdbCatalogs")} onChange={() => void toggle()} />
    </div>
  );
}
