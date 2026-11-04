import { useSyncExternalStore } from "react";
import type { AddonManifest, InstalledAddon } from "./contracts";
import { loadManifest } from "./protocol";
import { preferencesStore } from "./store";

export type AddonHealth = {
  status: "unchecked" | "local" | "checking" | "ok" | "unavailable" | "changed";
  checkedAt?: number;
};

type AddonStore = {
  getSnapshot(): { addons: InstalledAddon[] };
  refreshAddon(addon: InstalledAddon): void;
};
type Check = {
  installedAt: number;
  manifest: AddonManifest;
  value: AddonHealth;
  pending?: Promise<void>;
};

const unchecked: AddonHealth = { status: "unchecked" };
const local: AddonHealth = { status: "local" };

/** Only session state is retained. Errors never keep request URLs, headers or server messages. */
export function createAddonHealth(
  store: AddonStore,
  load: typeof loadManifest = loadManifest,
  now: () => number = Date.now,
) {
  const checks = new Map<string, Check>();
  const listeners = new Set<() => void>();
  const sameInstallation = (check: Pick<Check, "installedAt" | "manifest">, addon?: InstalledAddon) =>
    addon?.installedAt === check.installedAt && addon.manifest === check.manifest;
  const installed = (url: string) => store.getSnapshot().addons.find((addon) => addon.manifestUrl === url);
  const emit = () => { for (const listener of [...listeners]) listener(); };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    get(addon: InstalledAddon): AddonHealth {
      if (addon.manifestUrl.startsWith("vela:")) return local;
      const check = checks.get(addon.manifestUrl);
      return check && sameInstallation(check, addon) ? check.value : unchecked;
    },
    check(addon: InstalledAddon): Promise<void> {
      if (addon.manifestUrl.startsWith("vela:") || !sameInstallation(addon, installed(addon.manifestUrl)))
        return Promise.resolve();
      const previous = checks.get(addon.manifestUrl);
      if (previous?.pending && sameInstallation(previous, addon)) return previous.pending;
      const check: Check = {
        installedAt: addon.installedAt,
        manifest: addon.manifest,
        value: { status: "checking", checkedAt: sameInstallation(previous ?? addon, addon) ? previous?.value.checkedAt : undefined },
      };
      checks.set(addon.manifestUrl, check);
      const current = () => checks.get(addon.manifestUrl) === check && sameInstallation(check, installed(addon.manifestUrl));
      const complete = (status: AddonHealth["status"]) => {
        check.value = { status, checkedAt: now() };
        emit();
      };
      // Deferring the loader also makes synchronous failures take the same safe error path.
      check.pending = Promise.resolve()
        .then(() => load(addon.manifestUrl, AbortSignal.timeout(15_000)))
        .then((fresh) => {
          if (!current()) return;
          if (fresh.manifest.id !== addon.manifest.id) {
            complete("changed");
            return;
          }
          store.refreshAddon(fresh);
          const updated = installed(addon.manifestUrl);
          if (!updated || updated.installedAt !== addon.installedAt) return;
          check.manifest = updated.manifest;
          complete("ok");
        })
        .catch(() => {
          if (current()) complete("unavailable");
        })
        .finally(() => { check.pending = undefined; });
      emit();
      return check.pending;
    },
  };
}

export const addonHealth = createAddonHealth(preferencesStore);

export function useAddonHealth(addon: InstalledAddon): AddonHealth {
  return useSyncExternalStore(addonHealth.subscribe, () => addonHealth.get(addon), () => addonHealth.get(addon));
}
