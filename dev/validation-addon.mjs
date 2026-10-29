// Local addon used to validate playback integrations inside the desktop app.
// Run: node dev/validation-addon.mjs   then install http://127.0.0.1:7010/manifest.json in Vela.
//
// Torrents are Blender Foundation films distributed under Creative Commons BY 3.0
// (the WebTorrent sample torrents). The HEVC/MKV and header-protected files are generated
// locally from tests/fixtures/playback.mp4; see `media` below.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PORT || 7010);
const root = fileURLToPath(new URL("../", import.meta.url));
const media = {
  "h264.mp4": `${root}tests/fixtures/playback.mp4`,
  "hevc.mkv": `${root}.tmp/media/hevc.mkv`,
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
];

const streams = [
  { name: "Torrent\n1080p", title: "Sintel · fileIdx 5 explícito\nSintel.mp4 · 123 MB", infoHash: sintel, fileIdx: 5 },
  { name: "Torrent\nAuto", title: "Sintel · sin fileIdx (el servicio elige)\n11 archivos: vídeo, .srt y póster", infoHash: sintel },
  { name: "Torrent\nTrackers", title: "Big Buck Bunny · trackers en sources", infoHash: bunny, sources: trackers },
  { name: "Torrent\nÍndice erróneo", title: "Sintel · fileIdx 0 apunta a un .srt", infoHash: sintel, fileIdx: 0 },
  { name: "Torrent\nSin pares", title: "Hash inexistente: debe fallar con un mensaje claro", infoHash: "0123456789abcdef0123456789abcdef01234567" },
  { name: "Directo\nCabeceras", title: "MP4 que exige X-Vela-Token", url: `${base}/protected/h264.mp4`, behaviorHints: { proxyHeaders: { request: { "X-Vela-Token": "ok" } } } },
  { name: "Directo\nHEVC", title: "MKV con vídeo HEVC · requiere conversión o MPV", url: `${base}/media/hevc.mkv`, behaviorHints: { notWebReady: true } },
  { name: "Directo\nH.264", title: "MP4 H.264/AAC compatible", url: `${base}/media/h264.mp4` },
];

const manifest = {
  id: "dev.vela.validation",
  name: "Vela Validación",
  version: "1.0.0",
  description: "Fuentes locales y torrents CC para validar el reproductor y Stremio Service.",
  resources: ["catalog", "meta", "stream"],
  types: ["movie"],
  idPrefixes: ["velatest:"],
  catalogs: [{ id: "validation", type: "movie", name: "Validación" }],
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
  const type = path.endsWith(".mkv") ? "video/x-matroska" : "video/mp4";
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, {
      "content-type": type,
      "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${end}/${size}`,
      "content-length": end - start + 1,
    });
    createReadStream(path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size });
    createReadStream(path).pipe(res);
  }
}

createServer((req, res) => {
  const url = new URL(req.url, base);
  const path = decodeURIComponent(url.pathname);
  console.log(req.method, path, req.headers["x-vela-token"] ? "(token)" : "");
  if (path === "/manifest.json") return json(res, manifest);
  if (path === "/catalog/movie/validation.json") return json(res, { metas: titles });
  if (path === "/meta/movie/velatest:sintel.json") return json(res, { meta: titles[0] });
  if (path === "/stream/movie/velatest:sintel.json") return json(res, { streams });
  const protectedFile = /^\/protected\/(.+)$/.exec(path);
  if (protectedFile) {
    if (req.headers["x-vela-token"] !== "ok") return res.writeHead(403).end("missing header");
    return file(req, res, media[protectedFile[1]]);
  }
  const plain = /^\/media\/(.+)$/.exec(path);
  if (plain && media[plain[1]]) return file(req, res, media[plain[1]]);
  res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
}).listen(port, "127.0.0.1", () => console.log(`Validation addon on ${base}/manifest.json`));
