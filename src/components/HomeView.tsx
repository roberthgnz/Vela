import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Puzzle, X } from "lucide-react";
import type { CatalogSource, LibraryEntry, MediaItem } from "../lib/contracts";
import { getCatalog, getCatalogSources } from "../lib/protocol";
import { mediaKey, preferencesStore, usePreferences } from "../lib/store";
import { clock, errorMessage, safeImage } from "../lib/utils";
import { cardKeys, MediaCard, PosterSkeletons, type CardMenu } from "./MediaCard";
import { EmptyState, ErrorState } from "./Primitives";

export type OpenMedia = (meta: MediaItem, addonUrl: string, sources?: boolean) => void;

function useOverflow(track: RefObject<HTMLDivElement | null>, ready: boolean) {
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const node = track.current;
    if (!node) return;
    const update = () =>
      setEdges({
        start: node.scrollLeft > 4,
        end: node.scrollLeft + node.clientWidth < node.scrollWidth - 4,
      });
    update();
    node.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => {
      node.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [track, ready]);
  return edges;
}

function Shelf({
  title,
  subtitle,
  onBrowse,
  children,
  ready,
  className = "",
}: {
  title: string;
  subtitle?: string;
  onBrowse?: () => void;
  children: ReactNode;
  ready: boolean;
  className?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const edges = useOverflow(track, ready);
  const page = (direction: number) =>
    track.current?.scrollBy({
      left: direction * track.current.clientWidth * 0.85,
      behavior: "smooth",
    });
  return (
    <section className={`shelf ${className}`} aria-label={title}>
      <header className="shelf-header">
        <h2>{title}</h2>
        {subtitle && <span className="shelf-subtitle">{subtitle}</span>}
        {onBrowse && (
          <button className="link-button" onClick={onBrowse}>
            Ver todo <ChevronRight size={14} />
          </button>
        )}
      </header>
      <div className="shelf-viewport">
        {edges.start && (
          <button
            className="shelf-nav start"
            aria-label={`Anterior en ${title}`}
            tabIndex={-1}
            onClick={() => page(-1)}
          >
            <ChevronLeft size={18} />
          </button>
        )}
        <div className="shelf-track" ref={track} data-card-track>
          {children}
        </div>
        {edges.end && (
          <button
            className="shelf-nav end"
            aria-label={`Siguiente en ${title}`}
            tabIndex={-1}
            onClick={() => page(1)}
          >
            <ChevronRight size={18} />
          </button>
        )}
      </div>
    </section>
  );
}

function CatalogShelf({
  source,
  title,
  onOpen,
  onBrowse,
  onMenu,
}: {
  source: CatalogSource;
  title: string;
  onOpen: OpenMedia;
  onBrowse?: () => void;
  onMenu: CardMenu;
}) {
  const prefs = usePreferences();
  const query = useQuery({
    queryKey: ["catalog", source.key, ""],
    queryFn: ({ signal }) => getCatalog(source, {}, signal),
  });
  if (query.isSuccess && !query.data.length) return null;
  return (
    <Shelf
      title={title}
      subtitle={source.addon.manifest.name}
      onBrowse={onBrowse}
      ready={query.isSuccess}
    >
      {query.isPending ? (
        <PosterSkeletons count={10} />
      ) : query.isError ? (
        <ErrorState
          message={errorMessage(query.error)}
          retry={() => void query.refetch()}
        />
      ) : (
        query.data.slice(0, 24).map((meta) => (
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
    </Shelf>
  );
}

function episodeLabel(entry: LibraryEntry): string {
  const match = entry.progress?.videoId.match(/:(\d+):(\d+)$/);
  return match ? `T${match[1]} · E${match[2]}` : "";
}

function ContinueCard({
  entry,
  onOpen,
}: {
  entry: LibraryEntry;
  onOpen: OpenMedia;
}) {
  const progress = entry.progress!;
  const percent = Math.min(100, (progress.seconds / progress.duration) * 100);
  const image = safeImage(entry.meta.background || entry.meta.poster);
  const remaining = Math.max(0, progress.duration - progress.seconds);
  return (
    <article className="continue-card">
      <button
        className="continue-button"
        data-card-focus
        aria-label={`Continuar ${entry.meta.name}`}
        onClick={() => onOpen(entry.meta, entry.addonUrl, true)}
        onKeyDown={cardKeys}
      >
        <span className="continue-art">
          {image && <img src={image} alt="" loading="lazy" draggable={false} />}
        </span>
        <span className="continue-text">
          <strong>{entry.meta.name}</strong>
          <small>
            {[episodeLabel(entry), `Quedan ${clock(remaining)}`]
              .filter(Boolean)
              .join(" · ")}
          </small>
        </span>
        <span className="card-progress">
          <span style={{ width: `${percent}%` }} />
        </span>
      </button>
      <button
        className="continue-dismiss"
        aria-label={`Quitar ${entry.meta.name} de seguir viendo`}
        title="Quitar de Seguir viendo"
        tabIndex={-1}
        onClick={() => preferencesStore.removeMedia(entry.meta.type, entry.meta.id)}
      >
        <X size={13} />
      </button>
    </article>
  );
}

export function inProgress(entry: LibraryEntry): boolean {
  return Boolean(
    entry.progress &&
      entry.progress.duration > 0 &&
      entry.progress.seconds > 5 &&
      entry.progress.seconds < entry.progress.duration * 0.95,
  );
}

export function HomeView({
  onOpen,
  onBrowse,
  onAddons,
  onMenu,
}: {
  onOpen: OpenMedia;
  onBrowse: (type: "movie" | "series") => void;
  onAddons: () => void;
  onMenu: CardMenu;
}) {
  const prefs = usePreferences();
  const sources = getCatalogSources(prefs.addons).filter(
    (source) =>
      !source.catalog.extra?.some((extra) => extra.isRequired) &&
      !source.catalog.extraRequired?.length,
  );
  const cinemeta = sources.filter(
    (source) => source.addon.manifest.id === "com.linvo.cinemeta",
  );
  const movie =
    cinemeta.find((source) => source.catalog.type === "movie") ||
    sources.find((source) => source.catalog.type === "movie");
  const series =
    cinemeta.find((source) => source.catalog.type === "series") ||
    sources.find((source) => source.catalog.type === "series");
  const others = sources.filter((source) => source !== movie && source !== series);
  const continuing = Object.values(prefs.library)
    .filter(inProgress)
    .sort((a, b) => (b.progress?.updatedAt || 0) - (a.progress?.updatedAt || 0))
    .slice(0, 12);
  return (
    <div className="page home-page">
      <h1 className="sr-only">Inicio</h1>
      {continuing.length > 0 && (
        <Shelf title="Seguir viendo" ready className="continue-shelf">
          {continuing.map((entry) => (
            <ContinueCard
              key={mediaKey(entry.meta.type, entry.meta.id)}
              entry={entry}
              onOpen={onOpen}
            />
          ))}
        </Shelf>
      )}
      {movie && (
        <CatalogShelf
          source={movie}
          title="Películas populares"
          onOpen={onOpen}
          onBrowse={() => onBrowse("movie")}
          onMenu={onMenu}
        />
      )}
      {series && (
        <CatalogShelf
          source={series}
          title="Series populares"
          onOpen={onOpen}
          onBrowse={() => onBrowse("series")}
          onMenu={onMenu}
        />
      )}
      {others.slice(0, 8).map((source) => (
        <CatalogShelf
          key={source.key}
          source={source}
          title={source.catalog.name}
          onOpen={onOpen}
          onMenu={onMenu}
        />
      ))}
      {!sources.length && (
        <EmptyState
          icon={<Puzzle size={20} />}
          title="No hay catálogos activos"
          description="Activa o instala un addon con catálogos para explorar títulos."
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
