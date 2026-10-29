import { useCallback, useState } from "react";

const prefix = "vela.ui.";

/** Small per-device interface conveniences (density, view mode, sidebar). */
export function useUiSetting<T extends string>(
  key: string,
  fallback: T,
  allowed: readonly T[],
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(prefix + key) as T | null;
      return saved && allowed.includes(saved) ? saved : fallback;
    } catch {
      return fallback;
    }
  });
  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(prefix + key, next);
      } catch {
        /* Interface preferences are optional. */
      }
    },
    [key],
  );
  return [value, update];
}
