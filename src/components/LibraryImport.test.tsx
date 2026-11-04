// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ profile: "main", guarded: false, syncing: false, diskError: undefined as string | undefined }));
vi.mock("../lib/account", () => ({ useAccount: () => ({ status: "signed-in", syncing: state.syncing }) }));
vi.mock("../lib/profiles", () => ({
  useProfiles: () => ({ active: state.profile, profiles: [{ id: "main", name: "Principal" }, { id: "other", name: "Otro" }] }),
  managementGuard: () => state.guarded ? { id: "main", name: "Principal" } : undefined,
  profiles: { verify: vi.fn(async () => {}) },
}));
vi.mock("../lib/storage", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/storage")>(),
  getStorageStatus: () => ({ backend: "desktop", pending: 0, migrated: false, error: state.diskError }),
  useStorageStatus: () => ({ backend: "desktop", pending: 0, migrated: false }),
  backupStorage: vi.fn(),
  flushStorage: vi.fn(),
}));

import { MAX_LIBRARY_IMPORT_BYTES } from "../lib/libraryImport";
import { profiles } from "../lib/profiles";
import { backupStorage, flushStorage } from "../lib/storage";
import { mediaKey, preferencesStore } from "../lib/store";
import { LibraryImport } from "./LibraryImport";

const clients: QueryClient[] = [];
const addon = "https://example.test/manifest.json";
const key = mediaKey("movie", "imported");
function file(text = JSON.stringify({ version: 1, exportedAt: "2026-11-01T12:00:00Z", library: {
  [key]: { meta: { type: "movie", id: "imported", name: "Importada" }, addonUrl: addon, addedAt: 100, saved: true,
    progress: { videoId: "imported", seconds: 42, duration: 90, updatedAt: 200 } },
} })) {
  const result = new File([text], "vela-library.json", { type: "application/json" });
  Object.defineProperty(result, "text", { value: vi.fn(async () => text) });
  return result;
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const notify = vi.fn();
  render(<QueryClientProvider client={client}><LibraryImport notify={notify} /></QueryClientProvider>);
  return notify;
}
function choose(value = file()) {
  fireEvent.change(screen.getByLabelText("Archivo de biblioteca de Vela"), { target: { files: [value] } });
}

