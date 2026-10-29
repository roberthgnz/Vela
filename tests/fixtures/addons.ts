import { readFile } from "node:fs/promises";

import { expect, test as base, type Page, type Route } from "@playwright/test";

const artwork = "https://art.vela.test";
export const addonUrl = "https://fixtures.vela.test/manifest.json";

export const films = [
  {
    id: "tt1160419",
    type: "movie",
    name: "Dune",
    poster: `${artwork}/dune-poster.svg`,
    background: `${artwork}/dune-background.svg`,
    description: "Paul Atreides viaja al planeta desértico Arrakis.",
    releaseInfo: "2021",
    runtime: "155 min",
    imdbRating: "8.0",
    genres: ["Sci-Fi", "Adventure"],
    cast: ["Timothée Chalamet", "Zendaya"],
    director: ["Denis Villeneuve"],
  },
  {
    id: "tt0816692",
    type: "movie",
    name: "Interstellar",
    poster: `${artwork}/interstellar-poster.svg`,
    background: `${artwork}/interstellar-background.svg`,
    description:
      "Una expedición cruza el espacio para encontrar un nuevo hogar.",
    releaseInfo: "2014",
    runtime: "169 min",
    imdbRating: "8.7",
    genres: ["Sci-Fi", "Drama"],
    cast: ["Matthew McConaughey", "Anne Hathaway"],
    director: ["Christopher Nolan"],
  },
];

const searchFilm = {
  id: "tt2543164",
  type: "movie",
  name: "Arrival",
  poster: `${artwork}/arrival-poster.svg`,
  background: `${artwork}/arrival-background.svg`,
  description: "Una lingüista descubre una nueva forma de entender el tiempo.",
  releaseInfo: "2016",
  runtime: "116 min",
  imdbRating: "7.9",
  genres: ["Sci-Fi", "Drama"],
};

const series = {
  id: "tt4574334",
  type: "series",
  name: "Stranger Things",
  poster: `${artwork}/stranger-things-poster.svg`,
  background: `${artwork}/stranger-things-background.svg`,
  description: "Un misterio altera la vida de un pequeño pueblo.",
  releaseInfo: "2016–2025",
  imdbRating: "8.6",
  genres: ["Drama", "Sci-Fi"],
  videos: [
    {
      id: "tt4574334:1:1",
      title: "La desaparición",
      season: 1,
      episode: 1,
      released: "2016-07-15T00:00:00Z",
    },
    {
      id: "tt4574334:1:2",
      title: "La chica de la calle Maple",
      season: 1,
      episode: 2,
      released: "2016-07-15T00:00:00Z",
    },
  ],
};

// Spanish subtitles in Windows-1252 (listed twice), English SRT and a file that is not a subtitle.
const subtitleFiles: Record<string, Buffer> = {
  "es.srt": Buffer.from(
    "1\r\n00:00:00,500 --> 00:00:04,000\r\nCanci\u00f3n de prueba\r\n\r\n2\r\n00:00:06,000 --> 00:00:09,000\r\nSegunda l\u00ednea\r\n",
    "latin1",
  ),
  "en.srt": Buffer.from("1\n00:00:00,500 --> 00:00:04,000\nTest song\n"),
  "broken.srt": Buffer.from("<html>Not found</html>"),
};
const fixtureSubtitles = [
  { id: "es", lang: "spa", url: "https://fixtures.vela.test/subs/es.srt" },
  { id: "es-copy", lang: "es", url: "https://fixtures.vela.test/subs/es.srt" },
  { id: "en", lang: "eng", url: "https://fixtures.vela.test/subs/en.srt" },
  { id: "broken", lang: "fre", url: "https://fixtures.vela.test/subs/broken.srt" },
];

