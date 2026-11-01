import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn(async () => undefined) }));
vi.mock('./storage', () => {
  const values = new Map<string, string>();
  return {
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
  };
});
vi.mock('./streamingServer', () => ({
  serviceAvailable: vi.fn(),
  serviceInstalled: vi.fn(),
  isLocalService: (url: string) => url === 'http://127.0.0.1:11470',
}));

import { invoke } from '@tauri-apps/api/core';
import { serviceAvailable, serviceInstalled } from './streamingServer';
import { torrentEngine, warmVelaEngine } from './torrentEngine';

const local = 'http://127.0.0.1:11470';

describe('warmVelaEngine', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
    vi.mocked(serviceAvailable).mockReset();
    vi.mocked(serviceInstalled).mockReset();
  });

  it('starts the engine when Vela opens torrents, without asking about Stremio', async () => {
    torrentEngine.set('vela');
    expect(await warmVelaEngine(local)).toBe(true);
    expect(invoke).toHaveBeenCalledWith('torrent_warm');
    expect(serviceAvailable).not.toHaveBeenCalled();
  });

  it('leaves it stopped only for the explicit service selection', async () => {
    torrentEngine.set('service');
    expect(await warmVelaEngine(local)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    torrentEngine.set('auto');
    vi.mocked(serviceAvailable).mockResolvedValue(true);
    expect(await warmVelaEngine(local)).toBe(true);
    // Installed or running Stremio does not change the engine selected by «auto».
    vi.mocked(serviceAvailable).mockResolvedValue(false);
    vi.mocked(serviceInstalled).mockResolvedValue(true);
    expect(await warmVelaEngine(local)).toBe(true);
    expect(serviceAvailable).not.toHaveBeenCalled();
    expect(serviceInstalled).not.toHaveBeenCalled();
  });

  it('starts it in «auto» without probing the configured service', async () => {
    torrentEngine.set('auto');
    vi.mocked(serviceAvailable).mockResolvedValue(false);
    vi.mocked(serviceInstalled).mockResolvedValue(false);
    expect(await warmVelaEngine(local)).toBe(true);
    // A server elsewhere cannot be started by Vela.
    vi.mocked(serviceInstalled).mockResolvedValue(true);
    expect(await warmVelaEngine('http://192.168.1.10:11470')).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
