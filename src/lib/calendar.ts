import type { Episode, MediaItem } from "./contracts";

/** An episode of a saved series that came out recently or comes out soon. */
export type CalendarItem = { meta: MediaItem; addonUrl: string; episode: Episode; date: Date };

const DAY = 86_400_000;

/** Local midnight, so episodes group by the user's calendar day. */
export function dayStart(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Episodes released from `pastDays` ago to `aheadDays` ahead, oldest first. Specials (season 0)
 * are left out, and so are episodes without a valid date.
 */
export function upcomingEpisodes(
  series: { meta: MediaItem; addonUrl: string }[],
  now = new Date(),
  pastDays = 7,
  aheadDays = 45,
): CalendarItem[] {
  const from = dayStart(now) - pastDays * DAY;
  const to = dayStart(now) + (aheadDays + 1) * DAY;
  const items: CalendarItem[] = [];
  const seen = new Set<string>();
  for (const { meta, addonUrl } of series) {
    for (const episode of meta.videos ?? []) {
      if (!episode.released || (episode.season ?? 1) === 0) continue;
      const date = new Date(episode.released);
      const time = date.getTime();
      if (!Number.isFinite(time) || time < from || time >= to) continue;
      const key = `${meta.id}|${episode.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ meta, addonUrl, episode, date });
    }
  }
  return items.sort(
    (a, b) =>
      a.date.getTime() - b.date.getTime() ||
      a.meta.name.localeCompare(b.meta.name) ||
      (a.episode.season ?? 0) - (b.episode.season ?? 0) ||
      (a.episode.episode ?? 0) - (b.episode.episode ?? 0),
  );
}

/** Items grouped by local day, in order. */
export function byDay(items: CalendarItem[]): { day: number; items: CalendarItem[] }[] {
  const groups: { day: number; items: CalendarItem[] }[] = [];
  for (const item of items) {
    const day = dayStart(item.date);
    const last = groups.at(-1);
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

/** How far a day is from today: negative in the past, 0 today. */
export function daysFromToday(day: number, now = new Date()): number {
  return Math.round((day - dayStart(now)) / DAY);
}
