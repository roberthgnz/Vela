// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { languageLabel, normalizeLanguage } from "../../lib/languages";
import { defaultPlayer } from "../../lib/store";
import { SpeedPanel, TrackPanel } from "./panels";
import type { Track } from "./shared";

afterEach(cleanup);

const es = normalizeLanguage("spa");
const en = normalizeLanguage("eng");
const fr = normalizeLanguage("fra");

function subtitle(key: string, lang: string, label = languageLabel(lang), extra: Partial<Track> = {}): Track {
  return { key, label, lang, origin: "file", index: 0, subtitle: { id: key, lang, url: `http://subs.test/${key}` }, ...extra };
}

const subtitles = [
  subtitle("ext:fr", fr),
  subtitle("ext:es1", es),
  subtitle("ext:es2", es, `${languageLabel(es)} 2`, { detail: "Torrent" }),
  subtitle("ext:en", en),
  subtitle("ext:und", ""),
];

function renderPanel(overrides: Partial<Parameters<typeof TrackPanel>[0]> = {}) {
  const props = {
    right: 12,
    audio: [] as Track[],
    audioKey: "",
    subtitles,
    subtitleKey: "",
    preferred: ["spa", "eng"],
    delay: 0,
    cues: [],
    time: 10,
    onAudio: vi.fn(),
    onSubtitle: vi.fn(),
    onDelay: vi.fn(),
    look: defaultPlayer,
    onLook: vi.fn(),
    ...overrides,
  };
  render(<TrackPanel {...props} />);
  return props;
}

describe("TrackPanel", () => {
  it("lists the preferred languages first, then the rest alphabetically, with «Desactivados» checked", () => {
    renderPanel();
    const group = screen.getByRole("radiogroup", { name: "Idioma de los subtítulos" });
    const options = within(group).getAllByRole("radio");
    expect(options.map((option) => option.textContent)).toEqual([
      "Desactivados",
      `${languageLabel(es)}2`,
      languageLabel(en),
      languageLabel(fr),
      "Idioma no indicado",
    ]);
    expect(options[0]).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: new RegExp(languageLabel(es)) })).toHaveAttribute("aria-checked", "false");
  });

  it("chooses the first subtitle of a language, and none for «Desactivados»", () => {
    const props = renderPanel();
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(`^${languageLabel(es)}`) }));
    expect(props.onSubtitle).toHaveBeenCalledWith(subtitles[1]);
    fireEvent.click(screen.getByRole("radio", { name: "Desactivados" }));
    expect(props.onSubtitle).toHaveBeenCalledWith(null);
  });

  it("offers the other versions of the chosen language and enables the delay controls", () => {
    const props = renderPanel({ subtitleKey: "ext:es1" });
    const versions = screen.getByRole("radiogroup", { name: "Versión de los subtítulos" });
    const options = within(versions).getAllByRole("radio");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute("aria-checked", "true");
    expect(options[1].textContent).toContain("Torrent");
    fireEvent.click(options[1]);
    expect(props.onSubtitle).toHaveBeenCalledWith(subtitles[2]);
    fireEvent.click(screen.getByRole("button", { name: "Retrasar subtítulos 0,1 s" }));
    expect(props.onDelay).toHaveBeenCalledWith(0.1);
  });

  it("disables the delay and the sync without a chosen subtitle", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: "Retrasar subtítulos 0,1 s" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sincronizar con una frase" })).toBeDisabled();
    expect(screen.queryByRole("radiogroup", { name: "Versión de los subtítulos" })).toBeNull();
  });

  it("shows the audio tracks only when there is a choice", () => {
    const one: Track = { key: "native:0", label: "Español", lang: es, origin: "native", index: 0 };
    const two: Track = { key: "native:1", label: "Inglés", lang: en, origin: "native", index: 1 };
    const props = renderPanel({ audio: [one, two], audioKey: "native:0" });
    const group = screen.getByRole("radiogroup", { name: "Pista de audio" });
    fireEvent.click(within(group).getByRole("radio", { name: "Inglés" }));
    expect(props.onAudio).toHaveBeenCalledWith(two);
    cleanup();
    renderPanel({ audio: [one], audioKey: "native:0" });
    expect(screen.queryByRole("radiogroup", { name: "Pista de audio" })).toBeNull();
  });

  it("steps the subtitle size through the presets and changes colour and background", () => {
    const props = renderPanel({ look: { ...defaultPlayer, subtitleSize: 110 } });
    fireEvent.click(screen.getByRole("button", { name: "Subtítulos más grandes" }));
    expect(props.onLook).toHaveBeenCalledWith({ subtitleSize: 125 });
    fireEvent.click(screen.getByRole("button", { name: "Subtítulos más pequeños" }));
    expect(props.onLook).toHaveBeenCalledWith({ subtitleSize: 100 });
    fireEvent.click(screen.getByRole("button", { name: "100 %" }));
    expect(props.onLook).toHaveBeenCalledWith({ subtitleBackground: 1 });
  });
});

describe("SpeedPanel", () => {
  it("selects a speed and sets the intro and credits marks from the current position", () => {
    const onChange = vi.fn();
    const marks = { value: undefined, time: 65.4, duration: 1400, fromChapters: [] as ("intro" | "credits")[], onChange: vi.fn() };
    render(<SpeedPanel right={12} rate={1} onChange={onChange} marks={marks} />);
    expect(screen.getByRole("radio", { name: "Normal" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "1.5×" }));
    expect(onChange).toHaveBeenCalledWith(1.5);
    fireEvent.click(screen.getByRole("button", { name: "Empieza aquí" }));
    expect(marks.onChange).toHaveBeenCalledWith({ intro: { start: 65, end: 155 } });
    fireEvent.click(screen.getByRole("button", { name: "Empiezan aquí" }));
    expect(marks.onChange).toHaveBeenCalledWith({ creditsFromEnd: 1335 });
    expect(screen.getByRole("button", { name: "Borrar" })).toBeDisabled();
  });
});
