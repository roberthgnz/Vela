import { Children, isValidElement, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Bookmark,
  BookmarkCheck,
  Check,
  CheckCheck,
  Clapperboard,
  Circle,
  Eraser,
  Clipboard,
  ExternalLink,
  Globe,
  Magnet,
  MonitorPlay,
  MoreHorizontal,
  Play,
  Puzzle,
  RotateCw,
  Star,
  Users,
  SquarePlay,
} from "lucide-react";
import type {
  Episode,
  InstalledAddon,
  MediaItem,
  ResolvedStream,
} from "../lib/contracts";
import { episodeCode, isUpcoming, orderedEpisodes, videoProgress, watchedEpisodes } from "../lib/episodes";
import { getMeta, getStreams } from "../lib/protocol";
import { sourceHistory, sourceKey, useSourceMarks } from "../lib/sourceHistory";
import { useTranslatedMeta } from "../lib/tmdb";
import { useRouteState } from "../lib/navigation";
import { useUiSetting } from "../lib/ui";
import { mediaKey, preferencesStore, usePreferences } from "../lib/store";
import {
  kindLabel,
  qualityTier,
  qualityTiers,
  sortSources,
  type SourceOrder,
  streamDetail,
  streamFacts,
  streamLanguages,
  streamHeading,
  streamKind,
  streamQuality,
  streamTags,
  streamWarnings,
  type StreamKind,
} from "../lib/streams";
import { openExternal } from "../lib/transport";
import { addonHost, clock, errorMessage, motion, safeImage, yearOf } from "../lib/utils";
import { typeLabel } from "./MediaCard";
import {
  anchorFrom,
  Artwork,
  Dialog,
  EmptyState,
  ErrorState,
  Spinner,
  useMenu,
  type MenuAnchor,
} from "./Primitives";

export type PlayMode = "internal" | "external";
export type PlayHandler = (
  meta: MediaItem,
  addon: InstalledAddon,
  videoId: string,
  stream: ResolvedStream,
  mode: PlayMode,
  episode?: Episode,
) => Promise<void>;

const kindIcon: Record<StreamKind, typeof Play> = {
  direct: Play,
  hls: Play,
  torrent: Magnet,
  external: Globe,
  youtube: SquarePlay,
};

function formatDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" });
}

const upcoming = (episode: Episode) => isUpcoming(episode);

function markLabel(outcome: "opened" | "played" | "failed", last: boolean): string {
  if (last) return "Viendo";
  return outcome === "played" ? "Vista" : outcome === "failed" ? "Falló" : "Abierta";
}

function markText(outcome: "opened" | "played" | "failed", last: boolean, at: number): string {
  return `${markLabel(outcome, last)} ${relativeTime(at)}`;
}

function relativeTime(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "hace un momento";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `el ${new Date(at).toLocaleDateString("es", { day: "numeric", month: "short" })}`;
}

