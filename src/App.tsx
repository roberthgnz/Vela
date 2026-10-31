import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleUserRound,
  Download as DownloadIcon,
  Users,
  Film,
  Home,
  Keyboard,
  Library,
  PanelLeft,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Settings,
  Tv,
  X,
} from "lucide-react";
import { account, useAccount } from "./lib/account";
import type { Episode, InstalledAddon, MediaItem, ResolvedStream } from "./lib/contracts";
import { episodeCode, nextEpisode, pickNextStream } from "./lib/episodes";
import { externalPlayerName, onExternalClosed, playExternally } from "./lib/externalPlayback";
import { defaultAddons, getStreams, loadManifest } from "./lib/protocol";
import { metaAddon, RouteStateProvider, useNavigation, type Route, type Section } from "./lib/navigation";
import { resolvePlayback } from "./lib/playback";
import { CREDITS_THRESHOLD, mediaKey, preferencesStore, usePreferences } from "./lib/store";
import { openExternal } from "./lib/transport";
import { useUiSetting } from "./lib/ui";
import { clock, errorMessage, motion } from "./lib/utils";
import { AddonsView } from "./components/AddonsView";
import { BrowseView } from "./components/BrowseView";
import { DetailView, type PlayHandler, type PlayMode } from "./components/DetailView";
import { HomeView } from "./components/HomeView";
import { LibraryView } from "./components/LibraryView";
import { DownloadsView } from "./components/DownloadsView";
import { downloads, downloadsAvailable, type Download } from "./lib/downloads";
import type { CardMenu } from "./components/MediaCard";
import { Player, PreparingPlayer, type Playing } from "./components/Player";
import { Dialog, ErrorBoundary, ErrorState, useMenu } from "./components/Primitives";
import { SearchPalette, type Command } from "./components/SearchPalette";
import { SettingsView, ShortcutTable } from "./components/SettingsView";
import { UpdateNotice } from "./components/UpdateNotice";
import { openProfile, ProfileAvatar, ProfilePicker, usePinGate } from "./components/Profiles";
import { profiles, useProfiles } from "./lib/profiles";
import { native, WindowControls } from "./components/WindowControls";
import { sourceHistory } from "./lib/sourceHistory";
import { useStorageStatus } from "./lib/storage";
import { updates } from "./lib/updates";

const primary = [
  { id: "home", label: "Inicio", icon: Home, shortcut: "Ctrl 1" },
  { id: "movies", label: "Películas", icon: Film, shortcut: "Ctrl 2" },
  { id: "series", label: "Series", icon: Tv, shortcut: "Ctrl 3" },
  { id: "library", label: "Biblioteca", icon: Library, shortcut: "Ctrl 4" },
] as const;
const secondary = [
  ...(downloadsAvailable ? [{ id: "downloads", label: "Descargas", icon: DownloadIcon, shortcut: "" } as const] : []),
  { id: "addons", label: "Addons", icon: Puzzle, shortcut: "" },
  { id: "settings", label: "Ajustes", icon: Settings, shortcut: "Ctrl ," },
] as const;

type Toast = { id: number; message: string; tone: "ok" | "error" };

function editable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

