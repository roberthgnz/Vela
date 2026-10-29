import { useCallback, useDeferredValue, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowRight,
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  Compass,
  Film,
  Grid2X2,
  Library,
  Maximize2,
  Minus,
  Play,
  Search,
  Settings2,
  Star,
  Tv,
  X,
} from "lucide-react";
import type {
  CatalogSource,
  InstalledAddon,
  MediaItem,
  ResolvedStream,
} from "./lib/contracts";
import {
  getCatalog,
  getCatalogSources,
  getMeta,
  supportsResource,
} from "./lib/protocol";
import { mediaKey, preferencesStore, usePreferences } from "./lib/store";
import { openExternal, requestJson } from "./lib/transport";
import { errorMessage, isDirectUrl, safeImage, yearOf } from "./lib/utils";
import { AddonsView } from "./components/AddonsView";
import { MediaCard } from "./components/MediaCard";
import { MediaDetails, type Selection } from "./components/MediaDetails";
import { Player, type Playing } from "./components/Player";
import {
  Dialog,
  EmptyState,
  ErrorState,
  Loading,
} from "./components/Primitives";
import { SettingsView } from "./components/SettingsView";

type OpenMedia = (
  meta: MediaItem,
  addon: InstalledAddon,
  sources?: boolean,
) => void;
const navigation = [
  { id: "discover", label: "Descubrir", icon: Compass },
  { id: "movies", label: "Películas", icon: Film },
  { id: "series", label: "Series", icon: Tv },
  { id: "library", label: "Mi biblioteca", icon: Library },
] as const;

function Cards({
  items,
  addon,
  onOpen,
}: {
  items: MediaItem[];
  addon: InstalledAddon;
  onOpen: OpenMedia;
}) {
  const prefs = usePreferences();
  return items.map((meta) => (
    <MediaCard
      key={mediaKey(meta.type, meta.id)}
      meta={meta}
      entry={prefs.library[mediaKey(meta.type, meta.id)]}
      onOpen={() => onOpen(meta, addon)}
      onSave={() => preferencesStore.toggleMedia(meta, addon.manifestUrl)}
    />
  ));
}

