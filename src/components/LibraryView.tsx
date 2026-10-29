import { Library, List, LayoutGrid, Search, Trash2 } from "lucide-react";
import type { LibraryEntry } from "../lib/contracts";
import { useRouteState } from "../lib/navigation";
import { mediaKey, preferencesStore, usePreferences } from "../lib/store";
import { useUiSetting } from "../lib/ui";
import { clock, yearOf } from "../lib/utils";
import { inProgress, type OpenMedia } from "./HomeView";
import { cardKeys, MediaCard, typeLabel, type CardMenu } from "./MediaCard";
import { Artwork, EmptyState, Segmented } from "./Primitives";

type Filter = "all" | "continue" | "movie" | "series";
const sorts = ["recent", "watched", "title", "year"] as const;
const views = ["grid", "list"] as const;

function lastActivity(entry: LibraryEntry): number {
  return Math.max(entry.addedAt, entry.progress?.updatedAt || 0);
}

export function LibraryView({
  onOpen,
  onDiscover,
  onMenu,
}: {
  onOpen: OpenMedia;
  onDiscover: () => void;
  onMenu: CardMenu;
}) {
  const prefs = usePreferences();
  const [filter, setFilter] = useRouteState<Filter>("filter", "all");
  const [text, setText] = useRouteState<string>("text", "");
  const [sort, setSort] = useUiSetting("library.sort", "recent", sorts);
  const [view, setView] = useUiSetting("library.view", "grid", views);
  const everything = Object.values(prefs.library);
  // «Seguir viendo» also lists titles played without saving them (Stremio's temporary items).
  const all = everything.filter((entry) => entry.saved);
  const needle = text.trim().toLocaleLowerCase("es");
  const entries = (filter === "continue" ? everything : all)
    .filter((entry) =>
      filter === "all"
        ? true
        : filter === "continue"
          ? inProgress(entry)
          : entry.meta.type === filter,
    )
    .filter((entry) => !needle || entry.meta.name.toLocaleLowerCase("es").includes(needle))
    .sort((a, b) =>
      sort === "title"
        ? a.meta.name.localeCompare(b.meta.name, "es")
        : sort === "year"
          ? yearOf(b.meta).localeCompare(yearOf(a.meta))
          : sort === "watched"
            ? (b.progress?.updatedAt || 0) - (a.progress?.updatedAt || 0)
            : lastActivity(b) - lastActivity(a),
    );
  const counts = {
    all: all.length,
    continue: everything.filter(inProgress).length,
    movie: all.filter((entry) => entry.meta.type === "movie").length,
    series: all.filter((entry) => entry.meta.type === "series").length,
  };
  return (
    <div className="page">
      <header className="page-header">
        <h1>
          Biblioteca <span className="count">{all.length}</span>
        </h1>
        <div className="toolbar">
          <label className="filter-field">
            <Search size={14} />
            <input
              type="search"
              aria-label="Filtrar biblioteca"
              placeholder="Filtrar"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <label className="select">
            <span className="select-label">Orden</span>
            <select
              aria-label="Ordenar biblioteca"
              value={sort}
              onChange={(event) => setSort(event.target.value as (typeof sorts)[number])}
            >
              <option value="recent">Actividad reciente</option>
              <option value="watched">Visto recientemente</option>
              <option value="title">Título</option>
              <option value="year">Año</option>
            </select>
          </label>
          <Segmented
            label="Vista"
            value={view}
            onChange={setView}
            options={[
              { value: "grid", label: <LayoutGrid size={14} />, title: "Cuadrícula" },
              { value: "list", label: <List size={14} />, title: "Lista" },
            ]}
          />
        </div>
      </header>
      <div className="page-tabs" role="tablist" aria-label="Filtrar por tipo">
        {(
          [
            ["all", "Todo"],
            ["continue", "Seguir viendo"],
            ["movie", "Películas"],
            ["series", "Series"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={filter === value}
            className={filter === value ? "selected" : ""}
            onClick={() => setFilter(value)}
          >
            {label}
            <span className="tab-count">{counts[value]}</span>
          </button>
        ))}
      </div>
      {entries.length ? (
        view === "grid" ? (
          <div className="page-body">
            <div className="poster-grid comfortable" data-card-track>
              {entries.map((entry) => (
                <MediaCard
                  key={mediaKey(entry.meta.type, entry.meta.id)}
                  meta={entry.meta}
                  entry={entry}
                  removeLabel={entry.saved}
                  onOpen={() => onOpen(entry.meta, entry.addonUrl)}
                  onSources={() => onOpen(entry.meta, entry.addonUrl, true)}
                  onSave={() => preferencesStore.toggleMedia(entry.meta, entry.addonUrl)}
                  onMenu={onMenu}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="page-body">
            <div className="table" role="table" aria-label="Biblioteca">
              <div className="table-row table-head" role="row">
                <span role="columnheader">Título</span>
                <span role="columnheader">Tipo</span>
                <span role="columnheader">Año</span>
                <span role="columnheader">Progreso</span>
                <span role="columnheader">Añadido</span>
                <span role="columnheader" className="sr-only">Acciones</span>
              </div>
              <div data-card-track>
                {entries.map((entry) => {
                  const progress = entry.progress;
                  const percent = progress?.duration
                    ? Math.min(100, (progress.seconds / progress.duration) * 100)
                    : 0;
                  return (
                    <div className="table-row" role="row" key={mediaKey(entry.meta.type, entry.meta.id)}>
                      <span role="cell" className="table-title">
                        <button
                          data-card-focus
                          aria-label={`Ver ${entry.meta.name}`}
                          onKeyDown={cardKeys}
                          onClick={() => onOpen(entry.meta, entry.addonUrl)}
                        >
                          <Artwork src={entry.meta.poster} name={entry.meta.name} className="thumb" />
                          <span>{entry.meta.name}</span>
                        </button>
                      </span>
                      <span role="cell" className="muted">{typeLabel(entry.meta.type)}</span>
                      <span role="cell" className="muted tabular">{yearOf(entry.meta) || "—"}</span>
                      <span role="cell" className="muted tabular">
                        {progress && percent > 0 ? (
                          <span className="inline-progress" title={`${clock(progress.seconds)} / ${clock(progress.duration)}`}>
                            <span><span style={{ width: `${percent}%` }} /></span>
                            {Math.round(percent)}%
                          </span>
                        ) : (
                          "—"
                        )}
                      </span>
                      <span role="cell" className="muted tabular">
                        {new Date(entry.addedAt).toLocaleDateString("es", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </span>
                      <span role="cell" className="row-actions">
                        <button
                          className="icon-button"
                          aria-label={`Quitar ${entry.meta.name} de mi biblioteca`}
                          title="Quitar de la biblioteca"
                          onClick={() => preferencesStore.removeMedia(entry.meta.type, entry.meta.id)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )
      ) : (
        <EmptyState
          icon={<Library size={20} />}
          title={
            needle
              ? "Sin coincidencias"
              : filter === "continue"
                ? "Nada pendiente"
                : "La biblioteca está vacía"
          }
          description={
            needle
              ? "Ningún título guardado coincide con el filtro."
              : filter === "continue"
                ? "Los títulos que empieces a reproducir aparecerán aquí."
                : "Guarda películas y series desde sus detalles o con el botón + de cada cartel."
          }
          action={
            !needle && (
              <button className="button primary" onClick={onDiscover}>
                Explorar catálogos
              </button>
            )
          }
        />
      )}
    </div>
  );
}
