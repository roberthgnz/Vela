import { test, expect, installFixtureAddon, openDune } from "./fixtures/addons";
import type { Page } from "@playwright/test";

async function playDune(page: Page) {
  await page.goto("/");
  await installFixtureAddon(page);
  await page.getByRole("button", { name: "Películas", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Catálogo", exact: true })
    .selectOption({ label: "Vela Test Cinema · Cine de prueba" });
  const detail = await openDune(page);
  await detail.getByRole("button", { name: /^Reproducir Vídeo de prueba/ }).click();
  const video = page.locator("video");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
  return video;
}

async function cueAt(page: Page, time: number) {
  await page.locator("video").evaluate((element: HTMLVideoElement, at) => {
    element.pause();
    element.currentTime = at;
  }, time);
  await page.waitForTimeout(250);
  const overlay = page.locator(".player-subtitles");
  return (await overlay.count()) ? (await overlay.innerText()).trim() : "";
}

test("the subtitle panel groups languages, picks the first file of one and shifts cues", async ({ page }) => {
  await playDune(page);
  await page.getByRole("button", { name: "Audio y subtítulos" }).click();
  const panel = page.getByRole("dialog", { name: "Audio y subtítulos" });
  const languages = panel.getByRole("radiogroup", { name: "Idioma de los subtítulos" });
  // The duplicated Spanish file is listed once; the language button selects it directly.
  await expect(languages.getByRole("radio")).toHaveText(["Desactivados", "Español", "Inglés", "Francés"]);
  await languages.getByRole("radio", { name: "Español" }).click();
  await expect(languages.getByRole("radio", { name: "Español" })).toHaveAttribute("aria-checked", "true");
  // Windows-1252 is decoded.
  await expect.poll(() => cueAt(page, 1)).toBe("Canción de prueba");
  expect(await cueAt(page, 5)).toBe("");
  // H delays subtitles by 0.1 s per press.
  await page.locator(".player").focus();
  for (let index = 0; index < 20; index++) await page.keyboard.press("h");
  await expect(panel.locator(".track-delay output")).toHaveText("+2,0 s");
  expect(await cueAt(page, 1)).toBe("");
  expect(await cueAt(page, 2.7)).toBe("Canción de prueba");
  // A file that is not a subtitle reports a clear error and leaves subtitles off.
  await languages.getByRole("radio", { name: "Francés" }).click();
  await expect(page.getByRole("status").filter({ hasText: "formato de subtítulos reconocible" })).toBeVisible();
  await expect(languages.getByRole("radio", { name: "Desactivados" })).toHaveAttribute("aria-checked", "true");
});

test("subtitle style preferences apply to the player and persist", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+,");
  await page.getByRole("radiogroup", { name: "Tamaño de los subtítulos" }).getByRole("radio", { name: "150 %" }).click();
  await page.getByRole("radiogroup", { name: "Opacidad del fondo" }).getByRole("radio", { name: "Sin fondo" }).click();
  await page.getByRole("switch", { name: "Activar subtítulos automáticamente" }).click();
  await page.reload();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("vela.preferences.v2") ?? "{}").player);
  expect(stored).toMatchObject({ subtitleSize: 150, subtitleBackground: 0, subtitlesAuto: true });
  await playDune(page);
  // Automatic selection uses the preferred language (Spanish by default).
  await expect.poll(() => cueAt(page, 1)).toBe("Canción de prueba");
  const style = await page.locator(".player-subtitles").evaluate((element) => ({
    scale: (element as HTMLElement).style.getPropertyValue("--subtitle-scale"),
    background: (element as HTMLElement).style.getPropertyValue("--subtitle-background"),
  }));
  expect(style).toEqual({ scale: "1.5", background: "0" });
});

