import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  Globe,
  Layers3,
  Play,
  Plus,
  Star,
} from "lucide-react";
import type {
  InstalledAddon,
  MediaItem,
  ResolvedStream,
} from "../lib/contracts";
import { getMeta, getStreams } from "../lib/protocol";
import { mediaKey, preferencesStore, usePreferences } from "../lib/store";
import { errorMessage, safeImage, sourceTitle, yearOf } from "../lib/utils";
import { Artwork, Dialog, EmptyState, ErrorState, Loading } from "./Primitives";

export type Selection = {
  meta: MediaItem;
  addon: InstalledAddon;
  startSources?: boolean;
};

export function MediaDetails({
  selection,
  onClose,
  onPlay,
  onAddons,
}: {
  selection: Selection;
  onClose: () => void;
  onPlay: (
    meta: MediaItem,
    addon: InstalledAddon,
    videoId: string,
    stream: ResolvedStream,
  ) => Promise<void>;
  onAddons: () => void;
}) {
  const prefs = usePreferences();
  const [sourcesOpen, setSourcesOpen] = useState(
    Boolean(selection.startSources),
  );
  const [season, setSeason] = useState(1);
  const [episodeId, setEpisodeId] = useState("");
  const metadata = useQuery({
    queryKey: [
      "meta",
      selection.addon.manifestUrl,
      selection.meta.type,
      selection.meta.id,
    ],
    queryFn: ({ signal }) =>
      getMeta(selection.addon, selection.meta.type, selection.meta.id, signal),
  });
  const meta = metadata.data || selection.meta;
  const saved = Boolean(prefs.library[mediaKey(meta.type, meta.id)]);
  const episodes = meta.videos || [];
  const seasons = [...new Set(episodes.map((video) => video.season ?? 1))].sort(
    (a, b) => a - b,
  );
  const currentSeason = seasons.includes(season) ? season : (seasons[0] ?? 1);
  const seasonEpisodes = episodes.filter(
    (episode) => (episode.season ?? 1) === currentSeason,
  );
  const currentEpisode =
    seasonEpisodes.find((episode) => episode.id === episodeId) ||
    seasonEpisodes[0];
  const videoId = meta.type === "series" ? currentEpisode?.id : meta.id;
  const sources = useQuery({
    queryKey: [
      "streams",
      prefs.addons
        .filter((addon) => addon.enabled)
        .map((addon) => addon.manifestUrl),
      meta.type,
      videoId,
    ],
    queryFn: ({ signal }) =>
      getStreams(prefs.addons, meta.type, videoId!, signal),
    enabled: sourcesOpen && Boolean(videoId),
    retry: 0,
  });
  const play = useMutation({
    mutationFn: (stream: ResolvedStream) =>
      onPlay(meta, selection.addon, videoId!, stream),
  });
  return (
    <Dialog title={meta.name} onClose={onClose} className="detail-dialog">
      <div className="detail-backdrop">
        {safeImage(meta.background || meta.poster) && (
          <img src={safeImage(meta.background || meta.poster)} alt="" />
        )}
        <div />
      </div>
      <div className="detail-content">
        <div className="detail-heading">
          <Artwork
            src={meta.poster}
            name={meta.name}
            className="detail-poster"
          />
          <div>
            <span className="eyebrow">
              {meta.type === "series"
                ? "UNA HISTORIA EN EPISODIOS"
                : "TU PRÓXIMA PELÍCULA"}
            </span>
            <h2>{meta.name}</h2>
            <div className="detail-facts">
              {meta.imdbRating && (
                <span className="score">
                  <Star size={13} fill="currentColor" />
                  {meta.imdbRating}
                  <small>IMDb</small>
                </span>
              )}
              <span>{yearOf(meta)}</span>
              {meta.runtime && (
                <span>
                  <Clock3 size={13} />
                  {meta.runtime}
                </span>
              )}
            </div>
            <div className="genre-list">
              {meta.genres?.slice(0, 4).map((genre) => (
                <span key={genre}>{genre}</span>
              ))}
            </div>
            <div className="detail-actions">
              <button
                className="button primary"
                onClick={() => setSourcesOpen(true)}
              >
                <Play size={15} fill="currentColor" />
                Ver fuentes
              </button>
              <button
                className="button secondary"
                aria-label={
                  saved ? "Quitar de mi biblioteca" : "Guardar en mi biblioteca"
                }
                aria-pressed={saved}
                onClick={() =>
                  preferencesStore.toggleMedia(
                    meta,
                    selection.addon.manifestUrl,
                  )
                }
              >
                {saved ? <Check size={17} /> : <Plus size={17} />}
                <span>{saved ? "En tu biblioteca" : "Mi biblioteca"}</span>
              </button>
            </div>
          </div>
        </div>
        {metadata.isPending && !meta.description ? (
          <Loading label="Cargando los detalles" />
        ) : (
          meta.description && (
            <p className="detail-description">{meta.description}</p>
          )
        )}
        {metadata.isError && (
          <ErrorState
            message="No se han podido cargar todos los detalles de esta historia."
            retry={() => void metadata.refetch()}
          />
        )}
        <div className="credits">
          {meta.director?.length ? (
            <div>
              <span>DIRECCIÓN</span>
              <p>{meta.director.join(", ")}</p>
            </div>
          ) : null}
          {meta.cast?.length ? (
            <div>
              <span>REPARTO</span>
              <p>{meta.cast.slice(0, 5).join(", ")}</p>
            </div>
          ) : null}
        </div>
        {meta.type === "series" && (
          <section className="episodes-section">
            <div className="section-heading">
              <h3>Un capítulo más</h3>
              {seasons.length > 0 && (
                <label className="select-wrap">
                  <span className="sr-only">Temporada</span>
                  <select
                    aria-label="Temporada"
                    value={currentSeason}
                    onChange={(event) => {
                      setSeason(Number(event.target.value));
                      setEpisodeId("");
                    }}
                  >
                    {seasons.map((item) => (
                      <option key={item} value={item}>
                        {item === 0 ? "Especiales" : `Temporada ${item}`}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={14} />
                </label>
              )}
            </div>
            {metadata.isPending ? (
              <Loading label="Buscando episodios" />
            ) : seasonEpisodes.length ? (
              <div className="episode-list">
                {seasonEpisodes.map((episode) => (
                  <button
                    className={`episode ${currentEpisode?.id === episode.id ? "selected" : ""}`}
                    key={episode.id}
                    onClick={() => {
                      setEpisodeId(episode.id);
                      setSourcesOpen(true);
                    }}
                  >
                    <span className="episode-number">
                      {String(episode.episode ?? 1).padStart(2, "0")}
                    </span>
                    <span>
                      <strong>
                        {episode.title || `Episodio ${episode.episode ?? 1}`}
                      </strong>
                      {episode.released && (
                        <small>
                          {new Date(episode.released).toLocaleDateString("es", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })}
                        </small>
                      )}
                    </span>
                    <Play size={14} />
                  </button>
                ))}
              </div>
            ) : (
              <p className="hint">
                Este catálogo todavía no proporciona una lista de episodios.
              </p>
            )}
          </section>
        )}
        {sourcesOpen && (
          <section className="sources-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow muted">TUS ADDONS, CONECTADOS</span>
                <h3>Elige una fuente</h3>
              </div>
              <Layers3 size={19} />
            </div>
            {!videoId ? (
              <p className="hint">
                Selecciona un episodio para ver sus fuentes.
              </p>
            ) : sources.isPending ? (
              <Loading label="Consultando tus addons" />
            ) : sources.isError ? (
              <ErrorState
                message={errorMessage(sources.error)}
                retry={() => void sources.refetch()}
              />
            ) : sources.data?.length ? (
              <div className="source-list">
                {sources.data.map((stream, index) => (
                  <button
                    className="source"
                    key={`${stream.addonUrl}-${index}`}
                    aria-label={`Reproducir ${stream.name || stream.addonName} ${index + 1}`}
                    disabled={play.isPending}
                    onClick={() => play.mutate(stream)}
                  >
                    <span className="source-icon">
                      {stream.externalUrl || stream.ytId ? (
                        <Globe size={18} />
                      ) : (
                        <Play size={16} fill="currentColor" />
                      )}
                    </span>
                    <span className="source-label">
                      <strong>
                        {sourceTitle(stream.name || stream.addonName)}
                      </strong>
                      <small>
                        {sourceTitle(
                          stream.description ||
                            stream.title ||
                            stream.addonName,
                        )}
                      </small>
                    </span>
                    <span className="source-tag">
                      {stream.infoHash
                        ? "TORRENT"
                        : stream.externalUrl || stream.ytId
                          ? "EXTERNO"
                          : "STREAM"}
                    </span>
                    <ArrowRight size={16} />
                  </button>
                ))}
              </div>
            ) : (
              <EmptyState
                title="Todavía no hay fuentes para esta historia"
                description="Cinemeta aporta el catálogo. Añade un addon que ofrezca fuentes para poder reproducir este título."
                action={
                  <button className="button secondary" onClick={onAddons}>
                    Explorar mis addons
                    <ArrowRight size={15} />
                  </button>
                }
              />
            )}{" "}
            {play.isError && <ErrorState message={errorMessage(play.error)} />}{" "}
            {play.isPending && <Loading label="Preparando la reproducción" />}
          </section>
        )}
        <div className="detail-provider">
          <span className="status-dot" />
          Información de {selection.addon.manifest.name}
        </div>
      </div>
    </Dialog>
  );
}
