import { ArrowDown, ArrowUp } from "lucide-react";
import { homeRows, moveRow, renameRow, toggleRow } from "../lib/catalogLayout";
import { getCatalogSources } from "../lib/protocol";
import { preferencesStore, usePreferences } from "../lib/store";
import { Switch } from "./Primitives";
import { t } from "../lib/i18n";

const typeLabel: Record<string, string> = { movie: t("common.movies"), series: t("common.seriesPlural"), channel: t("common.channels"), tv: t("common.tv") };

/** Home catalogs of the active profile: order, visibility and names. */
export function CatalogSettings() {
  const prefs = usePreferences();
  const layout = prefs.catalogs;
  const rows = homeRows(getCatalogSources(prefs.addons), layout);
  const custom = layout.order.length > 0 || Object.keys(layout.hidden).length > 0 || Object.keys(layout.names).length > 0;
  if (!rows.length) {
    return (
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-text">
            <p>{t("catalogSettings.empty")}</p>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="settings-card">
      <ol className="catalog-list" aria-label={t("catalogSettings.list")}>
        {rows.map((row, index) => (
          <li key={row.source.key} className={`catalog-item ${row.visible ? "" : "hidden"}`}>
            <div className="catalog-move">
              <button
                className="icon-button small"
                aria-label={t("catalogSettings.moveUp", { title: row.title })}
                disabled={index === 0}
                onClick={() => preferencesStore.setCatalogLayout(moveRow(rows, layout, row.source.key, -1))}
              >
                <ArrowUp size={14} />
              </button>
              <button
                className="icon-button small"
                aria-label={t("catalogSettings.moveDown", { title: row.title })}
                disabled={index === rows.length - 1}
                onClick={() => preferencesStore.setCatalogLayout(moveRow(rows, layout, row.source.key, 1))}
              >
                <ArrowDown size={14} />
              </button>
            </div>
            <div className="catalog-name">
              <input
                className="input"
                aria-label={t("catalogSettings.name", { title: row.defaultTitle })}
                // Keyed by the stored name so a reset elsewhere refreshes the field.
                key={layout.names[row.source.key] ?? ""}
                defaultValue={layout.names[row.source.key] ?? ""}
                placeholder={row.defaultTitle}
                maxLength={80}
                onBlur={(event) => preferencesStore.setCatalogLayout(renameRow(layout, row.source.key, event.currentTarget.value))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              <small>
                {row.source.addon.manifest.name} · {typeLabel[row.source.catalog.type] ?? row.source.catalog.type}
              </small>
            </div>
            <Switch
              checked={row.visible}
              label={t("catalogSettings.show", { title: row.title })}
              onChange={() => preferencesStore.setCatalogLayout(toggleRow(layout, row))}
            />
          </li>
        ))}
      </ol>
      <div className="settings-row">
        <div className="settings-row-text">
          <p>{t("catalogSettings.hint")}</p>
        </div>
        <button
          className="button secondary"
          disabled={!custom}
          onClick={() => preferencesStore.setCatalogLayout({ order: [], hidden: {}, names: {} })}
        >
          {t("catalogSettings.reset")}
        </button>
      </div>
    </div>
  );
}
