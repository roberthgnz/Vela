import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Episode, ResolvedStream, Subtitle } from "./contracts";
import { postJson, requestJson } from "./transport";
import { plural, t } from "./i18n";

/**
 * Client for the Stremio streaming server (Stremio Service / the server bundled with Stremio).
 * Routes follow stremio-video's withStreamingServer adapters and were checked against a running server:
 *   GET  /settings
 *   POST /{infoHash}/create   { torrent: { infoHash }, peerSearch?, guessFileIdx }
 *   GET  /{infoHash}/{fileIdx}[?tr=…]
 *   GET  /proxy/d=<origin>&h=<name:value>…/<path>
 *   GET  /hlsv2/probe?mediaURL=…
 *   GET  /hlsv2/{id}/master.m3u8?mediaURL=…&videoCodecs=…&audioCodecs=…&maxAudioChannels=…
 */

export type TorrentFile = { name: string; length: number };
export type Probe = {
  format: { name: string; duration?: number };
  streams: {
    /** Index of the stream among those of the same kind (`audio0.m3u8`, `subtitle2.m3u8`). */
    id?: number;
    track: string;
    codec: string;
    channels?: number;
    language?: string | null;
    title?: string | null;
  }[];
};

const videoExtensions = /\.(mp4|m4v|mkv|webm|avi|mov|wmv|flv|ts|m2ts|mpg|mpeg|ogv|3gp)$/i;

function base(serviceUrl: string): string {
  return serviceUrl.replace(/\/+$/, "");
}

export async function serviceVersion(serviceUrl: string): Promise<string | undefined> {
  const settings = await requestJson(`${base(serviceUrl)}/settings`);
  const values = (settings as { values?: Record<string, unknown> } | null)?.values;
  return typeof values?.serverVersion === "string" ? values.serverVersion : undefined;
}

type TorrentLimits = {
  btMaxConnections: number;
  btHandshakeTimeout: number;
  btRequestTimeout: number;
  btDownloadSpeedSoftLimit: number;
  btDownloadSpeedHardLimit: number;
  btMinPeersForStable: number;
};
export type TorrentProfile = "soft" | "default" | "fast" | "ultra";

const MB = 1048576;
/**
 * Torrent engine presets. "default" is what the server ships with (checked with 4.22.3); the others
 * follow the profiles of Stremio's own settings. The server ignores values that are not positive
 * integers, and reads them when a torrent is created, so a change affects the next torrents only.
 */
export const torrentProfiles: Record<TorrentProfile, { label: string; title: string; values: TorrentLimits }> = {
  soft: {
    label: t("lib.server.profile.soft"),
    title: t("lib.server.profile.softTitle"),
    values: { btMaxConnections: 35, btHandshakeTimeout: 20000, btRequestTimeout: 4000, btDownloadSpeedSoftLimit: Math.round(1.6 * MB), btDownloadSpeedHardLimit: Math.round(1.6 * MB), btMinPeersForStable: 5 },
  },
  default: {
    label: t("lib.server.profile.default"),
    title: t("lib.server.profile.defaultTitle"),
    values: { btMaxConnections: 55, btHandshakeTimeout: 20000, btRequestTimeout: 4000, btDownloadSpeedSoftLimit: 2.5 * MB, btDownloadSpeedHardLimit: 3.5 * MB, btMinPeersForStable: 5 },
  },
  fast: {
    label: t("lib.server.profile.fast"),
    title: t("lib.server.profile.fastTitle"),
    values: { btMaxConnections: 200, btHandshakeTimeout: 20000, btRequestTimeout: 4000, btDownloadSpeedSoftLimit: 4 * MB, btDownloadSpeedHardLimit: 37.5 * MB, btMinPeersForStable: 10 },
  },
  ultra: {
    label: t("lib.server.profile.ultra"),
    title: t("lib.server.profile.ultraTitle"),
    values: { btMaxConnections: 400, btHandshakeTimeout: 25000, btRequestTimeout: 6000, btDownloadSpeedSoftLimit: 8 * MB, btDownloadSpeedHardLimit: 75 * MB, btMinPeersForStable: 10 },
  },
};

