// Local addon used to validate playback integrations inside the desktop app.
// Run: node dev/validation-addon.mjs   then install http://127.0.0.1:7010/manifest.json in Vela.
//
// Torrents are Blender Foundation films distributed under Creative Commons BY 3.0
// (the WebTorrent sample torrents). The HEVC/MKV and header-protected files are generated
// locally from dev/media/playback.mp4; the multitrack file, the episodes and the
// subtitles are synthetic (FFmpeg test patterns and tones): `node dev/make-validation-media.mjs`.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PORT || 7010);
const root = fileURLToPath(new URL("../", import.meta.url));
const generated = (name) => `${root}.tmp/media/${name}`;
const media = {
  "h264.mp4": `${root}dev/media/playback.mp4`,
  "hevc.mkv": generated("hevc.mkv"),
  "multitrack.mkv": generated("multitrack.mkv"),
  "multiaudio.mp4": generated("multiaudio.mp4"),
  "ep1.mp4": generated("ep1.mp4"),
  "ep2.mp4": generated("ep2.mp4"),
  "ep3.mp4": generated("ep3.mp4"),
  "styled.ass": generated("styled.ass"),
  "subs-en.srt": generated("subs-en.srt"),
  "subs-es-1252.srt": generated("subs-es-1252.srt"),
  "broken.srt": generated("broken.srt"),
};
const trackers = [
  "tracker:udp://tracker.opentrackr.org:1337/announce",
  "tracker:udp://explodie.org:6969",
  "tracker:udp://tracker.leechers-paradise.org:6969",
];
const sintel = "08ada5a7a6183aae1e09d831df6748d566095a10";
const bunny = "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c";
const base = `http://127.0.0.1:${port}`;

const titles = [
  {
    id: "velatest:sintel",
    type: "movie",
    name: "Sintel · Validación",
    description: "Sintel (Blender Foundation, CC BY 3.0). Fuentes torrent y directas para validar Vela.",
    releaseInfo: "2010",
  },
  {
    id: "velatest:tracks",
    type: "movie",
    name: "Pistas · Validación",
    description: "Patrón de prueba sintético con dos pistas de audio (inglés y español) y subtítulos SRT y ASS incrustados.",
    releaseInfo: "2026",
  },
];
const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
const series = {
  id: "velatest:serie",
  type: "series",
  name: "Serie · Validación",
  description: "Tres episodios sintéticos de 25 s para validar la continuidad entre episodios, más uno sin estrenar.",
  releaseInfo: "2026",
  videos: [
    ...[1, 2, 3].map((episode) => ({
      id: `velatest:serie:1:${episode}`,
      title: `Episodio ${episode}`,
      season: 1,
      episode,
      released: "2026-01-0" + episode + "T00:00:00.000Z",
    })),
    { id: "velatest:serie:1:4", title: "Episodio sin estrenar", season: 1, episode: 4, released: future },
  ],
};

const streams = [
  { name: "Torrent\n1080p", title: "Sintel · fileIdx 5 explícito\nSintel.mp4 · 123 MB", infoHash: sintel, fileIdx: 5 },
  { name: "Torrent\nAuto", title: "Sintel · sin fileIdx (el servicio elige)\n11 archivos: vídeo, .srt y póster", infoHash: sintel },
  { name: "Torrent\nTrackers", title: "Big Buck Bunny · trackers en sources", infoHash: bunny, sources: trackers },
  { name: "Torrent\nÍndice erróneo", title: "Sintel · fileIdx 0 apunta a un .srt", infoHash: sintel, fileIdx: 0 },
  { name: "Torrent\nSin pares", title: "Hash inexistente: debe fallar con un mensaje claro", infoHash: "0123456789abcdef0123456789abcdef01234567" },
  { name: "Directo\nCabeceras", title: "MP4 que exige X-Vela-Token", url: `${base}/protected/h264.mp4`, behaviorHints: { proxyHeaders: { request: { "X-Vela-Token": "ok" } } } },
  { name: "Directo\nHEVC", title: "MKV con vídeo HEVC · requiere conversión o MPV", url: `${base}/media/hevc.mkv`, behaviorHints: { notWebReady: true } },
  { name: "Directo\nH.264", title: "MP4 H.264/AAC compatible", url: `${base}/media/h264.mp4` },
  // Many audio languages, written as torrent addons do, to check that the language filter folds.
  {
    name: "Directo\nIdiomas",
    title: "MP4 H.264 · prueba del filtro de idiomas\n🇬🇧 / 🇪🇸 / 🇫🇷 / 🇩🇪 / 🇮🇹 / 🇵🇹 / 🇧🇷 / 🇷🇺 / 🇺🇦 / 🇵🇱 / 🇳🇱 / 🇸🇪 / 🇳🇴 / 🇩🇰 / 🇫🇮 / 🇨🇿 / 🇭🇺 / 🇷🇴 / 🇬🇷 / 🇹🇷 / 🇮🇱 / 🇸🇦 / 🇮🇳 / 🇯🇵 / 🇰🇷 / 🇨🇳 / 🇹🇭 / 🇻🇳 / 🇮🇩 / 🇲🇽",
    url: `${base}/media/h264.mp4`,
  },
];