export default function App() {
  const prefs = usePreferences();
  const storageStatus = useStorageStatus();
  const accountState = useAccount();
  const nav = useNavigation();
  const menu = useMenu();
  const pinGate = usePinGate((message) => notify(message, "error"));
  const content = useRef<HTMLElement>(null);
  const scrolls = useRef(new Map<number, number>());
  /** Accessible name of the focused control in each history entry, restored when going back. */
  const focused = useRef(new Map<number, string>());
  const restoring = useRef(false);
  const [sidebar, setSidebar] = useUiSetting("sidebar", "expanded", ["expanded", "collapsed"] as const);
  const [searchOpen, setSearchOpen] = useState(false);
  /** Text the palette starts with when it is opened to search for something specific. */
  const [searchText, setSearchText] = useState("");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [installRequest, setInstallRequest] = useState(0);
  const [playing, setPlaying] = useState<Playing | null>(null);
  /** Title whose source is being prepared: the player opens on its cover right away. */
  const [preparing, setPreparing] = useState<{ meta: MediaItem; episode?: Episode } | null>(null);
  /** Increases with every preparation; a result whose number is stale was cancelled. */
  const preparation = useRef(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const notify = useCallback((message: string, tone: Toast["tone"] = "ok") => {
    const id = ++toastId.current;
    setToasts((items) => [...items.slice(-2), { id, message, tone }]);
    setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 4500);
  }, []);

  const remember = () => {
    scrolls.current.set(nav.index, content.current?.scrollTop ?? 0);
    const active = document.activeElement;
    const name = active instanceof HTMLElement && content.current?.contains(active) ? active.getAttribute("aria-label") : null;
    if (name) focused.current.set(nav.index, name);
    else focused.current.delete(nav.index);
  };
  const go = (route: Route) => {
    remember();
    scrolls.current.delete(nav.index + 1);
    focused.current.delete(nav.index + 1);
    nav.navigate(route);
  };
  const section = (name: Section) => {
    // Choosing the current section again returns to its top, like tapping the current tab.
    if (nav.route.name === name) {
      content.current?.scrollTo({ top: 0, behavior: motion() });
      return;
    }
    go({ name });
  };
  const back = () => {
    remember();
    restoring.current = true;
    nav.back();
  };
  const forward = () => {
    remember();
    restoring.current = true;
    nav.forward();
  };
  useLayoutEffect(() => {
    if (content.current) content.current.scrollTop = scrolls.current.get(nav.index) ?? 0;
    if (!restoring.current) return;
    restoring.current = false;
    const name = focused.current.get(nav.index);
    if (!name) return;
    // Restore focus once the view has rendered its cached content.
    requestAnimationFrame(() => {
      const target = [...(content.current?.querySelectorAll<HTMLElement>("[aria-label]") ?? [])].find(
        (element) => element.getAttribute("aria-label") === name,
      );
      target?.focus({ preventScroll: true });
    });
  }, [nav.index]);

  const openMedia = (meta: MediaItem, addonUrl: string, sources?: boolean) =>
    go({ name: "detail", meta, addonUrl, sources });

  const startPlayback = async (
    meta: MediaItem,
    addonUrl: string,
    videoId: string,
    stream: ResolvedStream,
    mode: PlayMode,
    episode?: Episode,
    token = ++preparation.current,
  ) => {
    if (stream.externalUrl || stream.ytId) {
      setPreparing(null);
      await openExternal(
        stream.externalUrl || `https://www.youtube.com/watch?v=${encodeURIComponent(stream.ytId!)}`,
      );
      notify("Fuente abierta en el navegador.");
      return;
    }
    sourceHistory.mark(meta.type, meta.id, videoId, stream, "opened");
    if (mode !== "external") setPreparing({ meta, episode });
    let target: Awaited<ReturnType<typeof resolvePlayback>>;
    try {
      target = await resolvePlayback(meta, stream, prefs.serviceUrl, {
        episode,
        external: mode === "external",
      });
    } catch (error) {
      sourceHistory.mark(meta.type, meta.id, videoId, stream, "failed", errorMessage(error));
      if (token !== preparation.current) return;
      setPreparing(null);
      throw error;
    }
    if (token !== preparation.current) return;
    const entry = preferencesStore.getSnapshot().library[mediaKey(meta.type, meta.id)];
    const saved = entry?.videos?.[videoId] ?? (entry?.progress?.videoId === videoId ? entry.progress : undefined);
    const resume = saved && saved.duration > 0 && saved.seconds < saved.duration * CREDITS_THRESHOLD ? saved.seconds : 0;
    if (mode === "external") {
      const launch = await playExternally(target.externalUrl, {
        meta,
        addonUrl,
        videoId,
        headers: target.headers,
        title: episode ? `${meta.name} · ${episodeCode(episode)}` : meta.name,
        start: resume,
        stream,
        subtitles: target.subtitles,
      });
      sourceHistory.mark(meta.type, meta.id, videoId, stream, "played");
      notify(launch.ipc ? `Abierto en ${externalPlayerName(launch)}. Vela guardará el progreso al cerrarlo.` : "Fuente abierta en el reproductor externo.");
      return;
    }
    setPreparing(null);
    setPlaying({
      meta,
      addonUrl,
      videoId,
      stream: target.subtitles?.length
        ? { ...stream, subtitles: [...(stream.subtitles ?? []), ...target.subtitles] }
        : stream,
      url: target.url,
      externalUrl: target.externalUrl,
      headers: target.headers,
      transcodeUrl: target.transcodeUrl,
      transcodedBecause: target.transcodedBecause,
      probe: target.probe,
      serviceUrl: prefs.serviceUrl,
      note: target.note,
      episode,
      resume,
    });
  };

  /** Plays a downloaded file from disk, resuming like any other source. */
  const playDownload = (item: Download) => {
    const entry = preferencesStore.getSnapshot().library[mediaKey(item.meta.type, item.meta.id)];
    const saved = entry?.videos?.[item.videoId];
    const resume = saved && saved.duration > 0 && saved.seconds < saved.duration * CREDITS_THRESHOLD ? saved.seconds : 0;
    setPlaying({
      meta: entry?.meta.videos ? { ...item.meta, videos: entry.meta.videos } : item.meta,
      addonUrl: item.addonUrl,
      videoId: item.videoId,
      stream: item.stream,
      url: downloads.playableUrl(item),
      externalUrl: item.url,
      headers: item.headers,
      serviceUrl: prefs.serviceUrl,
      note: "Archivo descargado",
      episode: item.episode,
      resume,
    });
  };

  const onPlay: PlayHandler = (meta, addon, videoId, stream, mode, episode) =>
    startPlayback(meta, addon.manifestUrl, videoId, stream, mode, episode);

  /**
   * «Continuar»: plays the source last watched for this title at the saved position. For the next
   * episode it looks for the same release (`bingeGroup`). Without a usable source it opens the
   * sources of the episode instead.
   */
  const resumeTitle = async (meta: MediaItem, addonUrl: string) => {
    const entry = preferencesStore.getSnapshot().library[mediaKey(meta.type, meta.id)];
    const full = entry?.meta.videos?.length ? { ...meta, videos: meta.videos ?? entry.meta.videos } : meta;
    const videoId = entry?.progress?.videoId ?? (meta.type === "series" ? undefined : meta.id);
    const last = sourceHistory.last(meta.type, meta.id);
    const showSources = () => go({ name: "detail", meta: full, addonUrl, videoId, sources: true });
    if (!videoId || !last) return showSources();
    const episode = full.videos?.find((video) => video.id === videoId);
    const token = ++preparation.current;
    setPreparing({ meta: full, episode });
    try {
      let stream = last.videoId === videoId ? last.stream : undefined;
      if (!stream) stream = pickNextStream(await getStreams(preferencesStore.getSnapshot().addons, meta.type, videoId), last.stream);
      if (token !== preparation.current) return;
      if (!stream) {
        setPreparing(null);
        return showSources();
      }
      await startPlayback(full, addonUrl, videoId, stream, "internal", episode, token);
    } catch (error) {
      if (token !== preparation.current) return;
      setPreparing(null);
      notify(errorMessage(error), "error");
      showSources();
    }
  };

  const cancelPreparing = () => {
    preparation.current++;
    setPreparing(null);
  };

  /**
   * Plays the next episode with a stream of the same `bingeGroup` (or, failing that, the same
   * addon and stream name). Without a match, the episode's sources are shown instead.
   */
  const playNext = async (current: Playing, episode: Episode) => {
    const token = ++preparation.current;
    setPreparing({ meta: current.meta, episode });
    setPlaying(null);
    const showSources = () => {
      setPreparing(null);
      go({ name: "detail", meta: current.meta, addonUrl: current.addonUrl, videoId: episode.id, sources: true });
      notify(`Elige una fuente para ${episodeCode(episode)}.`);
    };
    try {
      // Returning from the player shows the episode that was playing.
      nav.update((route) =>
        route.name === "detail" && route.meta.id === current.meta.id
          ? { ...route, videoId: episode.id, season: episode.season ?? route.season }
          : route,
      );
      const streams = await getStreams(preferencesStore.getSnapshot().addons, current.meta.type, episode.id);
      if (token !== preparation.current) return;
      const match = pickNextStream(streams, current.stream);
      if (!match) return showSources();
      await startPlayback(current.meta, current.addonUrl, episode.id, match, "internal", episode, token);
    } catch (error) {
      if (token !== preparation.current) return;
      notify(errorMessage(error), "error");
      showSources();
    }
  };

  useEffect(
    () =>
      onExternalClosed((event) => {
        const position = event.position !== undefined ? ` en ${clock(event.position)}` : "";
        notify(
          event.finished
            ? `Has terminado ${event.meta.name}${nextEpisode(event.meta, event.videoId) ? "; el siguiente episodio queda en «Seguir viendo»" : ""}.`
            : event.ipc
              ? `Reproductor cerrado${position}. Progreso guardado.`
              : "Reproductor externo cerrado.",
        );
        void account.sync();
      }),
    [notify],
  );

  useEffect(() => {
    void account.init();
    // Look for a new version shortly after starting (installed builds only).
    const timer =
      updates.supported() && import.meta.env.PROD && updates.automatic()
        ? setTimeout(() => void updates.check(), 5000)
        : undefined;
    // Addons change their catalogs and resources over time; refresh the stored manifests quietly.
    const bundled = new Set(defaultAddons().map((addon) => addon.manifestUrl));
    for (const addon of preferencesStore.getSnapshot().addons) {
      if (!/^https?:/.test(addon.manifestUrl) || bundled.has(addon.manifestUrl)) continue;
      void loadManifest(addon.manifestUrl)
        .then((fresh) => preferencesStore.refreshAddon(fresh))
        .catch(() => {});
    }
    return () => clearTimeout(timer);
  }, []);

  const profileState = useProfiles();
  const currentProfile = profileState.profiles.find((profile) => profile.id === profileState.active);
  const openSettings = (part: string) => {
    section("settings");
    requestAnimationFrame(() => document.getElementById(`settings-${part}`)?.scrollIntoView());
  };
  // Another profile means another library: start a fresh history and synchronize if it owns the account.
  const shownProfile = useRef(profileState.active);
  useEffect(() => {
    if (shownProfile.current === profileState.active) return;
    shownProfile.current = profileState.active;
    setPlaying(null);
    scrolls.current.clear();
    focused.current.clear();
    nav.reset({ name: "home" });
    void account.sync();
  }, [profileState.active, nav]);

  const onCardMenu: CardMenu = (anchor, items, label) => menu.open(anchor, items, label);

  const latest = useRef({ back, forward, section, route: nav.route, setSidebar, sidebar });
  latest.current = { back, forward, section, route: nav.route, setSidebar, sidebar };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const ctrl = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (ctrl && key === "k") {
        if (document.querySelector("dialog[open]:not(.palette), .profile-picker")) return;
        event.preventDefault();
        setSearchOpen((value) => !value);
        return;
      }
      if (document.querySelector("dialog[open], .profile-picker") || event.defaultPrevented) return;
      const app = latest.current;
      if (event.altKey && key === "arrowleft") app.back();
      else if (event.altKey && key === "arrowright") app.forward();
      else if (event.key === "BrowserBack") app.back();
      else if (event.key === "BrowserForward") app.forward();
      else if (ctrl && /^[1-4]$/.test(key)) app.section(primary[Number(key) - 1].id);
      else if (ctrl && key === ",") app.section("settings");
      else if (ctrl && key === "b") app.setSidebar(app.sidebar === "expanded" ? "collapsed" : "expanded");
      else if ((ctrl && key === "/") || key === "f1") setShortcutsOpen(true);
      else if (key === "/" && !editable(event.target)) setSearchOpen(true);
      else if (key === "escape" && app.route.name === "detail" && !editable(event.target)) app.back();
      else if (key === "f5" || (ctrl && key === "r")) {
        /* Reloading would discard the in-memory history; keep the desktop behavior. */
      } else return;
      event.preventDefault();
    };
    const onMouse = (event: MouseEvent) => {
      if (document.querySelector("dialog[open]")) return;
      if (event.button === 3) latest.current.back();
      else if (event.button === 4) latest.current.forward();
      else return;
      event.preventDefault();
    };
    const onContext = (event: MouseEvent) => {
      if (editable(event.target) || window.getSelection()?.toString()) return;
      if (import.meta.env.DEV && event.shiftKey) return;
      event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mouseup", onMouse);
    document.addEventListener("contextmenu", onContext);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mouseup", onMouse);
      document.removeEventListener("contextmenu", onContext);
    };
  }, []);

  const route = nav.route;
  const routeState = useMemo(() => ({ state: route.state ?? {}, patch: nav.patchState }), [route.state, nav.patchState]);
  const active: Section | "detail" = route.name;
  const commands: Command[] = [
    ...primary.map((item) => ({
      id: item.id,
      label: item.label,
      icon: <item.icon size={15} />,
      shortcut: item.shortcut,
      run: () => section(item.id),
    })),
    { id: "addons", label: "Addons", icon: <Puzzle size={15} />, run: () => section("addons") },
    {
      id: "install",
      label: "Añadir addon",
      icon: <Plus size={15} />,
      run: () => {
        section("addons");
        setInstallRequest((value) => value + 1);
      },
    },
    { id: "settings", label: "Ajustes", icon: <Settings size={15} />, shortcut: "Ctrl ,", run: () => section("settings") },
    { id: "shortcuts", label: "Atajos de teclado", icon: <Keyboard size={15} />, shortcut: "F1", run: () => setShortcutsOpen(true) },
  ];
  const detailAddon: InstalledAddon | undefined =
    route.name === "detail" ? metaAddon(prefs.addons, route.meta, route.addonUrl) : undefined;

  const navButton = ({ id, label, icon: Icon, shortcut }: (typeof primary)[number] | (typeof secondary)[number]) => (
    <button
      key={id}
      className={`nav-item ${active === id ? "active" : ""}`}
      aria-current={active === id ? "page" : undefined}
      aria-label={label}
      title={sidebar === "collapsed" ? `${label}${shortcut ? ` (${shortcut})` : ""}` : undefined}
      onClick={() => section(id)}
    >
      <Icon size={17} strokeWidth={1.75} />
      <span>{label}</span>
    </button>
  );

  return (
    <div className={`app ${sidebar === "collapsed" ? "sidebar-collapsed" : ""} ${native ? "native" : ""}`}>
      <header className="titlebar" data-tauri-drag-region>
        <div className="titlebar-start" data-tauri-drag-region>
          <button
            className="titlebar-button"
            aria-label={sidebar === "expanded" ? "Ocultar barra lateral" : "Mostrar barra lateral"}
            title="Barra lateral (Ctrl B)"
            onClick={() => setSidebar(sidebar === "expanded" ? "collapsed" : "expanded")}
          >
            <PanelLeft size={16} strokeWidth={1.75} />
          </button>
          <span className="app-mark" data-tauri-drag-region>
            <img src="/vela.svg" alt="" draggable={false} />
            <span data-tauri-drag-region>Vela</span>
          </span>
          <div className="history-buttons">
            <button className="titlebar-button" aria-label="Atrás" title="Atrás (Alt ←)" disabled={!nav.canBack} onClick={back}>
              <ChevronLeft size={17} strokeWidth={1.75} />
            </button>
            <button className="titlebar-button" aria-label="Adelante" title="Adelante (Alt →)" disabled={!nav.canForward} onClick={forward}>
              <ChevronRight size={17} strokeWidth={1.75} />
            </button>
          </div>
        </div>
        <button className="search-trigger" aria-label="Buscar" aria-keyshortcuts="Control+K" onClick={() => setSearchOpen(true)}>
          <Search size={14} />
          <span>Buscar películas y series</span>
          <kbd>Ctrl K</kbd>
        </button>
        <div className="titlebar-end" data-tauri-drag-region>
          <WindowControls onError={(message) => notify(message, "error")} />
        </div>
      </header>
      <aside className="sidebar">
        <nav aria-label="Principal" className="nav-group">
          {primary.map(navButton)}
        </nav>
        <div className="sidebar-spacer" />
        <nav aria-label="Configuración" className="nav-group">
          {secondary.map(navButton)}
        </nav>
        {profileState.profiles.length > 1 && currentProfile ? (
          <button
            className="nav-item account-item"
            aria-haspopup="menu"
            aria-label={`Perfil: ${currentProfile.name}`}
            title="Cambiar de perfil"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              menu.open(
                { x: rect.left, y: rect.top - 6, above: true },
                [
                  ...profileState.profiles.map((profile) => ({
                    label: profile.name,
                    icon: <ProfileAvatar profile={profile} size={16} />,
                    checked: profile.id === profileState.active,
                    onSelect: () => openProfile(pinGate, profile),
                  })),
                  "separator" as const,
                  { label: "Administrar perfiles", icon: <Users size={15} />, onSelect: () => openSettings("profiles") },
                  {
                    label: accountState.user ? "Cuenta de Stremio" : "Iniciar sesión en Stremio",
                    icon: <CircleUserRound size={15} />,
                    onSelect: () => openSettings("account"),
                  },
                ],
                "Perfiles",
              );
            }}
          >
            <ProfileAvatar profile={currentProfile} size={18} />
            <span>{currentProfile.name}</span>
          </button>
        ) : (() => {
          const user = accountState.status === "signed-in" ? accountState.user : undefined;
          const state = accountState.syncing ? "Sincronizando…" : accountState.error ? "Error de sincronización" : "Stremio conectado";
          return (
            <button
              className="nav-item account-item"
              onClick={() => openSettings("account")}
              title={user ? `${user.email} · ${state}` : "Conectar la cuenta de Stremio"}
              aria-label={user ? `Cuenta de Stremio: ${user.email}. ${state}` : "Iniciar sesión en Stremio"}
            >
              {user ? (
                <span className={`account-initial ${accountState.error ? "error" : ""}`} aria-hidden="true">
                  {accountState.syncing ? <RefreshCw size={11} className="spin" /> : user.email.charAt(0).toUpperCase()}
                </span>
              ) : (
                <CircleUserRound size={17} strokeWidth={1.75} />
              )}
              <span>{user ? user.email : "Iniciar sesión"}</span>
            </button>
          );
        })()}
      </aside>
      <RouteStateProvider value={routeState}>
      <main id="main" className="content" ref={content} tabIndex={-1}>
        {(preferencesStore.getPersistenceError() || storageStatus.error) && (
          <div className="banner">
            <ErrorState
              message={
                storageStatus.backend === "desktop"
                  ? `No se pudo guardar en la base de datos de Vela (${storageStatus.error}). Vela lo reintentará; si el problema sigue, los cambios se perderán al cerrar.`
                  : storageStatus.error
                    ? `La base de datos de Vela no se pudo abrir (${storageStatus.error}). Los datos se guardan mientras tanto en el almacenamiento de WebView2.`
                    : "No se pudo guardar en este equipo. Los cambios se conservarán solo mientras Vela siga abierta."
              }
            />
          </div>
        )}
        <ErrorBoundary name={`view ${route.name}`} resetKey={route}>
        {route.name === "home" && (
          <HomeView
            onOpen={openMedia}
            onResume={(meta, addonUrl) => void resumeTitle(meta, addonUrl)}
            onBrowse={(type, catalog) => go({ name: type === "movie" ? "movies" : "series", state: { catalog } })}
            onAddons={() => section("addons")}
            onMenu={onCardMenu}
          />
        )}
        {(route.name === "movies" || route.name === "series") && (
          <BrowseView
            key={route.name}
            type={route.name === "movies" ? "movie" : "series"}
            onOpen={openMedia}
            onAddons={() => section("addons")}
            onMenu={onCardMenu}
          />
        )}
        {route.name === "library" && (
          <LibraryView onOpen={openMedia} onDiscover={() => section("home")} onMenu={onCardMenu} />
        )}
        {route.name === "downloads" && <DownloadsView onPlay={playDownload} notify={notify} />}
        {route.name === "addons" && <AddonsView notify={notify} installRequest={installRequest} />}
        {route.name === "settings" && <SettingsView notify={notify} />}
        {route.name === "detail" && detailAddon && (
          <DetailView
            key={`${nav.index}:${mediaKey(route.meta.type, route.meta.id)}`}
            meta={route.meta}
            addon={detailAddon}
            videoId={route.videoId}
            season={route.season}
            startSources={route.sources}
            onVideoChange={(videoId) => nav.update((current) => ({ ...current, videoId }))}
            onSeasonChange={(season) => nav.update((current) => ({ ...current, season }))}
            onSourcesChange={(sources) => nav.update((current) => ({ ...current, sources }))}
            onPlay={onPlay}
            onResume={() => void resumeTitle(route.meta, route.addonUrl)}
            onAddons={() => section("addons")}
            onGenre={(type, target) =>
              go({
                name: type === "movie" ? "movies" : "series",
                state: { catalog: target.source.key, filters: JSON.stringify({ genre: target.value }) },
              })
            }
            onPerson={(name) => {
              setSearchText(name);
              setSearchOpen(true);
            }}
            notify={notify}
          />
        )}
        </ErrorBoundary>
      </main>
      </RouteStateProvider>
      {searchOpen && (
        <SearchPalette
          initialQuery={searchText}
          onClose={() => {
            setSearchOpen(false);
            setSearchText("");
          }}
          onOpen={(meta, addon) => openMedia(meta, addon.manifestUrl)}
          commands={commands}
        />
      )}
      {shortcutsOpen && (
        <Dialog title="Atajos de teclado" onClose={() => setShortcutsOpen(false)} className="compact-dialog wide">
          <h2>Atajos de teclado</h2>
          <ShortcutTable seekShort={prefs.player.seekShort} seekLong={prefs.player.seekLong} />
        </Dialog>
      )}
      {playing && (
        <ErrorBoundary name="player" resetKey={playing}>
        <Player
          key={`${playing.videoId}|${playing.url}`}
          playing={playing}
          onNext={(episode) => void playNext(playing, episode)}
          onStarted={() => sourceHistory.mark(playing.meta.type, playing.meta.id, playing.videoId, playing.stream, "played")}
          onFailed={(message) =>
            sourceHistory.mark(playing.meta.type, playing.meta.id, playing.videoId, playing.stream, "failed", message)
          }
          onClose={() => {
            setPlaying(null);
            void account.sync();
          }}
        />
        </ErrorBoundary>
      )}
      {menu.element}
      <UpdateNotice />
      {!profileState.chosen && (
        <ProfilePicker onManage={() => openSettings("profiles")} />
      )}
      {pinGate.element}
      {preparing && !playing && (
        <PreparingPlayer meta={preparing.meta} episode={preparing.episode} onClose={cancelPreparing} />
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div className={`toast ${toast.tone}`} key={toast.id} role="status">
            {toast.tone === "ok" ? <CircleCheck size={15} /> : <AlertCircle size={15} />}
            <span>{toast.message}</span>
            <button
              className="icon-button"
              aria-label="Cerrar aviso"
              onClick={() => setToasts((items) => items.filter((item) => item.id !== toast.id))}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
