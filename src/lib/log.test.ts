import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from './log';

describe('log', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prints the message with the error name, message and the first stack frames', () => {
    const print = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('boom');
    error.stack = 'Error: boom\n    at first (a.ts:1:1)\n    at second (b.ts:2:2)';
    log.error('loading failed', error);
    expect(print).toHaveBeenCalledTimes(1);
    const [line] = print.mock.calls[0] as [string];
    expect(line).toBe('[vela] loading failed — Error: boom\n    at first (a.ts:1:1)\n    at second (b.ts:2:2)');
  });

  it('serializes plain details and tolerates values that cannot be serialized', () => {
    const print = vi.spyOn(console, 'warn').mockImplementation(() => {});
    log.warn('state', { a: 1 });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    log.warn('cyclic', cyclic);
    log.warn('plain');
    expect(print.mock.calls.map((call) => call[0])).toEqual(['[vela] state — {"a":1}', '[vela] cyclic — [object Object]', '[vela] plain']);
  });

  it('uses console.info for information', () => {
    const print = vi.spyOn(console, 'info').mockImplementation(() => {});
    log.info('started', 'desktop');
    expect(print).toHaveBeenCalledWith('[vela] started — desktop');
  });
});
