import { createContext, useCallback, useContext, useState } from "react";
import type { InstalledAddon, MediaItem } from "./contracts";
import { supportsResource } from "./protocol";

export type Section =
  | "home"
  | "movies"
  | "series"
  | "library"
  | "downloads"
  | "addons"
  | "settings";

/** Filters and choices of a view, kept in its history entry so going back restores them. */
export type ViewState = Record<string, string | number | boolean | undefined>;

export type Route =
  | { name: Section; state?: ViewState }
  | {
      name: "detail";
      meta: MediaItem;
      addonUrl: string;
      videoId?: string;
      season?: number;
      sources?: boolean;
      state?: ViewState;
    };

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
  /** Changes the current entry without adding one (the latest value is passed to `change`). */
  const update = useCallback((change: (route: Route) => Route) => {
    setHistory(({ entries, index }) => ({
      entries: entries.map((entry, i) => (i === index ? change(entry) : entry)),
      index,
    }));
  }, []);
  const replace = useCallback((route: Route) => update(() => route), [update]);
  const patchState = useCallback(
    (patch: ViewState) => update((route) => ({ ...route, state: { ...route.state, ...patch } })),
    [update],
  );
  /** Starts a new history (for example, after switching profiles). */
  const reset = useCallback((route: Route) => setHistory({ entries: [route], index: 0 }), []);
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
    update,
    patchState,
    reset,
    back,
    forward,
  };
}

const RouteStateContext = createContext<{ state: ViewState; patch: (patch: ViewState) => void }>({
  state: {},
  patch: () => {},
});

export const RouteStateProvider = RouteStateContext.Provider;

/** A view setting stored in the current history entry (like `useState`, but restored on «Atrás»). */
export function useRouteState<T extends string | number | boolean>(
  key: string,
  fallback: T,
): [T, (value: T) => void] {
  const { state, patch } = useContext(RouteStateContext);
  const saved = state[key];
  const value = (typeof saved === typeof fallback ? saved : fallback) as T;
  const set = useCallback((next: T) => patch({ [key]: next }), [key, patch]);
  return [value, set];
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
