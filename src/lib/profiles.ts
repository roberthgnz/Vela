import { useSyncExternalStore } from "react";
import { createAttempts, hashPin, isPinHash, verifyPin, type PinHash } from "./pin";
import { sourceHistory, sourcesKey } from "./sourceHistory";
import { MAIN_PROFILE, preferencesStore } from "./store";

/**
 * Local profiles, like Stremio's «Who's watching?». Each profile has its own library, progress,
 * watched marks, source history and playback preferences; addons, Stremio Service, the
 * external player and the TMDB key are shared. The main profile keeps the data Vela already had.
 */

/**
 * `kids`: Home, Explorar and search show only children's catalogs.
 * `pin`: the profile asks for its PIN before opening, and before its PIN is changed or it is deleted.
 */
export type Profile = { id: string; name: string; color: string; kids?: boolean; pin?: PinHash };
type Saved = { profiles: Profile[]; last?: string };

const storageKey = "vela.profiles.v1";
export const MAX_PROFILES = 8;
/** Avatar colors, chosen to read well on the dark interface. */
export const profileColors = ["#d6ef91", "#8ec5ff", "#f5a97f", "#c6a0f6", "#8bd5ca", "#f0c6c6", "#eed49f", "#a6da95"];

function read(): Saved {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Saved | null;
    const profiles = (value?.profiles ?? [])
      .filter((profile) => profile && typeof profile.id === "string" && typeof profile.name === "string" && profile.name.trim())
      .map(({ pin, ...profile }) => (isPinHash(pin) ? { ...profile, pin } : profile));
    if (profiles.some((profile) => profile.id === MAIN_PROFILE)) return { profiles, last: value?.last };
    return { profiles: [{ id: MAIN_PROFILE, name: "Principal", color: profileColors[0] }, ...profiles], last: value?.last };
  } catch {
    return { profiles: [{ id: MAIN_PROFILE, name: "Principal", color: profileColors[0] }] };
  }
}

let saved: Saved = typeof localStorage === "undefined" ? { profiles: [] } : read();
/** Whether a profile has been chosen in this session (the picker shows until then). */
let chosen = saved.profiles.length <= 1 && !saved.profiles[0]?.pin;
const attempts = createAttempts();
let snapshot = { ...saved, active: preferencesStore.getProfile(), chosen };
const listeners = new Set<() => void>();

function save(next: Saved) {
  saved = next;
  try {
    localStorage.setItem(storageKey, JSON.stringify(saved));
  } catch {
    /* Profiles still work for this session. */
  }
  emit();
}

function emit() {
  snapshot = { ...saved, active: preferencesStore.getProfile(), chosen };
  for (const listener of [...listeners]) listener();
}

function clean(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, 24);
}

function activate(id: string) {
  preferencesStore.switchProfile(id);
  sourceHistory.switchProfile(id);
  chosen = true;
  save({ ...saved, last: id });
}

/** Rejects unless `pin` opens profile `id` (profiles without a PIN always pass). */
async function check(id: string, pin: string) {
  const profile = saved.profiles.find((item) => item.id === id);
  if (!profile?.pin) return;
  const wait = attempts.wait(id);
  if (wait) throw new Error(`Demasiados intentos. Espera ${Math.ceil(wait / 1000)} s.`);
  if (!(await verifyPin(pin, profile.pin))) {
    attempts.fail(id);
    const locked = attempts.wait(id);
    throw new Error(locked ? `PIN incorrecto. Espera ${Math.ceil(locked / 1000)} s.` : "PIN incorrecto.");
  }
  attempts.succeed(id);
}

