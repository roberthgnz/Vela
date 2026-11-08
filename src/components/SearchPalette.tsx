import { useDeferredValue, useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CornerDownLeft, History, Search, Star, X } from "lucide-react";
import type { InstalledAddon, MediaItem } from "../lib/contracts";
import { getCatalog, getCatalogSources, getMeta } from "../lib/protocol";
import { activeFilters, applySearchFilters, decades, noSearchFilters, type SearchFilters } from "../lib/searchFilters";
import { searchHistory, useSearchHistory } from "../lib/searchHistory";
import { usePrefetchTranslation, useTranslatedMeta } from "../lib/tmdb";
import { useContentCategories, useContentFilter, type ContentCategory } from "../lib/contentFilter";
import { useKidsMode } from "../lib/profiles";
import { mediaKey, usePreferences } from "../lib/store";
import { errorMessage, safeImage, yearOf } from "../lib/utils";
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


type Result = { meta: MediaItem; addon: InstalledAddon };

/** The title with the searched text marked, when it appears in it. */
function Highlight({ text, needle }: { text: string; needle: string }) {
  const lower = text.toLocaleLowerCase();
  const index = needle ? lower.indexOf(needle.toLocaleLowerCase()) : -1;
  // Lowercasing can change the length of some characters; then the positions would not match.
  if (index < 0 || lower.length !== text.length) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + needle.length)}</mark>
      {text.slice(index + needle.length)}
    </>
  );
}

/**
 * The highlighted result, larger: its backdrop, logo, facts and synopsis. Search results carry
 * little more than the name and the art, so the full entry is read from the addon once the
 * selection rests on it for a moment (the title page reuses it from the cache).
 */
function Preview({ meta: item, addon }: Result) {
  const key = mediaKey(item.type, item.id);
  const [ready, setReady] = useState<string>();
  useEffect(() => {
    const timer = setTimeout(() => setReady(key), 180);
    return () => clearTimeout(timer);
  }, [key]);
  const full = useQuery({
    queryKey: ["meta", addon.manifestUrl, item.type, item.id],
    queryFn: ({ signal }) => getMeta(addon, item.type, item.id, signal),
    enabled: ready === key && addon.manifest.id !== "saved",
  });
  const { meta, translated } = useTranslatedMeta(full.data ?? item);
  const [failedLogo, setFailedLogo] = useState<string>();
  // Logos carry the original name: a translated title is written out instead.
  const logoUrl = translated ? undefined : safeImage(meta.logo);
  const logo = logoUrl && logoUrl !== failedLogo ? logoUrl : undefined;
  const art = safeImage(meta.background || item.background || meta.poster);
  const facts = [typeLabel(meta.type), yearOf(meta), meta.runtime].filter(Boolean);
  const loading = !meta.description && (ready !== key || full.isFetching);
  return (
    <aside className="palette-preview" aria-hidden="true">
      <div className="palette-preview-art">{art && <img src={art} alt="" key={art} draggable={false} />}</div>
      <div className="palette-preview-body" key={key}>
        {logo ? (
          <img className="palette-preview-logo" src={logo} alt="" draggable={false} onError={() => setFailedLogo(logo)} />
        ) : (
          <strong className="palette-preview-title">{meta.name}</strong>
        )}
        <div className="facts">
          {facts.map((fact) => (
            <span key={fact}>{fact}</span>
          ))}
          {meta.imdbRating && (
            <span className="rating">
              <Star size={11} fill="currentColor" /> {meta.imdbRating}
            </span>
          )}
        </div>
        {meta.genres?.length ? (
          <div className="genres">
            {meta.genres.slice(0, 3).map((genre) => (
              <span key={genre}>{genre}</span>
            ))}
          </div>
        ) : null}
        {meta.description ? (
          <p>{meta.description}</p>
        ) : loading ? (
          <div className="palette-preview-lines">
            <span className="skeleton skeleton-line" />
            <span className="skeleton skeleton-line" />
            <span className="skeleton skeleton-line short" />
          </div>
        ) : null}
        <span className="palette-preview-hint">
          <kbd>{t("search.enterKey")}</kbd> {t("search.open")} · {addon.manifest.name}
        </span>
      </div>
    </aside>
  );
}

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
  const prefetch = usePrefetchTranslation();
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
  // The result the preview shows: the one under the pointer or the focus, else the first.
  const [activeKey, setActiveKey] = useState<string>();
  const results = search.length >= 2 ? groups.flatMap((group) => group.items) : [];
  const active = results.find(({ meta }) => mediaKey(meta.type, meta.id) === activeKey) ?? results[0];
  return (
    <Dialog
      title={t("common.search")}
      className={`palette${active ? " with-preview" : ""}`}
      onClose={onClose}
      hideClose
    >
      <div className="palette-main">
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
              const root = event.currentTarget.closest(".palette");
              (
                root?.querySelector<HTMLElement>("[data-palette-item].active") ??
                root?.querySelector<HTMLElement>("[data-palette-item]")
              )?.click();
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
                      className={`palette-item result${active?.meta === meta ? " active" : ""}`}
                      data-palette-item
                      aria-label={t("library.open", { name: meta.name })}
                      onPointerEnter={() => {
                        prefetch(meta);
                        setActiveKey(mediaKey(meta.type, meta.id));
                      }}
                      onFocus={() => {
                        prefetch(meta);
                        setActiveKey(mediaKey(meta.type, meta.id));
                      }}
                      onKeyDown={moveFocus}
                      onClick={() => {
                        searchHistory.add(search);
                        onClose();
                        onOpen(meta, addon);
                      }}
                    >
                      <Artwork src={meta.poster} name={meta.name} className="thumb" />
                      <span className="palette-text">
                        <strong>
                          <Highlight text={meta.name} needle={search} />
                        </strong>
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
      </div>
      {active && <Preview key={mediaKey(active.meta.type, active.meta.id)} {...active} />}
    </Dialog>
  );
}