export function DetailView({
  meta: initial,
  addon,
  videoId: routeVideoId,
  season: routeSeason,
  startSources,
  onVideoChange,
  onSeasonChange,
  onSourcesChange,
  onPlay,
  onResume,
  onAddons,
  notify,
}: {
  meta: MediaItem;
  addon: InstalledAddon;
  onResume: () => void;
  videoId?: string;
  /** Season chosen in the episode list, kept in the history entry. */
  season?: number;
  startSources?: boolean;
  onVideoChange: (videoId: string) => void;
  onSeasonChange: (season: number) => void;
  onSourcesChange: (visible: boolean) => void;
  onPlay: PlayHandler;
  onAddons: () => void;
  notify: (message: string) => void;
}) {
  const prefs = usePreferences();
  const menu = useMenu();
  const panel = useRef<HTMLElement>(null);
  const metadata = useQuery({
    queryKey: ["meta", addon.manifestUrl, initial.type, initial.id],
    queryFn: ({ signal }) => getMeta(addon, initial.type, initial.id, signal),
    enabled: addon.manifest.id !== "saved",
  });
  const { meta, translated } = useTranslatedMeta(metadata.data || initial);
  const entry = prefs.library[mediaKey(meta.type, meta.id)];
  const saved = Boolean(entry?.saved);
  const isSeries = meta.type === "series";
  const episodes = meta.videos || [];
  const progressVideo = entry?.progress?.videoId;
  const initialEpisode =
    episodes.find((item) => item.id === routeVideoId) ||
    episodes.find((item) => item.id === progressVideo);
  const seasons = [...new Set(episodes.map((video) => video.season ?? 1))].sort(
    (a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b),
  );
  const season = routeSeason;
  const setSeason = onSeasonChange;
  const currentSeason =
    season !== undefined && seasons.includes(season)
      ? season
      : (initialEpisode?.season ?? seasons[0] ?? 1);
  const seasonEpisodes = episodes
    .filter((episode) => (episode.season ?? 1) === currentSeason)
    .sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
  // Whether the panel shows the sources of the selected episode is part of the history entry.
  const showSources = !isSeries || Boolean(startSources && (routeVideoId || progressVideo));
  const setShowSources = onSourcesChange;
  const selectedEpisode = isSeries
    ? episodes.find((item) => item.id === (routeVideoId || progressVideo))
    : undefined;
  const videoId = isSeries ? (showSources ? selectedEpisode?.id : undefined) : meta.id;
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [trailer, setTrailer] = useState<number | null>(null);
  const backdrop = safeImage(meta.background || meta.poster);
  const chooseEpisode = (episode: Episode) => {
    onVideoChange(episode.id);
    setShowSources(true);
  };
  const focusSources = () => {
    if (isSeries && !videoId) {
      const target = selectedEpisode || seasonEpisodes.find((item) => !upcoming(item)) || seasonEpisodes[0];
      if (target) chooseEpisode(target);
    }
    panel.current?.scrollIntoView({ block: "nearest", behavior: motion() });
    requestAnimationFrame(() =>
      panel.current?.querySelector<HTMLElement>(".source-row, .episode-row.selected, .episode-row")?.focus(),
    );
  };
  const more = (anchor: MenuAnchor) =>
    menu.open(
      anchor,
      [
        {
          label: "Actualizar información",
          icon: <RotateCw size={15} />,
          disabled: addon.manifest.id === "saved",
          onSelect: () => void metadata.refetch(),
        },
        ...(isSeries
          ? []
          : [
              {
                label: movieWatched ? "Marcar como no vista" : "Marcar como vista",
                icon: <Check size={15} />,
                onSelect: () => markWatched([meta.id], !movieWatched),
              },
            ]),
        {
          label: "Copiar identificador",
          icon: <Clipboard size={15} />,
          onSelect: () =>
            void navigator.clipboard
              .writeText(meta.id)
              .then(() => notify("Identificador copiado."))
              .catch(() => notify("No se pudo copiar al portapapeles.")),
        },
        ...(/^tt\d+$/.test(meta.id)
          ? [
              {
                label: "Abrir en IMDb",
                icon: <ExternalLink size={15} />,
                onSelect: () =>
                  void openExternal(`https://www.imdb.com/title/${meta.id}/`).catch((error) =>
                    notify(errorMessage(error)),
                  ),
              },
            ]
          : []),
      ],
      "Más acciones",
    );
  const watched = useQuery({
    queryKey: ["watched", meta.type, meta.id, entry?.remoteWatched, entry?.remoteWatchedAt, entry?.videos, episodes.map((item) => item.id).join()],
    queryFn: () => watchedEpisodes(entry, episodes),
    enabled: isSeries,
    placeholderData: (previous) => previous,
  });
  const watchedIds = watched.data ?? new Set<string>();
  const movieWatched = !isSeries && Boolean(entry?.watchedAt || entry?.videos?.[meta.id]?.watched);
  const markWatched = (ids: string[], value: boolean) => {
    preferencesStore.setWatched(meta, addon.manifestUrl, ids, value);
    notify(
      ids.length === 1
        ? value
          ? "Marcado como visto."
          : "Marcado como no visto."
        : `${ids.length} episodios marcados como ${value ? "vistos" : "no vistos"}.`,
    );
  };
  const resume =
    entry?.progress &&
    ((entry.progress.seconds > 5 && entry.progress.seconds < entry.progress.duration * 0.95) ||
      (isSeries && entry.progress.seconds === 0 && entry.progress.duration === 0))
      ? entry.progress
      : undefined;
  const resumeEpisode = resume && episodes.find((item) => item.id === resume.videoId);
  const upNext = Boolean(resume && resume.seconds === 0);
  const lastSource = sourceHistory.last(meta.type, meta.id);
  const facts = [
    typeLabel(meta.type),
    yearOf(meta),
    meta.runtime,
    isSeries && seasons.filter((value) => value > 0).length
      ? `${seasons.filter((value) => value > 0).length} ${seasons.filter((value) => value > 0).length === 1 ? "temporada" : "temporadas"}`
      : "",
  ].filter(Boolean);
  const long = (meta.description?.length || 0) > 360;
  return (
    <section className="detail" aria-label={meta.name} role="region">
      <div className="detail-backdrop" aria-hidden="true">
        {backdrop && <img src={backdrop} alt="" draggable={false} />}
      </div>
      <div className="detail-layout">
        <div className="detail-main">
          <div className="detail-header">
            <Artwork src={meta.poster} name={meta.name} className="detail-poster" />
            <div className="detail-info">
              <h1>{meta.name}</h1>
              <div className="facts">
                {facts.map((fact) => (
                  <span key={fact}>{fact}</span>
                ))}
                {movieWatched && (
                  <span className="watched-fact">
                    <Check size={12} /> Vista
                  </span>
                )}
                {meta.imdbRating && (
                  <span className="rating" title="Valoración IMDb">
                    <Star size={12} fill="currentColor" /> {meta.imdbRating}
                  </span>
                )}
              </div>
              {meta.genres?.length ? (
                <div className="genres">
                  {meta.genres.slice(0, 5).map((genre) => (
                    <span key={genre}>{genre}</span>
                  ))}
                </div>
              ) : null}
              <div className="detail-actions">
                {resume && (
                  <button
                    className="button primary"
                    title={lastSource ? `Continuar con ${streamHeading(lastSource.stream)}` : undefined}
                    onClick={() => {
                      // With a source already watched, play it directly; otherwise show the sources.
                      if (lastSource) return onResume();
                      if (resumeEpisode) chooseEpisode(resumeEpisode);
                      else setShowSources(true);
                      focusSources();
                    }}
                  >
                    <Play size={14} fill="currentColor" />
                    {upNext ? "Siguiente" : "Continuar"}
                    <span className="button-meta">
                      {resumeEpisode ? episodeCode(resumeEpisode) : ""}
                      {upNext ? "" : `${resumeEpisode ? " · " : ""}${clock(resume.seconds)}`}
                    </span>
                  </button>
                )}
                <button
                  className={`button ${resume ? "secondary" : "primary"}`}
                  onClick={focusSources}
                >
                  <Play size={14} fill={resume ? "none" : "currentColor"} />
                  Ver fuentes
                </button>
                {meta.trailers?.length ? (
                  <button className="button secondary" onClick={() => setTrailer(0)}>
                    <Clapperboard size={15} />
                    Tráiler
                  </button>
                ) : null}
                <button
                  className="button secondary"
                  aria-label={saved ? "Quitar de mi biblioteca" : "Guardar en mi biblioteca"}
                  aria-pressed={saved}
                  onClick={() => preferencesStore.toggleMedia(meta, addon.manifestUrl)}
                >
                  {saved ? <BookmarkCheck size={15} /> : <Bookmark size={15} />}
                  <span>{saved ? "En la biblioteca" : "Guardar"}</span>
                </button>
                <button
                  className="icon-button bordered"
                  aria-label="Más acciones"
                  aria-haspopup="menu"
                  title="Más acciones"
                  onClick={(event) => more(anchorFrom(event.currentTarget))}
                >
                  <MoreHorizontal size={16} />
                </button>
              </div>
            </div>
          </div>
          {metadata.isPending && !meta.description ? (
            <div className="detail-description">
              <div className="skeleton skeleton-line" />
              <div className="skeleton skeleton-line" />
              <div className="skeleton skeleton-line short" />
            </div>
          ) : (
            meta.description && (
              <div className="detail-description">
                <p className={long && !descriptionOpen ? "clamped" : ""}>{meta.description}</p>
                {long && (
                  <button className="link-button" onClick={() => setDescriptionOpen(!descriptionOpen)}>
                    {descriptionOpen ? "Mostrar menos" : "Mostrar más"}
                  </button>
                )}
              </div>
            )
          )}
          {metadata.isError && (
            <ErrorState
              message="No se han podido cargar todos los detalles de este título."
              retry={() => void metadata.refetch()}
            />
          )}
          {Boolean(meta.director?.length || meta.cast?.length) && (
            <dl className="credits">
              {meta.director?.length ? (
                <div>
                  <dt>Dirección</dt>
                  <dd>{meta.director.join(", ")}</dd>
                </div>
              ) : null}
              {meta.cast?.length ? (
                <div>
                  <dt>Reparto</dt>
                  <dd>{meta.cast.slice(0, 8).join(", ")}</dd>
                </div>
              ) : null}
            </dl>
          )}
          <p className="provider-note">
            Información de {addon.manifest.name}
            {translated ? " · traducción de TMDB" : ""}
          </p>
        </div>
        <aside className="detail-panel" ref={panel} aria-label={isSeries && !showSources ? "Episodios" : "Fuentes"}>
          {isSeries && !showSources ? (
            <EpisodesPanel
              seasons={seasons}
              season={currentSeason}
              episodes={seasonEpisodes}
              loading={metadata.isPending}
              selectedId={selectedEpisode?.id}
              progressOf={(id) => videoProgress(entry?.videos?.[id]) * 100}
              watched={watchedIds}
              onSeason={setSeason}
              onChoose={chooseEpisode}
              onMenu={(anchor, episode) => {
                const isWatched = watchedIds.has(episode.id);
                const ordered = orderedEpisodes(episodes).filter((item) => (item.season ?? 1) === (episode.season ?? 1));
                const before = ordered.slice(0, ordered.findIndex((item) => item.id === episode.id) + 1);
                menu.open(
                  anchor,
                  [
                    { label: "Ver fuentes", icon: <Play size={15} />, onSelect: () => chooseEpisode(episode) },
                    "separator",
                    {
                      label: isWatched ? "Marcar como no visto" : "Marcar como visto",
                      icon: isWatched ? <Circle size={15} /> : <Check size={15} />,
                      onSelect: () => markWatched([episode.id], !isWatched),
                    },
                    {
                      label: "Marcar como vistos hasta aquí",
                      icon: <CheckCheck size={15} />,
                      disabled: before.every((item) => watchedIds.has(item.id)),
                      onSelect: () => markWatched(before.map((item) => item.id), true),
                    },
                    {
                      label:
                        episode.season === 0
                          ? "Marcar especiales como vistos"
                          : `Marcar temporada ${episode.season ?? 1} como vista`,
                      icon: <CheckCheck size={15} />,
                      disabled: ordered.every((item) => watchedIds.has(item.id) || upcoming(item)),
                      onSelect: () => markWatched(ordered.filter((item) => !upcoming(item)).map((item) => item.id), true),
                    },
                  ],
                  `Episodio ${episodeCode(episode)}`,
                );
              }}
            />
          ) : (
            <SourcesPanel
              meta={meta}
              addon={addon}
              videoId={videoId}
              episode={selectedEpisode}
              onBack={isSeries ? () => setShowSources(false) : undefined}
              onPlay={onPlay}
              onAddons={onAddons}
              notify={notify}
            />
          )}
        </aside>
      </div>
      {menu.element}
      {trailer !== null && meta.trailers?.[trailer] && (
        <TrailerDialog
          title={meta.name}
          trailers={meta.trailers}
          index={trailer}
          onIndex={setTrailer}
          onClose={() => setTrailer(null)}
          notify={notify}
        />
      )}
    </section>
  );
}

