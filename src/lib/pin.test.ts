import { describe, expect, it } from 'vitest';

import { createAttempts, hashPin, LOCKOUT_MS, MAX_ATTEMPTS, validPin, verifyPin } from './pin';

describe('profile PINs', () => {
  it('accepts four digits only', () => {
    expect(validPin('0427')).toBe(true);
    expect(validPin('427')).toBe(false);
    expect(validPin('04a7')).toBe(false);
    expect(validPin('04277')).toBe(false);
  });

  it('stores a salted hash and verifies against it', async () => {
    const saved = await hashPin('0427');
    expect(JSON.stringify(saved)).not.toContain('0427');
    expect(await verifyPin('0427', saved)).toBe(true);
    expect(await verifyPin('0428', saved)).toBe(false);
    expect((await hashPin('0427')).hash).not.toBe(saved.hash);
    expect(await verifyPin('0427', { salt: '!!', hash: saved.hash })).toBe(false);
    await expect(hashPin('12')).rejects.toThrow();
  });

  it('makes a profile wait after too many wrong PINs', () => {
    let time = 0;
    const attempts = createAttempts(() => time);
    for (let index = 0; index < MAX_ATTEMPTS - 1; index++) attempts.fail('kid');
    expect(attempts.wait('kid')).toBe(0);
    attempts.fail('kid');
    expect(attempts.wait('kid')).toBe(LOCKOUT_MS);
    expect(attempts.wait('other')).toBe(0);
    time += LOCKOUT_MS;
    expect(attempts.wait('kid')).toBe(0);
    attempts.fail('kid');
    attempts.succeed('kid');
    expect(attempts.wait('kid')).toBe(0);
  });
});
