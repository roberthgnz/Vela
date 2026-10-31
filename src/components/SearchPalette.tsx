import { useDeferredValue, useState, type KeyboardEvent, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CornerDownLeft, History, Search, X } from "lucide-react";
import type { InstalledAddon, MediaItem } from "../lib/contracts";
import { getCatalog, getCatalogSources } from "../lib/protocol";
import { activeFilters, applySearchFilters, decades, noSearchFilters, type SearchFilters } from "../lib/searchFilters";
import { searchHistory, useSearchHistory } from "../lib/searchHistory";
import { useContentCategories, useContentFilter, type ContentCategory } from "../lib/contentFilter";
import { useKidsMode } from "../lib/profiles";
import { mediaKey, usePreferences } from "../lib/store";
import { errorMessage, yearOf } from "../lib/utils";
import { typeLabel } from "./MediaCard";
import { Artwork, Dialog, EmptyState, ErrorState, Spinner } from "./Primitives";
import { plural, t } from "../lib/i18n";

export type Command = {
  id: string;
  label: string;
  icon: ReactNode;
  shortcut?: string;
  run: () => void;
};


function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const root = event.currentTarget.closest(".palette");
  if (!root) return;
  const items = [...root.querySelectorAll<HTMLElement>("[data-palette-item]")];
  const input = root.querySelector<HTMLElement>("input");
  const index = items.indexOf(document.activeElement as HTMLElement);
  event.preventDefault();
  if (event.key === "ArrowDown") (items[index + 1] || items[0])?.focus();
  else if (index <= 0) input?.focus();
  else items[index - 1]?.focus();
}

