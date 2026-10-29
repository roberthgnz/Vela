import { Check, Play, Plus } from "lucide-react";
import type { LibraryEntry, MediaItem } from "../lib/contracts";
import { yearOf } from "../lib/utils";
import { Artwork } from "./Primitives";

export function MediaCard({
  meta,
  entry,
  onOpen,
  onSave,
}: {
  meta: MediaItem;
  entry?: LibraryEntry;
  onOpen: () => void;
  onSave: () => void;
}) {
  const progress =
    entry?.progress && entry.progress.duration > 0
      ? Math.min(100, (entry.progress.seconds / entry.progress.duration) * 100)
      : 0;
  return (
    <article className="media-card">
      <div className="poster-wrap">
        <button
          className="poster-button"
          onClick={onOpen}
          aria-label={`Ver ${meta.name}`}
        >
          <Artwork src={meta.poster} name={meta.name} />
          <span className="poster-play" aria-hidden="true">
            <Play size={20} fill="currentColor" />
          </span>
          {meta.imdbRating && (
            <span className="rating-badge">
              <span>★</span>
              {meta.imdbRating}
            </span>
          )}
          {progress > 0 && progress < 95 && (
            <span className="watch-progress">
              <span style={{ width: `${progress}%` }} />
            </span>
          )}
        </button>
        <button
          className={`save-button ${entry ? "is-saved" : ""}`}
          aria-label={
            entry
              ? `Quitar ${meta.name} de mi biblioteca`
              : `Guardar ${meta.name} en mi biblioteca`
          }
          aria-pressed={Boolean(entry)}
          onClick={onSave}
        >
          {entry ? <Check size={16} /> : <Plus size={16} />}
        </button>
      </div>
      <h3>{meta.name}</h3>
      <div className="card-meta">
        <span>{yearOf(meta) || "Por descubrir"}</span>
        <span className="meta-dot" />
        <span>
          {meta.type === "series"
            ? "Serie"
            : meta.type === "movie"
              ? "Película"
              : meta.type}
        </span>
      </div>
    </article>
  );
}
