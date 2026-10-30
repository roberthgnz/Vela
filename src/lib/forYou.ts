import { useEffect, useMemo } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useKidsMode } from "./profiles";
import { getCatalogSources } from "./protocol";
import { composeHome, enrichSeeds, excluded, seedsFrom, type HomePage } from "./recommend";
import { catalogPool, tmdbPool } from "./recommendSources";
import { preferencesStore, usePreferences } from "./store";
import { taste, useTaste } from "./taste";
import { tmdb, useTmdbConfigured } from "./tmdb";
import { currentTmdbContext, TMDB_CATALOGS_URL } from "./tmdbCatalogs";

const STALE = 30 * 60_000;
/** «Me gusta» a new profile is asked for, as a streaming service does when an account starts. */
export const COLD_LIKES = 3;

/**
 * The personalized part of Home for the active profile. Catalog candidates arrive first; with a
 * TMDB key the page waits for TMDB's neighbours too, so rows do not reshuffle under the user.
 * Ratings and «No me interesa» apply at once, without refetching. Children's profiles get none:
 * the catalogs that feed it are not filtered for them.
 */
export function useForYou(): {
  page?: HomePage;
  loading: boolean;
  /**
   * Too little to go on (nothing played or saved, under three «Me gusta»): Home asks what the
   * user likes, alongside whatever recommendations there already are.
   */
  cold: boolean;
  /** «Me gusta» given so far, while cold. */
  liked: number;
} {
  const prefs = usePreferences();
  const tasteState = useTaste();
  const kids = useKidsMode();
  const tmdbOn = useTmdbConfigured();
  const client = useQueryClient();
  const profile = preferencesStore.getProfile();
  useEffect(() => {
    void tmdb.key();
  }, []);
  // One clock per visit to Home: scores do not drift while it is open.
  const now = useMemo(() => Date.now(), []);
  const seeds = useMemo(() => seedsFrom(prefs.library, tasteState, now), [prefs.library, tasteState, now]);
  // Impressions as they were when Home opened: counting this visit must not reshuffle it.
  const fatigue = useMemo(
    () => Object.fromEntries(Object.entries(taste.getSnapshot().seen ?? {}).map(([key, mark]) => [key, mark.count])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profile],
  );
  const sources = useMemo(() => getCatalogSources(prefs.addons), [prefs.addons]);
  const enabled = !kids && seeds.some((seed) => seed.weight > 0);
  const liked = seeds.filter((seed) => seed.weight > 0 && seed.origin === "liked").length;
  // Pools depend on the strongest seeds only; small progress updates do not refetch them.
  const fingerprint = seeds
    .slice(0, 12)
    .map((seed) => `${seed.key}:${seed.weight.toFixed(1)}`)
    .join(",");
  const metaAddon =
    sources.find((source) => source.addon.manifest.id === "com.linvo.cinemeta")?.addon.manifestUrl ?? TMDB_CATALOGS_URL;
  const catalogs = useQuery({
    queryKey: ["for-you", "catalogs", profile, fingerprint, sources.map((source) => source.key).join()],
    queryFn: () => catalogPool(sources, seeds, client),
    enabled,
    staleTime: STALE,
    placeholderData: keepPreviousData,
  });
  const neighbours = useQuery({
    queryKey: ["for-you", "tmdb", profile, fingerprint, prefs.metadataLanguage],
    queryFn: async () => tmdbPool(seeds, await currentTmdbContext(), metaAddon, client, excluded(prefs.library, tasteState)),
    enabled: enabled && tmdbOn,
    staleTime: STALE,
    placeholderData: keepPreviousData,
    retry: 0,
  });
  const page = useMemo(() => {
    if (!enabled || !catalogs.data) return undefined;
    const pool = [...(neighbours.data?.candidates ?? []), ...catalogs.data.candidates];
    return composeHome(pool, prefs.library, tasteState, enrichSeeds(seeds, neighbours.data?.seedFeatures ?? {}), {
      now,
      fatigue,
      personPools: { ...catalogs.data.personPools, ...neighbours.data?.personPools },
    });
  }, [enabled, catalogs.data, neighbours.data, prefs.library, tasteState, seeds, now, fatigue]);
  const waitingTmdb = enabled && tmdbOn && neighbours.isPending && neighbours.fetchStatus !== "idle";
  return {
    page: waitingTmdb ? undefined : page,
    loading: enabled && (catalogs.isPending || waitingTmdb),
    cold: !kids && seeds.every((seed) => seed.origin === "liked") && liked < COLD_LIKES,
    liked,
  };
}
