import { describe, expect, it } from 'vitest';

import type { ResolvedStream } from './contracts';
import { createSourceHistory, sourceKey } from './sourceHistory';

function memory() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
}

const torrent = (fileIdx?: number): ResolvedStream => ({ name: '4K', infoHash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01', fileIdx, addonName: 'T', addonUrl: 'https://t.example/manifest.json' });
const direct: ResolvedStream = { name: '1080p', url: 'https://cdn.example/a.mp4', addonName: 'D', addonUrl: 'https://d.example/manifest.json' };

describe('source history', () => {
  it('identifies sources by addon and target', () => {
    expect(sourceKey(torrent(1))).toBe(sourceKey({ ...torrent(1), infoHash: torrent(1).infoHash!.toLowerCase(), name: 'renamed' }));
    expect(sourceKey(torrent(1))).not.toBe(sourceKey(torrent(2)));
    expect(sourceKey(direct)).not.toBe(sourceKey({ ...direct, addonUrl: 'https://other.example/manifest.json' }));
  });

  it('records attempts per video and remembers the last source that played', () => {
    const storage = memory();
    const history = createSourceHistory(storage);
    history.mark('series', 'tt1', 'tt1:1:1', torrent(1), 'opened');
    history.mark('series', 'tt1', 'tt1:1:1', direct, 'failed', 'Sin pares');
    expect(history.last('series', 'tt1')).toBeUndefined();
    history.mark('series', 'tt1', 'tt1:1:1', torrent(1), 'played');
    // Opening it again does not hide that it played.
    history.mark('series', 'tt1', 'tt1:1:1', torrent(1), 'opened');
    const marks = history.marks('tt1:1:1');
    expect(marks[sourceKey(torrent(1))].outcome).toBe('played');
    expect(marks[sourceKey(direct)]).toMatchObject({ outcome: 'failed', error: 'Sin pares' });
    expect(history.last('series', 'tt1')).toMatchObject({ videoId: 'tt1:1:1', stream: { fileIdx: 1 } });
    // Persisted and cleared.
    const restored = createSourceHistory(storage);
    expect(restored.marks('tt1:1:1')[sourceKey(direct)].outcome).toBe('failed');
    restored.clear('tt1:1:1', direct);
    expect(restored.marks('tt1:1:1')[sourceKey(direct)]).toBeUndefined();
  });

  it('survives damaged storage', () => {
    const storage = memory();
    storage.setItem('vela.sources.v1', '{broken');
    expect(createSourceHistory(storage).marks('x')).toEqual({});
  });
});
