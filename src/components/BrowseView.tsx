import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { LayoutGrid, Grid3X3, Puzzle } from "lucide-react";
import type { CatalogSource } from "../lib/contracts";
import { getCatalog, getCatalogSources } from "../lib/protocol";
import { mediaKey, preferencesStore, usePreferences } from "../lib/store";
import { useUiSetting } from "../lib/ui";
import { errorMessage } from "../lib/utils";
import type { OpenMedia } from "./HomeView";
import { MediaCard, PosterSkeletons, type CardMenu } from "./MediaCard";
import { EmptyState, ErrorState, Segmented, Spinner } from "./Primitives";

const densities = ["comfortable", "compact"] as const;

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
  const sources = getCatalogSources(prefs.addons, type).filter(
    (source) =>
      !(
        source.catalog.extra?.some(
          (extra) => extra.isRequired && extra.name !== "genre",
        ) || source.catalog.extraRequired?.some((extra) => extra !== "genre")
      ),
  ).sort(
    (a, b) =>
      Number(b.addon.manifest.id === "com.linvo.cinemeta") -
      Number(a.addon.manifest.id === "com.linvo.cinemeta"),
  );
  const [sourceKey, setSourceKey] = useState("");
  const [genre, setGenre] = useState("");
  const [density, setDensity] = useUiSetting("density", "comfortable", densities);
  const source = sources.find((item) => item.key === sourceKey) || sources[0];
  const genres =
    source?.catalog.extra?.find((extra) => extra.name === "genre")?.options || [];
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
                  setGenre("");
                }}
              >
                {sources.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.addon.manifest.name} · {item.catalog.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {genres.length > 0 && (
            <label className="select">
              <span className="select-label">Género</span>
              <select
                aria-label="Género"
                value={genre}
                onChange={(event) => setGenre(event.target.value)}
              >
                <option value="">Todos</option>
                {genres.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          )}
          <DensityToggle value={density} onChange={setDensity} />
        </div>
      </header>
      {source ? (
        <CatalogGrid
          key={`${source.key}|${genre}`}
          source={source}
          genre={genre}
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
  genre,
  density,
  onOpen,
  onMenu,
}: {
  source: CatalogSource;
  genre: string;
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
    queryKey: ["browse", source.key, genre],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      getCatalog(
        source,
        { genre: genre || undefined, skip: pageParam || undefined },
        signal,
      ),
    getNextPageParam: (last, pages) =>
      supportsSkip && last.length > 0
        ? pages.reduce((sum, page) => sum + page.length, 0)
        : undefined,
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
