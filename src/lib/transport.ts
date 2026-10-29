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

export async function launchExternalPlayer(raw: string, path: string): Promise<void> {
  const url = externalUrl(raw);
  if (!isTauri()) throw new Error('Open Vela Desktop to launch an external player.');
  try { await invoke('launch_external_player', { url, path }); } catch (error) { throw message(error); }
}
