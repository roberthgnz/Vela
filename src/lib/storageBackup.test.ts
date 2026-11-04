import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, isTauri: () => true }));
vi.mock("./log", () => ({ log: { info: vi.fn(), error: vi.fn() } }));

describe("backup with desktop persistence", () => {
  let fail = false;
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    fail = false;
    native.invoke.mockReset().mockImplementation(async (command: string) => {
      if (command === "storage_load") return [{ key: "vela.preferences.v2", value: '{"version":2,"library":{}}' }];
      if (command === "storage_write" && fail) throw new Error("disk full");
      if (command === "storage_backup" || command === "storage_restore") return "C:/Vela/backups/previous.db";
    });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("refuses a stale backup after a failed flush and allows retry when the changes are saved", async () => {
    const { initStorage, storage, backupStorage } = await import("./storage");
    await initStorage();
    storage.setItem("vela.progress", "latest");
    fail = true;
    await expect(backupStorage()).rejects.toThrow("disk full");
    expect(native.invoke.mock.calls.filter(([command]) => command === "storage_backup")).toHaveLength(0);
    fail = false;
    await expect(backupStorage()).resolves.toBe("C:/Vela/backups/previous.db");
    expect(native.invoke.mock.calls.filter(([command]) => command === "storage_backup")).toHaveLength(1);
  });

  it("never creates a backup from the old renderer while restored data is awaiting reload", async () => {
    const { initStorage, restoreStorage, storage, backupStorage } = await import("./storage");
    await initStorage();
    await restoreStorage("vela-20261101-120000.db");
    storage.setItem("vela.progress", "old renderer");
    await expect(backupStorage()).rejects.toThrow("restauración");
    expect(native.invoke.mock.calls.filter(([command]) => command === "storage_backup")).toHaveLength(0);
  });
});
