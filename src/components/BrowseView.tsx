import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { LayoutGrid, Grid3X3, Puzzle } from "lucide-react";
import { catalogTitle } from "../lib/catalogLayout";
import { useKidsMode } from "../lib/profiles";
import { kidsCatalog } from "../lib/tmdbCatalogs";
import type { CatalogSource } from "../lib/contracts";
import { useRouteState } from "../lib/navigation";
import { browsable, catalogFilters, getCatalog, getCatalogSources, nextCatalogSkip } from "../lib/protocol";
import { activeFilters, applySearchFilters, decades, noSearchFilters, type SearchFilters } from "../lib/searchFilters";
import { useContentCategories, useContentFilter, type ContentCategory } from "../lib/contentFilter";
import { CINEMETA_PAGE, decadeCatalogs, mergeByPopularity, type YearCatalogs } from "../lib/decadeCatalog";
import { mediaKey, preferencesStore, usePreferences } from "../lib/store";
import { useUiSetting } from "../lib/ui";
import { errorMessage } from "../lib/utils";
import type { OpenMedia } from "./HomeView";
import { MediaCard, PosterSkeletons, type CardMenu } from "./MediaCard";
import { EmptyState, ErrorState, Segmented, Spinner } from "./Primitives";
import { plural, t } from "../lib/i18n";

const densities = ["comfortable", "compact"] as const;

const filterNames: Record<string, string> = { genre: t("browse.filter.genre"), year: t("browse.filter.year"), sort: t("browse.filter.sort"), language: t("browse.filter.language"), country: t("browse.filter.country") };

function filterLabel(name: string, options: string[] = []): string {
  // Cinemeta's «by year» catalogs offer years through their `genre` extra.
  if (options.length && options.every((option) => /^\d{4}$/.test(option))) return t("browse.filter.year");
  return filterNames[name] ?? name.charAt(0).toLocaleUpperCase("es") + name.slice(1);
}

/** Pages loaded in a row while the filters hide every title, before waiting for «Cargar más». */
const FILTERED_AUTOLOAD_PAGES = 12;
/** Titles shown (and rated, when the profile or the filter needs it) at a time; more on scroll. */
const BATCH = 60;

export function DensityToggle({
  value,
  onChange,
}: {
  value: (typeof densities)[number];
  onChange: (value: (typeof densities)[number]) => void;
}) {
  return (
    <Segmented
      label={t("browse.posterSize")}
      value={value}
      onChange={onChange}
      options={[
        { value: "comfortable", label: <LayoutGrid size={14} />, title: t("browse.largePosters") },
        { value: "compact", label: <Grid3X3 size={14} />, title: t("browse.smallPosters") },
      ]}
    />
  );
}

