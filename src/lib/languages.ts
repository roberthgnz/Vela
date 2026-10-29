/**
 * Language codes as they appear in addons (ISO 639-1, 639-2/B, 639-2/T, OpenSubtitles' `pob`),
 * in media files (Matroska tags, HLS `LANGUAGE`) and in Vela's preferences (ISO 639-2/T).
 */

const twoLetter: Record<string, string> = {
  ar: "ara", bg: "bul", ca: "cat", cs: "ces", da: "dan", de: "deu", el: "ell", en: "eng", es: "spa", et: "est",
  eu: "eus", fa: "fas", fi: "fin", fr: "fra", gl: "glg", he: "heb", hi: "hin", hr: "hrv", hu: "hun", id: "ind",
  is: "isl", it: "ita", ja: "jpn", ko: "kor", lt: "lit", lv: "lav", ms: "msa", nb: "nob", nl: "nld", no: "nor",
  pl: "pol", pt: "por", ro: "ron", ru: "rus", sk: "slk", sl: "slv", sq: "sqi", sr: "srp", sv: "swe", th: "tha",
  tr: "tur", uk: "ukr", vi: "vie", zh: "zho",
};

/** Bibliographic ISO 639-2 codes and OpenSubtitles extensions mapped to the terminology codes. */
const variants: Record<string, string> = {
  fre: "fra", ger: "deu", dut: "nld", chi: "zho", cze: "ces", gre: "ell", per: "fas", rum: "ron", slo: "slk",
  alb: "sqi", arm: "hye", baq: "eus", bur: "mya", geo: "kat", ice: "isl", mac: "mkd", may: "msa", wel: "cym",
  pob: "por", pb: "por", spl: "spa", scc: "srp", nor: "nob", ze: "zho",
};

/** English names some addons and files use instead of codes. */
const names: Record<string, string> = {
  english: "eng", spanish: "spa", espanol: "spa", español: "spa", castellano: "spa", latino: "spa", french: "fra",
  german: "deu", italian: "ita", portuguese: "por", "portuguese (brazil)": "por", "brazilian portuguese": "por",
  russian: "rus", japanese: "jpn", korean: "kor", chinese: "zho", dutch: "nld", polish: "pol", turkish: "tur",
  arabic: "ara", swedish: "swe", danish: "dan", finnish: "fin", norwegian: "nob", czech: "ces", greek: "ell",
  hungarian: "hun", romanian: "ron", hebrew: "heb", catalan: "cat", basque: "eus", galician: "glg",
  ukrainian: "ukr", vietnamese: "vie", thai: "tha", indonesian: "ind", hindi: "hin", croatian: "hrv",
  serbian: "srp", bulgarian: "bul", slovak: "slk", slovenian: "slv",
};

/** Canonical three-letter code, or the lowercased input when it is not a known language. */
export function normalizeLanguage(value: string | null | undefined): string {
  if (!value) return "";
  const raw = value.trim().toLowerCase().replace(/_/g, "-");
  if (names[raw]) return names[raw];
  const base = raw.split("-")[0];
  if (variants[raw]) return variants[raw];
  if (variants[base]) return variants[base];
  if (base.length === 2 && twoLetter[base]) return twoLetter[base];
  if (/^[a-z]{3}$/.test(base)) return base;
  return raw;
}

export function sameLanguage(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeLanguage(a);
  return Boolean(left) && left === normalizeLanguage(b);
}

const displayNames = (() => {
  try {
    return new Intl.DisplayNames(["es"], { type: "language" });
  } catch {
    return undefined;
  }
})();

const toBcp47: Record<string, string> = Object.fromEntries(
  Object.entries(twoLetter).map(([short, long]) => [long, short]),
);

/** Human name in Spanish ("Inglés", "Portugués (Brasil)"); unknown codes are returned as given. */
export function languageLabel(code: string): string {
  const raw = code.trim();
  if (!raw) return "Desconocido";
  const lower = raw.toLowerCase();
  if (lower === "pob" || lower === "pt-br") return "Portugués (Brasil)";
  if (lower === "und" || lower === "unk") return "Idioma no indicado";
  const normalized = normalizeLanguage(raw);
  const candidate = toBcp47[normalized] ?? normalized;
  if (!/^[a-z]{2,3}$/.test(candidate)) return raw;
  try {
    const name = displayNames?.of(candidate);
    if (name && name.toLowerCase() !== candidate.toLowerCase())
      return name.charAt(0).toLocaleUpperCase("es") + name.slice(1);
  } catch {
    /* Unknown codes are shown as provided by the addon. */
  }
  return raw;
}

/** Languages offered in Settings, by ISO 639-2/T code. */
export const preferredLanguageOptions = [
  "spa", "eng", "fra", "deu", "ita", "por", "cat", "eus", "glg", "nld", "pol", "rus", "ukr", "tur", "ara", "heb",
  "hin", "jpn", "kor", "zho", "swe", "dan", "nob", "fin", "ces", "hun", "ron", "ell", "bul", "hrv", "srp",
];

/** Picks the first item in the primary language, then the secondary one. */
export function pickByLanguage<T>(
  items: T[],
  language: (item: T) => string | undefined,
  primary: string,
  secondary: string,
): T | undefined {
  for (const wanted of [primary, secondary]) {
    if (!wanted) continue;
    const match = items.find((item) => sameLanguage(language(item), wanted));
    if (match) return match;
  }
  return undefined;
}
