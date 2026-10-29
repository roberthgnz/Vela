import { useEffect, useRef } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { LayoutGrid, Grid3X3, Puzzle } from "lucide-react";
import { catalogTitle } from "../lib/catalogLayout";
import type { CatalogSource } from "../lib/contracts";
import { useRouteState } from "../lib/navigation";
import { browsable, catalogFilters, getCatalog, getCatalogSources, nextCatalogSkip } from "../lib/protocol";
import { mediaKey, preferencesStore, usePreferences } from "../lib/store";
import { useUiSetting } from "../lib/ui";
import { errorMessage } from "../lib/utils";
import type { OpenMedia } from "./HomeView";
import { MediaCard, PosterSkeletons, type CardMenu } from "./MediaCard";
import { EmptyState, ErrorState, Segmented, Spinner } from "./Primitives";

const densities = ["comfortable", "compact"] as const;

const filterNames: Record<string, string> = { genre: "Género", year: "Año", sort: "Orden", language: "Idioma", country: "País" };

function filterLabel(name: string): string {
  return filterNames[name] ?? name.charAt(0).toLocaleUpperCase("es") + name.slice(1);
}

export function DensityToggle({
  value,
  onChange,
}: {
  value: (typeof densities)[number];
  onChange: (value: (typeof densities)[number]) => void;
}) {
  return (
    <Segmented
      label="Tamaño de los carteles"
      value={value}
      onChange={onChange}
      options={[
        { value: "comfortable", label: <LayoutGrid size={14} />, title: "Carteles grandes" },
        { value: "compact", label: <Grid3X3 size={14} />, title: "Carteles pequeños" },
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
  const sources = getCatalogSources(prefs.addons, type).filter((source) => browsable(source.catalog)).sort(
    (a, b) =>
      Number(b.addon.manifest.id === "com.linvo.cinemeta") -
      Number(a.addon.manifest.id === "com.linvo.cinemeta"),
  );
  const [sourceKey, setSourceKey] = useRouteState<string>("catalog", "");
  const [filterState, setFilterState] = useRouteState<string>("filters", "{}");
  const [density, setDensity] = useUiSetting("density", "comfortable", densities);
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
  const title = type === "movie" ? "Películas" : "Series";
  return (
    <div className="page">
      <header className="page-header">
        <h1>{title}</h1>
        <div className="toolbar">
          {source && (
            <label className="select">
              <span className="select-label">Catálogo</span>
              <select
                aria-label="Catálogo"
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
              <span className="select-label">{filterLabel(filter.name)}</span>
              <select
                aria-label={filterLabel(filter.name)}
                value={values[filter.name] ?? ""}
                onChange={(event) => {
                  setFilterState(JSON.stringify({ ...values, [filter.name]: event.target.value }));
                  toTop();
                }}
              >
                {!filter.required && <option value="">Todos</option>}
                {filter.options.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <DensityToggle value={density} onChange={setDensity} />
        </div>
      </header>
      {source ? (
        <CatalogGrid
          key={`${source.key}|${JSON.stringify(values)}`}
          source={source}
          extra={values}
          density={density}
          onOpen={onOpen}
          onMenu={onMenu}
        />
      ) : (
        <EmptyState
          icon={<Puzzle size={20} />}
          title={`No hay catálogos de ${title.toLowerCase()}`}
          description="Activa o instala un addon que publique este tipo de catálogo."
          action={
            <button className="button primary" onClick={onAddons}>
              Gestionar addons
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
  density,
  onOpen,
  onMenu,
}: {
  source: CatalogSource;
  extra: Record<string, string>;
  density: string;
  onOpen: OpenMedia;
  onMenu: CardMenu;
}) {
  const prefs = usePreferences();
  const sentinel = useRef<HTMLDivElement>(null);
  const supportsSkip =
    source.catalog.extra?.some((extra) => extra.name === "skip") ||
    source.catalog.extraSupported?.includes("skip");
  const query = useInfiniteQuery({
    queryKey: ["browse", source.key, extra],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => getCatalog(source, { extra, skip: pageParam || undefined }, signal),
    getNextPageParam: (_last, pages) => nextCatalogSkip(pages, Boolean(supportsSkip)),
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasNextPage) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const seen = new Set<string>();
  const items = (query.data?.pages.flat() || []).filter((meta) => {
    const key = mediaKey(meta.type, meta.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (query.isError && !items.length)
    return (
      <div className="page-body">
        <ErrorState
          title="No se pudo cargar el catálogo"
          message={errorMessage(query.error)}
          retry={() => void query.refetch()}
        />
      </div>
    );
  if (query.isSuccess && !items.length)
    return (
      <EmptyState
        title="Sin títulos"
        description="Este catálogo no devuelve resultados para el filtro actual."
      />
    );
  return (
    <div className="page-body">
      <div className={`poster-grid ${density}`} data-card-track>
        {query.isPending ? (
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
      {query.hasNextPage && (
        <div className="grid-footer" ref={sentinel}>
          <button
            className="button subtle"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? <Spinner /> : null}
            {query.isFetchingNextPage ? "Cargando" : "Cargar más"}
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