const manifest = {
  id: "test.vela.cinema",
  name: "Vela Test Cinema",
  version: "1.0.0",
  description:
    "Catálogo y vídeo generado para comprobar la reproducción local.",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  catalogs: [
    {
      id: "fixture-films",
      name: "Cine de prueba",
      type: "movie",
      extra: [{ name: "search" }],
    },
    {
      id: "fixture-series",
      name: "Series de prueba",
      type: "series",
      extra: [{ name: "search" }],
    },
  ],
};

function posterSvg(name: string): string {
  const title = name.includes("interstellar")
    ? "INTERSTELLAR"
    : name.includes("arrival")
      ? "ARRIVAL"
      : name.includes("stranger")
        ? "STRANGER THINGS"
        : name.includes("dune")
          ? "DUNE"
          : "OPEN CINEMA";
  const hue =
    title === "DUNE"
      ? "#bc773c"
      : title === "ARRIVAL"
        ? "#719084"
        : title === "STRANGER THINGS"
          ? "#ae3b4d"
          : "#527d9b";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="1440" viewBox="0 0 960 1440"><defs><linearGradient id="g" x2=".9" y2="1"><stop stop-color="${hue}"/><stop offset="1" stop-color="#111924"/></linearGradient><radialGradient id="s"><stop stop-color="#f3dfaf" stop-opacity=".85"/><stop offset="1" stop-color="#f3dfaf" stop-opacity="0"/></radialGradient></defs><path fill="url(#g)" d="M0 0h960v1440H0z"/><circle cx="650" cy="370" r="320" fill="url(#s)"/><path fill="#17232c" opacity=".75" d="M0 980q290-260 550-70t410-170v700H0z"/><path fill="#0d141c" d="M0 1190q380-260 960-60v310H0z"/><text x="480" y="1190" text-anchor="middle" fill="#f7f1e4" font-family="Arial,sans-serif" font-size="${title.length > 14 ? 58 : 83}" letter-spacing="12">${title}</text><text x="480" y="1260" text-anchor="middle" fill="#e0d8c7" font-family="Arial,sans-serif" font-size="22" letter-spacing="8">VELA CINEMA</text></svg>`;
}

async function videoResponse(route: Route) {
  const body = await readFile(new URL("./playback.mp4", import.meta.url));
  const range = route
    .request()
    .headers()
    .range?.match(/^bytes=(\d+)-(\d*)$/);
  if (range) {
    const start = Number(range[1]);
    const end = Math.min(
      range[2] ? Number(range[2]) : body.length - 1,
      body.length - 1,
    );
    await route.fulfill({
      status: 206,
      contentType: "video/mp4",
      headers: {
        "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${body.length}`,
      },
      body: body.subarray(start, end + 1),
    });
  } else {
    await route.fulfill({
      contentType: "video/mp4",
      headers: { "accept-ranges": "bytes" },
      body,
    });
  }
}

