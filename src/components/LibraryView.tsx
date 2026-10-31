import { useState } from "react";
import { Folder, Library, List, LayoutGrid, MoreHorizontal, Pencil, Plus, Search, Trash2 } from "lucide-react";
import type { LibraryEntry } from "../lib/contracts";
import { useRouteState } from "../lib/navigation";
import { mediaKey, preferencesStore, usePreferences } from "../lib/store";
import { useUiSetting } from "../lib/ui";
import { clock, yearOf } from "../lib/utils";
import { inProgress, type OpenMedia } from "./HomeView";
import { cardKeys, MediaCard, typeLabel, type CardMenu } from "./MediaCard";
import { CollectionNameDialog } from "./Collections";
import { anchorFrom, Artwork, Dialog, EmptyState, Segmented } from "./Primitives";
import { compareText, locale, t } from "../lib/i18n";

/** A type tab, or `c:<id>` for a collection. */
type Filter = "all" | "continue" | "movie" | "series" | `c:${string}`;
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
  const [chosen, setFilter] = useRouteState<Filter>("filter", "all");
  const [naming, setNaming] = useState<{ id?: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const collection = chosen.startsWith("c:") ? prefs.collections.find((item) => `c:${item.id}` === chosen) : undefined;
  // A collection deleted elsewhere (or in another profile) falls back to everything.
  const filter: Filter = chosen.startsWith("c:") && !collection ? "all" : chosen;
  const [text, setText] = useRouteState<string>("text", "");
  const [sort, setSort] = useUiSetting("library.sort", "recent", sorts);
  const [view, setView] = useUiSetting("library.view", "grid", views);
  const everything = Object.values(prefs.library);
  // «Seguir viendo» also lists titles played without saving them (Stremio's temporary items).
  const all = everything.filter((entry) => entry.saved);
  const needle = text.trim().toLocaleLowerCase("es");
  const entries = (filter === "continue" ? everything : all)
    .filter((entry) =>
      collection
        ? collection.keys.includes(mediaKey(entry.meta.type, entry.meta.id))
        : filter === "all"
          ? true
          : filter === "continue"
            ? inProgress(entry)
            : entry.meta.type === filter,
    )
    .filter((entry) => !needle || entry.meta.name.toLocaleLowerCase("es").includes(needle))
    .sort((a, b) =>
      sort === "title"
        ? compareText(a.meta.name, b.meta.name)
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
  const savedKeys = new Set(all.map((entry) => mediaKey(entry.meta.type, entry.meta.id)));
  const collectionMenu = (anchor: Parameters<CardMenu>[0], id: string, name: string) =>
    onMenu(
      anchor,
      [
        { label: t("collections.rename"), icon: <Pencil size={15} />, onSelect: () => setNaming({ id, name }) },
        { label: t("collections.delete"), icon: <Trash2 size={15} />, danger: true, onSelect: () => setDeleting({ id, name }) },
      ],
      t("collections.actions"),
    );
  return (
    <div className="page">
      <header className="page-header">
        <h1>
          {t("nav.library")} <span className="count">{all.length}</span>
        </h1>
        <div className="toolbar">
          <label className="filter-field">
            <Search size={14} />
            <input
              type="search"
              aria-label={t("library.filterLabel")}
              placeholder={t("library.filterPlaceholder")}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <label className="select">
            <span className="select-label">{t("browse.filter.sort")}</span>
            <select
              aria-label={t("library.sortLabel")}
              value={sort}
              onChange={(event) => setSort(event.target.value as (typeof sorts)[number])}
            >
              <option value="recent">{t("library.sort.recent")}</option>
              <option value="watched">{t("library.sort.watched")}</option>
              <option value="title">{t("library.sort.title")}</option>
              <option value="year">{t("library.sort.year")}</option>
            </select>
          </label>
          <Segmented
            label={t("library.view")}
            value={view}
            onChange={setView}
            options={[
              { value: "grid", label: <LayoutGrid size={14} />, title: t("library.grid") },
              { value: "list", label: <List size={14} />, title: t("library.list") },
            ]}
          />
        </div>
      </header>
      <div className="page-tabs" role="tablist" aria-label={t("library.filterByType")}>
        {(
          [
            ["all", t("library.tab.all")],
            ["continue", t("home.continueWatching")],
            ["movie", t("nav.movies")],
            ["series", t("nav.series")],
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
        {prefs.collections.length > 0 && <span className="tab-divider" aria-hidden="true" />}
        {prefs.collections.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={filter === `c:${item.id}`}
            className={`collection-tab ${filter === `c:${item.id}` ? "selected" : ""}`}
            onClick={() => setFilter(`c:${item.id}`)}
            onContextMenu={(event) => {
              event.preventDefault();
              collectionMenu({ x: event.clientX, y: event.clientY }, item.id, item.name);
            }}
          >
            <Folder size={13} aria-hidden="true" />
            {item.name}
            <span className="tab-count">{item.keys.filter((key) => savedKeys.has(key)).length}</span>
          </button>
        ))}
        {collection && (
          <button
            className="icon-button tab-more"
            aria-label={t("collections.actions")}
            title={t("collections.actions")}
            aria-haspopup="menu"
            onClick={(event) => collectionMenu(anchorFrom(event.currentTarget), collection.id, collection.name)}
          >
            <MoreHorizontal size={15} />
          </button>
        )}
        <button className="tab-add" onClick={() => setNaming({ name: "" })}>
          <Plus size={13} /> {t("collections.new")}
        </button>
      </div>
      {naming && (
        <CollectionNameDialog
          title={naming.id ? t("collections.rename") : t("collections.new")}
          initial={naming.name}
          submitLabel={naming.id ? t("common.save") : t("collections.create")}
          onSubmit={(name) => {
            if (naming.id) preferencesStore.renameCollection(naming.id, name);
            else setFilter(`c:${preferencesStore.createCollection(name)}`);
          }}
          onClose={() => setNaming(null)}
        />
      )}
      {deleting && (
        <Dialog title={t("collections.delete")} onClose={() => setDeleting(null)} className="compact-dialog" hideClose>
          <h2>{t("collections.deleteConfirm", { name: deleting.name })}</h2>
          <p>{t("collections.deleteDescription")}</p>
          <div className="form-actions">
            <button className="button secondary" data-autofocus onClick={() => setDeleting(null)}>
              {t("common.cancel")}
            </button>
            <button
              className="button danger"
              onClick={() => {
                preferencesStore.deleteCollection(deleting.id);
                if (filter === `c:${deleting.id}`) setFilter("all");
                setDeleting(null);
              }}
            >
              {t("collections.delete")}
            </button>
          </div>
        </Dialog>
      )}
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
            <div className="table" role="table" aria-label={t("nav.library")}>
              <div className="table-row table-head" role="row">
                <span role="columnheader">{t("library.column.title")}</span>
                <span role="columnheader">{t("library.column.type")}</span>
                <span role="columnheader">{t("library.column.year")}</span>
                <span role="columnheader">{t("library.column.progress")}</span>
                <span role="columnheader">{t("library.column.added")}</span>
                <span role="columnheader" className="sr-only">{t("library.column.actions")}</span>
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
                          aria-label={t("library.open", { name: entry.meta.name })}
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
                        {new Date(entry.addedAt).toLocaleDateString(locale(), {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </span>
                      <span role="cell" className="row-actions">
                        <button
                          className="icon-button"
                          aria-label={t("library.removeName", { name: entry.meta.name })}
                          title={t("home.removeFromLibrary")}
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
          icon={collection ? <Folder size={20} /> : <Library size={20} />}
          title={
            needle
              ? t("library.noMatches")
              : collection
                ? t("collections.empty")
                : filter === "continue"
                  ? t("library.nothingInProgress")
                  : t("library.empty")
          }
          description={
            needle
              ? t("library.noMatchesDescription")
              : collection
                ? t("collections.emptyDescription")
                : filter === "continue"
                  ? t("library.nothingInProgressDescription")
                  : t("library.emptyDescription")
          }
          action={
            !needle && !collection && (
              <button className="button primary" onClick={onDiscover}>
                {t("library.explore")}
              </button>
            )
          }
        />
      )}
    </div>
  );
}