/** The preset the server is using, or undefined when its limits were set to something else. */
export function torrentProfileOf(values: Record<string, unknown>): TorrentProfile | undefined {
  return (Object.keys(torrentProfiles) as TorrentProfile[]).find((id) =>
    Object.entries(torrentProfiles[id].values).every(([key, value]) => values[key] === value),
  );
}

export async function torrentProfile(serviceUrl: string): Promise<TorrentProfile | undefined> {
  const settings = await requestJson(`${base(serviceUrl)}/settings`, AbortSignal.timeout(4000));
  const values = (settings as { values?: Record<string, unknown> } | null)?.values;
  if (!values) throw new Error(t("lib.server.noSettings"));
  return torrentProfileOf(values);
}

/** Saves the preset in the server's settings, which Stremio shares. Other settings are kept. */
export async function setTorrentProfile(serviceUrl: string, profile: TorrentProfile): Promise<void> {
  const reply = await postJson(`${base(serviceUrl)}/settings`, torrentProfiles[profile].values);
  if (!(reply as { success?: unknown } | null)?.success) throw new Error(t("lib.server.profileNotSaved"));
}

/** The server answers /settings at once when it runs; a hung or unrelated host should not hold playback back. */
export async function serviceAvailable(serviceUrl: string): Promise<boolean> {
  try {
    await requestJson(`${base(serviceUrl)}/settings`, AbortSignal.timeout(4000));
    return true;
  } catch {
    return false;
  }
}

/** The server Stremio installs listens here; only this address can be started by Vela. */
export function isLocalService(serviceUrl: string): boolean {
  try {
    const url = new URL(serviceUrl);
    return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) && url.port === "11470";
  } catch {
    return false;
  }
}

/** Whether Stremio is installed, so Vela can start its server (desktop only). */
export async function serviceInstalled(): Promise<boolean> {
  return isTauri() ? invoke<boolean>("service_installed").catch(() => false) : false;
}

let starting: Promise<boolean> | undefined;

/**
 * Answers whether the server is reachable, starting the one Stremio installs when nothing answers
 * on the default address. Startup takes a few seconds; concurrent callers share the same wait.
 */
export function ensureService(serviceUrl: string, wait = 20_000): Promise<boolean> {
  starting ??= (async () => {
    if (await serviceAvailable(serviceUrl)) return true;
    if (!isLocalService(serviceUrl) || !(await serviceInstalled())) return false;
    await invoke("service_start");
    const deadline = Date.now() + wait;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (await serviceAvailable(serviceUrl)) return true;
    }
    return false;
  })().finally(() => {
    starting = undefined;
  });
  return starting;
}

/** Normalizes addon `sources` into the server's peer-search notation. */
export function peerSources(infoHash: string, sources: string[] = []): string[] {
  const normalized = sources
    .filter((source) => typeof source === "string" && source.trim())
    .map((source) =>
      source.startsWith("tracker:") || source.startsWith("dht:") ? source : `tracker:${source}`,
    );
  return [...new Set(normalized.length ? [`dht:${infoHash}`, ...normalized] : [])];
}

