import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEV_URL = 'http://127.0.0.1:1430';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MARKER = /<meta\s+name=["']vela-app["']\s+content=["']com\.vela\.desktop["']\s*\/?>/i;

export async function probeVelaServer(url = DEV_URL) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(2500), redirect: 'error' });
  } catch (error) {
    if (error?.cause?.code === 'ECONNREFUSED') return false;
    throw new Error('Port 1430 is occupied or unavailable. Vela could not verify its development server.');
  }
  const reader = response.body?.getReader();
  let length = 0;
  const chunks = [];
  if (reader) {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 64 * 1024) throw new Error('The server on port 1430 is not a Vela development server.');
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
  }
  const html = Buffer.concat(chunks).toString('utf8');
  if (!response.ok || !MARKER.test(html) || !html.includes('/src/main.tsx') || !html.includes('/@vite/client')) {
    throw new Error('Port 1430 is used by another server. Stop that server before starting Vela Desktop.');
  }
  return true;
}

function pnpmEntrypoint() {
  const candidates = [
    process.env.npm_execpath,
    resolve(dirname(process.execPath), 'node_modules/corepack/dist/pnpm.js'),
  ];
  const entrypoint = candidates.find((path) => path && /pnpm\.(?:cjs|mjs|js)$/i.test(basename(path)) && existsSync(path));
  if (!entrypoint) throw new Error('pnpm could not be found. Start this app with pnpm desktop from the Vela folder.');
  return entrypoint;
}

export async function startVelaUi() {
  if (await probeVelaServer()) {
    console.log('Reusing the running Vela development server on 127.0.0.1:1430.');
    return;
  }
  const child = spawn(process.execPath, [pnpmEntrypoint(), 'dev'], { cwd: ROOT, stdio: 'inherit', shell: false });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    const code = await new Promise((accept, reject) => {
      child.once('error', () => reject(new Error('The Vela development server could not be started.')));
      child.once('exit', (status) => accept(status ?? 1));
    });
    process.exitCode = code;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  startVelaUi().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
