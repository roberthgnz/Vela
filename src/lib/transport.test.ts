import { describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => core);

import { postJson, requestBytes, requestJson } from './transport';

describe('desktop requests', () => {
  it('stop waiting for Rust when the signal aborts', async () => {
    core.invoke.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const pending = [
      requestJson('https://addon.example/manifest.json', controller.signal),
      requestBytes('https://addon.example/sub.srt', controller.signal),
      postJson('http://127.0.0.1:11470/x/create', {}, controller.signal),
    ];
    controller.abort();
    for (const request of pending) await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('still return Rust answers and errors when nothing aborts', async () => {
    core.invoke.mockResolvedValueOnce({ ok: true });
    expect(await requestJson('https://addon.example/a', AbortSignal.timeout(1000))).toEqual({ ok: true });
    core.invoke.mockRejectedValueOnce('No se pudo conectar con el addon.');
    await expect(requestJson('https://addon.example/b')).rejects.toThrow('No se pudo conectar con el addon.');
  });
});
