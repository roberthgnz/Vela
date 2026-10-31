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
import { prepareVelaTorrent, torrentEngine, velaEngineAvailable } from "./torrentEngine";
import { isDirectUrl } from "./utils";

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
  /** Which engine is streaming a torrent source. */
  torrentEngine?: "vela" | "service";
};

const serviceHint =
  "Vela inicia el servidor de Stremio si Stremio está instalado; si no, instala Stremio o abre Stremio Service y comprueba su dirección en Ajustes › Streaming.";

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
  // torrents on Vela's engine) only use it for optional probing and conversion.
  const service =
    (torrent && !ownEngine) || needsHeaders
      ? await ensureService(serviceUrl)
      : !options.external && (await serviceAvailable(serviceUrl));
  const useVela = ownEngine || (torrent && velaEngineAvailable && engine === "auto" && !service);
  let url = stream.url;
  let note: string | undefined;
  let subtitles: Subtitle[] = [];
  if (torrent && useVela) {
    const prepared = await prepareVelaTorrent(stream, options.episode);
    url = prepared.url;
    subtitles = prepared.subtitles;
    note = `Conectando con pares · ${prepared.fileName}`;
  } else if (torrent) {
    if (!service)
      throw new Error(`Las fuentes torrent necesitan Stremio Service y no responde. ${serviceHint}`);
    const prepared = await prepareTorrent(serviceUrl, stream, options.episode);
    url = prepared.url;
    subtitles = prepared.subtitles;
    note = prepared.fileName ? `Conectando con pares · ${prepared.fileName}` : "Conectando con los pares del torrent";
  }
  const engineUsed = torrent ? (useVela ? "vela" : "service") : undefined;
  if (!isDirectUrl(url)) throw new Error("Esta fuente no proporciona un enlace de vídeo compatible.");
  if (options.external) {
    if (needsHeaders) return { url, externalUrl: url, headers, torrentEngine: engineUsed };
    return { url, externalUrl: url, torrentEngine: engineUsed };
  }
  let playable = url;
  if (needsHeaders) {
    if (!service)
      throw new Error(
        `Esta fuente exige cabeceras HTTP especiales. Para verla en Vela hace falta el proxy de Stremio Service (${serviceHint.toLowerCase()}), o ábrela con MPV.`,
      );
    // Verified against the server bundled with Stremio: its proxy rejects plain HTTP destinations.
    if (new URL(url).protocol !== "https:")
      throw new Error(
        "Esta fuente exige cabeceras HTTP y no usa HTTPS; el proxy de Stremio Service solo acepta HTTPS. Ábrela con MPV desde el menú de la fuente.",
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
    if (useVela) target.note = note;
    const problems = probeProblems(target.probe, capabilities);
    if (problems.length) {
      target.url = target.transcodeUrl;
      target.transcodedBecause = problems;
      target.note = `Convirtiendo con Stremio Service (${problems.join(", ")})`;
    }
  } catch {
    /* Probing is best effort; the player still offers conversion if decoding fails. */
  }
  return target;
}
