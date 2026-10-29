import {
  test,
  expect,
  addonUrl,
  installFixtureAddon,
  openDune,
} from "./fixtures/addons";

test("saved films and metadata survive a full reload", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Ver Dune", exact: true }).first(),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("desktop-discover.png"),
    fullPage: false,
  });
  const detail = await openDune(page);
  await page.screenshot({
    path: testInfo.outputPath("desktop-details.png"),
    fullPage: false,
  });
  await detail
    .getByRole("button", { name: "Guardar en mi biblioteca", exact: true })
    .click();
  await expect(
    detail.getByRole("button", {
      name: "Quitar de mi biblioteca",
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Mi biblioteca", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Ver Dune", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Mi biblioteca", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Ver Dune", exact: true }),
  ).toBeVisible();
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("vela.preferences.v1") ?? "{}"),
  );
  expect(
    Object.values(saved.library).some(
      (entry: any) =>
        entry.meta.id === "tt1160419" && entry.meta.name === "Dune",
    ),
  ).toBe(true);
  const restoredDetail = await openDune(page);
  await expect(
    restoredDetail.getByRole("button", {
      name: "Quitar de mi biblioteca",
      exact: true,
    }),
  ).toBeVisible();
});

test("search requests the actual query and shows a result outside the initial catalog", async ({
  page,
  addonRequests,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Ver Dune", exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ver Arrival", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Buscar", exact: true }).click();
  const search = page.getByRole("searchbox", {
    name: "Buscar películas y series",
    exact: true,
  });
  await search.fill("Arrival");
  await expect(
    page.getByRole("button", { name: "Ver Arrival", exact: true }),
  ).toBeVisible();
  expect(
    addonRequests.some((url) =>
      decodeURIComponent(url.pathname).includes("/search=Arrival.json"),
    ),
  ).toBe(true);
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Ver Dune", exact: true }),
  ).toHaveCount(0);
  await search.fill("not-a-real-film-7282");
  await expect(dialog.getByRole("button", { name: /^Ver / })).toHaveCount(0);
  await expect(
    dialog.getByText(/sin resultados|no encontramos|no hay resultados/i),
  ).toBeVisible();
});

test("addon installation is persisted, can be disabled and removed, and reports malformed manifests", async ({
  page,
}) => {
  await page.goto("/");
  await installFixtureAddon(page);
  let stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("vela.preferences.v1") ?? "{}"),
  );
  expect(
    stored.addons.some(
      (item: any) => item.manifestUrl === addonUrl && item.enabled,
    ),
  ).toBe(true);
  const card = page
    .getByRole("heading", { name: "Vela Test Cinema", exact: true })
    .locator("..");
  await card.getByRole("switch", { name: /desactivar/i }).click();
  stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("vela.preferences.v1") ?? "{}"),
  );
  expect(
    stored.addons.find((item: any) => item.manifestUrl === addonUrl).enabled,
  ).toBe(false);
  await page.reload();
  await page.getByRole("button", { name: "Addons", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Vela Test Cinema", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("heading", { name: "Vela Test Cinema", exact: true })
    .locator("..")
    .getByRole("button", { name: /eliminar/i })
    .click();
  await page
    .getByRole("dialog", { name: "Eliminar Vela Test Cinema", exact: true })
    .getByRole("button", { name: "Eliminar addon", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Vela Test Cinema", exact: true }),
  ).toHaveCount(0);
  stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("vela.preferences.v1") ?? "{}"),
  );
  expect(stored.addons.some((item: any) => item.manifestUrl === addonUrl)).toBe(
    false,
  );

  await page.getByRole("button", { name: "Añadir addon", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "URL del addon", exact: true })
    .fill("https://invalid.vela.test/manifest.json");
  await dialog
    .getByRole("button", { name: "Instalar addon", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog).toBeVisible();
  stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("vela.preferences.v1") ?? "{}"),
  );
  expect(
    stored.addons.some((item: any) =>
      item.manifestUrl.includes("invalid.vela.test"),
    ),
  ).toBe(false);
});

test("a title without streaming sources explains how to continue", async ({
  page,
}) => {
  await page.goto("/");
  const detail = await openDune(page);
  await detail
    .getByRole("button", { name: "Ver fuentes", exact: true })
    .click();
  await expect(
    detail.getByText(/no hay fuentes|sin fuentes|no encontramos fuentes/i),
  ).toBeVisible();
  await expect(detail.getByText(/addon/i).last()).toBeVisible();
});

test("series show their real episode metadata and season selector", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Series", exact: true }).click();
  await page
    .getByRole("button", { name: "Ver Stranger Things", exact: true })
    .first()
    .click();
  const detail = page.getByRole("dialog", {
    name: "Stranger Things",
    exact: true,
  });
  await expect(detail).toBeVisible();
  await expect(
    detail.getByRole("combobox", { name: "Temporada", exact: true }),
  ).toHaveValue("1");
  await expect(
    detail.getByRole("button", { name: /La desaparición/ }),
  ).toBeVisible();
  await detail
    .getByRole("button", { name: /La chica de la calle Maple/ })
    .click();
  await expect(
    detail.getByText(/no hay fuentes|sin fuentes|no encontramos fuentes/i),
  ).toBeVisible();
});

test("keyboard search restores focus and the mobile layout stays within its viewport", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Ver Dune", exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Buscar", exact: true }).focus();
  await page.keyboard.press("Control+k");
  const search = page.getByRole("searchbox", {
    name: "Buscar películas y series",
    exact: true,
  });
  await expect(search).toBeFocused();
  await search.fill("Dune");
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Ver Dune", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Buscar", exact: true }),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("mobile-discover.png"),
    fullPage: false,
  });
  await page
    .getByRole("button", { name: "Mi biblioteca", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("a direct stream loads real video and saves actual playback progress", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await installFixtureAddon(page);
  await page.getByRole("button", { name: "Películas", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Catálogo", exact: true })
    .selectOption({ label: "Vela Test Cinema · Cine de prueba" });
  const detail = await openDune(page);
  await detail
    .getByRole("button", { name: "Ver fuentes", exact: true })
    .click();
  await detail
    .getByRole("button", { name: /^Reproducir/ })
    .first()
    .click();
  const video = page.locator("video");
  await expect(video).toBeVisible();
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.readyState),
    )
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(0.5);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const preferences = JSON.parse(
          localStorage.getItem("vela.preferences.v1") ?? "{}",
        );
        return Math.max(
          0,
          ...Object.values(preferences.library ?? {}).map(
            (entry: any) => entry.progress?.seconds ?? 0,
          ),
        );
      }),
    )
    .toBeGreaterThan(0);
  await page.screenshot({
    path: testInfo.outputPath("desktop-playback.png"),
    fullPage: true,
  });
});
