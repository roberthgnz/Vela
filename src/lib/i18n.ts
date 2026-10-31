import { en } from "../locales/en";
import { es } from "../locales/es";
import { flushStorage, storage } from "./storage";

/**
 * The interface language. Spanish (`es.ts`) is the source; `en.ts` has the same keys, which `tsc`
 * checks. The language is resolved once, when this module loads (the desktop database is loaded
 * before `App` is imported), and changing it reloads the window.
 */
export type Locale = "es" | "en";
export type LanguageSetting = "system" | Locale;
export type MessageKey = keyof typeof es;
export type MessageParams = Record<string, string | number>;

export const LANGUAGE_KEY = "vela.ui.language";
export const locales: readonly Locale[] = ["es", "en"];

const dictionaries: Record<Locale, Record<MessageKey, string>> = { es, en };

/** `system` follows the operating system: Spanish when its language is Spanish, English otherwise. */
export function resolveLocale(setting: string | null | undefined, systemLanguage: string | null | undefined): Locale {
  if (setting === "es" || setting === "en") return setting;
  return systemLanguage?.trim().toLowerCase().startsWith("es") ? "es" : "en";
}

/** Saved by every Vela that ever ran (see `store.ts`). */
const EXISTING_INSTALL_KEY = "vela.preferences.v2";

/**
 * Vela was Spanish-only before 1.0: an existing installation keeps Spanish (saved, so Settings
 * shows it) instead of switching to the system language on update; new installations follow the
 * system.
 */
export function initialSetting(saved: string | null, existingInstall: boolean): LanguageSetting {
  if (saved === "es" || saved === "en" || saved === "system") return saved;
  return existingInstall ? "es" : "system";
}

function readSetting(): LanguageSetting {
  try {
    const saved = storage.getItem(LANGUAGE_KEY);
    const value = initialSetting(saved, storage.getItem(EXISTING_INSTALL_KEY) !== null);
    if (saved === null && value === "es") storage.setItem(LANGUAGE_KEY, "es");
    return value;
  } catch {
    return "system";
  }
}

const setting = readSetting();
const active: Locale = resolveLocale(setting, typeof navigator === "undefined" ? undefined : navigator.language);
if (typeof document !== "undefined") document.documentElement.lang = active;

/** The active interface language. */
export function locale(): Locale {
  return active;
}

/** What the user chose in Settings (`system` unless they picked a language). */
export function languageSetting(): LanguageSetting {
  return setting;
}

/** Saves the choice and reloads the window so every view is rendered in the new language. */
export async function setLanguage(value: LanguageSetting): Promise<void> {
  storage.setItem(LANGUAGE_KEY, value);
  await flushStorage();
  location.reload();
}

/** Replaces `{name}` with `params.name`; placeholders without a value stay visible. */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/** A message in a given language (tests and previews); the interface uses `t`. */
export function translate(target: Locale, key: MessageKey, params?: MessageParams): string {
  return interpolate(dictionaries[target][key] ?? es[key] ?? key, params);
}

/** A message in the active language, e.g. `t("player.back")`, `t("detail.season", { number: 2 })`. */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(active, key, params);
}

/**
 * A message that depends on a count: `one` when it is 1, `other` otherwise (both languages use
 * these two forms). `{count}` is available to both messages.
 */
export function plural(count: number, one: MessageKey, other: MessageKey, params?: MessageParams): string {
  return t(count === 1 ? one : other, { count, ...params });
}

/** The BCP 47 tag for `Intl` and `toLocale*String` calls in the interface. */
export function dateLocale(): Locale {
  return active;
}

export function formatDate(value: number | string | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Date(value).toLocaleDateString(active, options);
}

export function formatDateTime(value: number | string | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Date(value).toLocaleString(active, options);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return value.toLocaleString(active, options);
}

/** Alphabetical order in the active language. */
export function compareText(a: string, b: string): number {
  return a.localeCompare(b, active);
}