/**
 * YouTube's privacy-enhanced player in a dialog. (Stremio Service's /yt resolver no longer works
 * with YouTube: it answers "Could not extract signature deciphering actions".)
 */
function TrailerDialog({
  title,
  trailers,
  index,
  onIndex,
  onClose,
  notify,
}: {
  title: string;
  trailers: NonNullable<MediaItem["trailers"]>;
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const current = trailers[index];
  return (
    <Dialog title={`Tráiler de ${title}`} onClose={onClose} className="trailer-dialog" hideClose>
      <div className="trailer-frame">
        <iframe
          key={current.ytId}
          src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(current.ytId)}?autoplay=1&rel=0&modestbranding=1`}
          title={`Tráiler de ${title}`}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
        />
      </div>
      <div className="trailer-bar">
        {trailers.length > 1 && (
          <div className="segmented" role="radiogroup" aria-label="Tráileres">
            {trailers.map((item, position) => (
              <button key={item.ytId} role="radio" aria-checked={position === index} onClick={() => onIndex(position)}>
                <span className="segment-text">{position + 1}</span>
              </button>
            ))}
          </div>
        )}
        <button
          className="button subtle small"
          onClick={() =>
            void openExternal(`https://www.youtube.com/watch?v=${encodeURIComponent(current.ytId)}`).catch((error) =>
              notify(errorMessage(error)),
            )
          }
        >
          Abrir en YouTube <ExternalLink size={12} />
        </button>
        <button className="button secondary small" data-autofocus onClick={onClose}>
          Cerrar
        </button>
      </div>
    </Dialog>
  );
}

