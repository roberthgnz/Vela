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

export type LibraryEntry = {
  meta: MediaItem;
  addonUrl: string;
  addedAt: number;
  progress?: PlaybackProgress;
};

export type AppPreferences = {
  version: 1;
  addons: InstalledAddon[];
  library: Record<string, LibraryEntry>;
  serviceUrl: string;
  externalPlayerPath: string;
};
