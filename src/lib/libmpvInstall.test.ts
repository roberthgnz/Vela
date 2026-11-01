import { beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => ({ handler: undefined as undefined | ((event: { payload: unknown }) => void), unlisten: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: unknown }) => void) => {
    events.handler = handler;
    return events.unlisten;
  }),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cancelLibmpvInstall, embeddedLibrary, installLibmpv, libmpvInfo, removeLibmpv } from "./embeddedMpv";

const library = (path: string | null) =>
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "mpv_embedded_library") return path;
    return undefined;
  });

describe("installLibmpv", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockClear();
    events.unlisten.mockClear();
    events.handler = undefined;
  });

  it("forwards the progress events, stops listening and looks for the library again", async () => {
    library(null);
    expect(await embeddedLibrary()).toBeNull();
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "mpv_install") {
        events.handler?.({ payload: { stage: "download", downloaded: 10, total: 100 } });
        return "C:/Vela/libmpv/libmpv-2.dll";
      }
      return "C:/Vela/libmpv/libmpv-2.dll";
    });
    const seen: unknown[] = [];
    const path = await installLibmpv((progress) => seen.push(progress));
    expect(path).toBe("C:/Vela/libmpv/libmpv-2.dll");
    expect(listen).toHaveBeenCalledWith("mpv-install", expect.any(Function));
    expect(seen).toEqual([{ stage: "download", downloaded: 10, total: 100 }]);
    expect(events.unlisten).toHaveBeenCalledTimes(1);
    // The library cached as missing is asked for again.
    expect(await embeddedLibrary()).toBe("C:/Vela/libmpv/libmpv-2.dll");
  });

  it("turns what Rust reports into an error with its message, and still stops listening", async () => {
    vi.mocked(invoke).mockRejectedValue("El archivo descargado no coincide con el esperado.");
    await expect(installLibmpv(() => {})).rejects.toThrow("El archivo descargado no coincide con el esperado.");
    expect(events.unlisten).toHaveBeenCalledTimes(1);
  });

  it("asks Rust to cancel", () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    cancelLibmpvInstall();
    expect(invoke).toHaveBeenCalledWith("mpv_install_cancel");
  });
});

describe("removeLibmpv", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("deletes the download and forgets the library", async () => {
    library("C:/Vela/libmpv/libmpv-2.dll");
    expect(await embeddedLibrary()).toBe("C:/Vela/libmpv/libmpv-2.dll");
    library(null);
    await removeLibmpv();
    expect(invoke).toHaveBeenCalledWith("mpv_uninstall");
    expect(await embeddedLibrary()).toBeNull();
  });

  it("reports why it could not delete it", async () => {
    vi.mocked(invoke).mockRejectedValue("No se pudo borrar mpv. Cierra el vídeo que lo usa y vuelve a intentarlo.");
    await expect(removeLibmpv()).rejects.toThrow("Cierra el vídeo");
  });
});

describe("libmpvInfo", () => {
  it("returns what Rust knows about the pinned build, or null when it cannot be read", async () => {
    const info = { version: "20261101-914a11c30c", size: 29021126, license: "LGPL-2.1-or-later", source: "x", path: null };
    vi.mocked(invoke).mockResolvedValueOnce(info);
    expect(await libmpvInfo()).toEqual(info);
    expect(invoke).toHaveBeenLastCalledWith("mpv_install_info");
    vi.mocked(invoke).mockRejectedValueOnce("fallo");
    expect(await libmpvInfo()).toBeNull();
  });
});
