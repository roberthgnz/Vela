// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ syncing: false, downloading: false, guarded: false }));
const copy = { name: "vela-20261101-120000.db", size: 4096, created: 1_793_534_400_000 };
const info = { path: "C:/Vela/vela.db", folder: "C:/Vela", keys: 10, size: 8192, backups: [copy] };

vi.mock("../lib/account", () => ({ useAccount: () => ({ syncing: state.syncing }) }));
vi.mock("../lib/downloads", () => ({
  useDownloads: () => state.downloading ? [{ status: "downloading" }] : [],
  formatBytes: (value: number) => `${value} B`,
}));
vi.mock("../lib/profiles", () => ({ useProfiles: () => ({}), managementGuard: () => state.guarded ? {} : undefined }));
vi.mock("../lib/storage", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/storage")>(),
  useStorageStatus: () => ({ backend: "desktop", pending: 0, migrated: false }),
  storageInfo: vi.fn(),
  backupStorage: vi.fn(),
  previewStorageBackup: vi.fn(),
  restoreStorage: vi.fn(),
}));

import { backupStorage, previewStorageBackup, restoreStorage, storageInfo } from "../lib/storage";
import { StorageSettings } from "./StorageSettings";

const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const element = <QueryClientProvider client={client}><StorageSettings notify={vi.fn()} /></QueryClientProvider>;
  return { ...render(element), element };
}

describe("backup recovery in Settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.syncing = state.downloading = state.guarded = false;
    vi.mocked(storageInfo).mockResolvedValue(info);
    vi.mocked(previewStorageBackup).mockResolvedValue({ name: copy.name, keys: 7, profiles: 2, libraryItems: 3 });
    vi.mocked(restoreStorage).mockImplementation(() => new Promise(() => {}));
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } });
  });
  afterEach(() => {
    cleanup();
    for (const client of clients.splice(0)) client.clear();
  });

  it("previews the selected copy and permits cancellation without replacing data", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Revisar copia" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("2 perfiles y 3 títulos");
    expect(previewStorageBackup).toHaveBeenCalledWith(copy.name, expect.anything());
    expect(restoreStorage).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent("volver a vincular");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(restoreStorage).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation and prevents duplicate requests or dismissing a pending restore", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Revisar copia" }));
    const confirm = await screen.findByRole("button", { name: "Restaurar y recargar" });
    fireEvent.click(confirm);
    await waitFor(() => expect(restoreStorage).toHaveBeenCalledWith(copy.name, expect.anything()));
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(restoreStorage).toHaveBeenCalledTimes(1);
  });

  it("shows invalid backup errors without offering replacement", async () => {
    vi.mocked(previewStorageBackup).mockRejectedValue(new Error("La copia está dañada."));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Revisar copia" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("La copia está dañada.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(restoreStorage).not.toHaveBeenCalled();
  });

  it("keeps confirmation available after a restore error so the user can retry or cancel", async () => {
    vi.mocked(restoreStorage).mockRejectedValue(new Error("No hay espacio para crear la copia previa."));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Revisar copia" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restaurar y recargar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No hay espacio");
    expect(screen.getByRole("button", { name: "Restaurar y recargar" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeEnabled();
  });

  it.each(["syncing", "downloading", "guarded"] as const)("does not offer recovery while %s", async (reason) => {
    state[reason] = true;
    mount();
    expect(await screen.findByRole("button", { name: "Revisar copia" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(reason === "guarded" ? "perfil principal" : "pausa las descargas");
    expect(previewStorageBackup).not.toHaveBeenCalled();
  });

  it("does not offer restoring when there are no backups", async () => {
    vi.mocked(storageInfo).mockResolvedValue({ ...info, backups: [] });
    mount();
    await screen.findByText(/Vela hace una copia al día/);
    expect(screen.queryByRole("button", { name: "Revisar copia" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Crear copia ahora" })).toBeEnabled();
    expect(backupStorage).not.toHaveBeenCalled();
  });
});
