import type { KeyboardEvent, MouseEvent } from "react";
import { Bookmark, BookmarkCheck, Check, Info, Play, Plus, Trash2 } from "lucide-react";
import type { LibraryEntry, MediaItem } from "../lib/contracts";
import { clock, yearOf } from "../lib/utils";
import { Artwork, type MenuAnchor, type MenuItem } from "./Primitives";

export type CardMenu = (anchor: MenuAnchor, items: MenuItem[], label: string) => void;

function progressOf(entry?: LibraryEntry): number {
  return entry?.progress && entry.progress.duration > 0
    ? Math.min(100, (entry.progress.seconds / entry.progress.duration) * 100)
    : 0;
}

export function typeLabel(type: string): string {
  return type === "series" ? "Serie" : type === "movie" ? "Película" : type;
}

/** Moves focus between sibling cards with the arrow keys. */
export function cardKeys(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  // Alt+arrows navigate the history; modified keys are not card movement.
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const track = event.currentTarget.closest("[data-card-track]");
  if (!track) return;
  const cards = [...track.querySelectorAll<HTMLElement>("[data-card-focus]")];
  const index = cards.indexOf(event.currentTarget);
  let next = index;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = cards.length - 1;
  else if (event.key === "ArrowLeft") next = index - 1;
  else if (event.key === "ArrowRight") next = index + 1;
  else {
    const top = event.currentTarget.getBoundingClientRect();
    const sameColumn = cards.filter((card) => {
      const rect = card.getBoundingClientRect();
      return Math.abs(rect.left - top.left) < 4;
    });
    const position = sameColumn.indexOf(event.currentTarget);
    const target = sameColumn[position + (event.key === "ArrowDown" ? 1 : -1)];
    if (!target) return;
    next = cards.indexOf(target);
  }
  if (next < 0 || next >= cards.length) return;
  event.preventDefault();
  cards[next].focus();
  cards[next].scrollIntoView({ block: "nearest", inline: "nearest" });
}

export function MediaCard({
  meta,
  entry,
  onOpen,
  onSave,
  onSources,
  onMenu,
  removeLabel,
}: {
  meta: MediaItem;
  entry?: LibraryEntry;
  onOpen: () => void;
  onSave: () => void;
  onSources?: () => void;
  onMenu?: CardMenu;
  removeLabel?: boolean;
}) {
  const progress = progressOf(entry);
  const saved = Boolean(entry?.saved);
  const watched = Boolean(entry?.watchedAt);
  const year = yearOf(meta);
  const openMenu = (anchor: MenuAnchor) =>
    onMenu?.(
      anchor,
      [
        { label: "Abrir detalles", icon: <Info size={15} />, shortcut: "Intro", onSelect: onOpen },
        ...(onSources
          ? [{ label: "Ver fuentes", icon: <Play size={15} />, onSelect: onSources }]
          : []),
        "separator",
        saved
          ? {
              label: "Quitar de la biblioteca",
              icon: removeLabel ? <Trash2 size={15} /> : <BookmarkCheck size={15} />,
              danger: removeLabel,
              onSelect: onSave,
            }
          : { label: "Añadir a la biblioteca", icon: <Bookmark size={15} />, onSelect: onSave },
      ],
      meta.name,
    );
  return (
    <article
      className="media-card"
      onContextMenu={(event: MouseEvent) => {
        if (!onMenu) return;
        event.preventDefault();
        openMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <button
        className="poster-button"
        onClick={onOpen}
        data-card-focus
        onKeyDown={(event) => {
          if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu({ x: rect.left + 12, y: rect.top + 12 });
            return;
          }
          cardKeys(event);
        }}
        aria-label={`Ver ${meta.name}`}
      >
        <Artwork src={meta.poster} name={meta.name} className="poster" />
        {watched && (
          <span className="card-watched" title="Vista">
            <Check size={12} strokeWidth={2.5} />
            <span className="sr-only">Vista</span>
          </span>
        )}
        {progress > 0 && progress < 95 && (
          <span
            className="card-progress"
            title={`Visto ${clock(entry!.progress!.seconds)} de ${clock(entry!.progress!.duration)}`}
          >
            <span style={{ width: `${progress}%` }} />
          </span>
        )}
      </button>
      <button
        className={`card-save ${saved ? "saved" : ""}`}
        aria-label={
          saved
            ? `Quitar ${meta.name} de mi biblioteca`
            : `Guardar ${meta.name} en mi biblioteca`
        }
        title={saved ? "Quitar de la biblioteca" : "Añadir a la biblioteca"}
        aria-pressed={saved}
        tabIndex={-1}
        onClick={onSave}
      >
        {saved ? <Check size={14} /> : <Plus size={14} />}
      </button>
      <div className="card-text" aria-hidden="true">
        <span className="card-title" title={meta.name}>
          {meta.name}
        </span>
        <span className="card-meta">
          {[year, meta.imdbRating && `★ ${meta.imdbRating}`]
            .filter(Boolean)
            .join(" · ") || typeLabel(meta.type)}
        </span>
      </div>
    </article>
  );
}

export function PosterSkeletons({ count = 8 }: { count?: number }) {
  return Array.from({ length: count }, (_, index) => (
    <div className="media-card skeleton-card" key={index} aria-hidden="true">
      <div className="poster skeleton" />
      <div className="skeleton skeleton-line" />
      <div className="skeleton skeleton-line short" />
    </div>
  ));
}
