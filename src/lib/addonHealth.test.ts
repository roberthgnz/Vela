import { describe, expect, it, vi } from "vitest";
import { createAddonHealth } from "./addonHealth";
import type { InstalledAddon } from "./contracts";
import { createPreferencesStore } from "./store";

const url = "https://addon.example.test/config-token/manifest.json";
function fixture(version = "1.0.0", id = "test.addon"): InstalledAddon {
  return {
    manifestUrl: url,
    enabled: true,
    installedAt: 1,
    manifest: { id, name: "Test addon", version, types: ["movie"], resources: ["stream"], catalogs: [] },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function setup(load = vi.fn(async () => fixture("2.0.0"))) {
  const values = new Map<string, string>();
  const store = createPreferencesStore({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  });
  store.installAddon(fixture());
  const current = () => store.getSnapshot().addons.find((addon) => addon.manifestUrl === url)!;
  const health = createAddonHealth(store, load, () => 42);
  return { store, current, health, load, values };
}

describe("installed addon manifest health", () => {
  it("refreshes the manifest while preserving the latest enabled choice", async () => {
    const response = deferred<InstalledAddon>();
    const { store, current, health } = setup(vi.fn(() => response.promise));
    const check = health.check(current());
    expect(health.get(current())).toEqual({ status: "checking", checkedAt: undefined });
    store.toggleAddon(url);
    response.resolve(fixture("2.0.0"));
    await check;
    expect(current()).toMatchObject({ enabled: false, manifest: { version: "2.0.0" } });
    expect(health.get(current())).toEqual({ status: "ok", checkedAt: 42 });
  });

  it("deduplicates checks shared by startup and manual actions", async () => {
    const response = deferred<InstalledAddon>();
    const { current, health, load } = setup(vi.fn(() => response.promise));
    const first = health.check(current());
    const second = health.check(current());
    expect(second).toBe(first);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    response.resolve(fixture("2.0.0"));
    await Promise.all([first, second]);
    expect(health.get(current()).status).toBe("ok");
  });

  it("keeps the installed addon when its URL starts serving another identity", async () => {
    const { current, health } = setup(vi.fn(async () => fixture("9.0.0", "someone.else")));
    await health.check(current());
    expect(current().manifest).toMatchObject({ id: "test.addon", version: "1.0.0" });
    expect(health.get(current())).toEqual({ status: "changed", checkedAt: 42 });
  });

  it("shows only a safe failure state and permits a successful retry", async () => {
    const load = vi.fn(async () => fixture("2.0.0"));
    load.mockRejectedValueOnce(new Error(`Authorization failed for ${url}; Bearer secret-token`));
    const { current, health, values } = setup(load);
    await expect(health.check(current())).resolves.toBeUndefined();
    expect(health.get(current())).toEqual({ status: "unavailable", checkedAt: 42 });
    expect(JSON.stringify(health.get(current()))).not.toContain("token");
    expect([...values.keys()]).not.toContain("vela.addonHealth");
    await health.check(current());
    expect(health.get(current()).status).toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not reinstall an addon removed while the request is pending", async () => {
    const response = deferred<InstalledAddon>();
    const { store, current, health } = setup(vi.fn(() => response.promise));
    const checking = health.check(current());
    store.removeAddon(url);
    response.resolve(fixture("2.0.0"));
    await checking;
    expect(store.getSnapshot().addons.some((addon) => addon.manifestUrl === url)).toBe(false);
  });

  it("ignores an old response after reinstalling at the same URL, even with the same installedAt", async () => {
    const response = deferred<InstalledAddon>();
    const { store, current, health } = setup(vi.fn(() => response.promise));
    const original = current();
    const checking = health.check(original);
    // installAddon preserves the original installedAt while replacing its parsed manifest.
    store.installAddon(fixture("3.0.0"));
    expect(current().installedAt).toBe(original.installedAt);
    response.resolve(fixture("2.0.0"));
    await checking;
    expect(current().manifest.version).toBe("3.0.0");
    expect(health.get(current()).status).toBe("unchecked");
  });

  it("lets a reinstalled addon's new check win over an older in-flight check", async () => {
    const oldResponse = deferred<InstalledAddon>();
    const freshResponse = deferred<InstalledAddon>();
    const load = vi.fn<() => Promise<InstalledAddon>>()
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(freshResponse.promise);
    const { store, current, health } = setup(load);
    const old = health.check(current());
    store.removeAddon(url);
    store.installAddon(fixture("3.0.0"));
    const fresh = health.check(current());
    freshResponse.resolve(fixture("4.0.0"));
    await fresh;
    oldResponse.resolve(fixture("2.0.0"));
    await old;
    expect(current().manifest.version).toBe("4.0.0");
    expect(health.get(current()).status).toBe("ok");
  });

  it("never uses the network for local addons and returns stable snapshots", async () => {
    const { store, current, health, load } = setup();
    const addon = store.getSnapshot().addons.find((item) => item.manifestUrl.startsWith("vela:"))!;
    expect(health.get(current())).toBe(health.get(current()));
    expect(health.get(addon)).toBe(health.get(addon));
    expect(health.get(addon).status).toBe("local");
    await health.check(addon);
    expect(load).not.toHaveBeenCalled();
  });

  it("notifies subscribers at the start and end and supports unsubscribing", async () => {
    const { current, health } = setup();
    const notified = vi.fn();
    const unsubscribe = health.subscribe(notified);
    await health.check(current());
    expect(notified).toHaveBeenCalledTimes(2);
    unsubscribe();
    await health.check(current());
    expect(notified).toHaveBeenCalledTimes(2);
  });
});
