import type { Episode, MediaItem, ResolvedStream, Subtitle } from "./contracts";
import {
  type Probe,
  ensureService,
  mediaCapabilities,
  prepareTorrent,
  probe,
  probeProblems,
  proxyUrl,
  serviceAvailable,
  transcodeUrl,
} from "./streamingServer";
import { streamTags } from "./streams";
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
  /** Why the file was converted before playback, if it was. */
  transcodedBecause?: string[];
  /** Subtitle files shipped inside a torrent. */
  subtitles?: Subtitle[];
  /** Tracks reported by Stremio Service, when the file was inspected. */
  probe?: Probe;
};

const serviceHint =
  t("lib.playback.serviceHint");

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
  // Torrents and header proxies cannot work without the server, so Vela starts it if it can;
  // plain links only use it for optional probing and conversion.
  const service =
    torrent || needsHeaders
      ? await ensureService(serviceUrl)
      : !options.external && (await serviceAvailable(serviceUrl));
  let url = stream.url;
  let note: string | undefined;
  let subtitles: Subtitle[] = [];
  if (torrent) {
    if (!service)
      throw new Error(t("lib.playback.torrentNeedsService", { hint: serviceHint }));
    const prepared = await prepareTorrent(serviceUrl, stream, options.episode);
    url = prepared.url;
    subtitles = prepared.subtitles;
    note = prepared.fileName ? t("lib.playback.connectingFile", { file: prepared.fileName }) : t("lib.playback.connecting");
  }
  if (!isDirectUrl(url)) throw new Error(t("lib.playback.unsupportedLink"));
  if (options.external) {
    if (needsHeaders) return { url, externalUrl: url, headers };
    return { url, externalUrl: url };
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
  };
  if (!service || /\.m3u8(?:$|[?#])/i.test(playable)) return target;
  const capabilities = mediaCapabilities();
  target.transcodeUrl = transcodeUrl(serviceUrl, playable, capabilities);
  const suspicious =
    torrent ||
    stream.behaviorHints?.notWebReady ||
    streamTags(stream).some((tag) => tag === "HEVC" || tag === "MKV");
  if (!suspicious) return target;
  try {
    // The server reads the file's header before answering, which waits for peers on a torrent.
    // The player shows the swarm and offers the conversion later, so the wait is kept short.
    target.probe = await probe(serviceUrl, playable, AbortSignal.timeout(torrent ? 10_000 : 20_000));
    const problems = probeProblems(target.probe, capabilities);
    if (problems.length) {
      target.url = target.transcodeUrl;
      target.transcodedBecause = problems;
      target.note = t("lib.playback.converting", { problems: problems.join(", ") });
    }
  } catch {
    /* Probing is best effort; the player still offers conversion if decoding fails. */
  }
  return target;
}
