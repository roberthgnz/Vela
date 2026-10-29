import { useCallback, useState } from "react";
import type { InstalledAddon, MediaItem } from "./contracts";
import { supportsResource } from "./protocol";

export type Section =
  | "home"
  | "movies"
  | "series"
  | "library"
  | "addons"
  | "settings";

export type Route =
  | { name: Section }
  | { name: "detail"; meta: MediaItem; addonUrl: string; videoId?: string; sources?: boolean };

type History = { entries: Route[]; index: number };

export function useNavigation(initial: Route = { name: "home" }) {
  const [history, setHistory] = useState<History>({
    entries: [initial],
    index: 0,
  });
  const navigate = useCallback((route: Route) => {
    setHistory(({ entries, index }) => {
      const current = entries[index];
      if (current.name === route.name && route.name !== "detail")
        return { entries, index };
      return { entries: [...entries.slice(0, index + 1), route], index: index + 1 };
    });
  }, []);
  const replace = useCallback((route: Route) => {
    setHistory(({ entries, index }) => ({
      entries: entries.map((entry, i) => (i === index ? route : entry)),
      index,
    }));
  }, []);
  const back = useCallback(
    () =>
      setHistory((value) =>
        value.index > 0 ? { ...value, index: value.index - 1 } : value,
      ),
    [],
  );
  const forward = useCallback(
    () =>
      setHistory((value) =>
        value.index < value.entries.length - 1
          ? { ...value, index: value.index + 1 }
          : value,
      ),
    [],
  );
  return {
    route: history.entries[history.index],
    index: history.index,
    canBack: history.index > 0,
    canForward: history.index < history.entries.length - 1,
    navigate,
    replace,
    back,
    forward,
  };
}

/** Finds the addon that should describe a title, falling back to a read-only placeholder. */
export function metaAddon(
  addons: InstalledAddon[],
  meta: MediaItem,
  addonUrl: string,
): InstalledAddon {
  return (
    addons.find((item) => item.enabled && item.manifestUrl === addonUrl) ||
    addons.find(
      (item) => item.enabled && supportsResource(item, "meta", meta.type, meta.id),
    ) || {
      manifestUrl: addonUrl,
      enabled: true,
      installedAt: 0,
      manifest: {
        id: "saved",
        name: "Tu biblioteca",
        version: "1",
        resources: [],
        types: [meta.type],
        catalogs: [],
      },
    }
  );
}