describe("import library confirmation", () => {
  beforeEach(() => {
    state.profile = "main";
    state.guarded = state.syncing = false;
    state.diskError = undefined;
    preferencesStore.switchProfile("main");
    preferencesStore.clearLibrary();
    vi.clearAllMocks();
    vi.mocked(backupStorage).mockResolvedValue("C:/Vela/backups/previous.db");
    vi.mocked(flushStorage).mockResolvedValue();
    vi.mocked(profiles.verify).mockResolvedValue();
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } });
  });
  afterEach(() => {
    cleanup();
    for (const client of clients.splice(0)) client.clear();
  });

  it("reviews the file, target profile and merge counts without importing before confirmation", async () => {
    mount();
    choose();
    expect(await screen.findByRole("dialog")).toHaveTextContent("Nuevos: 1 · Por actualizar: 0 · Sin cambios: 0");
    expect(screen.getByRole("dialog")).toHaveTextContent("perfil «Principal»");
    expect(screen.getByRole("dialog")).toHaveTextContent("próxima sincronización");
    expect(preferencesStore.getSnapshot().library[key]).toBeUndefined();
    expect(backupStorage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(preferencesStore.getSnapshot().library[key]).toBeUndefined();
  });

  it("saves a backup first, then merges into the current profile and preserves current titles/settings", async () => {
    preferencesStore.saveMedia({ type: "movie", id: "current", name: "Actual" }, addon);
    const settings = preferencesStore.getSnapshot();
    vi.mocked(backupStorage).mockImplementation(async () => {
      expect(preferencesStore.getSnapshot().library[key]).toBeUndefined();
      return "previous.db";
    });
    const notify = mount();
    choose();
    fireEvent.click(await screen.findByRole("button", { name: "Combinar biblioteca" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Biblioteca importada. Nuevos: 1 · Actualizados: 0."));
    expect(backupStorage).toHaveBeenCalledTimes(1);
    expect(preferencesStore.getSnapshot().library[key].progress?.seconds).toBe(42);
    expect(preferencesStore.getSnapshot().library[mediaKey("movie", "current")]).toBeDefined();
    expect(preferencesStore.getSnapshot().addons).toEqual(settings.addons);
    expect(preferencesStore.getSnapshot().serviceUrl).toBe(settings.serviceUrl);
    expect(flushStorage).toHaveBeenCalledTimes(1);
  });

  it("does not merge anything if saving the safety copy fails", async () => {
    vi.mocked(backupStorage).mockRejectedValue(new Error("No se pudo crear la copia."));
    mount();
    choose();
    fireEvent.click(await screen.findByRole("button", { name: "Combinar biblioteca" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo crear la copia.");
    expect(preferencesStore.getSnapshot().library[key]).toBeUndefined();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeEnabled();
  });

  it("rejects oversized files before reading them", async () => {
    const oversized = file();
    Object.defineProperty(oversized, "size", { value: MAX_LIBRARY_IMPORT_BYTES + 1 });
    mount();
    choose(oversized);
    expect(await screen.findByRole("alert")).toHaveTextContent("límite de 20 MB");
    expect(oversized.text).not.toHaveBeenCalled();
    expect(backupStorage).not.toHaveBeenCalled();
  });

  it("shows a safe message for malformed JSON without exposing the file's contents", async () => {
    mount();
    choose(file('{"token":"private-content"'));
    expect(await screen.findByRole("alert")).toHaveTextContent("no es una exportación válida");
    expect(screen.queryByText(/private-content/)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("rejects a profile change while the safety copy is being created", async () => {
    let finish!: (value: string) => void;
    vi.mocked(backupStorage).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    mount();
    choose();
    fireEvent.click(await screen.findByRole("button", { name: "Combinar biblioteca" }));
    await waitFor(() => expect(backupStorage).toHaveBeenCalled());
    act(() => {
      state.profile = "other";
      preferencesStore.switchProfile("other");
      finish("previous.db");
    });
    await waitFor(() => expect(screen.getAllByRole("alert")[0]).toHaveTextContent("perfil ha cambiado"));
    expect(preferencesStore.getSnapshot().library[key]).toBeUndefined();
    act(() => preferencesStore.switchProfile("main"));
    expect(preferencesStore.getSnapshot().library[key]).toBeUndefined();
  });

  it("requires and checks the main profile PIN when importing from a guarded child profile", async () => {
    state.guarded = true;
    mount();
    choose();
    const button = await screen.findByRole("button", { name: "Combinar biblioteca" });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("PIN de Principal"), { target: { value: "1234" } });
    fireEvent.click(button);
    await waitFor(() => expect(profiles.verify).toHaveBeenCalledWith("main", "1234"));
    await waitFor(() => expect(preferencesStore.getSnapshot().library[key]).toBeDefined());
  });

  it("reports a write failure after merging as pending persistence rather than failed import", async () => {
    vi.mocked(flushStorage).mockImplementation(async () => { state.diskError = "disk full"; });
    const notify = mount();
    choose();
    fireEvent.click(await screen.findByRole("button", { name: "Combinar biblioteca" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining("importada en esta sesión")));
    expect(preferencesStore.getSnapshot().library[key]).toBeDefined();
  });

  it("does not create a backup or merge data when the PIN is rejected", async () => {
    state.guarded = true;
    vi.mocked(profiles.verify).mockRejectedValueOnce(new Error("PIN incorrecto."));
    mount();
    choose();
    const button = await screen.findByRole("button", { name: "Combinar biblioteca" });
    fireEvent.change(screen.getByLabelText("PIN de Principal"), { target: { value: "1111" } });
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("PIN incorrecto");
    expect(backupStorage).not.toHaveBeenCalled();
    expect(preferencesStore.getSnapshot().library[key]).toBeUndefined();
    expect(screen.getByLabelText("PIN de Principal")).toHaveValue("");
  });
});