test("the next episode keeps the same release and series progress continues", async ({ page }) => {
  await page.goto("/");
  await installFixtureAddon(page);
  await page.getByRole("button", { name: "Series", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Catálogo", exact: true })
    .selectOption({ label: "Vela Test Cinema · Series de prueba" });
  await page.getByRole("button", { name: "Ver Stranger Things", exact: true }).click();
  const detail = page.getByRole("region", { name: "Stranger Things", exact: true });
  await detail.getByRole("button", { name: /^1\. La desaparición/ }).click();
  // Group B is chosen for the first episode.
  await detail.getByRole("button", { name: /^Reproducir Otra versión/ }).click();
  const video = page.locator("video");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
  await video.evaluate((element: HTMLVideoElement) => {
    element.currentTime = element.duration - 0.5;
    void element.play();
  });
  const card = page.getByRole("region", { name: "Siguiente episodio" });
  await expect(card).toContainText("T1 · E2 · La chica de la calle Maple");
  await expect(card).toContainText(/Siguiente episodio en \d+ s/);
  await card.getByRole("button", { name: "Ver ahora" }).click();
  await expect(page.locator(".player-title")).toContainText("T1 · E2");
  await expect.poll(() => page.locator("video").evaluate((element: HTMLVideoElement) => element.currentSrc)).toContain("fixture-media.mp4?b");
  await expect.poll(() => page.locator("video").evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
  await page.locator("video").evaluate((element: HTMLVideoElement) => {
    element.currentTime = 6;
  });
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  // Back on the series: the second episode is the one shown, the first is watched.
  await expect(detail.getByText("T1 · E2 · La chica de la calle Maple")).toBeVisible();
  await detail.getByRole("button", { name: "Volver a episodios" }).click();
  await expect(detail.getByRole("button", { name: /^1\. La desaparición, visto/ })).toBeVisible();
  await expect(detail.getByRole("button", { name: /Continuar/ })).toContainText("T1 · E2");
  await page.getByRole("button", { name: "Inicio", exact: true }).click();
  await expect(page.getByRole("button", { name: "Continuar Stranger Things" })).toContainText("T1 · E2");
  // Watched titles outside the library are not listed in it.
  await page.getByRole("button", { name: "Biblioteca", exact: true }).click();
  await expect(page.getByRole("tab", { name: /Todo/ })).toContainText("0");
  await expect(page.getByRole("tab", { name: /Seguir viendo/ })).toContainText("1");
});

test("going back restores the catalog, the focused card and the chosen season", async ({ page }) => {
  await page.goto("/");
  await installFixtureAddon(page);
  await page.getByRole("button", { name: "Películas", exact: true }).click();
  const catalog = page.getByRole("combobox", { name: "Catálogo", exact: true });
  await catalog.selectOption({ label: "Vela Test Cinema · Cine de prueba" });
  const card = page.getByRole("button", { name: "Ver Dune", exact: true });
  await card.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Dune", exact: true })).toBeVisible();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(catalog).toHaveValue(/Vela Test Cinema|fixture/i);
  await expect(page.locator("select[aria-label=Catálogo] option:checked")).toHaveText("Vela Test Cinema · Cine de prueba");
  await expect(card).toBeFocused();
  // Episode lists keep the season and selected episode in the history entry.
  await page.getByRole("button", { name: "Series", exact: true }).click();
  await page.getByRole("button", { name: "Ver Stranger Things", exact: true }).first().click();
  const detail = page.getByRole("region", { name: "Stranger Things", exact: true });
  await detail.getByRole("button", { name: /^2\. La chica de la calle Maple/ }).click();
  await page.getByRole("button", { name: "Biblioteca", exact: true }).click();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(detail.getByText("T1 · E2 · La chica de la calle Maple")).toBeVisible();
});

test("episodes can be marked as watched from their context menu", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Series", exact: true }).click();
  await page.getByRole("button", { name: "Ver Stranger Things", exact: true }).first().click();
  const detail = page.getByRole("region", { name: "Stranger Things", exact: true });
  const second = detail.getByRole("button", { name: /^2\. La chica de la calle Maple/ });
  await second.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Marcar como vistos hasta aquí" }).click();
  await expect(detail.getByRole("button", { name: /^1\. La desaparición, visto/ })).toBeVisible();
  await expect(detail.getByRole("button", { name: /^2\. La chica de la calle Maple, visto/ })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Series", exact: true }).click();
  await page.getByRole("button", { name: "Ver Stranger Things", exact: true }).first().click();
  await expect(page.getByRole("button", { name: /^2\. La chica de la calle Maple, visto/ })).toBeVisible();
  await page.getByRole("button", { name: /^2\. La chica de la calle Maple, visto/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Marcar como no visto" }).click();
  await expect(page.getByRole("button", { name: /^2\. La chica de la calle Maple$/ })).toBeVisible();
});
