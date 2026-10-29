export type MediaType = "movie" | "series" | string;

export type Episode = {
  id: string;
  title?: string;
  season?: number;
  episode?: number;
  released?: string;
  thumbnail?: string;
  overview?: string;
};

export type MediaItem = {
  id: string;
  type: MediaType;
  name: string;
  poster?: string;
  background?: string;
  logo?: string;
  description?: string;
  releaseInfo?: string;
  released?: string;
  runtime?: string;
  imdbRating?: string;
  genres?: string[];
  cast?: string[];
  director?: string[];
  videos?: Episode[];
  /** YouTube trailers (`trailerStreams` / `trailers` in Cinemeta). */
  trailers?: { ytId: string; title?: string }[];
};

export type AddonCatalog = {
  id: string;
  type: string;
  name: string;
  extra?: { name: string; isRequired?: boolean; options?: string[] }[];
  extraSupported?: string[];
  extraRequired?: string[];
};

export type AddonManifest = {
  id: string;
  name: string;
  version: string;
  description?: string;
  logo?: string;
  resources: (
    string | { name: string; types?: string[]; idPrefixes?: string[] }
  )[];
  types: string[];
  idPrefixes?: string[];
  catalogs: AddonCatalog[];
};

export type InstalledAddon = {
  manifestUrl: string;
  manifest: AddonManifest;
  enabled: boolean;
  installedAt: number;
};

export type CatalogSource = {
  key: string;
  addon: InstalledAddon;
  catalog: AddonCatalog;
};

export type Stream = {
  name?: string;
  title?: string;
  description?: string;
  url?: string;
  externalUrl?: string;
  ytId?: string;
  infoHash?: string;
  fileIdx?: number;
  /** Extra peer discovery sources for torrents: `tracker:<url>` or `dht:<infoHash>`. */
  sources?: string[];
  subtitles?: Subtitle[];
  behaviorHints?: {
    filename?: string;
    videoHash?: string;
    videoSize?: number;
    notWebReady?: boolean;
    /** Streams of consecutive episodes that belong together (same release group or quality). */
    bingeGroup?: string;
    proxyHeaders?: {
      request?: Record<string, string>;
      response?: Record<string, string>;
    };
  };
};

export type ResolvedStream = Stream & { addonName: string; addonUrl: string };
export type Subtitle = { id: string; lang: string; url: string };

export type PlaybackProgress = {
  videoId: string;
  seconds: number;
  duration: number;
  updatedAt: number;
};

/** Playback history of one video (a movie or an episode). */
export type VideoState = {
  seconds: number;
  duration: number;
  updatedAt: number;
  /** Explicitly watched (true) or unwatched (false); absent when never marked. */
  watched?: boolean;
};

export type LibraryEntry = {
  meta: MediaItem;
  addonUrl: string;
  addedAt: number;
  /**
   * Where to continue: the last video played and its position. `seconds` and `duration` are 0
   * when it points to the next episode after finishing one (Stremio's `time_offset: 1`).
   */
  progress?: PlaybackProgress;
  /** In the library (true) or only in «Seguir viendo» (false, Stremio's temporary items). */
  saved: boolean;
  /** Per-video history, by video id. */
  videos?: Record<string, VideoState>;
  /** Last local change to `saved` or to the continue pointer that is not a playback position. */
  changedAt?: number;
  /** When the whole title was marked as watched (movies); 0 when explicitly unmarked. */
  watchedAt?: number;
  /** Stremio's watched bitfield as last synchronized, kept until it can be decoded with the episode list. */
  remoteWatched?: string;
  /** Remote `_mtime` (ms) of `remoteWatched`. */
  remoteWatchedAt?: number;
};

export type PlayerPreferences = {
  /** ISO 639-2/T codes; empty means no preference. */
  subtitleLanguage: string;
  subtitleSecondary: string;
  /** Turn subtitles on automatically when a preferred language is available. */
  subtitlesAuto: boolean;
  /** Text size, as a percentage of the default. */
  subtitleSize: number;
  subtitleOpacity: number;
  subtitleBackground: number;
  audioLanguage: string;
  audioSecondary: string;
  /** Seconds for arrow keys, and for J/L and the skip buttons. */
  seekShort: number;
  seekLong: number;
  /** Offer the next episode when one ends, and start it after `nextCountdown` seconds (0: wait). */
  autoNext: boolean;
  nextCountdown: number;
};

export type AppPreferences = {
  version: 2;
  addons: InstalledAddon[];
  library: Record<string, LibraryEntry>;
  serviceUrl: string;
  externalPlayerPath: string;
  player: PlayerPreferences;
  /** Language of titles and synopses (BCP 47, for example "es-ES"); empty keeps the addon's. */
  metadataLanguage: string;
};
