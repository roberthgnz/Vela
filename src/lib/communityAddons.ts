import { normalizeManifestUrl } from "./protocol";
import { requestJson } from "./transport";

/**
 * The community addon catalog of stremio-addons.net, read through its own Stremio addon
 * (`addon_catalog` resource, the same one Stremio uses for its addon catalogs). One request lists
 * every addon with its manifest; the server caches it for four hours.
 */
export const COMMUNITY_CATALOG_URL = "https://stremio-addons.net/api/addon_catalog/all/stremio-addons.net.json";
export const COMMUNITY_SITE_URL = "https://stremio-addons.net/";

/** Resources shown as capabilities, in this order. */
export const communityCapabilities = ["stream", "subtitles", "catalog", "meta"] as const;
export type CommunityCapability = (typeof communityCapabilities)[number];

export type CommunityAddon = {
  manifestUrl: string;
  id: string;
  name: string;
  version?: string;
  description?: string;
  logo?: string;
  types: string[];
  capabilities: CommunityCapability[];
  /** The addon can be set up on its own page (`/configure`) before installing. */
  configurable: boolean;
  /** The addon does nothing until it is set up: it is installed from its page, not directly. */
  configurationRequired: boolean;
  adult: boolean;
  /** Streams come from peer-to-peer sources (torrents). */
  p2p: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cleanText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function httpsUrl(value: unknown): string | undefined {
  const raw = cleanText(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function entry(value: unknown): CommunityAddon | null {
  if (!isRecord(value) || !isRecord(value.manifest)) return null;
  if (value.transportName !== undefined && value.transportName !== "http") return null;
  const manifest = value.manifest;
  const id = cleanText(manifest.id);
  const name = cleanText(manifest.name);
  const transport = cleanText(value.transportUrl);
  if (!id || !name || !transport || !/^https?:\/\//i.test(transport)) return null;
  let manifestUrl: string;
  try {
    manifestUrl = normalizeManifestUrl(transport);
  } catch {
    return null;
  }
  const resources = new Set(
    (Array.isArray(manifest.resources) ? manifest.resources : [])
      .map((resource) => (typeof resource === "string" ? resource : isRecord(resource) ? resource.name : undefined))
      .filter((resource): resource is string => typeof resource === "string"),
  );
  const hints = isRecord(manifest.behaviorHints) ? manifest.behaviorHints : {};
  return {
    manifestUrl,
    id,
    name,
    version: cleanText(manifest.version),
    description: cleanText(manifest.description),
    logo: httpsUrl(manifest.logo),
    types: Array.isArray(manifest.types)
      ? manifest.types.filter((type): type is string => typeof type === "string" && Boolean(type.trim()))
      : [],
    capabilities: communityCapabilities.filter((name) => resources.has(name)),
    configurable: hints.configurable === true || hints.configurationRequired === true,
    configurationRequired: hints.configurationRequired === true,
    adult: hints.adult === true,
    p2p: hints.p2p === true,
  };
}

/** The addons of an `addon_catalog` response; entries that are not usable HTTP addons are left out. */
export function parseCommunityCatalog(value: unknown): CommunityAddon[] {
  if (!isRecord(value) || !Array.isArray(value.addons)) throw new Error("The addon catalog has no addon list.");
  const seen = new Set<string>();
  const result: CommunityAddon[] = [];
  for (const item of value.addons) {
    const addon = entry(item);
    if (!addon || seen.has(addon.manifestUrl)) continue;
    seen.add(addon.manifestUrl);
    result.push(addon);
  }
  return result;
}

export async function loadCommunityAddons(signal?: AbortSignal): Promise<CommunityAddon[]> {
  return parseCommunityCatalog(await requestJson(COMMUNITY_CATALOG_URL, signal));
}

/** The addon's setup page, by Stremio's convention next to its manifest. */
export function configureUrl(manifestUrl: string): string {
  const url = new URL(manifestUrl);
  url.pathname = url.pathname.replace(/\/manifest\.json$/, "/configure");
  url.search = "";
  return url.href;
}

const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

export function filterCommunityAddons(
  addons: CommunityAddon[],
  options: { query?: string; capability?: CommunityCapability | "all"; adult?: boolean },
): CommunityAddon[] {
  const words = fold(options.query ?? "")
    .split(/\s+/)
    .filter(Boolean);
  return addons.filter((addon) => {
    if (addon.adult && !options.adult) return false;
    if (options.capability && options.capability !== "all" && !addon.capabilities.includes(options.capability)) return false;
    if (!words.length) return true;
    const haystack = fold(`${addon.name} ${addon.description ?? ""} ${addon.types.join(" ")} ${new URL(addon.manifestUrl).host}`);
    return words.every((word) => haystack.includes(word));
  });
}
