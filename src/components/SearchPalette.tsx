import { useDeferredValue, useState, type KeyboardEvent, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CornerDownLeft, Search } from "lucide-react";
import type { InstalledAddon, MediaItem } from "../lib/contracts";
import { getCatalog, getCatalogSources } from "../lib/protocol";
import { useKidsMode } from "../lib/profiles";
import { mediaKey, usePreferences } from "../lib/store";
import { errorMessage, yearOf } from "../lib/utils";
import { typeLabel } from "./MediaCard";
import { Artwork, Dialog, EmptyState, ErrorState, Spinner } from "./Primitives";

export type Command = {
  id: string;
  label: string;
  icon: ReactNode;
  shortcut?: string;
  run: () => void;
};


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
}: {
  onClose: () => void;
  onOpen: (meta: MediaItem, addon: InstalledAddon) => void;
  commands: Command[];
}) {
  const prefs = usePreferences();
  const [input, setInput] = useState("");
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
        throw new Error("Los catálogos no han respondido. Prueba de nuevo.");
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
  const groups = query.data
    ? (["movie", "series"] as const)
        .map((type) => ({ type, items: query.data.filter(({ meta }) => meta.type === type) }))
        .concat([
          {
            type: "other" as never,
            items: query.data.filter(({ meta }) => meta.type !== "movie" && meta.type !== "series"),
          },
        ])
        .filter((group) => group.items.length)
    : [];
  return (
    <Dialog title="Buscar" className="palette" onClose={onClose} hideClose>
      <div className="palette-field">
        <Search size={17} />
        <input
          type="search"
          aria-label="Buscar películas y series"
          placeholder="Buscar películas, series o comandos"
          autoFocus
          data-autofocus
          autoComplete="off"
          spellCheck={false}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget
                .closest(".palette")
                ?.querySelector<HTMLElement>("[data-palette-item]")
                ?.click();
            } else moveFocus(event);
          }}
        />
        {query.isFetching && <Spinner />}
        <kbd>Esc</kbd>
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
                <section key={group.type} aria-label={group.type === "series" ? "Series" : group.type === "movie" ? "Películas" : "Otros"}>
                  <h3 className="palette-group">
                    {group.type === "series" ? "Series" : group.type === "movie" ? "Películas" : "Otros"}
                    <span>{group.items.length}</span>
                  </h3>
                  {group.items.map(({ meta, addon }) => (
                    <button
                      key={mediaKey(meta.type, meta.id)}
                      className="palette-item"
                      data-palette-item
                      aria-label={`Ver ${meta.name}`}
                      onKeyDown={moveFocus}
                      onClick={() => {
                        onClose();
                        onOpen(meta, addon);
                      }}
                    >
                      <Artwork src={meta.poster} name={meta.name} className="thumb" />
                      <span className="palette-text">
                        <strong>{meta.name}</strong>
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
              <EmptyState
                compact
                icon={<Search size={18} />}
                title="No encontramos resultados"
                description={
                  sources.length
                    ? `Ningún catálogo devuelve resultados para «${search}».`
                    : "No hay ningún catálogo activo con búsqueda."
                }
              />
            )}
          </>
        )}
        {matchingCommands.length > 0 && (
          <section aria-label="Comandos">
            <h3 className="palette-group">Ir a</h3>
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
          <EmptyState compact icon={<Search size={18} />} title="Escribe al menos dos letras" description="La búsqueda consulta los catálogos activos." />
        )}
      </div>
      <footer className="palette-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> navegar</span>
        <span><kbd>Intro</kbd> abrir</span>
        <span><kbd>Esc</kbd> cerrar</span>
      </footer>
    </Dialog>
  );
}