export const profiles = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => snapshot,
  /** Activates a profile and loads its data. Profiles with a PIN open with `unlock`. */
  select(id: string) {
    const profile = saved.profiles.find((item) => item.id === id);
    if (!profile) return;
    if (profile.pin) throw new Error(`«${profile.name}» tiene PIN.`);
    activate(id);
  },
  locked(id: string): boolean {
    return Boolean(saved.profiles.find((profile) => profile.id === id)?.pin);
  },
  /** Opens a profile after checking its PIN. */
  async unlock(id: string, pin: string) {
    if (!saved.profiles.some((profile) => profile.id === id)) return;
    await check(id, pin);
    activate(id);
  },
  /** Checks a profile's PIN without opening it (to manage that profile). */
  verify: check,
  /**
   * Sets, changes (`pin`) or removes (`null`) a profile's PIN. A profile that already has one
   * needs it (`current`) first.
   */
  async setPin(id: string, pin: string | null, current = "") {
    if (!saved.profiles.some((profile) => profile.id === id)) return;
    await check(id, current);
    const value = pin === null ? undefined : await hashPin(pin);
    save({
      ...saved,
      profiles: saved.profiles.map((profile) => {
        if (profile.id !== id) return profile;
        const { pin: _old, ...rest } = profile;
        return value ? { ...rest, pin: value } : rest;
      }),
    });
  },
  create(name: string, color = profileColors[saved.profiles.length % profileColors.length]): Profile {
    const value = clean(name);
    if (!value) throw new Error("Escribe un nombre para el perfil.");
    if (saved.profiles.length >= MAX_PROFILES) throw new Error(`Puedes tener hasta ${MAX_PROFILES} perfiles.`);
    if (saved.profiles.some((profile) => profile.name.toLocaleLowerCase("es") === value.toLocaleLowerCase("es")))
      throw new Error("Ya hay un perfil con ese nombre.");
    const profile = { id: crypto.randomUUID().slice(0, 8), name: value, color };
    save({ ...saved, profiles: [...saved.profiles, profile] });
    return profile;
  },
  update(id: string, change: Partial<Pick<Profile, "name" | "color" | "kids">>) {
    const name = change.name === undefined ? undefined : clean(change.name);
    if (name === "") throw new Error("Escribe un nombre para el perfil.");
    if (name && saved.profiles.some((profile) => profile.id !== id && profile.name.toLocaleLowerCase("es") === name.toLocaleLowerCase("es")))
      throw new Error("Ya hay un perfil con ese nombre.");
    save({
      ...saved,
      profiles: saved.profiles.map((profile) =>
        profile.id === id
          ? {
              ...profile,
              ...(name ? { name } : {}),
              ...(change.color ? { color: change.color } : {}),
              // The main profile keeps the install's original data and settings; it is never a child's.
              ...(change.kids !== undefined && id !== MAIN_PROFILE ? { kids: change.kids } : {}),
            }
          : profile,
      ),
    });
  },
  /**
   * Deletes a profile and its data. The main profile and the active one cannot be deleted; one
   * with a PIN needs it.
   */
  async remove(id: string, pin = "") {
    if (id === MAIN_PROFILE || id === preferencesStore.getProfile()) return;
    await check(id, pin);
    preferencesStore.forgetProfile(id);
    try {
      localStorage.removeItem(sourcesKey(id));
    } catch {
      /* Nothing else to remove. */
    }
    save({ ...saved, profiles: saved.profiles.filter((profile) => profile.id !== id), last: saved.last === id ? undefined : saved.last });
  },
  /** Shows the picker again. */
  choose() {
    chosen = false;
    emit();
  },
};

/** Without a picker (one profile), the last profile used is restored. */
if (chosen && saved.last && saved.last !== MAIN_PROFILE && saved.profiles.some((profile) => profile.id === saved.last))
  activate(saved.last);

export function useProfiles() {
  return useSyncExternalStore(profiles.subscribe, profiles.getSnapshot, profiles.getSnapshot);
}

/**
 * The profile whose PIN guards profile management: with a child's profile open, the main
 * profile's PIN (when it has one), so the child cannot turn the restriction off.
 */
export function managementGuard(state: { profiles: Profile[]; active: string }): Profile | undefined {
  const active = state.profiles.find((profile) => profile.id === state.active);
  const main = state.profiles.find((profile) => profile.id === MAIN_PROFILE);
  return active?.kids && main?.pin ? main : undefined;
}

/** Whether the active profile is a child's. */
export function useKidsMode(): boolean {
  const state = useProfiles();
  return Boolean(state.profiles.find((profile) => profile.id === state.active)?.kids);
}
