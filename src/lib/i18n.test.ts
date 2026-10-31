import { describe, expect, it } from "vitest";
import { en } from "../locales/en";
import { es } from "../locales/es";
import { initialSetting, interpolate, locale, plural, resolveLocale, t, translate } from "./i18n";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("dictionaries", () => {
  it("have the same keys", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(es).sort());
  });

  it("use the same placeholders in both languages", () => {
    const mismatched = Object.keys(es).filter((key) => {
      const k = key as keyof typeof es;
      return placeholders(es[k]).join() !== placeholders(en[k]).join();
    });
    expect(mismatched).toEqual([]);
  });

  it("have no empty messages", () => {
    expect(Object.entries(es).filter(([, text]) => !text.trim())).toEqual([]);
    expect(Object.entries(en).filter(([, text]) => !text.trim())).toEqual([]);
  });
});

describe("i18n", () => {
  it("resolves the language from the setting and the system", () => {
    expect(resolveLocale("es", "en-US")).toBe("es");
    expect(resolveLocale("en", "es-ES")).toBe("en");
    expect(resolveLocale("system", "es-MX")).toBe("es");
    expect(resolveLocale(null, "es")).toBe("es");
    expect(resolveLocale("system", "fr-FR")).toBe("en");
    expect(resolveLocale(undefined, undefined)).toBe("en");
  });

  it("runs the tests in Spanish", () => {
    expect(locale()).toBe("es");
    expect(t("nav.library")).toBe("Biblioteca");
    expect(translate("en", "nav.library")).toBe("Library");
  });

  it("interpolates and leaves unknown placeholders visible", () => {
    expect(interpolate("{a} y {b}", { a: 1, b: "dos" })).toBe("1 y dos");
    expect(interpolate("Hola {name}", {})).toBe("Hola {name}");
    expect(interpolate("Hola {name}", { other: "x" })).toBe("Hola {name}");
    expect(interpolate("{name} {name}", { name: "Vela" })).toBe("Vela Vela");
    expect(interpolate("Sin datos")).toBe("Sin datos");
  });

  it("picks the plural form by count", () => {
    const one = "settings.storage.backupCount.one";
    const other = "settings.storage.backupCount.other";
    expect(plural(1, one, other, { last: "hoy" })).toBe(interpolate(es[one], { count: 1, last: "hoy" }));
    expect(plural(1, one, other, { last: "hoy" })).toMatch(/^1 copia /);
    expect(plural(3, one, other, { last: "hoy" })).toMatch(/^3 copias /);
    expect(plural(0, one, other, { last: "hoy" })).toMatch(/^0 copias /);
    expect(plural(2, one, other)).toContain("{last}");
  });

  it("pairs every singular message with a plural one", () => {
    const keys = new Set(Object.keys(es));
    const unpaired = [...keys].filter(
      (key) => (key.endsWith(".one") && !keys.has(key.replace(/\.one$/, ".other"))) || (key.endsWith(".other") && !keys.has(key.replace(/\.other$/, ".one"))),
    );
    expect(unpaired).toEqual([]);
  });
});

describe("initialSetting", () => {
  it("keeps a saved choice", () => {
    expect(initialSetting("en", true)).toBe("en");
    expect(initialSetting("system", true)).toBe("system");
    expect(initialSetting("es", false)).toBe("es");
  });
  it("keeps Spanish for installations from before 1.0 and follows the system on new ones", () => {
    expect(initialSetting(null, true)).toBe("es");
    // Once saved, «system» stays even when the installation has data.
    expect(initialSetting("system", true)).toBe("system");
    expect(initialSetting(null, false)).toBe("system");
    expect(initialSetting("garbage", false)).toBe("system");
  });
});