export function torrentUrl(serviceUrl: string, infoHash: string, fileIdx: number, sources: string[] = []): string {
  const query = sources.length ? `?${new URLSearchParams(sources.map((source) => ["tr", source]))}` : "";
  return `${base(serviceUrl)}/${encodeURIComponent(infoHash.toLowerCase())}/${encodeURIComponent(fileIdx)}${query}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Prepares a torrent on the server. When the addon gives no file index, the server guesses it
 * (using season and episode for series) and Vela checks that the chosen file looks like a video.
 */
export async function prepareTorrent(
  serviceUrl: string,
  stream: Pick<ResolvedStream, "infoHash" | "fileIdx" | "sources">,
  episode?: Pick<Episode, "season" | "episode">,
): Promise<{ url: string; fileIdx: number; fileName?: string; subtitles: Subtitle[] }> {
  const infoHash = stream.infoHash!.toLowerCase();
  const sources = peerSources(infoHash, stream.sources);
  const knownIndex = stream.fileIdx !== undefined && Number.isInteger(stream.fileIdx);
  // Even with a known index the torrent is created first: the response lists its files,
  // which lets Vela reject indexes that point to subtitles, images or missing files.
  const guess: Record<string, number> = {};
  if (episode?.season !== undefined) guess.season = episode.season;
  if (episode?.episode !== undefined) guess.episode = episode.episode;
  const body: Record<string, unknown> = {
    torrent: { infoHash },
    guessFileIdx: knownIndex ? false : guess,
  };
  if (sources.length) body.peerSearch = { sources, min: 40, max: 200 };
  let response: unknown;
  try {
    response = await postJson(`${base(serviceUrl)}/${encodeURIComponent(infoHash)}/create`, body);
  } catch (error) {
    throw new Error(
      /timed out|tiempo/i.test(errorText(error))
        ? t("lib.server.torrentTimeout")
        : t("lib.server.torrentFailed", { error: errorText(error) }),
    );
  }
  const result = (response ?? {}) as { guessedFileIdx?: unknown; files?: unknown };
  const files = Array.isArray(result.files)
    ? result.files.filter(
        (file): file is TorrentFile =>
          typeof file === "object" && file !== null && typeof (file as TorrentFile).name === "string",
      )
    : [];
  const fileIdx = knownIndex ? stream.fileIdx! : result.guessedFileIdx;
  if (typeof fileIdx !== "number" || !Number.isInteger(fileIdx) || fileIdx < 0)
    throw new Error(t("lib.server.noVideoFile"));
  const file = files[fileIdx];
  if (files.length && !file) throw new Error(t("lib.server.badFileIndex"));
  if (file && !videoExtensions.test(file.name))
    throw new Error(t("lib.server.notVideo", { name: file.name }));
  const subtitles = files.flatMap((item, index) => {
    if (!/\.(srt|vtt)$/i.test(item.name)) return [];
    const code = /\.([a-z]{2,3}(?:-[a-z]{2})?)\.(?:srt|vtt)$/i.exec(item.name)?.[1];
    return [{ id: `torrent:${index}`, lang: code || item.name, url: torrentUrl(serviceUrl, infoHash, index) }];
  });
  return { url: torrentUrl(serviceUrl, infoHash, fileIdx, sources), fileIdx, fileName: file?.name, subtitles };
}

export type TorrentStats = { peers: number; found: number; unchoked: number; speed: number; downloaded: number; searching: boolean };

/**
 * Swarm state of a torrent the server is streaming (`/{infoHash}/stats.json`, checked with server 4.22.3).
 * `peers` are connections that completed the handshake (at most `btMaxConnections`); `found` are the
 * addresses trackers and DHT returned that are still candidates (`unique`). Many of those never accept
 * a connection. `swarmSize` is not a peer count: it is the connection limit.
 */
export async function torrentStats(serviceUrl: string, infoHash: string): Promise<TorrentStats> {
  const value = (await requestJson(`${base(serviceUrl)}/${encodeURIComponent(infoHash.toLowerCase())}/stats.json`)) as Record<string, unknown> | null;
  const number = (key: string) => (typeof value?.[key] === "number" && Number.isFinite(value[key]) ? (value[key] as number) : 0);
  return {
    peers: number("peers"),
    found: number("unique"),
    unchoked: number("unchoked"),
    speed: number("downloadSpeed"),
    downloaded: number("downloaded"),
    searching: value?.peerSearchRunning === true,
  };
}

/** Readable summary of a torrent's swarm, for loading screens. */
export function describeTorrent(stats: TorrentStats): string {
  const speed = stats.speed >= 1048576 ? `${(stats.speed / 1048576).toFixed(1)} MB/s` : `${Math.round(stats.speed / 1024)} KB/s`;
  const downloaded = `${Math.round(stats.downloaded / 1048576)} MB`;
  // Incoming connections are not among the found addresses, so `peers` can exceed `found`.
  const peers =
    stats.found > stats.peers
      ? t("lib.server.peersOf", { peers: stats.peers, found: stats.found })
      : plural(stats.peers, "lib.server.peers.one", "lib.server.peers.other");
  return t("lib.server.torrentSummary", { peers, speed, downloaded });
}

/** Routes a URL through the server so it can add the request/response headers an addon requires. */
export function proxyUrl(
  serviceUrl: string,
  url: string,
  request: Record<string, string> = {},
  response: Record<string, string> = {},
): string {
  const parsed = new URL(url);
  const options = new URLSearchParams();
  options.set("d", parsed.origin);
  for (const [name, value] of Object.entries(request)) options.append("h", `${name}:${value}`);
  for (const [name, value] of Object.entries(response)) options.append("r", `${name}:${value}`);
  return `${base(serviceUrl)}/proxy/${options}${parsed.pathname}${parsed.search}`;
}

export type Capabilities = {
  formats: string[];
  videoCodecs: string[];
  audioCodecs: string[];
  maxAudioChannels: number;
};

/** What WebView2/Chromium decodes natively. HEVC is excluded because support depends on hardware and extensions. */
export function mediaCapabilities(): Capabilities {
  const video = typeof document === "undefined" ? undefined : document.createElement("video");
  const can = (mime: string) => Boolean(video?.canPlayType(mime));
  const videoCodecs = ["h264"];
  if (can('video/webm; codecs="vp8"')) videoCodecs.push("vp8");
  if (can('video/webm; codecs="vp9"') || can('video/mp4; codecs="vp09.00.10.08"')) videoCodecs.push("vp9");
  if (can('video/mp4; codecs="av01.0.05M.08"')) videoCodecs.push("av1");
  const audioCodecs = ["aac", "mp3"];
  if (can('audio/webm; codecs="opus"') || can('audio/mp4; codecs="opus"')) audioCodecs.push("opus");
  if (can('audio/webm; codecs="vorbis"')) audioCodecs.push("vorbis");
  if (can('audio/flac') || can('audio/mp4; codecs="flac"')) audioCodecs.push("flac");
  if (can('audio/mp4; codecs="ac-3"')) audioCodecs.push("ac3");
  if (can('audio/mp4; codecs="ec-3"')) audioCodecs.push("eac3");
  return { formats: ["mp4", "matroska,webm"], videoCodecs, audioCodecs, maxAudioChannels: 8 };
}

export async function probe(serviceUrl: string, mediaUrl: string, signal?: AbortSignal): Promise<Probe> {
  const result = (await requestJson(
    `${base(serviceUrl)}/hlsv2/probe?${new URLSearchParams({ mediaURL: mediaUrl })}`,
    signal,
  )) as Probe;
  if (!result?.format || !Array.isArray(result.streams)) throw new Error(t("lib.server.badProbe"));
  return result;
}

/** Returns the reasons why the integrated player cannot decode a probed file (empty when playable). */
export function probeProblems(result: Probe, capabilities: Capabilities): string[] {
  const problems: string[] = [];
  if (!capabilities.formats.some((format) => result.format.name.includes(format)))
    problems.push(t("lib.server.problem.container", { name: result.format.name.split(",")[0] }));
  for (const stream of result.streams) {
    if (stream.track === "video" && !capabilities.videoCodecs.includes(stream.codec))
      problems.push(t("lib.server.problem.video", { codec: stream.codec.toUpperCase() }));
    if (stream.track === "audio" && !capabilities.audioCodecs.includes(stream.codec))
      problems.push(t("lib.server.problem.audio", { codec: stream.codec.toUpperCase() }));
  }
  const audio = result.streams.filter((stream) => stream.track === "audio");
  if (audio.length && !audio.some((stream) => capabilities.audioCodecs.includes(stream.codec)))
    problems.push(t("lib.server.problem.noAudio"));
  return [...new Set(problems)];
}

export function transcodeUrl(serviceUrl: string, mediaUrl: string, capabilities: Capabilities): string {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const query = new URLSearchParams([["mediaURL", mediaUrl]]);
  for (const codec of capabilities.videoCodecs) query.append("videoCodecs", codec);
  for (const codec of capabilities.audioCodecs) query.append("audioCodecs", codec);
  query.set("maxAudioChannels", "2");
  return `${base(serviceUrl)}/hlsv2/${id}/master.m3u8?${query}`;
}

/**
 * Raw ASS/SSA text of an embedded subtitle track, read by the HLS converter that `master.m3u8`
 * created (checked against server 4.22: `/hlsv2/{id}/source/subtitle/{n}.ass`; it answers only
 * for ASS/SSA tracks).
 */
export function embeddedAssUrl(transcode: string, subtitleId: number): string {
  const url = new URL(transcode);
  url.pathname = url.pathname.replace(/master\.m3u8$/, `source/subtitle/${subtitleId}.ass`);
  return url.href;
}

/** WebVTT rendition of an embedded subtitle track (any text codec), split into HLS segments. */
export function embeddedSubtitlePlaylist(transcode: string, subtitleId: number): string {
  const url = new URL(transcode);
  url.pathname = url.pathname.replace(/master\.m3u8$/, `subtitle${subtitleId}.m3u8`);
  return url.href;
}

/**
 * Reads a whole WebVTT rendition: the playlist, then its segments, nearest to `from` first.
 * The server only sends CORS headers to Stremio's own origins, so these requests go through
 * the desktop transport rather than the WebView. `onPart` receives each segment as it arrives.
 */
export async function readSubtitleRendition(
  playlistUrl: string,
  read: (url: string) => Promise<string>,
  onPart: (text: string) => void,
  from = 0,
  signal?: AbortSignal,
): Promise<void> {
  const playlist = await read(playlistUrl);
  const segments: { url: string; start: number }[] = [];
  let start = 0;
  let duration = 0;
  for (const line of playlist.split(/\r?\n/)) {
    const info = /^#EXTINF:([\d.]+)/.exec(line);
    if (info) duration = Number(info[1]);
    else if (line && !line.startsWith("#")) {
      segments.push({ url: new URL(line, playlistUrl).href, start });
      start += duration;
    }
  }
  if (!segments.length) throw new Error(t("lib.server.emptySubtitles"));
  // One request at a time: the converter cancels a segment when another is requested meanwhile
  // ("Segment is canceled", checked with server 4.22.3). Start where the video is, then go back.
  const first = Math.max(0, segments.findLastIndex((segment) => segment.start <= from));
  const order = [...segments.slice(first), ...segments.slice(0, first).reverse()];
  let failures = 0;
  for (const segment of order) {
    if (signal?.aborted) return;
    let text: string | undefined;
    for (let attempt = 0; attempt < 2 && text === undefined; attempt++) {
      try {
        text = await read(segment.url);
      } catch {
        /* Retried once; a failed segment only leaves a gap. */
      }
    }
    if (text === undefined) failures++;
    else onPart(text);
  }
  if (failures === segments.length) throw new Error(t("lib.server.subtitlesFailed"));
}

export function subtitleUrl(serviceUrl: string, url: string): string {
  return `${base(serviceUrl)}/subtitles.vtt?${new URLSearchParams({ from: url })}`;
}
