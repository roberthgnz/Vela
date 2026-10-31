import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { CalendarDays } from "lucide-react";
import { byDay, daysFromToday, upcomingEpisodes } from "../lib/calendar";
import type { Episode, MediaItem } from "../lib/contracts";
import { episodeCode } from "../lib/episodes";
import { formatDate, t } from "../lib/i18n";
import { metaAddon } from "../lib/navigation";
import { getMeta } from "../lib/protocol";
import { usePreferences } from "../lib/store";
import { Artwork, EmptyState, Loading } from "./Primitives";

/** Fresh episode lists are fetched at most every few hours; the saved copy is shown meanwhile. */
const STALE = 6 * 60 * 60_000;

function dayTitle(day: number): string {
  const offset = daysFromToday(day);
  if (offset === 0) return t("calendar.today");
  if (offset === 1) return t("calendar.tomorrow");
  if (offset === -1) return t("calendar.yesterday");
  return formatDate(day, { weekday: "long", day: "numeric", month: "long" });
}

/**
 * Episodes of the series saved in the library: the past week and the next weeks, by day. Each
 * series' episode list is refreshed from its add-on (Cinemeta, usually) so new dates show up.
 */
export function CalendarView({
  onOpenEpisode,
  onDiscover,
}: {
  onOpenEpisode: (meta: MediaItem, addonUrl: string, episode: Episode) => void;
  onDiscover: () => void;
}) {
  const prefs = usePreferences();
  const saved = useMemo(
    () => Object.values(prefs.library).filter((entry) => entry.saved && entry.meta.type === "series"),
    [prefs.library],
  );
  const metas = useQueries({
    queries: saved.map((entry) => ({
      queryKey: ["calendar-meta", entry.meta.id, entry.addonUrl],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getMeta(metaAddon(prefs.addons, entry.meta, entry.addonUrl), "series", entry.meta.id, signal),
      staleTime: STALE,
      gcTime: STALE,
      retry: 1,
    })),
  });
  const loading = metas.some((query) => query.isPending);
  const series = saved.map((entry, index) => ({
    meta: { ...entry.meta, videos: metas[index]?.data?.videos ?? entry.meta.videos },
    addonUrl: entry.addonUrl,
  }));
  const groups = byDay(upcomingEpisodes(series));

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t("nav.calendar")}</h1>
      </header>
      <div className="page-body narrow">
        {!saved.length ? (
          <EmptyState
            title={t("calendar.noSeries")}
            description={t("calendar.noSeriesDescription")}
            icon={<CalendarDays size={20} />}
            action={
              <button className="button primary" onClick={onDiscover}>
                {t("calendar.discover")}
              </button>
            }
          />
        ) : !groups.length && loading ? (
          <Loading label={t("calendar.loading")} />
        ) : !groups.length ? (
          <EmptyState icon={<CalendarDays size={20} />} title={t("calendar.empty")} description={t("calendar.emptyDescription")} />
        ) : (
          <div className="calendar">
            {groups.map((group) => {
              const offset = daysFromToday(group.day);
              return (
                <section
                  key={group.day}
                  className={`calendar-day ${offset === 0 ? "today" : offset < 0 ? "past" : ""}`}
                  aria-label={dayTitle(group.day)}
                >
                  <h2>
                    <CalendarDays size={15} aria-hidden="true" /> {dayTitle(group.day)}
                  </h2>
                  <ul>
                    {group.items.map((item) => (
                      <li key={`${item.meta.id}|${item.episode.id}`}>
                        <button
                          className="calendar-item"
                          onClick={() => onOpenEpisode(item.meta, item.addonUrl, item.episode)}
                        >
                          <Artwork src={item.episode.thumbnail ?? item.meta.poster} name={item.meta.name} className="calendar-art" />
                          <span className="calendar-text">
                            <strong>{item.meta.name}</strong>
                            <span>
                              {episodeCode(item.episode)}
                              {item.episode.title ? ` · ${item.episode.title}` : ""}
                            </span>
                          </span>
                          {offset > 0 && (
                            <span className="calendar-when">
                              {formatDate(item.date, { hour: "2-digit", minute: "2-digit" })}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            {loading && <Loading label={t("calendar.loading")} />}
          </div>
        )}
      </div>
    </div>
  );
}
