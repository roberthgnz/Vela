import { useSyncExternalStore } from "react";
import { sourceHistory, sourcesKey } from "./sourceHistory";
import { MAIN_PROFILE, preferencesStore } from "./store";

/**
 * Local profiles, like Stremio's «Who's watching?». Each profile has its own library, progress,
 * watched marks, source history and playback preferences; addons, Stremio Service, the
 * external player and the TMDB key are shared. The main profile keeps the data Vela already had.
 */

export type Profile = { id: string; name: string; color: string };
type Saved = { profiles: Profile[]; last?: string };

const storageKey = "vela.profiles.v1";
export const MAX_PROFILES = 8;
/** Avatar colors, chosen to read well on the dark interface. */
export const profileColors = ["#d6ef91", "#8ec5ff", "#f5a97f", "#c6a0f6", "#8bd5ca", "#f0c6c6", "#eed49f", "#a6da95"];

function read(): Saved {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Saved | null;
    const profiles = (value?.profiles ?? []).filter(
      (profile) => profile && typeof profile.id === "string" && typeof profile.name === "string" && profile.name.trim(),
    );
    if (profiles.some((profile) => profile.id === MAIN_PROFILE)) return { profiles, last: value?.last };
    return { profiles: [{ id: MAIN_PROFILE, name: "Principal", color: profileColors[0] }, ...profiles], last: value?.last };
  } catch {
    return { profiles: [{ id: MAIN_PROFILE, name: "Principal", color: profileColors[0] }] };
  }
}

let saved: Saved = typeof localStorage === "undefined" ? { profiles: [] } : read();
/** Whether a profile has been chosen in this session (the picker shows until then). */
let chosen = saved.profiles.length <= 1;
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

export const profiles = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => snapshot,
  /** Activates a profile and loads its data. */
  select(id: string) {
    if (!saved.profiles.some((profile) => profile.id === id)) return;
    preferencesStore.switchProfile(id);
    sourceHistory.switchProfile(id);
    chosen = true;
    save({ ...saved, last: id });
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
  update(id: string, change: Partial<Pick<Profile, "name" | "color">>) {
    const name = change.name === undefined ? undefined : clean(change.name);
    if (name === "") throw new Error("Escribe un nombre para el perfil.");
    if (name && saved.profiles.some((profile) => profile.id !== id && profile.name.toLocaleLowerCase("es") === name.toLocaleLowerCase("es")))
      throw new Error("Ya hay un perfil con ese nombre.");
    save({
      ...saved,
      profiles: saved.profiles.map((profile) =>
        profile.id === id ? { ...profile, ...(name ? { name } : {}), ...(change.color ? { color: change.color } : {}) } : profile,
      ),
    });
  },
  /** Deletes a profile and its data. The main profile and the active one cannot be deleted. */
  remove(id: string) {
    if (id === MAIN_PROFILE || id === preferencesStore.getProfile()) return;
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
  profiles.select(saved.last);

export function useProfiles() {
  return useSyncExternalStore(profiles.subscribe, profiles.getSnapshot, profiles.getSnapshot);
}
