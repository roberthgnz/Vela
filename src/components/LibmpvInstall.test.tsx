// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibmpvProgress } from "../lib/embeddedMpv";

const info = { version: "20261101-914a11c30c", size: 29_021_126, license: "LGPL-2.1-or-later", source: "https://example.org", path: null };
const state = vi.hoisted(() => ({
  install: undefined as undefined | ((progress: (value: LibmpvProgress) => void) => Promise<string>),
}));

vi.mock("../lib/embeddedMpv", () => ({
  libmpvInfo: vi.fn(async () => info),
  installLibmpv: vi.fn((progress: (value: LibmpvProgress) => void) => state.install!(progress)),
  cancelLibmpvInstall: vi.fn(),
}));

import { cancelLibmpvInstall, installLibmpv } from "../lib/embeddedMpv";
import { LibmpvInstall } from "./LibmpvInstall";

describe("LibmpvInstall", () => {
  beforeEach(() => {
    vi.mocked(installLibmpv).mockClear();
    vi.mocked(cancelLibmpvInstall).mockClear();
  });
  afterEach(cleanup);

  it("offers the download with its size and shows the progress until it ends", async () => {
    let report!: (value: LibmpvProgress) => void;
    let finish!: (path: string) => void;
    state.install = (progress) => {
      report = progress;
      return new Promise((resolve) => (finish = resolve));
    };
    const done = vi.fn();
    render(<LibmpvInstall onDone={done} />);
    const button = await screen.findByRole("button", { name: /Descargar mpv \(29 MB\)/ });
    fireEvent.click(button);

    expect(await screen.findByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    act(() => report({ stage: "download", downloaded: 14_510_563, total: 29_021_126 }));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("Descargando mpv… 50 %")).toBeInTheDocument();
    act(() => report({ stage: "unpack", downloaded: 29_021_126, total: 29_021_126 }));
    expect(screen.getByText("Descomprimiendo mpv…")).toBeInTheDocument();
    // Cancelling is only possible while it downloads.
    expect(screen.queryByRole("button", { name: "Cancelar" })).not.toBeInTheDocument();

    act(() => finish("C:/Vela/libmpv/libmpv-2.dll"));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: /Descargar mpv/ })).toBeInTheDocument();
  });

  it("shows what failed and lets the user try again", async () => {
    state.install = () => Promise.reject(new Error("El archivo descargado no coincide con el esperado."));
    const done = vi.fn();
    render(<LibmpvInstall onDone={done} />);
    fireEvent.click(await screen.findByRole("button", { name: /Descargar mpv/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo obtener mpv. El archivo descargado no coincide con el esperado.");
    expect(done).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Descargar mpv/ })).toBeEnabled();
  });

  it("cancels while downloading without calling it an error", async () => {
    let fail!: (reason: Error) => void;
    state.install = () => new Promise((_, reject) => (fail = reject));
    render(<LibmpvInstall />);
    fireEvent.click(await screen.findByRole("button", { name: /Descargar mpv/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
    expect(cancelLibmpvInstall).toHaveBeenCalledTimes(1);
    act(() => fail(new Error("Descarga cancelada.")));
    await waitFor(() => expect(screen.getByRole("button", { name: /Descargar mpv/ })).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("carries on with playback in the player's error panel", async () => {
    state.install = async () => "C:/Vela/libmpv/libmpv-2.dll";
    const done = vi.fn();
    render(<LibmpvInstall play onDone={done} />);
    fireEvent.click(await screen.findByRole("button", { name: /Descargar mpv y reproducir \(29 MB\)/ }));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  });
});
