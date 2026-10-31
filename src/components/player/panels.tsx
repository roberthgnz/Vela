import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { PlayerPreferences } from "../../lib/contracts";
import { formatNumber, locale, t } from "../../lib/i18n";
import { languageLabel, normalizeLanguage } from "../../lib/languages";
import type { SeriesMarks } from "../../lib/skipSegments";
import { subtitleColors, subtitleSizes } from "../../lib/store";
import { activeCues, syncCandidates, syncDelay, type Cue } from "../../lib/subtitles";
import { clock } from "../../lib/utils";
import { speeds, type Track } from "./shared";

function Option({
  checked,
  label,
  detail,
  title,
  onSelect,
}: {
  checked: boolean;
  label: string;
  detail?: string;
  title?: string;
  onSelect: () => void;
}) {
  return (
    <button role="radio" aria-checked={checked} className="track-option" title={title} onClick={onSelect}>
      <span>{label}</span>
      {detail && <small>{detail}</small>}
    </button>
  );
}

export type MarksControl = {
  value: SeriesMarks | undefined;
  time: number;
  duration: number;
  /** Kinds the file's chapters already provide (those take precedence over the marks). */
  fromChapters: ("intro" | "credits")[];
  onChange: (value: SeriesMarks) => void;
};

/** Speed choices and, for series, the intro and credits marks shared by all episodes. */
export function SpeedPanel({
  right,
  rate,
  onChange,
  marks,
}: {
  right: number;
  rate: number;
  onChange: (value: number) => void;
  marks?: MarksControl;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[aria-checked=true]")?.focus();
  }, []);
  return (
    <div
      className={`player-popover speed-panel ${marks ? "with-marks" : ""}`}
      role="dialog"
      aria-label={marks ? t("player.speedAndMarks") : t("player.speed")}
      ref={ref}
      style={{ right }}
    >
      <section>
        <h3>{t("player.speed")}</h3>
        <div role="radiogroup" aria-label={t("player.playbackSpeed")}>
          {speeds.map((value) => (
            <Option key={value} checked={rate === value} label={value === 1 ? t("player.speedNormal") : `${value}×`} onSelect={() => onChange(value)} />
          ))}
        </div>
      </section>
      {marks && <MarksSection {...marks} />}
    </div>
  );
}

/** Intro start and end, and where the credits begin, set from the current position. */
export function MarksSection({ value, time, duration, fromChapters, onChange }: MarksControl) {
  const intro = value?.intro;
  const now = Math.round(time);
  const setStart = () => onChange({ ...value, intro: { start: now, end: intro && intro.end > now ? intro.end : now + 90 } });
  const setEnd = () => onChange({ ...value, intro: { start: intro && intro.start < now ? intro.start : Math.max(0, now - 90), end: now } });
  const setCredits = () => duration > now && onChange({ ...value, creditsFromEnd: Math.round(duration - now) });
  return (
    <section className="skip-marks">
      <h3>{t("player.marks.title")}</h3>
      <p className="skip-marks-value">
        {t("player.marks.intro", { value: intro ? `${clock(intro.start)} – ${clock(intro.end)}` : t("player.marks.unset") })}
        {fromChapters.includes("intro") && ` ${t("player.marks.usesChapters")}`}
      </p>
      <div className="skip-marks-actions">
        <button className="button small subtle" onClick={setStart}>{t("player.marks.introStart")}</button>
        <button className="button small subtle" onClick={setEnd}>{t("player.marks.introEnd")}</button>
      </div>
      <p className="skip-marks-value">
        {t("player.marks.credits", { value: value?.creditsFromEnd ? t("player.marks.lastPart", { time: clock(value.creditsFromEnd) }) : t("player.marks.unset") })}
        {fromChapters.includes("credits") && ` ${t("player.marks.usesChapters")}`}
      </p>
      <div className="skip-marks-actions">
        <button className="button small subtle" disabled={!duration} onClick={setCredits}>{t("player.marks.creditsStart")}</button>
        <button className="button small subtle" disabled={!value} onClick={() => onChange({})}>{t("player.marks.clear")}</button>
      </div>
    </section>
  );
}

/**
 * Audio and subtitle choices. Subtitles are grouped by language, with the preferred languages
 * first; choosing a language selects its first subtitle and «Versión» lists the others.
 */
