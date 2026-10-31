import { Fragment, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { useContentFilter, useTitleAllowed } from "../lib/contentFilter";
import { Check, ChevronLeft, ChevronRight, EyeOff, Info, Play, Plus, Puzzle, ThumbsUp, X } from "lucide-react";
import type { CatalogSource, LibraryEntry, MediaItem } from "../lib/contracts";
import { homeRows } from "../lib/catalogLayout";
import { useKidsMode } from "../lib/profiles";
import { kidsCatalog } from "../lib/tmdbCatalogs";
import { getCatalog, getCatalogSources } from "../lib/protocol";
import { mediaKey, preferencesStore, usePreferences } from "../lib/store";
import { episodeCode } from "../lib/episodes";
import { COLD_LIKES, useForYou } from "../lib/forYou";
import { reasonText, type Row, type Scored } from "../lib/recommend";
import { taste, useTaste } from "../lib/taste";
import { clock, errorMessage, motion, safeImage } from "../lib/utils";
import { cardKeys, MediaCard, PosterSkeletons, typeLabel, type CardMenu } from "./MediaCard";
import { Artwork, EmptyState, ErrorState } from "./Primitives";
import { plural, t } from "../lib/i18n";

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
      behavior: motion(),
    });
  return (
    <section className={`shelf ${className}`} aria-label={title}>
      <header className="shelf-header">
        <h2>{title}</h2>
        {subtitle && <span className="shelf-subtitle">{subtitle}</span>}
        {onBrowse && (
          <button className="link-button" onClick={onBrowse}>
            {t("home.seeAll")} <ChevronRight size={14} />
          </button>
        )}
      </header>
      <div className="shelf-viewport">
        {edges.start && (
          <button
            className="shelf-nav start"
            aria-label={t("home.previousIn", { title })}
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
            aria-label={t("home.nextIn", { title })}
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
  const content = useContentFilter(query.data ?? [], (meta) => meta);
  if (query.isSuccess && !content.visible.length && !content.pending) return null;
  return (
    <Shelf
      title={title}
      subtitle={source.addon.manifest.name}
      onBrowse={onBrowse}
      ready={query.isSuccess}
    >
      {query.isPending || (!content.visible.length && content.pending) ? (
        <PosterSkeletons count={10} />
      ) : query.isError ? (
        <ErrorState
          message={errorMessage(query.error)}
          retry={() => void query.refetch()}
        />
      ) : (
        content.visible.slice(0, 24).map((meta) => (
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
  const videoId = entry.progress?.videoId;
  const episode = entry.meta.videos?.find((video) => video.id === videoId);
  if (episode) return episodeCode(episode);
  const match = videoId?.match(/:(\d+):(\d+)$/);
  return match ? t("home.episodeCode", { season: match[1], episode: match[2] }) : "";
}

function ContinueCard({
  entry,
  onOpen,
  onResume,
}: {
  entry: LibraryEntry;
  onOpen: OpenMedia;
  onResume: (meta: MediaItem, addonUrl: string) => void;
}) {
  const progress = entry.progress!;
  const upNext = progress.duration === 0;
  const percent = upNext ? 0 : Math.min(100, (progress.seconds / progress.duration) * 100);
  const image = safeImage(entry.meta.background || entry.meta.poster);
  const remaining = Math.max(0, progress.duration - progress.seconds);
  return (
    <article className="continue-card">
      <button
        className="continue-button"
        data-card-focus
        aria-label={t("home.resume", { name: entry.meta.name })}
        title={t("home.resumeTitle")}
        onClick={() => onResume(entry.meta, entry.addonUrl)}
        onContextMenu={(event) => {
          event.preventDefault();
          onOpen(entry.meta, entry.addonUrl, true);
        }}
        onKeyDown={cardKeys}
      >
        <span className="continue-art">
          {image && <img src={image} alt="" loading="lazy" draggable={false} />}
        </span>
        <span className="continue-text">
          <strong>{entry.meta.name}</strong>
          <small>
            {upNext
              ? t("home.upNext", { episode: episodeLabel(entry) })
              : [episodeLabel(entry), t("home.remaining", { time: clock(remaining) })].filter(Boolean).join(" · ")}
          </small>
        </span>
        <span className="card-progress">
          <span style={{ width: `${percent}%` }} />
        </span>
      </button>
      <button
        className="continue-dismiss"
        aria-label={t("home.dismissLabel", { name: entry.meta.name })}
        title={t("home.dismissTitle")}
        tabIndex={-1}
        onClick={() => preferencesStore.dismissProgress(entry.meta.type, entry.meta.id)}
      >
        <X size={13} />
      </button>
    </article>
  );
}

/** The billboard, only for a title the profile may see. */
function AllowedHero({ item, onOpen }: { item: Scored; onOpen: OpenMedia }) {
  const allowed = useTitleAllowed(item.item);
  return allowed === "allowed" ? <ForYouHero item={item} onOpen={onOpen} /> : allowed === "pending" ? <HeroSkeleton /> : null;
}

/** The billboard: the title the recommendations rate highest today, with what to do about it. */
function ForYouHero({ item, onOpen }: { item: Scored; onOpen: OpenMedia }) {
  const prefs = usePreferences();
  const ratings = useTaste().ratings;
  const { item: meta, addonUrl } = item;
  const liked = ratings[item.key]?.value === "like";
  const saved = Boolean(prefs.library[item.key]?.saved);
  const image = safeImage(meta.background);
  // Many titles have no logo image; the name is shown instead when it fails to load.
  const [logoFailed, setLogoFailed] = useState<string>();
  const logo = logoFailed === meta.logo ? undefined : safeImage(meta.logo);
  return (
    <section className="for-you-hero" aria-label={t("home.featured", { name: meta.name })}>
      {image && (
        <div className="for-you-hero-art" aria-hidden="true">
          <img src={image} alt="" draggable={false} />
        </div>
      )}
      <div className="for-you-hero-body">
        {logo ? (
          <h2 className="for-you-logo">
            <img src={logo} alt={meta.name} draggable={false} onError={() => setLogoFailed(meta.logo)} />
          </h2>
        ) : (
          <h2 className="for-you-title">{meta.name}</h2>
        )}
        <div className="facts for-you-facts">
          <span className="for-you-match">{t("home.match", { match: item.match })}</span>
          {item.year && <span>{item.year}</span>}
          <span>{typeLabel(meta.type)}</span>
          {meta.imdbRating && <span>★ {meta.imdbRating}</span>}
        </div>
        {meta.description && <p className="for-you-description">{meta.description}</p>}
        <p className="for-you-reason">{reasonText(item.reason)}</p>
        <div className="for-you-actions">
          <button className="button primary" onClick={() => onOpen(meta, addonUrl, true)}>
            <Play size={15} /> {t("home.watchNow")}
          </button>
          <button className="button secondary" onClick={() => onOpen(meta, addonUrl)}>
            <Info size={15} /> {t("home.moreInfo")}
          </button>
          <button
            className={`for-you-icon ${saved ? "on" : ""}`}
            aria-pressed={saved}
            title={saved ? t("home.removeFromLibrary") : t("home.addToLibrary")}
            aria-label={saved ? t("home.removeNameFromLibrary", { name: meta.name }) : t("home.addNameToLibrary", { name: meta.name })}
            onClick={() => preferencesStore.toggleMedia(meta, addonUrl)}
          >
            {saved ? <Check size={16} /> : <Plus size={16} />}
          </button>
          <button
            className={`for-you-icon ${liked ? "on" : ""}`}
            aria-pressed={liked}
            title={liked ? t("home.unlike") : t("home.like")}
            aria-label={t("home.likeName", { name: meta.name })}
            onClick={() => taste.rate(meta, liked ? null : "like")}
          >
            <ThumbsUp size={16} />
          </button>
          <button
            className="for-you-icon"
            title={t("home.notInterested")}
            aria-label={t("home.notInterestedName", { name: meta.name })}
            onClick={() => taste.hide(meta.type, meta.id)}
          >
            <EyeOff size={16} />
          </button>
        </div>
      </div>
    </section>
  );
}

function HeroSkeleton() {
  return (
    <div className="for-you-hero" aria-hidden="true">
      <div className="for-you-hero-body">
        <div className="skeleton for-you-skeleton-title" />
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line" />
      </div>
    </div>
  );
}

function ForYouShelf({ row, onOpen, onMenu }: { row: Row; onOpen: OpenMedia; onMenu: CardMenu }) {
  const prefs = usePreferences();
  // The profile's age limit applies to recommendations as to any catalog.
  const content = useContentFilter(row.items, (item) => item.item);
  if (content.visible.length < 4 && !content.pending) return null;
  return (
    <Shelf title={row.title} subtitle={row.subtitle} ready>
      {!content.visible.length && <PosterSkeletons count={10} />}
      {content.visible.map((item) => (
        <MediaCard
          key={item.key}
          meta={item.item}
          entry={prefs.library[item.key]}
          match={item.match}
          reason={reasonText(item.reason)}
          onOpen={() => onOpen(item.item, item.addonUrl)}
          onSources={() => onOpen(item.item, item.addonUrl, true)}
          onSave={() => preferencesStore.toggleMedia(item.item, item.addonUrl)}
          onMenu={onMenu}
          extraMenu={[{ label: t("home.notInterested"), icon: <EyeOff size={15} />, onSelect: () => taste.hide(item.item.type, item.item.id) }]}
        />
      ))}
    </Shelf>
  );
}

/** Recommendation rows shown before the first catalog; the rest go between catalogs. */
const LEADING_ROWS = 3;

/**
 * Cold start: before anything was watched or saved, Home asks for a few titles the user likes
 * from what is popular now. Recommendations appear from the first «Me gusta» and sharpen with each.
 */
function ColdStart({ liked: count, onOpen }: { liked: number; onOpen: OpenMedia }) {
  const prefs = usePreferences();
  const ratings = useTaste().ratings;
  const popular = getCatalogSources(prefs.addons).filter(
    (source) => source.addon.manifest.id === "com.linvo.cinemeta" && source.catalog.id === "top",
  );
  const movieSource = popular.find((source) => source.catalog.type === "movie");
  const seriesSource = popular.find((source) => source.catalog.type === "series");
  // The same queries as Home's own «populares» rows: no extra requests.
  const movies = useQuery({
    queryKey: ["catalog", movieSource?.key ?? "", ""],
    queryFn: ({ signal }) => getCatalog(movieSource!, {}, signal),
    enabled: Boolean(movieSource),
  });
  const series = useQuery({
    queryKey: ["catalog", seriesSource?.key ?? "", ""],
    queryFn: ({ signal }) => getCatalog(seriesSource!, {}, signal),
    enabled: Boolean(seriesSource),
  });
  // Movies and series alternate, so both kinds of taste can be told.
  const mixed = Array.from({ length: 15 }, (_, index) => [movies.data?.[index], series.data?.[index]])
    .flat()
    .filter((meta): meta is MediaItem => Boolean(meta?.poster));
  const content = useContentFilter(mixed, (meta) => meta);
  const addonUrl = popular[0]?.addon.manifestUrl;
  if (!addonUrl || (!content.visible.length && !movies.isPending && !content.pending)) return null;
  return (
    <Shelf
      title={t("home.coldTitle")}
      subtitle={
        count
          ? t("home.coldProgress", { count, total: COLD_LIKES })
          : t("home.coldPrompt", { count: COLD_LIKES })
      }
      ready={!movies.isPending}
    >
      {!content.visible.length && <PosterSkeletons count={10} />}
      {content.visible.map((meta) => {
        const liked = ratings[mediaKey(meta.type, meta.id)]?.value === "like";
        return (
          <article className="media-card" key={mediaKey(meta.type, meta.id)}>
            <button
              className={`poster-button taste-pick ${liked ? "on" : ""}`}
              data-card-focus
              aria-pressed={liked}
              aria-label={t("home.likeName", { name: meta.name })}
              onClick={() => taste.rate(meta, liked ? null : "like")}
              onContextMenu={(event) => {
                event.preventDefault();
                onOpen(meta, addonUrl);
              }}
              onKeyDown={cardKeys}
            >
              <Artwork src={meta.poster} name={meta.name} className="poster" />
              <span className="taste-pick-mark" aria-hidden="true">
                {liked ? <Check size={22} strokeWidth={2.5} /> : <ThumbsUp size={20} />}
              </span>
            </button>
            <div className="card-text" aria-hidden="true">
              <span className="card-title" title={meta.name}>
                {meta.name}
              </span>
              <span className="card-meta">{typeLabel(meta.type)}</span>
            </div>
          </article>
        );
      })}
    </Shelf>
  );
}

/** Titles in «Seguir viendo»: started and not finished, or pointing to the next episode. */
export function inProgress(entry: LibraryEntry): boolean {
  const progress = entry.progress;
  if (!progress) return false;
  if (progress.duration === 0 && progress.seconds === 0) return entry.meta.type === "series";
  return progress.duration > 0 && progress.seconds > 5 && progress.seconds < progress.duration * 0.95;
}

export function HomeView({
  onOpen,
  onResume,
  onBrowse,
  onAddons,
  onMenu,
}: {
  onOpen: OpenMedia;
  onResume: (meta: MediaItem, addonUrl: string) => void;
  onBrowse: (type: "movie" | "series", catalog: string) => void;
  onAddons: () => void;
  onMenu: CardMenu;
}) {
  const prefs = usePreferences();
  const kids = useKidsMode();
  const rows = homeRows(getCatalogSources(prefs.addons).filter((source) => !kids || kidsCatalog(source)), prefs.catalogs);
  const visible = rows.filter((row) => row.visible);
  const continuing = Object.values(prefs.library)
    .filter(inProgress)
    .sort((a, b) => (b.progress?.updatedAt || 0) - (a.progress?.updatedAt || 0))
    .slice(0, 12);
  const forYou = useForYou();
  const tasteState = useTaste();
  const hidden = Object.keys(tasteState.hidden).length;
  // The billboard stays for the whole visit unless it is turned down: saving or liking it reshapes
  // the recommendations, and the title should not jump away from under the pointer.
  const heroRef = useRef<{ profile: string; item?: Scored }>(undefined);
  const profile = preferencesStore.getProfile();
  const kept = heroRef.current?.profile === profile ? heroRef.current.item : undefined;
  const rejected = kept && (tasteState.hidden[kept.key] || tasteState.ratings[kept.key]?.value === "dislike");
  if (!kept || rejected) heroRef.current = { profile, item: forYou.page?.hero };
  const hero = heroRef.current?.item;
  const recommended = forYou.page?.rows ?? [];
  const later = recommended.slice(LEADING_ROWS);
  // What a visit shows: the billboard and the first cards of each row (the rest needs scrolling).
  useEffect(() => {
    if (!forYou.page) return;
    const shown = [hero?.key, ...forYou.page.rows.flatMap((row) => row.items.slice(0, 6).map((item) => item.key))];
    taste.markSeen(shown.filter((key): key is string => Boolean(key)));
  }, [forYou.page, hero?.key]);
  const openRecommended: OpenMedia = (meta, addonUrl, sources) => {
    taste.opened(meta.type, meta.id);
    onOpen(meta, addonUrl, sources);
  };
  const recommendedShelf = (row: Row) => <ForYouShelf key={row.id} row={row} onOpen={openRecommended} onMenu={onMenu} />;
  return (
    <div className="page home-page">
      <h1 className="sr-only">{t("nav.home")}</h1>
      {/* A new profile is asked first; the billboard follows as soon as there is a recommendation. */}
      {forYou.cold && <ColdStart liked={forYou.liked} onOpen={onOpen} />}
      {hero ? <AllowedHero item={hero} onOpen={openRecommended} /> : forYou.loading && <HeroSkeleton />}
      {continuing.length > 0 && (
        <Shelf title={t("home.continueWatching")} ready className="continue-shelf">
          {continuing.map((entry) => (
            <ContinueCard
              key={mediaKey(entry.meta.type, entry.meta.id)}
              entry={entry}
              onOpen={onOpen}
              onResume={onResume}
            />
          ))}
        </Shelf>
      )}
      {forYou.loading && !recommended.length && (
        <Shelf title={t("home.forYou")} ready={false}>
          <PosterSkeletons count={10} />
        </Shelf>
      )}
      {recommended.slice(0, LEADING_ROWS).map(recommendedShelf)}
      {visible.map(({ source, title, browse }, index) => (
        <Fragment key={source.key}>
          <CatalogShelf
            source={source}
            title={title}
            onOpen={onOpen}
            onBrowse={browse ? () => onBrowse(browse, source.key) : undefined}
            onMenu={onMenu}
          />
          {/* One more recommendation row after every second catalog. */}
          {index % 2 === 1 && later[(index - 1) / 2] && recommendedShelf(later[(index - 1) / 2])}
        </Fragment>
      ))}
      {later.slice(Math.floor(visible.length / 2)).map(recommendedShelf)}
      {hidden > 0 && (
        <p className="for-you-footer">
          {plural(hidden, "home.hidden.one", "home.hidden.other")}{" "}
          <button className="link-button" onClick={() => taste.clearHidden()}>
            {t("home.showAgain")}
          </button>
        </p>
      )}
      {!rows.length && kids && (
        <EmptyState
          icon={<Puzzle size={20} />}
          title={t("home.noKidsCatalogs")}
          description={t("home.noKidsCatalogsDescription")}
        />
      )}
      {!rows.length && !kids && (
        <EmptyState
          icon={<Puzzle size={20} />}
          title={t("home.noCatalogs")}
          description={t("home.noCatalogsDescription")}
          action={
            <button className="button primary" onClick={onAddons}>
              {t("home.manageAddons")}
            </button>
          }
        />
      )}
    </div>
  );
}