export function SearchPalette({
  onClose,
  onOpen,
  commands,
  initialQuery = "",
}: {
  /** Text to search for as soon as the palette opens (a person from the credits, for example). */
  initialQuery?: string;
  onClose: () => void;
  onOpen: (meta: MediaItem, addon: InstalledAddon) => void;
  commands: Command[];
}) {
  const prefs = usePreferences();
  const [input, setInput] = useState(initialQuery);
  const recent = useSearchHistory();
  const search = useDeferredValue(input.trim());
  // A children's profile does not search: addon search results cannot be filtered by age.
  const kids = useKidsMode();
  const sources = getCatalogSources(prefs.addons).filter(
    (source) =>
      !kids &&
      (source.catalog.extra?.some((extra) => extra.name === "search") || source.catalog.extraSupported?.includes("search")),
  );
  const query = useQuery({
    queryKey: ["search", sources.map((source) => source.key), search],
    enabled: search.length >= 2,
    // Each keystroke is a new query; keeping the last results until the next ones arrive stops the
    // list from collapsing into skeletons and growing back while the user types.
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const results = await Promise.allSettled(
        sources.map(async (source) => ({
          source,
          items: await getCatalog(source, { search }, signal),
        })),
      );
      if (signal.aborted) throw new DOMException("Solicitud cancelada", "AbortError");
      const valid = results
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value);
      if (!valid.length && results.length)
        throw new Error(t("search.noResponse"));
      const found = new Set<string>();
      return valid
        .flatMap(({ source, items }) => items.map((meta) => ({ meta, addon: source.addon })))
        .filter(({ meta }) => {
          const key = mediaKey(meta.type, meta.id);
          if (found.has(key)) return false;
          found.add(key);
          return true;
        });
    },
  });
  const needle = input.trim().toLocaleLowerCase("es");
  const matchingCommands = commands.filter(
    (command) => !needle || command.label.toLocaleLowerCase("es").includes(needle),
  );
  const [filters, setFilters] = useState<SearchFilters>(noSearchFilters);
  const filter = (change: Partial<SearchFilters>) => setFilters((current) => ({ ...current, ...change }));
  const categories = useContentCategories();
  const [content, setContent] = useState<ContentCategory>("all");
  const allowed = useContentFilter(
    query.data ? applySearchFilters(query.data, filters) : [],
    ({ meta }) => meta,
    categories ? content : "all",
  );
  const filtered = query.data ? allowed.visible : undefined;
  const groups = filtered
    ? (["movie", "series"] as const)
        .map((type) => ({ type, items: filtered.filter(({ meta }) => meta.type === type) }))
        .concat([
          {
            type: "other" as never,
            items: filtered.filter(({ meta }) => meta.type !== "movie" && meta.type !== "series"),
          },
        ])
        .filter((group) => group.items.length)
    : [];
  return (
    <Dialog title={t("common.search")} className="palette" onClose={onClose} hideClose>
      <div className="palette-field">
        <Search size={17} />
        <input
          type="search"
          aria-label={t("app.searchPlaceholder")}
          placeholder={t("search.placeholder")}
          autoFocus
          data-autofocus
          autoComplete="off"
          spellCheck={false}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget
                .closest(".palette")
                ?.querySelector<HTMLElement>("[data-palette-item]")
                ?.click();
            } else moveFocus(event);
          }}
        />
        {query.isFetching && <Spinner />}
        <kbd>Esc</kbd>
      </div>
      <div className="palette-filters" role="group" aria-label={t("search.filters")}>
        <div className="palette-types" role="group" aria-label={t("search.type")}>
          {(
            [
              ["all", t("library.tab.all")],
              ["movie", t("nav.movies")],
              ["series", t("nav.series")],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              className={`chip ${filters.type === value ? "selected" : ""}`}
              aria-pressed={filters.type === value}
              onClick={() => filter({ type: value })}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          className="palette-select"
          aria-label={t("browse.filter.year")}
          value={filters.decade}
          data-active={Boolean(filters.decade) || undefined}
          onChange={(event) => filter({ decade: event.target.value })}
        >
          <option value="">{t("search.anyYear")}</option>
          {decades.map((decade) => (
            <option key={decade} value={decade}>
              {t("browse.decade", { short: decade.slice(2) })}
            </option>
          ))}
          <option value="older">{t("browse.before1980")}</option>
        </select>
        <select
          className="palette-select"
          aria-label={t("browse.filter.sort")}
          value={filters.sort}
          data-active={filters.sort !== "relevance" || undefined}
          onChange={(event) => filter({ sort: event.target.value as SearchFilters["sort"] })}
        >
          <option value="relevance">{t("search.sort.relevance")}</option>
          <option value="newest">{t("browse.sort.newest")}</option>
          <option value="oldest">{t("browse.sort.oldest")}</option>
        </select>
        {categories && (
          <select
            className="palette-select"
            aria-label={t("browse.content")}
            title={t("browse.contentTitle")}
            value={content}
            data-active={content !== "all" || undefined}
            onChange={(event) => setContent(event.target.value as ContentCategory)}
          >
            <option value="all">{t("search.allContent")}</option>
            <option value="sfw">{t("browse.content.sfw")}</option>
            <option value="nsfw">{t("browse.content.nsfw")}</option>
          </select>
        )}
        {(activeFilters(filters) > 0 || content !== "all") && (
          <button
            className="icon-button palette-clear"
            aria-label={t("browse.clearFilters")}
            title={t("browse.clearFilters")}
            onClick={() => {
              setFilters(noSearchFilters);
              setContent("all");
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>
      <div className="palette-body" aria-busy={query.isFetching} data-stale={query.isPlaceholderData || undefined}>
        {search.length >= 2 && (
          <>
            {query.isPending ? (
              Array.from({ length: 4 }, (_, index) => (
                <div className="palette-item skeleton-row" key={index} aria-hidden="true">
                  <span className="skeleton thumb" />
                  <span className="skeleton skeleton-line" />
                </div>
              ))
            ) : query.isError ? (
              <ErrorState message={errorMessage(query.error)} retry={() => void query.refetch()} />
            ) : groups.length ? (
              groups.map((group) => (
                <section key={group.type} aria-label={group.type === "series" ? t("nav.series") : group.type === "movie" ? t("nav.movies") : t("common.others")}>
                  <h3 className="palette-group">
                    {group.type === "series" ? t("nav.series") : group.type === "movie" ? t("nav.movies") : t("common.others")}
                    <span>{group.items.length}</span>
                  </h3>
                  {group.items.map(({ meta, addon }) => (
                    <button
                      key={mediaKey(meta.type, meta.id)}
                      className="palette-item"
                      data-palette-item
                      aria-label={t("library.open", { name: meta.name })}
                      onKeyDown={moveFocus}
                      onClick={() => {
                        searchHistory.add(search);
                        onClose();
                        onOpen(meta, addon);
                      }}
                    >
                      <Artwork src={meta.poster} name={meta.name} className="thumb" />
                      <span className="palette-text">
                        <strong>{meta.name}</strong>
                        <small>
                          {[typeLabel(meta.type), yearOf(meta), meta.imdbRating && `★ ${meta.imdbRating}`, addon.manifest.name]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                      </span>
                      <CornerDownLeft size={14} className="palette-enter" />
                    </button>
                  ))}
                </section>
              ))
            ) : (
              allowed.pending ? (
                <div className="palette-item skeleton-row" aria-hidden="true">
                  <span className="skeleton thumb" />
                  <span className="skeleton skeleton-line" />
                </div>
              ) : query.data?.length && (activeFilters(filters) || content !== "all" || allowed.limited) ? (
                <EmptyState
                  compact
                  icon={<Search size={18} />}
                  title={t("search.noFilteredResults")}
                  description={plural(query.data.length, "search.unfilteredCount.one", "search.unfilteredCount.other", { query: search })}
                  action={
                    <button
                      className="button secondary small"
                      onClick={() => {
                        setFilters(noSearchFilters);
                        setContent("all");
                      }}
                    >
                      {t("browse.clearFilters")}
                    </button>
                  }
                />
              ) : (
                <EmptyState
                  compact
                  icon={<Search size={18} />}
                  title={t("search.noResults")}
                  description={
                    sources.length
                      ? t("search.noCatalogResults", { query: search })
                      : t("search.noSearchCatalogs")
                  }
                />
              )
            )}
          </>
        )}
        {!input.trim() && recent.length > 0 && (
          <section aria-label={t("search.recentSearches")}>
            <h3 className="palette-group">
              {t("search.recent")}
              <button className="link-button palette-forget" onClick={() => searchHistory.clear()}>
                {t("search.clearHistory")}
              </button>
            </h3>
            {recent.map((text) => (
              <div className="palette-recent" key={text}>
                <button
                  className="palette-item command"
                  data-palette-item
                  aria-label={t("search.searchFor", { text })}
                  onKeyDown={moveFocus}
                  onClick={(event) => {
                    setInput(text);
                    event.currentTarget.closest(".palette")?.querySelector<HTMLElement>("input")?.focus();
                  }}
                >
                  <span className="palette-icon">
                    <History size={15} />
                  </span>
                  <span className="palette-text">
                    <strong>{text}</strong>
                  </span>
                </button>
                <button
                  className="icon-button palette-remove"
                  aria-label={t("search.removeFromHistoryName", { text })}
                  title={t("search.removeFromHistory")}
                  onClick={() => searchHistory.remove(text)}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </section>
        )}
        {matchingCommands.length > 0 && (
          <section aria-label={t("search.commands")}>
            <h3 className="palette-group">{t("search.goTo")}</h3>
            {matchingCommands.map((command) => (
              <button
                key={command.id}
                className="palette-item command"
                data-palette-item
                onKeyDown={moveFocus}
                onClick={() => {
                  onClose();
                  command.run();
                }}
              >
                <span className="palette-icon">{command.icon}</span>
                <span className="palette-text">
                  <strong>{command.label}</strong>
                </span>
                {command.shortcut && <kbd>{command.shortcut}</kbd>}
              </button>
            ))}
          </section>
        )}
        {search.length < 2 && !matchingCommands.length && (
          <EmptyState compact icon={<Search size={18} />} title={t("search.typeMore")} description={t("search.typeMoreDescription")} />
        )}
      </div>
      <footer className="palette-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> {t("search.navigate")}</span>
        <span><kbd>{t("search.enterKey")}</kbd> {t("search.open")}</span>
        <span><kbd>Esc</kbd> {t("search.close")}</span>
      </footer>
    </Dialog>
  );
}