export function TrackPanel({
  right,
  audio,
  audioKey,
  subtitles,
  subtitleKey,
  preferred,
  delay,
  cues,
  time,
  onAudio,
  onSubtitle,
  onDelay,
  look,
  onLook,
}: {
  right: number;
  audio: Track[];
  audioKey: string;
  subtitles: Track[];
  subtitleKey: string;
  preferred: string[];
  delay: number;
  cues: Cue[];
  time: number;
  onAudio: (track: Track) => void;
  onSubtitle: (track: Track | null) => void;
  onDelay: (value: number) => void;
  look: PlayerPreferences;
  onLook: (value: Partial<PlayerPreferences>) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Steps through the preset sizes; a size set elsewhere moves to the nearest preset.
  const resize = (step: number) => {
    const sizes: number[] = [...subtitleSizes];
    const next = step > 0 ? sizes.find((size) => size > look.subtitleSize) : sizes.findLast((size) => size < look.subtitleSize);
    if (next !== undefined) onLook({ subtitleSize: next });
  };
  const selected = subtitles.find((track) => track.key === subtitleKey);
  const langOf = (track: Track) => track.lang || "und";
  const selectedLang = selected ? langOf(selected) : undefined;
  const all = [...new Set(subtitles.map(langOf))];
  const wanted = preferred.map((code) => normalizeLanguage(code)).filter(Boolean);
  const label = (lang: string) => (lang === "und" ? t("player.unknownLanguage") : languageLabel(lang));
  const top = all.filter((lang) => wanted.includes(lang) || lang === selectedLang)
    .sort((a, b) => (wanted.indexOf(a) + 1 || 99) - (wanted.indexOf(b) + 1 || 99));
  const others = all.filter((lang) => !top.includes(lang)).sort((a, b) => label(a).localeCompare(label(b), locale()));
  const variants = selected ? subtitles.filter((track) => langOf(track) === selectedLang) : [];
  // Syncing by ear: the position is frozen when the list opens, so the lines do not move under
  // the pointer, and the chosen line is shown at that position.
  const [syncAt, setSyncAt] = useState<number | null>(null);
  const candidates = useMemo(() => (syncAt === null ? [] : syncCandidates(cues, syncAt, delay)), [cues, delay, syncAt]);
  const showing = syncAt === null ? [] : activeCues(cues, syncAt - delay);
  useEffect(() => {
    if (syncAt === null) return;
    const list = ref.current?.querySelector<HTMLElement>(".track-sync-list");
    (list?.querySelector<HTMLElement>("[data-current]") ?? list?.querySelector<HTMLElement>("button"))?.scrollIntoView({ block: "center" });
  }, [syncAt]);
  useEffect(() => setSyncAt(null), [subtitleKey]);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(".track-languages [aria-checked=true]")?.focus();
  }, []);
  const conversionHint = (track: Track) =>
    track.origin === "embedded" && track.key.startsWith("file-audio") ? t("player.conversionHint") : undefined;
  const language = (lang: string) => {
    const first = subtitles.find((track) => langOf(track) === lang)!;
    const count = subtitles.filter((track) => langOf(track) === lang).length;
    return (
      <Option
        key={lang}
        checked={selectedLang === lang}
        label={label(lang)}
        detail={count > 1 ? String(count) : undefined}
        onSelect={() => onSubtitle(selected && selectedLang === lang ? selected : first)}
      />
    );
  };
  return (
    <div className="player-popover track-panel" role="dialog" aria-label={t("player.audioAndSubtitles")} ref={ref} style={{ right }}>
      <section className="track-languages">
        <h3>{t("player.subtitles")}</h3>
        <div role="radiogroup" aria-label={t("player.subtitleLanguage")} className="track-scroll">
          <Option checked={!selected} label={t("player.subtitlesOff")} onSelect={() => onSubtitle(null)} />
          {top.map(language)}
          {others.length > 0 && top.length > 0 && <hr className="track-divider" aria-hidden="true" />}
          {others.map(language)}
          {!subtitles.length && <p className="track-empty">{t("player.noSubtitles")}</p>}
        </div>
      </section>
      <div className="track-side">
        {audio.length > 1 && (
          <section>
            <h3>{t("player.audio")}</h3>
            <div role="radiogroup" aria-label={t("player.audioTrack")}>
              {audio.map((track) => (
                <Option
                  key={track.key}
                  checked={track.key === audioKey}
                  label={track.label}
                  detail={track.detail}
                  title={conversionHint(track)}
                  onSelect={() => onAudio(track)}
                />
              ))}
            </div>
          </section>
        )}
        {variants.length > 1 && (
          <section>
            <h3>{t("player.version")}</h3>
            <div role="radiogroup" aria-label={t("player.subtitleVersion")} className="track-scroll">
              {variants.map((track) => (
                <Option
                  key={track.key}
                  checked={track.key === subtitleKey}
                  label={track.label}
                  detail={[track.origin === "file" ? t("player.external") : t("player.fromFile"), track.detail].filter(Boolean).join(" · ")}
                  onSelect={() => onSubtitle(track)}
                />
              ))}
            </div>
          </section>
        )}
        <section className="track-delay">
          <h3 id="subtitle-delay">{t("player.delay")}</h3>
          <div className="stepper" role="group" aria-labelledby="subtitle-delay">
            <button className="button small subtle" aria-label={t("player.delayEarlierLabel")} title={t("player.delayEarlierTitle")} disabled={!selected} onClick={() => onDelay(delay - 0.1)}>
              {t("player.delayEarlierButton")}
            </button>
            <output aria-live="polite">{`${delay > 0 ? "+" : ""}${formatNumber(delay, { minimumFractionDigits: 1 })} s`}</output>
            <button className="button small subtle" aria-label={t("player.delayLaterLabel")} title={t("player.delayLaterTitle")} disabled={!selected} onClick={() => onDelay(delay + 0.1)}>
              {t("player.delayLaterButton")}
            </button>
            <button className="button small subtle" disabled={!delay} onClick={() => onDelay(0)}>
              {t("player.reset")}
            </button>
          </div>
          <button
            className="button small subtle track-sync-toggle"
            aria-expanded={syncAt !== null}
            disabled={!selected || !cues.length}
            onClick={() => setSyncAt(syncAt === null ? time : null)}
          >
            {syncAt === null ? t("player.syncWithLine") : t("player.cancelSync")}
          </button>
          {syncAt !== null && (
            <div className="track-sync">
              <p>{t("player.pickLine")}</p>
              <div className="track-sync-list track-scroll" role="list">
                {candidates.map((cue) => (
                  <button
                    key={`${cue.start}-${cue.text}`}
                    role="listitem"
                    className="track-sync-line"
                    data-current={showing.includes(cue) || undefined}
                    onClick={() => {
                      onDelay(syncDelay(cue, syncAt));
                      setSyncAt(null);
                    }}
                  >
                    <small>{clock(cue.start)}</small>
                    <span>{cue.text}</span>
                  </button>
                ))}
                {!candidates.length && <p className="track-empty">{t("player.noLinesNearby")}</p>}
              </div>
            </div>
          )}
        </section>
        <section className="track-look">
          <h3>{t("player.style")}</h3>
          <div className="track-look-row">
            <span id="subtitle-size">{t("player.size")}</span>
            <div className="stepper" role="group" aria-labelledby="subtitle-size">
              <button
                className="button small subtle"
                aria-label={t("player.smallerSubtitles")}
                disabled={look.subtitleSize <= subtitleSizes[0]}
                onClick={() => resize(-1)}
              >
                A−
              </button>
              <output aria-live="polite">{look.subtitleSize} %</output>
              <button
                className="button small subtle"
                aria-label={t("player.largerSubtitles")}
                disabled={look.subtitleSize >= subtitleSizes[subtitleSizes.length - 1]}
                onClick={() => resize(1)}
              >
                A+
              </button>
            </div>
          </div>
          <div className="track-look-row">
            <span id="subtitle-color">{t("player.color")}</span>
            <div className="track-swatches" role="group" aria-labelledby="subtitle-color">
              {subtitleColors.map((color) => (
                <button
                  key={color.value}
                  className="track-swatch"
                  aria-label={color.label}
                  title={color.label}
                  aria-pressed={look.subtitleColor === color.value}
                  style={{ "--swatch": color.value } as CSSProperties}
                  onClick={() => onLook({ subtitleColor: color.value })}
                />
              ))}
            </div>
          </div>
          <div className="track-look-row">
            <span id="subtitle-background">{t("player.background")}</span>
            <div className="track-choices" role="group" aria-labelledby="subtitle-background">
              {[0, 0.5, 0.75, 1].map((value) => (
                <button
                  key={value}
                  className="button small subtle"
                  aria-pressed={look.subtitleBackground === value}
                  title={value ? t("player.backgroundAt", { percent: value * 100 }) : t("player.noBackground")}
                  onClick={() => onLook({ subtitleBackground: value })}
                >
                  {value ? `${value * 100} %` : t("player.backgroundNone")}
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
