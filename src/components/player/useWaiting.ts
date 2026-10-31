import { useEffect, useState } from "react";
import { torrentStats, type TorrentStats } from "../../lib/streamingServer";

/** A wait longer than this gets an explanation and alternatives instead of an endless spinner. */
const SLOW_AFTER = 15_000;
/** A torrent without new data for this long is reported as starved. */
const STARVED_AFTER = 20_000;
const SWARM_EVERY = 2000;

/** Whether the current wait (loading or buffering, restarted by `since`) has been going on too long. */
export function useSlowWait(waiting: boolean, since: number): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!waiting) return;
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER);
    return () => clearTimeout(timer);
  }, [waiting, since]);
  return slow;
}

export type Swarm = { stats: TorrentStats; stalledSince?: number };

/** Polls the torrent's swarm while waiting, and says when no data arrives. */
export function useTorrentSwarm(infoHash: string | undefined, serviceUrl: string, waiting: boolean) {
  const [swarm, setSwarm] = useState<Swarm | null>(null);
  useEffect(() => {
    if (!infoHash || !waiting) return;
    let active = true;
    const read = () =>
      void torrentStats(serviceUrl, infoHash)
        .then((stats) => {
          if (!active) return;
          setSwarm((previous) => {
            const moving = stats.speed > 0 || stats.downloaded > (previous?.stats.downloaded ?? 0);
            return { stats, stalledSince: moving ? undefined : (previous?.stalledSince ?? Date.now()) };
          });
        })
        .catch(() => {});
    read();
    const timer = setInterval(read, SWARM_EVERY);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [infoHash, serviceUrl, waiting]);
  const starved = Boolean(swarm?.stalledSince && Date.now() - swarm.stalledSince > STARVED_AFTER);
  return { swarm, starved };
}