export function BrowseView({
  type,
  onOpen,
  onAddons,
  onMenu,
}: {
  type: "movie" | "series";
  onOpen: OpenMedia;
  onAddons: () => void;
  onMenu: CardMenu;
}) {
  const prefs = usePreferences();
  const kids = useKidsMode();
  const sources = getCatalogSources(prefs.addons, type).filter((source) => browsable(source.catalog) && (!kids || kidsCatalog(source))).sort(
    (a, b) =>
      Number(b.addon.manifest.id === "com.linvo.cinemeta") -
      Number(a.addon.manifest.id === "com.linvo.cinemeta"),
  );
  const [sourceKey, setSourceKey] = useRouteState<string>("catalog", "");
  const [filterState, setFilterState] = useRouteState<string>("filters", "{}");
  const [density, setDensity] = useUiSetting("density", "comfortable", densities);
  const [decade, setDecade] = useRouteState<string>("decade", "");
  const [minRating, setMinRating] = useRouteState<number>("rating", 0);
  const [order, setOrder] = useRouteState<string>("order", "relevance");
  const categories = useContentCategories();
  const [contentChoice, setContent] = useRouteState<string>("content", "all");
  const content: ContentCategory = categories && (contentChoice === "sfw" || contentChoice === "nsfw") ? contentChoice : "all";
  const refine: SearchFilters = {
    ...noSearchFilters,
    decade,
    rating: minRating,
    sort: (["relevance", "newest", "oldest", "rating"] as const).find((value) => value === order) ?? "relevance",
  };
  const source = sources.find((item) => item.key === sourceKey) || sources[0];
  const filters = source ? catalogFilters(source.catalog) : [];
  const chosen = (() => {
    try {
      return JSON.parse(filterState) as Record<string, string>;
    } catch {
      return {};
    }
  })();
  // Required filters always have a value: the catalog's first option until the user picks one.
  const values = Object.fromEntries(
    filters.flatMap((filter) => {
      const value = filter.options.includes(chosen[filter.name]) ? chosen[filter.name] : filter.required ? filter.options[0] : "";
      return value ? [[filter.name, value]] : [];
    }),
  );
  const toTop = () => document.getElementById("main")?.scrollTo({ top: 0 });
  const title = type === "movie" ? t("nav.movies") : t("nav.series");
  return (
    <div className="page">
      <header className="page-header">
        <h1>{title}</h1>
        <div className="toolbar">
          {source && (
            <label className="select">
              <span className="select-label">{t("browse.catalog")}</span>
              <select
                aria-label={t("browse.catalog")}
                value={source.key}
                onChange={(event) => {
                  setSourceKey(event.target.value);
                  setFilterState("{}");
                  toTop();
                }}
              >
                {sources.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.addon.manifest.name} · {catalogTitle(item, prefs.catalogs)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {filters.map((filter) => (
            <label className="select" key={filter.name}>
              <span className="select-label">{filterLabel(filter.name, filter.options)}</span>
              <select
                aria-label={filterLabel(filter.name, filter.options)}
                value={values[filter.name] ?? ""}
                onChange={(event) => {
                  setFilterState(JSON.stringify({ ...values, [filter.name]: event.target.value }));
                  toTop();
                }}
              >
                {!filter.required && <option value="">{t("browse.all")}</option>}
                {filter.options.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {!filters.some((filter) => filterLabel(filter.name, filter.options) === t("browse.filter.year")) && (
            <label className="select">
              <span className="select-label">{t("browse.filter.year")}</span>
              <select aria-label={t("browse.filter.year")} value={decade} onChange={(event) => setDecade(event.target.value)}>
                <option value="">{t("browse.all")}</option>
                {decades.map((value) => (
                  <option key={value} value={value}>
                    {t("browse.decade", { short: value.slice(2) })}
                  </option>
                ))}
                <option value="older">{t("browse.before1980")}</option>
              </select>
            </label>
          )}
          <label className="select">
            <span className="select-label">{t("browse.rating")}</span>
            <select aria-label={t("browse.rating")} value={String(minRating)} onChange={(event) => setMinRating(Number(event.target.value))}>
              <option value="0">{t("browse.allRatings")}</option>
              {[6, 7, 8].map((value) => (
                <option key={value} value={value}>
                  {t("browse.ratingAtLeast", { value })}
                </option>
              ))}
            </select>
          </label>
          <label className="select">
            <span className="select-label">{t("browse.filter.sort")}</span>
            <select
              aria-label={t("browse.filter.sort")}
              title={t("browse.sortTitle")}
              value={refine.sort}
              onChange={(event) => setOrder(event.target.value)}
            >
              <option value="relevance">{t("browse.sort.relevance")}</option>
              <option value="newest">{t("browse.sort.newest")}</option>
              <option value="oldest">{t("browse.sort.oldest")}</option>
              <option value="rating">{t("browse.sort.rating")}</option>
            </select>
          </label>
          {categories && (
            <label className="select">
              <span className="select-label">{t("browse.content")}</span>
              <select
                aria-label={t("browse.content")}
                title={t("browse.contentTitle")}
                value={content}
                onChange={(event) => setContent(event.target.value)}
              >
                <option value="all">{t("browse.content.all")}</option>
                <option value="sfw">{t("browse.content.sfw")}</option>
                <option value="nsfw">{t("browse.content.nsfw")}</option>
              </select>
            </label>
          )}
          {(activeFilters(refine) > 0 || content !== "all") && (
            <button
              className="link-button"
              onClick={() => {
                setDecade("");
                setMinRating(0);
                setOrder("relevance");
                setContent("all");
              }}
            >
              {t("browse.clearFilters")}
            </button>
          )}
          <DensityToggle value={density} onChange={setDensity} />
        </div>
      </header>
      {source ? (
        <CatalogGrid
          key={`${source.key}|${JSON.stringify(values)}|${decade}|${content}`}
          source={source}
          extra={values}
          byYear={decadeCatalogs(getCatalogSources(prefs.addons, type), source, decade, values)}
          refine={refine}
          content={content}
          density={density}
          onOpen={onOpen}
          onMenu={onMenu}
        />
      ) : (
        <EmptyState
          icon={<Puzzle size={20} />}
          title={t(type === "movie" ? "browse.noCatalogs.movie" : "browse.noCatalogs.series")}
          description={t("browse.noCatalogsDescription")}
          action={
            <button className="button primary" onClick={onAddons}>
              {t("home.manageAddons")}
            </button>
          }
        />
      )}
    </div>
  );
}

function CatalogGrid({
  source,
  extra,
  byYear,
  refine,
  content,
  density,
  onOpen,
  onMenu,
}: {
  source: CatalogSource;
  extra: Record<string, string>;
  /** For a decade of Cinemeta's popular catalog: its per-year catalogs, merged by popularity. */
  byYear?: YearCatalogs;
  /** SFW/NSFW choice, from TMDB's age ratings. */
  content: ContentCategory;
  /** Year, rating and order chosen in Vela, applied to the titles loaded so far. */
  refine: SearchFilters;
  density: string;
  onOpen: OpenMedia;
  onMenu: CardMenu;
}) {
  const prefs = usePreferences();
  const sentinel = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(BATCH);
  const supportsSkip =
    source.catalog.extra?.some((extra) => extra.name === "skip") ||
    source.catalog.extraSupported?.includes("skip");
  const query = useInfiniteQuery({
    queryKey: byYear ? ["browse-years", byYear.source.key, byYear.years] : ["browse", source.key, extra],
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      if (!byYear) return getCatalog(source, { extra, skip: pageParam || undefined }, signal);
      // All the years at once; a year that fails only leaves a gap.
      const years = await Promise.allSettled(
        byYear.years.map((year) => getCatalog(byYear.source, { extra: { genre: year }, skip: pageParam || undefined }, signal)),
      );
      const pages = years.filter((year) => year.status === "fulfilled").map((year) => year.value);
      if (!pages.length) throw (years[0] as PromiseRejectedResult).reason;
      return mergeByPopularity(pages);
    },
    // With the years, another page may follow while they still fill a page between them (an
    // empty page ends the list).
    getNextPageParam: (last, pages, lastParam) =>
      byYear
        ? last.length >= CINEMETA_PAGE
          ? lastParam + CINEMETA_PAGE
          : undefined
        : nextCatalogSkip(pages, Boolean(supportsSkip)),
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const seen = new Set<string>();
  const loaded = (query.data?.pages.flat() || []).filter((meta) => {
    const key = mediaKey(meta.type, meta.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const refined = activeFilters(refine) > 0 ? applySearchFilters(loaded.map((meta) => ({ meta })), refine).map(({ meta }) => meta) : loaded;
  // Titles are shown (and, when they need an age rating, rated) a batch at a time, in order, as
  // the user scrolls: a decade brings hundreds of titles at once, and rating or drawing them all
  // made the first ones wait for the rest.
  const considered = refined.slice(0, shown);
  const allowed = useContentFilter(considered, (meta) => meta, content);
  const moreToShow = shown < refined.length;
  const items = allowed.visible;
  const refining = activeFilters(refine) > 0 || content !== "all" || allowed.limited;
  // While the filters hide (almost) everything, more pages load on their own, up to a limit.
  const autoLoad = !refining || items.length > 0 || (query.data?.pages.length ?? 0) < FILTERED_AUTOLOAD_PAGES;
  const pending = allowed.pending > 0;
  useEffect(() => {
    const node = sentinel.current;
    if (!node || (!moreToShow && (!hasNextPage || !autoLoad))) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        // Waits for the ratings in flight before asking for more titles.
        if (!entry.isIntersecting || pending || isFetchingNextPage) return;
        if (moreToShow) setShown((value) => value + BATCH);
        else void fetchNextPage();
      },
      // The content scrolls inside #main, which clips: with the viewport as root, the margin never
      // applied and the end of the list had to be on screen before anything more loaded.
      { root: document.getElementById("main"), rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
    // `shown` and the number of titles re-create the observer after each batch or page: it only
    // reports changes, so while the end of the list stays in view nothing else would ask for more.
  }, [autoLoad, hasNextPage, isFetchingNextPage, fetchNextPage, moreToShow, pending, shown, loaded.length]);
  if (query.isError && !items.length)
    return (
      <div className="page-body">
        <ErrorState
          title={t("browse.loadError")}
          message={errorMessage(query.error)}
          retry={() => void query.refetch()}
        />
      </div>
    );
  if (query.isSuccess && loaded.length && !items.length && !hasNextPage && !pending && !moreToShow)
    return (
      <EmptyState
        title={t("browse.noMatches")}
        description={plural(loaded.length, "browse.noMatchesDescription.one", "browse.noMatchesDescription.other")}
      />
    );
  if (query.isSuccess && !loaded.length)
    return (
      <EmptyState
        title={t("browse.empty")}
        description={t("browse.emptyDescription")}
      />
    );
  return (
    <div className="page-body">
      <div className={`poster-grid ${density}`} data-card-track>
        {query.isPending || (!items.length && (pending || moreToShow || query.isFetchingNextPage)) ? (
          <PosterSkeletons count={18} />
        ) : (
          items.map((meta) => (
            <MediaCard
              key={mediaKey(meta.type, meta.id)}
              meta={meta}
              entry={prefs.library[mediaKey(meta.type, meta.id)]}
              onOpen={() => onOpen(meta, source.addon.manifestUrl)}
              onSources={() => onOpen(meta, source.addon.manifestUrl, true)}
              onSave={() => preferencesStore.toggleMedia(meta, source.addon.manifestUrl)}
              onMenu={onMenu}
            />
          ))
        )}
      </div>
      {(query.hasNextPage || moreToShow) && (
        <div className="grid-footer" ref={sentinel}>
          <button
            className="button subtle"
            disabled={query.isFetchingNextPage || pending}
            onClick={() => (moreToShow ? setShown((value) => value + BATCH) : void query.fetchNextPage())}
          >
            {query.isFetchingNextPage || pending ? <Spinner /> : null}
            {pending ? t("browse.checkingRatings") : query.isFetchingNextPage ? t("browse.loading") : t("browse.loadMore")}
          </button>
        </div>
      )}
      {query.isError && items.length > 0 && (
        <ErrorState
          message={errorMessage(query.error)}
          retry={() => void query.fetchNextPage()}
        />
      )}
    </div>
  );
}
