/**
 * Profile PINs. A PIN keeps someone else from opening a profile on a shared computer (like
 * Netflix's profile lock); it is not encryption: the profile's data stays readable on disk.
 * Only a salted PBKDF2 hash is stored.
 */

import { t } from "./i18n";

export type PinHash = { salt: string; hash: string };

export const PIN_LENGTH = 4;
const ITERATIONS = 120_000;

export function validPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

function base64(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function derive(pin: string, salt: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS }, key, 256);
  return base64(bits);
}

export async function hashPin(pin: string): Promise<PinHash> {
  if (!validPin(pin)) throw new Error(t("profiles.pinLength", { length: PIN_LENGTH }));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: base64(salt), hash: await derive(pin, salt) };
}

export async function verifyPin(pin: string, saved: PinHash): Promise<boolean> {
  if (!validPin(pin)) return false;
  try {
    return (await derive(pin, bytes(saved.salt))) === saved.hash;
  } catch {
    return false;
  }
}

export function isPinHash(value: unknown): value is PinHash {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PinHash).salt === "string" &&
    typeof (value as PinHash).hash === "string"
  );
}

/** After this many wrong PINs in a row, a profile waits before accepting another try. */
export const MAX_ATTEMPTS = 5;
export const LOCKOUT_MS = 30_000;

/** Wrong attempts per profile, kept in memory: restarting Vela resets them. */
export function createAttempts(now = () => Date.now()) {
  const failures = new Map<string, { count: number; until: number }>();
  return {
    /** Milliseconds left before `id` accepts another try (0 when it can try now). */
    wait(id: string): number {
      return Math.max(0, (failures.get(id)?.until ?? 0) - now());
    },
    fail(id: string) {
      const count = (failures.get(id)?.count ?? 0) + 1;
      failures.set(id, { count: count >= MAX_ATTEMPTS ? 0 : count, until: count >= MAX_ATTEMPTS ? now() + LOCKOUT_MS : 0 });
    },
    succeed(id: string) {
      failures.delete(id);
    },
  };
}
