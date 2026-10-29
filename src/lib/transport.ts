import { invoke, isTauri } from '@tauri-apps/api/core';

function checkSignal(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError');
}

function message(error: unknown): Error {
  return error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'The addon request failed.');
}

async function request(url: string, format: 'json' | 'text', signal?: AbortSignal): Promise<unknown> {
  checkSignal(signal);
  if (isTauri()) {
    try {
      const result = await invoke(format === 'json' ? 'request_json' : 'request_text', { url });
      checkSignal(signal);
      return result;
    } catch (error) {
      checkSignal(signal);
      throw message(error);
    }
  }
  const params = new URLSearchParams({ url, format });
  const response = await fetch(`/api/addon?${params}`, { signal, credentials: 'same-origin' });
  checkSignal(signal);
  if (!response.ok) {
    let error = 'The addon request failed.';
    try {
      const body: unknown = await response.json();
      if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') error = body.error;
    } catch { /* The proxy may be unavailable in a static deployment. */ }
    throw new Error(error);
  }
  const result: unknown = format === 'json' ? await response.json() : await response.text();
  checkSignal(signal);
  return result;
}

export function requestJson(url: string, signal?: AbortSignal): Promise<unknown> {
  return request(url, 'json', signal);
}

export async function requestText(url: string, signal?: AbortSignal): Promise<string> {
  return await request(url, 'text', signal) as string;
}

/** Raw bytes (for subtitles, whose encoding Vela detects itself). */
export async function requestBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  checkSignal(signal);
  if (isTauri()) {
    try {
      const result = await invoke<ArrayBuffer | number[]>('request_bytes', { url });
      checkSignal(signal);
      return result instanceof ArrayBuffer ? new Uint8Array(result) : Uint8Array.from(result);
    } catch (error) {
      checkSignal(signal);
      throw message(error);
    }
  }
  const params = new URLSearchParams({ url, format: 'bytes' });
  const response = await fetch(`/api/addon?${params}`, { signal, credentials: 'same-origin' });
  checkSignal(signal);
  if (!response.ok) throw new Error('The subtitle request failed.');
  return new Uint8Array(await response.arrayBuffer());
}

/** POSTs JSON through Rust in the desktop app. In a browser it calls the service directly, which must allow CORS. */
export async function postJson(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  checkSignal(signal);
  if (isTauri()) {
    try {
      const result = await invoke('post_json', { url, body });
      checkSignal(signal);
      return result;
    } catch (error) {
      checkSignal(signal);
      throw message(error);
    }
  }
  const response = await fetch(externalUrl(url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(20_000),
    credentials: 'omit',
  });
  if (!response.ok) throw new Error(`The service returned HTTP ${response.status}.`);
  return response.json();
}

function externalUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Enter a valid HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTP or HTTPS URL without embedded credentials.');
  }
  return url.href;
}

export async function openExternal(raw: string): Promise<void> {
  const url = externalUrl(raw);
  if (isTauri()) {
    try { await invoke('open_external', { url }); } catch (error) { throw message(error); }
  }
  else window.open(url, '_blank', 'noopener,noreferrer');
}

const sessionFallback = new Map<string, string>();

/** Reads a secret from the Windows credential store. Outside the desktop app it lives only in memory. */
export async function getSecret(name: 'stremio-auth-key'): Promise<string | null> {
  if (!isTauri()) return sessionFallback.get(name) ?? null;
  try { return await invoke<string | null>('secret_get', { name }); } catch (error) { throw message(error); }
}

export async function setSecret(name: 'stremio-auth-key', value: string): Promise<void> {
  if (!isTauri()) { sessionFallback.set(name, value); return; }
  try { await invoke('secret_set', { name, value }); } catch (error) { throw message(error); }
}

export async function deleteSecret(name: 'stremio-auth-key'): Promise<void> {
  if (!isTauri()) { sessionFallback.delete(name); return; }
  try { await invoke('secret_delete', { name }); } catch (error) { throw message(error); }
}

/**
 * Starts an external player. With MPV and a `session`, the desktop app follows playback through
 * MPV's IPC and emits `player-progress`; every player emits `player-closed` when it exits.
 * Returns whether progress will be reported.
 */
export async function launchExternalPlayer(
  raw: string,
  path: string,
  options: { headers?: Record<string, string>; title?: string; session?: string; start?: number } = {},
): Promise<{ ipc: boolean }> {
  const url = externalUrl(raw);
  if (!isTauri()) throw new Error('Open Vela Desktop to launch an external player.');
  try {
    return await invoke<{ ipc: boolean }>('launch_external_player', {
      url,
      path,
      headers: options.headers ?? null,
      title: options.title ?? null,
      session: options.session ?? null,
      start: options.start ?? null,
    });
  } catch (error) { throw message(error); }
}
