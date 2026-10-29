import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

class ProxyError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function checkedUrl(raw: string): URL {
  if (raw.length > 8192) throw new ProxyError(400, 'The URL is too long.');
  let url: URL;
  try { url = new URL(raw); } catch { throw new ProxyError(400, 'Enter a valid HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new ProxyError(400, 'Only HTTP and HTTPS URLs are supported.');
  }
  if (url.username || url.password) throw new ProxyError(400, 'URLs with embedded credentials are not supported.');
  return url;
}

function verifyLocalRequest(req: IncomingMessage) {
  const port = req.socket.localPort;
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!req.headers.host || !hosts.includes(req.headers.host)) throw new ProxyError(403, 'This proxy is available only on this computer.');
  const origin = req.headers.origin;
  if ((origin && origin !== `http://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site') {
    throw new ProxyError(403, 'Cross-site addon requests are not allowed.');
  }
}

async function upstream(raw: string, signal: AbortSignal): Promise<Uint8Array> {
  let url = checkedUrl(raw);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const response = await fetch(url, {
      signal,
      redirect: 'manual',
      headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.5', 'user-agent': 'Vela/0.2.0' },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      if (redirect === MAX_REDIRECTS) throw new ProxyError(502, 'The addon redirected too many times.');
      const location = response.headers.get('location');
      if (!location) throw new ProxyError(502, 'The addon returned an invalid redirect.');
      try { url = checkedUrl(new URL(location, url).href); } catch { throw new ProxyError(502, 'The addon returned an unsupported redirect.'); }
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProxyError(502, `The addon returned HTTP ${response.status}.`);
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (declaredLength > MAX_BYTES) {
      await response.body?.cancel();
      throw new ProxyError(413, 'The addon response exceeds the 8 MB limit.');
    }
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_BYTES) throw new ProxyError(413, 'The addon response exceeds the 8 MB limit.');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }
  throw new ProxyError(502, 'The addon could not be reached.');
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const disconnect = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', disconnect);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    verifyLocalRequest(req);
    if (req.method !== 'GET') throw new ProxyError(405, 'Only GET requests are supported.');
    const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
    const raw = query.get('url');
    const format = query.get('format') ?? 'json';
    if (!raw) throw new ProxyError(400, 'An addon URL is required.');
    if (!['json', 'text'].includes(format)) throw new ProxyError(400, 'Unsupported response format.');
    const bytes = await upstream(raw, controller.signal);
    let body: string;
    try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ProxyError(502, 'The addon returned invalid UTF-8 text.'); }
    if (format === 'json') {
      try { JSON.parse(body); } catch { throw new ProxyError(502, 'The addon returned invalid JSON.'); }
    }
    res.setHeader('Content-Type', format === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
    res.statusCode = 200;
    res.end(body);
  } catch (error) {
    if (res.destroyed) return;
    const failure = error instanceof ProxyError ? error : new ProxyError(controller.signal.aborted ? 504 : 502,
      controller.signal.aborted ? 'The addon request timed out.' : 'The addon could not be reached. Check its URL and connection.');
    res.statusCode = failure.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: failure.message }));
  } finally {
    clearTimeout(timer);
    res.off('close', disconnect);
  }
}

export function addonProxyPlugin(): Plugin {
  const install = (server: { middlewares: { use: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => unknown } }) => {
    server.middlewares.use((req, res, next) => {
      if (req.url?.split('?')[0] !== '/api/addon') { next(); return; }
      void route(req, res);
    });
  };
  return { name: 'vela-addon-proxy', configureServer: install, configurePreviewServer: install };
}