async function mockAddons(page: Page, requests: URL[]) {
  await page.route(/\/fixture-media\.mp4(\?|$)/, videoResponse);
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (
      request.resourceType() === "image" &&
      !request.url().startsWith("http://127.0.0.1:1430/")
    ) {
      await route.fulfill({
        contentType: "image/svg+xml",
        body: posterSvg(request.url()),
      });
    } else await route.fallback();
  });
  await page.route("**/api/addon?**", async (route) => {
    const source = new URL(route.request().url()).searchParams.get("url");
    if (!source)
      return route.fulfill({
        status: 400,
        json: { error: "Missing addon URL" },
      });
    const url = new URL(source);
    requests.push(url);
    if (url.hostname === "invalid.vela.test") {
      return route.fulfill({
        json: { id: "broken", name: "Broken manifest", resources: "wrong" },
      });
    }
    if (
      url.hostname !== "fixtures.vela.test" &&
      url.hostname !== "v3-cinemeta.strem.io"
    ) {
      return route.fulfill({
        status: 503,
        json: { error: `Unmocked addon request: ${url.href}` },
      });
    }
    if (url.pathname.endsWith("/manifest.json"))
      return route.fulfill({ json: manifest });
    if (url.pathname.startsWith("/subs/")) {
      const file = subtitleFiles[url.pathname.slice("/subs/".length)];
      return file
        ? route.fulfill({ contentType: "application/octet-stream", body: file })
        : route.fulfill({ status: 404, json: { error: "Unknown subtitle" } });
    }
    const segments = url.pathname.split("/").filter(Boolean);
    const resource = decodeURIComponent(segments[0] ?? "");
    const type = decodeURIComponent(segments[1] ?? "");
    const id = decodeURIComponent(segments[2]?.replace(/\.json$/, "") ?? "");
    const extras = new URLSearchParams(
      segments[3]?.replace(/\.json$/, "") ?? "",
    );
    const available = type === "series" ? [series] : films;
    if (resource === "catalog") {
      const expectedId =
        url.hostname === "v3-cinemeta.strem.io"
          ? "top"
          : type === "movie"
            ? "fixture-films"
            : "fixture-series";
      if (!["movie", "series"].includes(type) || id !== expectedId) {
        return route.fulfill({
          status: 404,
          json: { error: "Unknown fixture catalog" },
        });
      }
      const search = extras.get("search")?.trim().toLowerCase();
      const catalog = search
        ? [...films, searchFilm, series].filter(
            (item) =>
              item.type === type && item.name.toLowerCase().includes(search),
          )
        : available;
      return route.fulfill({ json: { metas: catalog } });
    }
    if (resource === "meta") {
      const meta = [...films, searchFilm, series].find(
        (item) => item.id === id && item.type === type,
      );
      return meta
        ? route.fulfill({ json: { meta } })
        : route.fulfill({
            status: 404,
            json: { error: "Unknown fixture title" },
          });
    }
    if (resource === "stream") {
      const knownId =
        films.some((item) => item.id === id && item.type === type) ||
        (type === "series" && series.videos.some((item) => item.id === id));
      if (!knownId)
        return route.fulfill({
          status: 404,
          json: { error: "Unknown fixture video" },
        });
      return route.fulfill({
        json: {
          streams:
            url.hostname === "fixtures.vela.test"
              ? [
                  {
                    name: "Vídeo de prueba",
                    title: "MP4 local · 320 × 180",
                    url: "http://127.0.0.1:1430/fixture-media.mp4",
                    behaviorHints: { bingeGroup: "fixture-a" },
                    subtitles: fixtureSubtitles,
                  },
                  {
                    name: "Otra versión",
                    title: "MP4 local · grupo B",
                    url: "http://127.0.0.1:1430/fixture-media.mp4?b",
                    behaviorHints: { bingeGroup: "fixture-b" },
                  },
                ]
              : [],
        },
      });
    }
    if (resource === "subtitles")
      return route.fulfill({ json: { subtitles: [] } });
    return route.fulfill({
      status: 404,
      json: { error: "Unsupported fixture resource" },
    });
  });
}

export const test = base.extend<{ addonRequests: URL[] }>({
  addonRequests: [
    async ({ page }, use) => {
      const requests: URL[] = [];
      await mockAddons(page, requests);
      await use(requests);
    },
    { auto: true },
  ],
});

export { expect };

export async function openDune(page: Page) {
  await page
    .getByRole("button", { name: "Ver Dune", exact: true })
    .first()
    .click();
  const detail = page.getByRole("region", { name: "Dune", exact: true });
  await expect(detail).toBeVisible();
  return detail;
}

export async function installFixtureAddon(page: Page) {
  await page.getByRole("button", { name: "Addons", exact: true }).click();
  await page.getByRole("button", { name: "Añadir addon", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "URL del addon", exact: true })
    .fill(addonUrl);
  await dialog
    .getByRole("button", { name: "Instalar addon", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Vela Test Cinema", exact: true }),
  ).toBeVisible();
}
