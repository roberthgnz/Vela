import type { MediaItem } from "./contracts";
import { t } from "./i18n";

export function safeImage(value?: string): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("/art/")) return value;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function addonHost(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "vela:" ? t("lib.utils.includedWithVela") : url.hostname;
  } catch {
    return t("lib.utils.addon");
  }
}

export function yearOf(meta: MediaItem): string {
  return meta.releaseInfo?.slice(0, 9) || meta.released?.slice(0, 4) || "";
}

export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  return total >= 3600
    ? `${Math.floor(total / 3600)}:${String(Math.floor(total / 60) % 60).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
    : `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function errorMessage(error: unknown): string {
  // Without a connection every addon "fails"; say what actually happened.
  if (typeof navigator !== "undefined" && navigator.onLine === false)
    return t("errors.offline");
  return error instanceof Error
    ? error.message
    : t("errors.generic");
}

export function sourceTitle(value?: string): string {
  return (
    value
      ?.replace(/\r/g, "")
      .split("\n")
      .filter(Boolean)
      .slice(0, 3)
      .join(" · ") || t("lib.utils.videoSource")
  );
}

export function isDirectUrl(value?: string): value is string {
  if (!value) return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** Scroll behavior that honors the system's reduced-motion setting. */
export function motion(): ScrollBehavior {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}
