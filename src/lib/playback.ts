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
      throw new Error(`Las fuentes torrent necesitan Stremio Service y no responde. ${serviceHint}`);
    const prepared = await prepareTorrent(serviceUrl, stream, options.episode);
    url = prepared.url;
    subtitles = prepared.subtitles;
    note = prepared.fileName ? `Conectando con pares · ${prepared.fileName}` : "Conectando con los pares del torrent";
  }
  if (!isDirectUrl(url)) throw new Error("Esta fuente no proporciona un enlace de vídeo compatible.");
  if (options.external) {
    if (needsHeaders) return { url, externalUrl: url, headers };
    return { url, externalUrl: url };
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
    target.probe = await probe(serviceUrl, playable);
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