function EpisodesPanel({
  seasons,
  season,
  episodes,
  loading,
  selectedId,
  progressOf,
  watched,
  onSeason,
  onChoose,
  onMenu,
}: {
  seasons: number[];
  season: number;
  episodes: Episode[];
  loading: boolean;
  selectedId?: string;
  progressOf: (id: string) => number;
  watched: Set<string>;
  onSeason: (season: number) => void;
  onChoose: (episode: Episode) => void;
  onMenu: (anchor: MenuAnchor, episode: Episode) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(".episode-row.selected")?.scrollIntoView({ block: "nearest" });
  }, [season]);
  return (
    <>
      <header className="panel-header">
        <h2>Episodios</h2>
        {seasons.length > 0 && (
          <label className="select compact">
            <select
              aria-label="Temporada"
              value={season}
              onChange={(event) => onSeason(Number(event.target.value))}
            >
              {seasons.map((item) => (
                <option key={item} value={item}>
                  {item === 0 ? "Especiales" : `Temporada ${item}`}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>
      <div className="panel-scroll" ref={list}>
        {loading && !episodes.length ? (
          Array.from({ length: 6 }, (_, index) => (
            <div className="episode-row skeleton-row" key={index} aria-hidden="true">
              <span className="skeleton episode-thumb" />
              <span className="skeleton skeleton-line" />
            </div>
          ))
        ) : episodes.length ? (
          episodes.map((episode) => {
            const future = upcoming(episode);
            const seen = watched.has(episode.id);
            const percent = progressOf(episode.id);
            return (
              <button
                key={episode.id}
                className={`episode-row ${selectedId === episode.id ? "selected" : ""} ${future ? "future" : ""} ${seen ? "watched" : ""}`}
                aria-label={`${episode.episode ?? 1}. ${episode.title || `Episodio ${episode.episode ?? 1}`}${seen ? ", visto" : ""}`}
                onClick={() => onChoose(episode)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onMenu({ x: event.clientX, y: event.clientY }, episode);
                }}
                onKeyDown={(event) => {
                  if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
                    event.preventDefault();
                    onMenu(anchorFrom(event.currentTarget), episode);
                    return;
                  }
                  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                  event.preventDefault();
                  const sibling =
                    event.key === "ArrowDown"
                      ? event.currentTarget.nextElementSibling
                      : event.currentTarget.previousElementSibling;
                  (sibling as HTMLElement | null)?.focus();
                }}
              >
                <span className="episode-thumb">
                  {safeImage(episode.thumbnail) ? (
                    <img src={safeImage(episode.thumbnail)} alt="" loading="lazy" draggable={false} />
                  ) : (
                    <span>{episode.episode ?? "·"}</span>
                  )}
                  {percent > 0 && !seen && (
                    <span className="card-progress">
                      <span style={{ width: `${Math.min(100, percent)}%` }} />
                    </span>
                  )}
                  {seen && (
                    <span className="episode-watched" aria-hidden="true">
                      <Check size={13} strokeWidth={2.5} />
                    </span>
                  )}
                </span>
                <span className="episode-text">
                  <strong>
                    <span className="episode-number">{episode.episode ?? 1}.</span>{" "}
                    {episode.title || `Episodio ${episode.episode ?? 1}`}
                  </strong>
                  <small>
                    {future ? `Se estrena el ${formatDate(episode.released)}` : formatDate(episode.released)}
                  </small>
                  {episode.overview && <span className="episode-overview">{episode.overview}</span>}
                </span>
              </button>
            );
          })
        ) : (
          <EmptyState
            compact
            title="Sin episodios"
            description="El addon de metadatos no proporciona una lista de episodios para esta serie."
          />
        )}
      </div>
    </>
  );
}

/**
 * A row of filter chips limited to two lines; the rest fold behind «+N» (the selected chip
 * always stays visible).
 */
function CollapsibleChips({ label, selected, children }: { label: string; selected: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [limit, setLimit] = useState<number | null>(null);
  const items = Children.toArray(children);
  // Measure with every chip shown, then keep those on the first two lines (minus room for «+N»).
  const measured = useRef(-1);
  useLayoutEffect(() => {
    if (expanded || (limit !== null && measured.current === items.length)) return;
    const node = ref.current;
    if (!node) return;
    measured.current = items.length;
    const chips = [...node.children] as HTMLElement[];
    const rows = [...new Set(chips.map((chip) => chip.offsetTop))];
    if (rows.length <= 2) return setLimit(items.length);
    const firstHidden = chips.findIndex((chip) => chip.offsetTop >= rows[2]);
    setLimit(Math.max(1, firstHidden - 1));
  }, [expanded, items.length, limit]);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth !== width) {
        width = node.clientWidth;
        measured.current = -1;
        setLimit(null);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const folded = !expanded && limit !== null && limit < items.length;
  const visible = folded
    ? items.filter((item, index) => index < limit! || (isValidElement(item) && item.key === `.$${selected}` && selected !== ""))
    : items;
  return (
    <div className="chip-row" role="toolbar" aria-label={label} ref={ref}>
      {visible}
      {folded && (
        <button className="chip chip-more" aria-expanded={false} onClick={() => setExpanded(true)}>
          +{items.length - visible.length}
        </button>
      )}
      {expanded && (
        <button className="chip chip-more" aria-expanded onClick={() => (setExpanded(false), setLimit(null))}>
          Menos
        </button>
      )}
    </div>
  );
}

function SourcesPanel({
  meta,
  addon,
  videoId,
  episode,
  onBack,
  onPlay,
  onAddons,
  notify,
}: {
  meta: MediaItem;
  addon: InstalledAddon;
  videoId?: string;
  episode?: Episode;
  onBack?: () => void;
  onPlay: PlayHandler;
  onAddons: () => void;
  notify: (message: string) => void;
}) {
  const prefs = usePreferences();
  const menu = useMenu();
  const [addonFilter, setAddonFilter] = useState("");
  const [languageFilter, setLanguageFilter] = useState("");
  const [active, setActive] = useState<number | null>(null);
  const [qualityFilter, setQualityFilter] = useRouteState<string>("sourceQuality", "");
  const [order, setOrder] = useUiSetting<SourceOrder>("sources.order", "addon", ["addon", "seeders", "largest", "smallest"]);
  const marks = useSourceMarks(videoId);
  const position = videoId ? prefs.library[mediaKey(meta.type, meta.id)]?.videos?.[videoId]?.seconds : undefined;
  const lastKey = (() => {
    const last = sourceHistory.last(meta.type, meta.id);
    return last && last.videoId === videoId ? sourceKey(last.stream) : undefined;
  })();
  const enabled = prefs.addons.filter((item) => item.enabled).map((item) => item.manifestUrl);
  const sources = useQuery({
    queryKey: ["streams", enabled, meta.type, videoId],
    queryFn: ({ signal }) => getStreams(prefs.addons, meta.type, videoId!, signal),
    enabled: Boolean(videoId),
    retry: 0,
  });
  const play = useMutation({
    mutationFn: ({ stream, mode }: { stream: ResolvedStream; mode: PlayMode }) =>
      onPlay(meta, addon, videoId!, stream, mode, episode),
    onSettled: () => setActive(null),
  });
  const streams = sources.data || [];
  // Several configured copies of one addon share its name; they are told apart by number.
  const addonLabels = new Map<string, string>();
  for (const url of new Set(streams.map((stream) => stream.addonUrl))) {
    const name = streams.find((stream) => stream.addonUrl === url)!.addonName;
    const copies = [...new Set(streams.filter((stream) => stream.addonName === name).map((stream) => stream.addonUrl))];
    addonLabels.set(url, copies.length > 1 ? `${name} ${copies.indexOf(url) + 1}` : name);
  }
  const addonLabel = (stream: ResolvedStream) => addonLabels.get(stream.addonUrl) ?? stream.addonName;
  const addonUrls = [...addonLabels.keys()];
  const languages = new Map<string, { label: string; count: number }>();
  for (const stream of streams)
    for (const language of streamLanguages(stream)) {
      const current = languages.get(language.flag);
      languages.set(language.flag, { label: language.label, count: (current?.count ?? 0) + 1 });
    }
  const tiers = qualityTiers.filter((tier) => streams.some((stream) => qualityTier(stream) === tier));
  const visible = sortSources(
    streams.filter(
      (stream) =>
        (!addonFilter || stream.addonUrl === addonFilter) &&
        (!qualityFilter || qualityTier(stream) === qualityFilter) &&
        (!languageFilter || streamLanguages(stream).some((language) => language.flag === languageFilter)),
    ),
    order,
  );
  const start = (stream: ResolvedStream, mode: PlayMode, index: number) => {
    setActive(index);
    play.mutate({ stream, mode });
  };
  const rowMenu = (anchor: MenuAnchor, stream: ResolvedStream, index: number) => {
    const kind = streamKind(stream);
    const link =
      stream.url || stream.externalUrl || (stream.ytId ? `https://www.youtube.com/watch?v=${stream.ytId}` : "");
    menu.open(
      anchor,
      [
        {
          label: kind === "external" || kind === "youtube" ? "Abrir en el navegador" : "Reproducir en Vela",
          icon: <Play size={15} />,
          onSelect: () => start(stream, "internal", index),
        },
        {
          label: "Abrir en reproductor externo",
          icon: <MonitorPlay size={15} />,
          disabled: kind === "external" || kind === "youtube",
          onSelect: () => start(stream, "external", index),
        },
        "separator",
        ...(marks[sourceKey(stream)]
          ? [{ label: "Quitar marca", icon: <Eraser size={15} />, onSelect: () => videoId && sourceHistory.clear(videoId, stream) }]
          : []),
        {
          label: stream.infoHash && !stream.url ? "Copiar enlace magnet" : "Copiar enlace",
          icon: <Clipboard size={15} />,
          disabled: !link && !stream.infoHash,
          onSelect: () =>
            void navigator.clipboard
              .writeText(link || `magnet:?xt=urn:btih:${stream.infoHash}`)
              .then(() => notify("Enlace copiado."))
              .catch(() => notify("No se pudo copiar al portapapeles.")),
        },
      ],
      "Opciones de la fuente",
    );
  };
  return (
    <>
      <header className="panel-header">
        {onBack && (
          <button className="icon-button" aria-label="Volver a episodios" title="Episodios" onClick={onBack}>
            <ArrowLeft size={16} />
          </button>
        )}
        <div className="panel-title">
          <h2>Fuentes</h2>
          {episode && (
            <span className="panel-subtitle" title={episode.title}>
              T{episode.season ?? 1} · E{episode.episode ?? 1}
              {episode.title ? ` · ${episode.title}` : ""}
            </span>
          )}
        </div>
        {sources.isSuccess && streams.length > 0 && (
          <span className="count">{visible.length}</span>
        )}
        <button
          className="icon-button"
          aria-label="Actualizar fuentes"
          title="Actualizar fuentes"
          disabled={!videoId || sources.isFetching}
          onClick={() => void sources.refetch()}
        >
          <RotateCw size={14} className={sources.isFetching && !sources.isPending ? "spin" : ""} />
        </button>
      </header>
      {streams.length > 1 && (
        <div className="source-toolbar">
          {tiers.length > 1 ? (
            <div className="segmented" role="radiogroup" aria-label="Calidad">
              {["", ...tiers].map((tier) => (
                <button
                  key={tier || "all"}
                  role="radio"
                  aria-checked={qualityFilter === tier}
                  onClick={() => setQualityFilter(tier)}
                >
                  <span className="segment-text">{tier === "" ? "Todas" : tier === "?" ? "Otras" : tier}</span>
                </button>
              ))}
            </div>
          ) : (
            <span />
          )}
          <label className="select compact">
            <select aria-label="Ordenar fuentes" value={order} onChange={(event) => setOrder(event.target.value as SourceOrder)}>
              <option value="addon">Orden del addon</option>
              <option value="seeders">Más semillas</option>
              <option value="largest">Mayor tamaño</option>
              <option value="smallest">Menor tamaño</option>
            </select>
          </label>
        </div>
      )}
      {addonUrls.length > 1 && (
        <div className="chip-row" role="toolbar" aria-label="Filtrar por addon">
          {["", ...addonUrls].map((url) => (
            <button
              key={url || "all"}
              className={`chip ${addonFilter === url ? "selected" : ""}`}
              aria-pressed={addonFilter === url}
              title={url ? addonHost(url) : undefined}
              onClick={() => setAddonFilter(url)}
            >
              {url ? addonLabels.get(url) : "Todos"}
              <span>{url ? streams.filter((stream) => stream.addonUrl === url).length : streams.length}</span>
            </button>
          ))}
        </div>
      )}
      {languages.size > 0 && (
        <CollapsibleChips label="Filtrar por idioma" selected={languageFilter}>
          <button
            className={`chip ${!languageFilter ? "selected" : ""}`}
            aria-pressed={!languageFilter}
            onClick={() => setLanguageFilter("")}
          >
            Todos los idiomas
          </button>
          {[...languages]
            .sort((a, b) => b[1].count - a[1].count)
            .map(([flag, { label, count }]) => (
              <button
                key={flag}
                className={`chip ${languageFilter === flag ? "selected" : ""}`}
                aria-pressed={languageFilter === flag}
                aria-label={`${label}: ${count} fuentes`}
                title={label}
                onClick={() => setLanguageFilter(languageFilter === flag ? "" : flag)}
              >
                <span className="flag" aria-hidden="true">{flag}</span>
                <span>{count}</span>
              </button>
            ))}
        </CollapsibleChips>
      )}
      {play.isError && (
        <div className="panel-alert">
          <ErrorState title="No se pudo reproducir" message={errorMessage(play.error)} />
        </div>
      )}
      <div className="panel-scroll">
        {!videoId ? (
          <EmptyState compact title="Elige un episodio" description="Selecciona un episodio para consultar sus fuentes." />
        ) : sources.isPending ? (
          <>
            <p className="panel-status">
              <Spinner /> Consultando {enabled.length} addons…
            </p>
            {Array.from({ length: 5 }, (_, index) => (
              <div className="source-row skeleton-row" key={index} aria-hidden="true">
                <span className="skeleton source-badge" />
                <span className="skeleton skeleton-line" />
              </div>
            ))}
          </>
        ) : sources.isError ? (
          <ErrorState
            title="Las fuentes no respondieron"
            message={errorMessage(sources.error)}
            retry={() => void sources.refetch()}
          />
        ) : visible.length ? (
          <ul className="source-list">
            {visible.map((stream, index) => {
              const kind = streamKind(stream);
              const Icon = kindIcon[kind];
              const quality = streamQuality(stream);
              const warnings = streamWarnings(stream);
              const detail = streamDetail(stream);
              const streamLanguageList = streamLanguages(stream);
              const facts = streamFacts(stream);
              const key = sourceKey(stream);
              const mark = marks[key];
              const isLast = key === lastKey;
              return (
                <li
                  key={`${stream.addonUrl}-${index}`}
                  className={`source-item ${mark ? `marked ${mark.outcome}` : ""} ${isLast ? "last" : ""}`}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    rowMenu({ x: event.clientX, y: event.clientY }, stream, index);
                  }}
                >
                  <button
                    className="source-row"
                    aria-label={`Reproducir ${stream.name || stream.addonName} ${index + 1}${mark ? `, ${markLabel(mark.outcome, isLast).toLowerCase()}` : ""}`}
                    disabled={play.isPending}
                    onClick={() => start(stream, "internal", index)}
                    onKeyDown={(event) => {
                      if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
                        event.preventDefault();
                        rowMenu(anchorFrom(event.currentTarget), stream, index);
                      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        event.preventDefault();
                        const item = event.currentTarget.parentElement;
                        const sibling = event.key === "ArrowDown" ? item?.nextElementSibling : item?.previousElementSibling;
                        sibling?.querySelector<HTMLElement>(".source-row")?.focus();
                      }
                    }}
                  >
                    <span className={`source-badge ${quality ? "quality" : ""}`}>
                      {active === index && play.isPending ? <Spinner /> : quality || <Icon size={14} />}
                    </span>
                    <span className="source-body">
                      <span className="source-heading">{streamHeading(stream)}</span>
                      {detail.length > 0 && <span className="source-detail">{detail.join(" · ")}</span>}
                      <span className="source-tags">
                        <span className={`tag kind-${kind}`}>{kindLabel[kind]}</span>
                        {streamLanguageList.length > 0 && (
                          <span
                            className="flags"
                            title={streamLanguageList.map((language) => language.label).join(", ")}
                            aria-label={`Idiomas: ${streamLanguageList.map((language) => language.label).join(", ")}`}
                          >
                            {streamLanguageList.slice(0, 6).map((language) => (
                              <span className="flag" key={language.flag}>
                                {language.flag}
                              </span>
                            ))}
                            {streamLanguageList.length > 6 && (
                              <span className="flag-more">+{streamLanguageList.length - 6}</span>
                            )}
                          </span>
                        )}
                        {facts.multiAudio && <span className="tag">Multiaudio</span>}
                        {streamTags(stream).map((tag) => (
                          <span className="tag" key={tag}>
                            {tag}
                          </span>
                        ))}
                        {warnings.length > 0 && (
                          <span className="tag warning" title={warnings.join(". ")}>
                            <AlertTriangle size={11} /> {warnings.length > 1 ? "Limitaciones" : warnings[0].startsWith("Requiere") ? "Cabeceras" : "No web"}
                          </span>
                        )}
                        {facts.seeders !== undefined && (
                          <span
                            className="tag seeders"
                            title={`${facts.seeders} ${facts.seeders === 1 ? "semilla" : "semillas"} según el addon. Es la cifra que registró al indexar el torrent: al conectar suelen responder bastantes menos pares.`}
                          >
                            <Users size={11} /> {facts.seeders}
                          </span>
                        )}
                        <span className="source-addon">
                          {mark ? (
                            <span
                              className={`source-mark ${isLast ? "last" : mark.outcome}`}
                              title={mark.error ? `${mark.error} (${relativeTime(mark.at)})` : relativeTime(mark.at)}
                            >
                              {isLast && position && position >= 15 ? `Viendo · ${clock(position)}` : isLast ? "Viendo" : markText(mark.outcome, false, mark.at)}
                            </span>
                          ) : (
                            [addonLabel(stream), facts.provider].filter(Boolean).join(" · ")
                          )}
                        </span>
                      </span>
                    </span>
                  </button>
                  <button
                    className="icon-button source-more"
                    aria-label={`Opciones de la fuente ${index + 1}`}
                    aria-haspopup="menu"
                    title="Más opciones"
                    tabIndex={-1}
                    onClick={(event) => rowMenu(anchorFrom(event.currentTarget, "end"), stream, index)}
                  >
                    <MoreHorizontal size={15} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            compact
            icon={<Puzzle size={18} />}
            title="No hay fuentes para este título"
            description="Cinemeta aporta solo el catálogo. Instala o activa un addon que ofrezca fuentes de reproducción."
            action={
              <button className="button secondary small" onClick={onAddons}>
                Gestionar addons
              </button>
            }
          />
        )}
      </div>
      {menu.element}
    </>
  );
}
