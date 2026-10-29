import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Bookmark,
  BookmarkCheck,
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
import { getMeta, getStreams } from "../lib/protocol";
import { mediaKey, preferencesStore, usePreferences } from "../lib/store";
import {
  kindLabel,
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
import { clock, errorMessage, safeImage, yearOf } from "../lib/utils";
import { typeLabel } from "./MediaCard";
import {
  anchorFrom,
  Artwork,
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

function upcoming(episode: Episode): boolean {
  return Boolean(episode.released && new Date(episode.released).getTime() > Date.now());
}

export function DetailView({
  meta: initial,
  addon,
  videoId: routeVideoId,
  startSources,
  onVideoChange,
  onPlay,
  onAddons,
  notify,
}: {
  meta: MediaItem;
  addon: InstalledAddon;
  videoId?: string;
  startSources?: boolean;
  onVideoChange: (videoId: string) => void;
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
  const meta = metadata.data || initial;
  const entry = prefs.library[mediaKey(meta.type, meta.id)];
  const saved = Boolean(entry);
  const isSeries = meta.type === "series";
  const episodes = meta.videos || [];
  const progressVideo = entry?.progress?.videoId;
  const initialEpisode =
    episodes.find((item) => item.id === routeVideoId) ||
    episodes.find((item) => item.id === progressVideo);
  const seasons = [...new Set(episodes.map((video) => video.season ?? 1))].sort(
    (a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b),
  );
  const [season, setSeason] = useState<number | undefined>(undefined);
  const currentSeason =
    season !== undefined && seasons.includes(season)
      ? season
      : (initialEpisode?.season ?? seasons[0] ?? 1);
  const seasonEpisodes = episodes
    .filter((episode) => (episode.season ?? 1) === currentSeason)
    .sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
  const [showSources, setShowSources] = useState(
    !isSeries || Boolean(startSources && (routeVideoId || progressVideo)),
  );
  const selectedEpisode = isSeries
    ? episodes.find((item) => item.id === (routeVideoId || progressVideo))
    : undefined;
  const videoId = isSeries ? (showSources ? selectedEpisode?.id : undefined) : meta.id;
  const [descriptionOpen, setDescriptionOpen] = useState(false);
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
    panel.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
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
  const resume =
    entry?.progress && entry.progress.seconds > 5 && entry.progress.seconds < entry.progress.duration * 0.95
      ? entry.progress
      : undefined;
  const resumeEpisode = resume && episodes.find((item) => item.id === resume.videoId);
  const facts = [
    typeLabel(meta.type),
    yearOf(meta),
    meta.runtime,
    isSeries && seasons.filter((value) => value > 0).length
      ? `${seasons.filter((value) => value > 0).length} temporadas`
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
                    onClick={() => {
                      if (resumeEpisode) chooseEpisode(resumeEpisode);
                      else setShowSources(true);
                      focusSources();
                    }}
                  >
                    <Play size={14} fill="currentColor" />
                    Continuar
                    <span className="button-meta">
                      {resumeEpisode
                        ? `T${resumeEpisode.season ?? 1}·E${resumeEpisode.episode ?? 1} · `
                        : ""}
                      {clock(resume.seconds)}
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
              progressId={progressVideo}
              progressPercent={
                entry?.progress?.duration ? (entry.progress.seconds / entry.progress.duration) * 100 : 0
              }
              onSeason={setSeason}
              onChoose={chooseEpisode}
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
    </section>
  );
}

function EpisodesPanel({
  seasons,
  season,
  episodes,
  loading,
  selectedId,
  progressId,
  progressPercent,
  onSeason,
  onChoose,
}: {
  seasons: number[];
  season: number;
  episodes: Episode[];
  loading: boolean;
  selectedId?: string;
  progressId?: string;
  progressPercent: number;
  onSeason: (season: number) => void;
  onChoose: (episode: Episode) => void;
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
            return (
              <button
                key={episode.id}
                className={`episode-row ${selectedId === episode.id ? "selected" : ""} ${future ? "future" : ""}`}
                onClick={() => onChoose(episode)}
                onKeyDown={(event) => {
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
                  {progressId === episode.id && progressPercent > 0 && (
                    <span className="card-progress">
                      <span style={{ width: `${Math.min(100, progressPercent)}%` }} />
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
  const addonNames = [...new Set(streams.map((stream) => stream.addonName))];
  const languages = new Map<string, { label: string; count: number }>();
  for (const stream of streams)
    for (const language of streamLanguages(stream)) {
      const current = languages.get(language.flag);
      languages.set(language.flag, { label: language.label, count: (current?.count ?? 0) + 1 });
    }
  const visible = streams.filter(
    (stream) =>
      (!addonFilter || stream.addonName === addonFilter) &&
      (!languageFilter || streamLanguages(stream).some((language) => language.flag === languageFilter)),
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
      {addonNames.length > 1 && (
        <div className="chip-row" role="toolbar" aria-label="Filtrar por addon">
          {["", ...addonNames].map((name) => (
            <button
              key={name || "all"}
              className={`chip ${addonFilter === name ? "selected" : ""}`}
              aria-pressed={addonFilter === name}
              onClick={() => setAddonFilter(name)}
            >
              {name || "Todos"}
              <span>{name ? streams.filter((stream) => stream.addonName === name).length : streams.length}</span>
            </button>
          ))}
        </div>
      )}
      {languages.size > 0 && (
        <div className="chip-row" role="toolbar" aria-label="Filtrar por idioma">
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
        </div>
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
              return (
                <li
                  key={`${stream.addonUrl}-${index}`}
                  className="source-item"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    rowMenu({ x: event.clientX, y: event.clientY }, stream, index);
                  }}
                >
                  <button
                    className="source-row"
                    aria-label={`Reproducir ${stream.name || stream.addonName} ${index + 1}`}
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
                          <span className="tag seeders" title={`${facts.seeders} pares`}>
                            <Users size={11} /> {facts.seeders}
                          </span>
                        )}
                        <span className="source-addon">
                          {[stream.addonName, facts.provider].filter(Boolean).join(" · ")}
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
