// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddonHealth } from "../lib/addonHealth";
import type { InstalledAddon } from "../lib/contracts";

const state = vi.hoisted(() => ({ health: { status: "unchecked" } as AddonHealth }));
vi.mock("../lib/addonHealth", () => ({ useAddonHealth: () => state.health, addonHealth: { check: vi.fn(async () => {}) } }));

import { addonHealth } from "../lib/addonHealth";
import { AddonHealthStatus } from "./AddonsView";

const addon: InstalledAddon = {
  manifestUrl: "https://addon.example.test/private-config/manifest.json", enabled: true, installedAt: 1,
  manifest: { id: "addon.test", name: "Test addon", version: "1.0.0", resources: ["stream"], types: ["movie"], catalogs: [] },
};

describe("addon health controls", () => {
  beforeEach(() => { vi.clearAllMocks(); state.health = { status: "unchecked" }; });
  afterEach(cleanup);

  it("offers a named manual check for an unchecked installed addon", () => {
    render(<AddonHealthStatus addon={addon} />);
    expect(screen.getByRole("status")).toHaveTextContent("Manifiesto sin comprobar");
    fireEvent.click(screen.getByRole("button", { name: "Comprobar · Test addon" }));
    expect(addonHealth.check).toHaveBeenCalledWith(addon);
  });

  it("disables duplicate checks while showing progress", () => {
    state.health = { status: "checking" };
    render(<AddonHealthStatus addon={addon} />);
    expect(screen.getByRole("status")).toHaveTextContent("Comprobando manifiesto");
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it.each(["unavailable", "changed"] as const)("offers retry for %s without displaying private addresses", (status) => {
    state.health = { status, checkedAt: 1_793_534_400_000 };
    const { container } = render(<AddonHealthStatus addon={addon} />);
    expect(screen.getByRole("status")).toHaveTextContent("Última comprobación:");
    expect(screen.getByRole("button", { name: "Volver a comprobar · Test addon" })).toBeEnabled();
    expect(container).not.toHaveTextContent("private-config");
    expect(container).not.toHaveTextContent("https:");
  });

  it("does not offer a network action for local addons", () => {
    state.health = { status: "local" };
    render(<AddonHealthStatus addon={addon} />);
    expect(screen.getByRole("status")).toHaveTextContent("incluido en Vela");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