function CatalogShelf({
  source,
  title,
  onOpen,
  onBrowse,
}: {
  source: CatalogSource;
  title: string;
  onOpen: OpenMedia;
  onBrowse?: () => void;
}) {
  const shelf = useRef<HTMLDivElement>(null);
  const query = useQuery({
    queryKey: ["catalog", source.key, ""],
    queryFn: ({ signal }) => getCatalog(source, {}, signal),
  });
  return (
    <section className="content-section catalog-shelf">
      <div className="section-heading">
        <div>
          <span className="eyebrow muted">{source.addon.manifest.name}</span>
          <h2>{title}</h2>
        </div>
        <div className="shelf-controls">
          {onBrowse && (
            <button className="text-button" onClick={onBrowse}>
              Ver todo <ArrowRight size={14} />
            </button>
          )}
          <button
            className="icon-button"
            aria-label={`Anterior en ${title}`}
            onClick={() =>
              shelf.current?.scrollBy({ left: -600, behavior: "smooth" })
            }
          >
            <ChevronLeft size={17} />
          </button>
          <button
            className="icon-button"
            aria-label={`Siguiente en ${title}`}
            onClick={() =>
              shelf.current?.scrollBy({ left: 600, behavior: "smooth" })
            }
          >
            <ChevronRight size={17} />
          </button>
        </div>
      </div>
      {query.isPending ? (
        <div className="shelf-track">
          {Array.from({ length: 6 }, (_, i) => (
            <div className="poster-skeleton" key={i} />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState
          message={errorMessage(query.error)}
          retry={() => void query.refetch()}
        />
      ) : query.data.length ? (
        <div className="shelf-track" ref={shelf}>
          <Cards
            items={query.data.slice(0, 18)}
            addon={source.addon}
            onOpen={onOpen}
          />
        </div>
      ) : (
        <p className="hint">Este catálogo aún no tiene títulos disponibles.</p>
      )}
    </section>
  );
}

function Hero({ addon, onOpen }: { addon: InstalledAddon; onOpen: OpenMedia }) {
  const [index, setIndex] = useState(0);
  const prefs = usePreferences();
  const ids = ["tt1160419", "tt0816692", "tt1856101"];
  const query = useQuery({
    queryKey: ["meta", addon.manifestUrl, "movie", ids[index]],
    queryFn: ({ signal }) => getMeta(addon, "movie", ids[index], signal),
  });
  const meta = query.data;
  if (query.isError) return null;
  if (!meta)
    return (
      <section className="hero hero-loading">
        <Loading label="Preparando tus recomendaciones" />
      </section>
    );
  const saved = Boolean(prefs.library[mediaKey(meta.type, meta.id)]);
  return (
    <section className="hero">
      {safeImage(meta.background || meta.poster) && (
        <img
          className="hero-backdrop"
          src={safeImage(meta.background || meta.poster)}
          alt=""
          fetchPriority="high"
        />
      )}
      <div className="hero-shade" />
      <div className="hero-copy">
        <span className="eyebrow">EN EL RADAR</span>
        <h1>{meta.name}</h1>
        <div className="hero-facts">
          {meta.imdbRating && (
            <span className="score">
              <Star size={13} fill="currentColor" />
              {meta.imdbRating}
            </span>
          )}
          <span>{yearOf(meta)}</span>
          <span>{meta.runtime}</span>
          <span>{meta.genres?.slice(0, 2).join(" · ")}</span>
        </div>
        <p>{meta.description}</p>
        <div className="hero-actions">
          <button
            className="button primary"
            onClick={() => onOpen(meta, addon, true)}
          >
            <Play size={15} fill="currentColor" />
            Ver fuentes
          </button>
          <button
            className="button secondary"
            onClick={() => onOpen(meta, addon)}
          >
            Ver detalles
          </button>
          <button
            className="icon-button hero-save"
            aria-label={
              saved ? "Quitar de mi biblioteca" : "Guardar en mi biblioteca"
            }
            aria-pressed={saved}
            onClick={() =>
              preferencesStore.toggleMedia(meta, addon.manifestUrl)
            }
          >
            {saved ? <Check size={19} /> : <Bookmark size={19} />}
          </button>
        </div>
      </div>
      <div className="hero-pages">
        {ids.map((id, i) => (
          <button
            key={id}
            className={i === index ? "selected" : ""}
            aria-label={`Recomendación ${i + 1}`}
            aria-pressed={i === index}
            onClick={() => setIndex(i)}
          />
        ))}
      </div>
    </section>
  );
}

function BrowseView({ type, onOpen }: { type: string; onOpen: OpenMedia }) {
  const prefs = usePreferences();
  const sources = getCatalogSources(prefs.addons, type).filter(
    (source) =>
      !(
        source.catalog.extra?.some(
          (extra) => extra.isRequired && extra.name !== "genre",
        ) || source.catalog.extraRequired?.some((extra) => extra !== "genre")
      ),
  );
  const [sourceKey, setSourceKey] = useState("");
  const source = sources.find((item) => item.key === sourceKey) || sources[0];
  return (
    <section className="page-view">
      <div className="page-heading browse-heading">
        <div>
          <span className="eyebrow">EXPLORAR CATÁLOGOS</span>
          <h1>{type === "movie" ? "Películas" : "Series"}</h1>
        </div>
        {source && (
          <label className="source-select">
            <span className="sr-only">Catálogo</span>
            <select
              aria-label="Catálogo"
              value={source.key}
              onChange={(event) => setSourceKey(event.target.value)}
            >
              {sources.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.addon.manifest.name} · {item.catalog.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {source ? (
        <BrowseCatalog key={source.key} source={source} onOpen={onOpen} />
      ) : (
        <EmptyState
          title="Aquí empieza tu catálogo"
          description="Activa o instala un addon con catálogos para explorar nuevas historias."
        />
      )}
    </section>
  );
}

function BrowseCatalog({
  source,
  onOpen,
}: {
  source: CatalogSource;
  onOpen: OpenMedia;
}) {
  const [genre, setGenre] = useState("");
  const genres =
    source.catalog.extra?.find((extra) => extra.name === "genre")?.options ||
    [];
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
  const seen = new Set<string>();
  const items = (query.data?.pages.flat() || []).filter((meta) => {
    const key = mediaKey(meta.type, meta.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return (
    <>
      {genres.length > 0 && (
        <div className="filter-chips">
          <button
            className={!genre ? "selected" : ""}
            onClick={() => setGenre("")}
          >
            Todo
          </button>
          {genres.map((value) => (
            <button
              key={value}
              className={value === genre ? "selected" : ""}
              onClick={() => setGenre(value)}
            >
              {value}
            </button>
          ))}
        </div>
      )}
      {query.isPending ? (
        <Loading label="Cargando tu catálogo" />
      ) : query.isError ? (
        <ErrorState
          message={errorMessage(query.error)}
          retry={() => void query.refetch()}
        />
      ) : items.length ? (
        <>
          <div className="poster-grid">
            <Cards items={items} addon={source.addon} onOpen={onOpen} />
          </div>
          {query.hasNextPage && (
            <div className="load-more">
              <button
                className="button secondary"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? "Cargando…" : "Cargar más"}
              </button>
            </div>
          )}
        </>
      ) : (
        <EmptyState
          title="Sin títulos por ahora"
          description="Prueba otro género o cambia de catálogo."
        />
      )}
    </>
  );
}

function SearchDialog({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  onOpen: OpenMedia;
}) {
  const prefs = usePreferences();
  const [input, setInput] = useState("");
  const search = useDeferredValue(input.trim());
  const sources = getCatalogSources(prefs.addons).filter(
    (source) =>
      source.catalog.extra?.some((extra) => extra.name === "search") ||
      source.catalog.extraSupported?.includes("search"),
  );
  const query = useQuery({
    queryKey: ["search", sources.map((source) => source.key), search],
    enabled: search.length >= 2,
    queryFn: async ({ signal }) => {
      const results = await Promise.allSettled(
        sources.map(async (source) => ({
          source,
          items: await getCatalog(source, { search }, signal),
        })),
      );
      if (signal.aborted)
        throw new DOMException("Solicitud cancelada", "AbortError");
      const valid = results
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value);
      if (!valid.length && results.length)
        throw new Error(
          "Tus catálogos no han podido responder. Prueba de nuevo.",
        );
      const found = new Set<string>();
      return valid
        .flatMap(({ source, items }) =>
          items.map((meta) => ({ meta, addon: source.addon })),
        )
        .filter(({ meta }) => {
          const key = mediaKey(meta.type, meta.id);
          if (found.has(key)) return false;
          found.add(key);
          return true;
        });
    },
  });
  return (
    <Dialog title="Buscar" className="search-dialog" onClose={onClose}>
      <div className="search-field">
        <Search size={21} />
        <input
          type="search"
          aria-label="Buscar películas y series"
          placeholder="Películas, series, tu próxima obsesión…"
          autoFocus
          data-autofocus
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <kbd>ESC</kbd>
      </div>
      <div className="search-results">
        {search.length < 2 ? (
          <EmptyState
            title="¿Qué te apetece ver?"
            description="Escribe al menos dos letras para buscar en tus catálogos."
            icon={<Search size={25} />}
          />
        ) : query.isPending ? (
          <Loading label="Buscando en tus addons" />
        ) : query.isError ? (
          <ErrorState
            message={errorMessage(query.error)}
            retry={() => void query.refetch()}
          />
        ) : query.data?.length ? (
          <>
            <div className="section-heading">
              <span className="eyebrow muted">
                {query.data.length} RESULTADOS
              </span>
            </div>
            <div className="search-results-grid">
              {query.data.map(({ meta, addon }) => (
                <MediaCard
                  key={mediaKey(meta.type, meta.id)}
                  meta={meta}
                  entry={prefs.library[mediaKey(meta.type, meta.id)]}
                  onOpen={() => {
                    onClose();
                    onOpen(meta, addon);
                  }}
                  onSave={() =>
                    preferencesStore.toggleMedia(meta, addon.manifestUrl)
                  }
                />
              ))}
            </div>
          </>
        ) : (
          <EmptyState
            title="No encontramos esa historia"
            description={
              sources.length
                ? "Prueba otro título o instala un catálogo diferente."
                : "No tienes ningún catálogo con búsqueda activado."
            }
          />
        )}
      </div>
    </Dialog>
  );
}

function LibraryView({
  onOpen,
  onDiscover,
}: {
  onOpen: OpenMedia;
  onDiscover: () => void;
}) {
  const prefs = usePreferences();
  const [tab, setTab] = useState("all");
  const entries = Object.values(prefs.library)
    .filter(
      (entry) =>
        tab === "all" ||
        (entry.progress &&
          entry.progress.seconds > 0 &&
          entry.progress.seconds < entry.progress.duration * 0.95),
    )
    .sort((a, b) =>
      tab === "continue"
        ? (b.progress?.updatedAt || 0) - (a.progress?.updatedAt || 0)
        : b.addedAt - a.addedAt,
    );
  const open = (meta: MediaItem, addonUrl: string) => {
    const addon =
      prefs.addons.find(
        (item) => item.enabled && item.manifestUrl === addonUrl,
      ) ||
      prefs.addons.find(
        (item) =>
          item.enabled && supportsResource(item, "meta", meta.type, meta.id),
      );
    onOpen(
      meta,
      addon || {
        manifestUrl: addonUrl,
        enabled: true,
        installedAt: 0,
        manifest: {
          id: "saved",
          name: "Tu biblioteca",
          version: "1",
          resources: [],
          types: [meta.type],
          catalogs: [],
        },
      },
    );
  };
  return (
    <section className="page-view">
      <div className="page-heading">
        <div>
          <span className="eyebrow">GUARDADO PARA TI</span>
          <h1>Mi biblioteca</h1>
          <p>
            {Object.keys(prefs.library).length} historias en este dispositivo.
          </p>
        </div>
      </div>
      <div className="filter-chips library-tabs">
        <button
          className={tab === "all" ? "selected" : ""}
          onClick={() => setTab("all")}
        >
          Todas
        </button>
        <button
          className={tab === "continue" ? "selected" : ""}
          onClick={() => setTab("continue")}
        >
          Seguir viendo
        </button>
      </div>
      {entries.length ? (
        <div className="poster-grid">
          {entries.map((entry) => (
            <MediaCard
              key={mediaKey(entry.meta.type, entry.meta.id)}
              meta={entry.meta}
              entry={entry}
              onOpen={() => open(entry.meta, entry.addonUrl)}
              onSave={() =>
                preferencesStore.removeMedia(entry.meta.type, entry.meta.id)
              }
            />
          ))}
        </div>
      ) : (
        <EmptyState
          title={
            tab === "continue"
              ? "Tu próxima sesión empieza aquí"
              : "Hay historias que merecen guardarse"
          }
          description={
            tab === "continue"
              ? "Cuando reproduzcas un vídeo, podrás retomarlo desde aquí."
              : "Usa el botón + de una película o serie para encontrarla después."
          }
          action={
            <button className="button primary" onClick={onDiscover}>
              Descubrir historias <ArrowRight size={15} />
            </button>
          }
          icon={<Library size={26} />}
        />
      )}
    </section>
  );
}

export default function App() {
  const prefs = usePreferences();
  const [view, setView] = useState("discover");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [playing, setPlaying] = useState<Playing | null>(null);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const notify = (message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 5000);
  };
  const mount = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((value) => !value);
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      clearTimeout(toastTimer.current);
    };
  }, []);
  const open: OpenMedia = (meta, addon, sources) =>
    setSelection({ meta, addon, startSources: sources });
  const navigate = (value: string) => {
    setView(value);
    window.scrollTo({ top: 0 });
  };
  const sources = getCatalogSources(prefs.addons).filter(
    (source) =>
      !source.catalog.extra?.some((extra) => extra.isRequired) &&
      !source.catalog.extraRequired?.length,
  );
  const cinema = prefs.addons.find(
    (addon) => addon.enabled && addon.manifest.id === "com.linvo.cinemeta",
  );
  const movie =
    sources.find(
      (source) => source.catalog.type === "movie" && source.addon === cinema,
    ) || sources.find((source) => source.catalog.type === "movie");
  const series = sources.find((source) => source.catalog.type === "series");
  const demo = sources.find(
    (source) => source.addon.manifest.id === "com.vela.open-cinema",
  );
  const onPlay = async (
    meta: MediaItem,
    addon: InstalledAddon,
    videoId: string,
    stream: ResolvedStream,
  ) => {
    if (stream.externalUrl || stream.ytId) {
      await openExternal(
        stream.externalUrl ||
          `https://www.youtube.com/watch?v=${encodeURIComponent(stream.ytId!)}`,
      );
      notify("Fuente abierta en tu navegador.");
      return;
    }
    let url = stream.url;
    if (stream.infoHash && !url) {
      if (!/^[a-f0-9]{40}$/i.test(stream.infoHash))
        throw new Error(
          "Este addon devolvió un identificador torrent no válido.",
        );
      if (meta.type === "series" && stream.fileIdx === undefined)
        throw new Error(
          "Esta fuente no identifica el archivo del episodio. Prueba otra fuente.",
        );
      try {
        await requestJson(`${prefs.serviceUrl.replace(/\/$/, "")}/settings`);
      } catch {
        throw new Error(
          "Abre Stremio Service para reproducir torrents y comprueba su conexión en Ajustes. Los enlaces MP4 y HLS no necesitan ese servicio.",
        );
      }
      url = `${prefs.serviceUrl.replace(/\/$/, "")}/${stream.infoHash}/${stream.fileIdx ?? -1}`;
    }
    if (!isDirectUrl(url))
      throw new Error(
        "Esta fuente no proporciona un enlace de vídeo compatible.",
      );
    if (Object.keys(stream.behaviorHints?.proxyHeaders?.request || {}).length)
      throw new Error(
        "Esta fuente requiere cabeceras especiales. Elige otra fuente; este tipo de proxy todavía no está integrado.",
      );
    const progress = prefs.library[mediaKey(meta.type, meta.id)]?.progress;
    setSelection(null);
    setPlaying({
      meta,
      addonUrl: addon.manifestUrl,
      videoId,
      stream,
      url,
      resume: progress?.videoId === videoId ? progress.seconds : 0,
    });
  };
  const native = isTauri();
  const windowAction = (action: "minimize" | "toggleMaximize" | "close") => {
    void getCurrentWindow()
      [action]()
      .catch((error) => notify(errorMessage(error)));
  };
  const extraSources = sources
    .filter(
      (source) => source !== movie && source !== series && source !== demo,
    )
    .slice(0, 3);
  return (
    <div className={`app-shell ${native ? "native-app" : ""}`} ref={mount}>
      <a className="skip-link" href="#main">
        Saltar al contenido
      </a>
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => navigate("discover")}
          aria-label="Vela, inicio"
        >
          <img src="/vela.svg" alt="" />
          <span>vela</span>
        </button>
        <span className="nav-label">BIBLIOTECA MULTIMEDIA</span>
        <nav aria-label="Principal">
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${view === id ? "active" : ""}`}
              aria-current={view === id ? "page" : undefined}
              aria-label={label}
              onClick={() => navigate(id)}
            >
              <Icon size={19} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {[
            { id: "addons", label: "Addons", icon: Grid2X2 },
            { id: "settings", label: "Ajustes", icon: Settings2 },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${view === id ? "active" : ""}`}
              aria-current={view === id ? "page" : undefined}
              aria-label={label}
              onClick={() => navigate(id)}
            >
              <Icon size={19} />
              <span>{label}</span>
            </button>
          ))}
          <div className="local-profile">
            <span className="avatar">V</span>
            <span>
              Espacio local<small>En este dispositivo</small>
            </span>
          </div>
        </div>
      </aside>
      <main id="main" className="main-content">
        <header className="topbar" data-tauri-drag-region>
          <span className="breadcrumb" data-tauri-drag-region>
            {navigation.find((item) => item.id === view)?.label ||
              (view === "addons" ? "Addons" : "Ajustes")}
          </span>
          <button
            className="search-trigger"
            aria-label="Buscar"
            onClick={() => setSearchOpen(true)}
          >
            <Search size={16} />
            <span>Buscar películas y series</span>
            <kbd>Ctrl K</kbd>
          </button>
          {native && (
            <div className="desktop-window-controls">
              <button
                className="window-control"
                aria-label="Minimizar"
                onClick={() => windowAction("minimize")}
              >
                <Minus size={15} />
              </button>
              <button
                className="window-control"
                aria-label="Maximizar o restaurar"
                onClick={() => windowAction("toggleMaximize")}
              >
                <Maximize2 size={13} />
              </button>
              <button
                className="window-control close-window"
                aria-label="Cerrar Vela"
                onClick={() => windowAction("close")}
              >
                <X size={17} />
              </button>
            </div>
          )}
        </header>
        {preferencesStore.getPersistenceError() && (
          <ErrorState message="No se pudo guardar en este dispositivo. Los cambios actuales se conservarán solo mientras Vela permanezca abierta." />
        )}
        {view === "discover" && (
          <>
            {cinema && <Hero addon={cinema} onOpen={open} />}
            <div className="discover-heading">
              <span className="eyebrow muted">TUS CATÁLOGOS</span>
              <h2>Encuentra qué ver</h2>
            </div>
            {movie && (
              <CatalogShelf
                source={movie}
                title="Películas para tu lista"
                onOpen={open}
                onBrowse={() => navigate("movies")}
              />
            )}{" "}
            {series && (
              <CatalogShelf
                source={series}
                title="Un capítulo más"
                onOpen={open}
                onBrowse={() => navigate("series")}
              />
            )}{" "}
            {demo && demo !== movie && (
              <CatalogShelf
                source={demo}
                title="Prueba el reproductor · Tráileres"
                onOpen={open}
              />
            )}{" "}
            {extraSources.map((source) => (
              <CatalogShelf
                key={source.key}
                source={source}
                title={source.catalog.name}
                onOpen={open}
              />
            ))}
            {!sources.length && (
              <EmptyState
                title="Conecta tu próximo descubrimiento"
                description="Activa un catálogo en Addons para comenzar."
                action={
                  <button
                    className="button primary"
                    onClick={() => navigate("addons")}
                  >
                    Abrir addons
                  </button>
                }
              />
            )}
          </>
        )}
        {view === "movies" && (
          <BrowseView key="movies" type="movie" onOpen={open} />
        )}{" "}
        {view === "series" && (
          <BrowseView key="series" type="series" onOpen={open} />
        )}{" "}
        {view === "library" && (
          <LibraryView onOpen={open} onDiscover={() => navigate("discover")} />
        )}{" "}
        {view === "addons" && <AddonsView />}{" "}
        {view === "settings" && <SettingsView notify={notify} />}
      </main>
      {searchOpen && (
        <SearchDialog onClose={() => setSearchOpen(false)} onOpen={open} />
      )}{" "}
      {selection && (
        <MediaDetails
          key={`${selection.addon.manifestUrl}-${mediaKey(selection.meta.type, selection.meta.id)}`}
          selection={selection}
          onClose={() => setSelection(null)}
          onPlay={onPlay}
          onAddons={() => {
            setSelection(null);
            navigate("addons");
          }}
        />
      )}{" "}
      {playing && (
        <Player
          playing={playing}
          onClose={() => {
            setPlaying(null);
            const addon = prefs.addons.find(
              (item) => item.manifestUrl === playing.addonUrl,
            );
            if (addon)
              setSelection({ meta: playing.meta, addon, startSources: true });
          }}
        />
      )}{" "}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          <span>{toast}</span>
          <button
            className="icon-button"
            aria-label="Cerrar aviso"
            onClick={() => setToast("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