const trackStreams = [
  {
    name: "Directo\nMKV multipista",
    title: "H.264 · 2 audios (eng, spa) · SRT eng/spa y ASS incrustados",
    url: `${base}/media/multitrack.mkv`,
    behaviorHints: { filename: "multitrack.mkv" },
  },
  {
    name: "Directo\nMP4 dos audios",
    title: "H.264 · AAC inglés y español en el mismo MP4",
    url: `${base}/media/multiaudio.mp4`,
    subtitles: [{ id: "stream-ass", lang: "eng", url: `${base}/media/styled.ass` }],
  },
];
// The Spanish file is Windows-1252 and listed twice; broken.srt is not a subtitle file.
const addonSubtitles = [
  { id: "en", lang: "eng", url: `${base}/media/subs-en.srt` },
  { id: "es", lang: "spa", url: `${base}/media/subs-es-1252.srt` },
  { id: "es-copy", lang: "es", url: `${base}/media/subs-es-1252.srt` },
  { id: "ass", lang: "eng", url: `${base}/media/styled.ass` },
  { id: "broken", lang: "fre", url: `${base}/media/broken.srt` },
];
function episodeStreams(episode) {
  if (episode > 3) return [];
  return [
    { name: "Directo\n360p", title: `Episodio ${episode} · grupo A`, url: `${base}/media/ep${episode}.mp4`, behaviorHints: { bingeGroup: "vela-validation-a" } },
    { name: "Alternativa\n360p", title: `Episodio ${episode} · grupo B`, url: `${base}/media/ep${episode}.mp4`, behaviorHints: { bingeGroup: "vela-validation-b" } },
  ];
}

const manifest = {
  id: "dev.vela.validation",
  name: "Vela Validación",
  version: "1.0.0",
  description: "Fuentes locales y torrents CC para validar el reproductor y Stremio Service.",
  resources: ["catalog", "meta", "stream", "subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["velatest:"],
  catalogs: [
    { id: "validation", type: "movie", name: "Validación" },
    { id: "validation", type: "series", name: "Validación" },
  ],
};

function json(res, body) {
  res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

function file(req, res, path) {
  if (!existsSync(path)) {
    res.writeHead(404).end("missing; run the ffmpeg command in docs/stremio.md");
    return;
  }
  const size = statSync(path).size;
  const type = path.endsWith(".mkv") ? "video/x-matroska" : /\.(srt|ass)$/.test(path) ? "text/plain" : "video/mp4";
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    // VLC probes the end of the file (`bytes=<size>-`); answer as HTTP says instead of crashing.
    if (start > end) {
      res.writeHead(416, { "content-range": `bytes */${size}`, "access-control-allow-origin": "*" }).end();
      return;
    }
    res.writeHead(206, {
      "content-type": type,
      "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${end}/${size}`,
      "access-control-allow-origin": "*",
      "content-length": end - start + 1,
    });
    createReadStream(path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size, "access-control-allow-origin": "*" });
    createReadStream(path).pipe(res);
  }
}

createServer((req, res) => {
  const url = new URL(req.url, base);
  const path = decodeURIComponent(url.pathname);
  console.log(req.method, path, req.headers["x-vela-token"] ? "(token)" : "");
  if (path === "/manifest.json") return json(res, manifest);
  if (path === "/catalog/movie/validation.json") return json(res, { metas: titles });
  if (path === "/catalog/series/validation.json") return json(res, { metas: [series] });
  const meta = /^\/meta\/(movie|series)\/(.+)\.json$/.exec(path);
  if (meta) return json(res, { meta: [...titles, series].find((item) => item.id === meta[2]) ?? null });
  if (path === "/stream/movie/velatest:sintel.json") return json(res, { streams });
  if (path === "/stream/movie/velatest:tracks.json") return json(res, { streams: trackStreams });
  const episode = /^\/stream\/series\/velatest:serie:1:(\d)\.json$/.exec(path);
  if (episode) return json(res, { streams: episodeStreams(Number(episode[1])) });
  if (path.startsWith("/subtitles/movie/velatest:tracks")) return json(res, { subtitles: addonSubtitles });
  const protectedFile = /^\/protected\/(.+)$/.exec(path);
  if (protectedFile) {
    if (req.headers["x-vela-token"] !== "ok") return res.writeHead(403).end("missing header");
    return file(req, res, media[protectedFile[1]]);
  }
  const plain = /^\/media\/(.+)$/.exec(path);
  if (plain && media[plain[1]]) return file(req, res, media[plain[1]]);
  res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
}).listen(port, "127.0.0.1", () => console.log(`Validation addon on ${base}/manifest.json`));
