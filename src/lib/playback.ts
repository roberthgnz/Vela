import type { Episode, MediaItem, ResolvedStream, Subtitle } from "./contracts";
import {
  ensureService,
  mediaCapabilities,
  prepareTorrent,
  proxyUrl,
  serviceAvailable,
  transcodeUrl,
} from "./streamingServer";
import { streamTags } from "./streams";
import { prepareVelaTorrent, torrentEngine, velaEngineAvailable } from "./torrentEngine";
import { isDirectUrl } from "./utils";
import { t } from "./i18n";

export type PlaybackTarget = {
  /** URL for the integrated player. */
  url: string;
  /** Original URL for external players, which can send headers themselves. */
  externalUrl: string;
  headers?: Record<string, string>;
  note?: string;
  /** HLS conversion offered by Stremio Service when the integrated player cannot decode the file. */
  transcodeUrl?: string;
  /**
   * The file may be one the integrated player cannot decode (a torrent, `notWebReady`, HEVC or
   * MKV): the player has Stremio Service inspect it while it starts and switches to the
   * conversion if a track cannot be decoded.
   */
  convertIfNeeded?: boolean;
  /** Subtitle files shipped inside a torrent. */
  subtitles?: Subtitle[];
  /** Which engine is streaming a torrent source. */
  torrentEngine?: "vela" | "service";
};

const serviceHint =
  t("lib.playback.serviceHint");

/**
 * How long a torrent on Vela's engine waits, once open, for the answer about Stremio Service,
 * which it asked for meanwhile. The server answers at once when it runs (or the connection is
 * refused); only a host that hangs takes longer, and then the conversion is not offered.
 */
const SERVICE_GRACE = 500;

function within(answer: Promise<boolean>, ms: number): Promise<boolean> {
  return Promise.race([answer, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
}

/** Turns an addon stream into URLs the integrated or external player can open. */
export async function resolvePlayback(
  meta: MediaItem,
  stream: ResolvedStream,
  serviceUrl: string,
  options: { episode?: Episode; external?: boolean } = {},
): Promise<PlaybackTarget> {
  const headers = stream.behaviorHints?.proxyHeaders?.request || {};
  const needsHeaders = Object.keys(headers).length > 0;
  const torrent = Boolean(stream.infoHash && !stream.url);
  const engine = torrentEngine.get();
  // Vela's own engine opens torrents when chosen, or in «auto» when Stremio's server is missing.
  const ownEngine = torrent && velaEngineAvailable && engine === "vela";
  // Torrents and header proxies need the server, so Vela starts it if it can; plain links (and
  // torrents on Vela's engine) only use it for optional inspection and conversion. On Vela's
  // engine the question is asked while the torrent opens, so it costs nothing in between.
  let optionalService: Promise<boolean> | undefined;
  let service: boolean;
  if ((torrent && !ownEngine) || needsHeaders) service = await ensureService(serviceUrl);
  else if (options.external) service = false;
  else if (ownEngine) {
    optionalService = serviceAvailable(serviceUrl);
    service = false;
  } else service = await serviceAvailable(serviceUrl);
  const useVela = ownEngine || (torrent && velaEngineAvailable && engine === "auto" && !service);
  let url = stream.url;
  let note: string | undefined;
  let subtitles: Subtitle[] = [];
  if (torrent && useVela) {
    const prepared = await prepareVelaTorrent(stream, options.episode);
    url = prepared.url;
    subtitles = prepared.subtitles;
    note = t("lib.playback.connectingFile", { file: prepared.fileName });
  } else if (torrent) {
    if (!service)
      throw new Error(t("lib.playback.torrentNeedsService", { hint: serviceHint }));
    const prepared = await prepareTorrent(serviceUrl, stream, options.episode);
    url = prepared.url;
    subtitles = prepared.subtitles;
    note = prepared.fileName ? t("lib.playback.connectingFile", { file: prepared.fileName }) : t("lib.playback.connecting");
  }
  const engineUsed = torrent ? (useVela ? "vela" : "service") : undefined;
  if (!isDirectUrl(url)) throw new Error(t("lib.playback.unsupportedLink"));
  if (options.external) {
    if (needsHeaders) return { url, externalUrl: url, headers, torrentEngine: engineUsed };
    return { url, externalUrl: url, torrentEngine: engineUsed };
  }
  let playable = url;
  if (needsHeaders) {
    if (!service)
      throw new Error(
        t("lib.playback.needsProxy", { hint: serviceHint.toLowerCase() }),
      );
    // Verified against the server bundled with Stremio: its proxy rejects plain HTTP destinations.
    if (new URL(url).protocol !== "https:")
      throw new Error(
        t("lib.playback.needsHttps"),
      );
    playable = proxyUrl(serviceUrl, url, headers, stream.behaviorHints?.proxyHeaders?.response);
  }
  const target: PlaybackTarget = {
    url: playable,
    externalUrl: url,
    headers: needsHeaders ? headers : undefined,
    note,
    subtitles,
    torrentEngine: engineUsed,
  };
  if (optionalService) service = await within(optionalService, SERVICE_GRACE);
  if (!service || /\.m3u8(?:$|[?#])/i.test(playable)) return target;
  target.transcodeUrl = transcodeUrl(serviceUrl, playable, mediaCapabilities());
  // The file is not inspected here: that waits for the server to read its header (for a torrent,
  // for the first pieces), and the player can start meanwhile. It inspects it in the background.
  target.convertIfNeeded = Boolean(
    torrent ||
      stream.behaviorHints?.notWebReady ||
      streamTags(stream).some((tag) => tag === "HEVC" || tag === "MKV"),
  );
  return target;
}
