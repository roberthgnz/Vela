import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  Captions,
  ClipboardCopy,
  DatabaseBackup,
  FolderOpen,
  Globe,
  House,
  Info,
  Keyboard,
  Languages,
  Play,
  Library,
  MonitorPlay,
  Radio,
  RefreshCw,
  Trash2,
  User,
  Users,
  XCircle,
} from "lucide-react";
import type { PlayerPreferences } from "../lib/contracts";
import { languageLabel, preferredLanguageOptions } from "../lib/languages";
import { preferencesStore, subtitleColors, subtitleSizes, usePreferences } from "../lib/store";
import {
  ensureService,
  isLocalService,
  serviceInstalled,
  serviceVersion,
  setTorrentProfile,
  torrentProfile,
  torrentProfiles,
  type TorrentProfile,
} from "../lib/streamingServer";
import { logFolder, logTail, revealLog, saveReport } from "../lib/log";
import { backupStorage, getStorageStatus, revealStorage, storageInfo, useStorageStatus } from "../lib/storage";
import { formatBytes } from "../lib/downloads";
import { openExternal } from "../lib/transport";
import { errorMessage, motion } from "../lib/utils";
import { AccountSection } from "./AccountSection";
import { TorrentEngineRow } from "./TorrentEngineRow";
import { VideoPlayerRow } from "./VideoPlayerRow";
import { DesktopRows } from "./DesktopRows";
import { TvRows } from "./TvRows";
import { Dialog, Segmented, Spinner, Switch } from "./Primitives";
import { tmdb, useTmdbConfigured } from "../lib/tmdb";
import { updates, useUpdates } from "../lib/updates";
import { native } from "./WindowControls";
import { ProfileSettings } from "./Profiles";
import { CatalogSettings } from "./CatalogSettings";
import { TmdbCatalogsRow } from "./TmdbCatalogsRow";
import { parseKeywords, sourceKeywords, useSourceKeywords } from "../lib/sourceKeywords";
import { compareText, formatDateTime, languageSetting, plural, setLanguage, t, type LanguageSetting } from "../lib/i18n";

export function shortcutList(seekShort = 5, seekLong = 10): [string, string][] {
  return [
    ["Ctrl K  ·  /", t("settings.shortcuts.search")],
    ["Ctrl 1–5", t("settings.shortcuts.sections")],
    ["Ctrl ,", t("nav.settings")],
    ["Ctrl B", t("settings.shortcuts.sidebar")],
    ["Alt ←  ·  Alt →", t("settings.shortcuts.history")],
    ["Esc", t("settings.shortcuts.escape")],
    [t("settings.shortcuts.contextKeys"), t("settings.shortcuts.contextMenu")],
    [t("settings.shortcuts.playKeys"), t("settings.shortcuts.play")],
    ["←  →  ·  J  L", t("settings.shortcuts.seek", { short: seekShort, long: seekLong })],
    ["↑  ↓  ·  M", t("settings.shortcuts.volume")],
    [t("settings.shortcuts.edgeKeys"), t("settings.shortcuts.edges")],
    ["<  >", t("settings.shortcuts.speed")],
    [",  .", t("settings.shortcuts.frame")],
    ["F  ·  C  ·  A", t("settings.shortcuts.toggles")],
    ["G  ·  H", t("settings.shortcuts.subtitleDelay")],
    ["N", t("settings.shortcuts.nextEpisode")],
    ["0–9", t("settings.shortcuts.jump")],
  ];
}

const sections = [
  { id: "account", label: t("settings.section.account"), icon: User },
  { id: "profiles", label: t("settings.section.profiles"), icon: Users },
  { id: "metadata", label: t("settings.section.metadata"), icon: Globe },
  { id: "home", label: t("nav.home"), icon: House },
  { id: "subtitles", label: t("settings.section.subtitles"), icon: Captions },
  { id: "audio", label: t("settings.section.audio"), icon: Languages },
  { id: "playback", label: t("settings.section.playback"), icon: Play },
  ...(native ? [{ id: "external", label: t("settings.section.external"), icon: MonitorPlay }] : []),
  { id: "streaming", label: t("settings.section.streaming"), icon: Radio },
  { id: "library", label: t("nav.library"), icon: Library },
  { id: "keyboard", label: t("settings.section.keyboard"), icon: Keyboard },
  { id: "about", label: t("settings.section.about"), icon: Info },
] as const;

function Row({
  label,
  description,
  children,
  htmlFor,
  stacked,
}: {
  label: string;
  description?: ReactNode;
  children?: ReactNode;
  htmlFor?: string;
  stacked?: boolean;
}) {
  return (
    <div className={`settings-row ${stacked ? "stacked" : ""}`}>
      <div className="settings-row-text">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span className="settings-row-label">{label}</span>}
        {description && <p>{description}</p>}
      </div>
      {children && <div className="settings-row-control">{children}</div>}
    </div>
  );
}

/** What a bug report needs: versions, where the data is, and the end of the log. Nothing is sent. */
async function diagnosticReport(): Promise<string> {
  const status = getStorageStatus();
  const info = await storageInfo().catch(() => null);
  const tail = await logTail().catch((error: unknown) => `(log unavailable: ${errorMessage(error)})`);
  const lines = [
    `Vela ${__APP_VERSION__}`,
    t("settings.report.date", { value: new Date().toISOString() }),
    t("settings.report.browser", { value: navigator.userAgent }),
    t("settings.report.screen", { value: `${window.screen.width}×${window.screen.height} @${window.devicePixelRatio}` }),
    t("settings.report.storage", { value: `${status.backend}${status.error ? ` (error: ${status.error})` : ""}${info ? t("settings.report.storageInfo", { keys: info.keys, size: formatBytes(info.size), backups: info.backups.length }) : ""}` }),
    `Stremio Service: ${(await serviceInstalled().catch(() => false)) ? t("settings.report.installed") : t("settings.report.notFound")}`,
    "",
    t("settings.report.logTail"),
    tail.trimEnd(),
  ];
  return lines.join("\n");
}

function DiagnosticsRows({ notify }: { notify: (message: string) => void }) {
  const folder = useQuery({ queryKey: ["log-folder"], queryFn: logFolder, staleTime: Infinity });
  const copy = useMutation({
    // WebView2's clipboard needs a focused document and may never answer; after a moment the
    // report is saved as a text file in the logs folder and shown in Explorer instead.
    mutationFn: async () => {
      const report = await diagnosticReport();
      const copied = await Promise.race([
        navigator.clipboard.writeText(report).then(() => true, () => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
      ]);
      if (copied) return t("settings.diagnostics.copied");
      const path = await saveReport(report);
      return t("settings.diagnostics.saved", { path });
    },
    onSuccess: notify,
    onError: (error) => notify(errorMessage(error)),
  });
  return (
    <Row
      label={t("settings.diagnostics.label")}
      description={t("settings.diagnostics.description", { folder: folder.data || t("settings.diagnostics.logsFolder") })}
    >
      <button className="button secondary" onClick={() => copy.mutate()} disabled={copy.isPending}>
        {copy.isPending ? <Spinner /> : <ClipboardCopy size={14} />} {t("settings.diagnostics.copy")}
      </button>
      <button className="button subtle" onClick={() => void revealLog().catch((error) => notify(errorMessage(error)))}>
        <FolderOpen size={14} /> {t("settings.openFolder")}
      </button>
    </Row>
  );
}

function when(at: number): string {
  return formatDateTime(at, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** The database that holds the library, profiles and preferences, and its daily copies. */
function StorageSettings({ notify }: { notify: (message: string) => void }) {
  const status = useStorageStatus();
  const queryClient = useQueryClient();
  const info = useQuery({ queryKey: ["storage-info"], queryFn: storageInfo, staleTime: 10_000 });
  const backup = useMutation({
    mutationFn: backupStorage,
    onSuccess: () => {
      notify(t("settings.storage.backupCreated"));
      void queryClient.invalidateQueries({ queryKey: ["storage-info"] });
    },
    onError: (error) => notify(errorMessage(error)),
  });
  const data = info.data;
  const newest = data?.backups[0];
  return (
    <div className="settings-card">
      <Row
        label={t("settings.storage.database")}
        description={
          status.backend !== "desktop"
            ? t("settings.storage.unavailable", { error: status.error ? ` (${status.error})` : "" })
            : data
              ? t("settings.storage.summary", { folder: data.folder, size: formatBytes(data.size), keys: data.keys, migrated: status.migrated ? t("settings.storage.migrated") : "" })
              : t("settings.storage.default")
        }
      >
        {status.backend === "desktop" && (
          <button className="button secondary" onClick={() => void revealStorage().catch((error) => notify(errorMessage(error)))}>
            <FolderOpen size={14} /> {t("settings.openFolder")}
          </button>
        )}
      </Row>
      {status.backend === "desktop" && (
        <Row
          label={t("settings.storage.backups")}
          description={
            data
              ? data.backups.length
                ? plural(data.backups.length, "settings.storage.backupCount.one", "settings.storage.backupCount.other", { last: newest ? when(newest.created) : "" })
                : t("settings.storage.backupsNone")
              : t("settings.storage.backupsDefault")
          }
        >
          <button className="button secondary" onClick={() => backup.mutate()} disabled={backup.isPending}>
            {backup.isPending ? <Spinner /> : <DatabaseBackup size={14} />} {t("settings.storage.backupNow")}
          </button>
        </Row>
      )}
    </div>
  );
}

function validServiceUrl(value: string): string {
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error(t("settings.service.invalidUrl"));
  return url.href.replace(/\/$/, "");
}

export function SettingsView({ notify }: { notify: (message: string) => void }) {
  const prefs = usePreferences();
  const [service, setService] = useState(prefs.serviceUrl);
  const [serviceError, setServiceError] = useState("");
  const [playerPath, setPlayerPath] = useState(prefs.externalPlayerPath);
  const setPlayer = (value: Partial<PlayerPreferences>) => preferencesStore.setPlayer(value);
  const [clearing, setClearing] = useState(false);
  const probe = useMutation({
    mutationFn: async () => {
      const url = validServiceUrl(service);
      if (!(await ensureService(url)))
        throw new Error(
          !isLocalService(url)
            ? t("settings.service.noResponse")
            : (await serviceInstalled())
              ? t("settings.service.startedNoResponse")
              : t("settings.service.notInstalled"),
        );
      return { url, version: await serviceVersion(url).catch(() => undefined) };
    },
    onSuccess: ({ url }) => {
      preferencesStore.setServiceUrl(url);
      setServiceError("");
    },
  });
  const commitService = () => {
    try {
      const url = validServiceUrl(service);
      if (url !== prefs.serviceUrl) {
        preferencesStore.setServiceUrl(url);
        notify(t("settings.service.saved"));
        probe.reset();
      }
      setServiceError("");
    } catch (error) {
      setServiceError(error instanceof TypeError ? t("settings.service.example") : errorMessage(error));
    }
  };
  const commitPlayer = () => {
    if (playerPath.trim() !== prefs.externalPlayerPath) {
      preferencesStore.setExternalPlayerPath(playerPath);
      notify(playerPath.trim() ? t("settings.player.saved") : t("settings.player.auto"));
    }
  };
  const exportLibrary = () => {
    const blob = new Blob(
      [JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), library: prefs.library }, null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = t("settings.library.exportFile", { date: new Date().toISOString().slice(0, 10) });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify(t("settings.library.exportReady"));
  };
  const [current, setCurrent] = useState<string>(sections[0].id);
  // The current section is the last one whose title has scrolled past the top of the content (or
  // the last one, at the very bottom). An IntersectionObserver only reports the sections that
  // changed, so after a jump it kept the section above highlighted.
  useEffect(() => {
    const scroller = document.getElementById("main");
    if (!scroller) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const nodes = sections
        .map(({ id }) => document.getElementById(`settings-${id}`))
        .filter((node): node is HTMLElement => Boolean(node));
      const top = scroller.getBoundingClientRect().top + 120;
      const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      const passed = nodes.filter((node) => node.getBoundingClientRect().top <= top);
      const node = atEnd ? nodes.at(-1) : (passed.at(-1) ?? nodes[0]);
      if (node) setCurrent(node.id.replace("settings-", ""));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);
  const count = Object.values(prefs.library).filter((entry) => entry.saved).length;
  const withProgress = Object.values(prefs.library).filter((entry) => entry.progress || entry.videos).length;
  return (
    <div className="page settings-page">
      <header className="page-header">
        <h1>{t("nav.settings")}</h1>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t("settings.nav")}>
          {sections.map(({ id, label, icon: Icon }) => (
            <a
              key={id}
              href={`#settings-${id}`}
              aria-current={current === id ? "true" : undefined}
              onClick={(event) => {
              event.preventDefault();
              document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: motion(), block: "start" });
            }}>
              <Icon size={15} /> {label}
            </a>
          ))}
        </nav>
        <div className="settings-content">
          <section id="settings-account" className="settings-group" aria-labelledby="settings-account-title">
            <h2 id="settings-account-title">{t("settings.section.account")}</h2>
            <AccountSection notify={notify} />
          </section>

          <section id="settings-profiles" className="settings-group" aria-labelledby="settings-profiles-title">
            <h2 id="settings-profiles-title">{t("settings.section.profiles")}</h2>
            <ProfileSettings notify={notify} />
          </section>

          <section id="settings-metadata" className="settings-group" aria-labelledby="settings-metadata-title">
            <h2 id="settings-metadata-title">{t("settings.section.metadata")}</h2>
            <MetadataSettings notify={notify} />
          </section>

          <section id="settings-home" className="settings-group" aria-labelledby="settings-home-title">
            <h2 id="settings-home-title">{t("nav.home")}</h2>
            <CatalogSettings />
          </section>

          <section id="settings-subtitles" className="settings-group" aria-labelledby="settings-subtitles-title">
            <h2 id="settings-subtitles-title">{t("settings.section.subtitles")}</h2>
            <div className="settings-card">
              <Row label={t("settings.subtitles.primary")} htmlFor="subtitle-language" description={t("settings.subtitles.primaryHint")}>
                <LanguageSelect id="subtitle-language" value={prefs.player.subtitleLanguage} onChange={(value) => setPlayer({ subtitleLanguage: value })} />
              </Row>
              <Row label={t("settings.subtitles.secondary")} htmlFor="subtitle-secondary" description={t("settings.subtitles.secondaryHint")}>
                <LanguageSelect id="subtitle-secondary" value={prefs.player.subtitleSecondary} onChange={(value) => setPlayer({ subtitleSecondary: value })} />
              </Row>
              <Row
                label={t("settings.subtitles.auto")}
                description={t("settings.subtitles.autoHint")}
              >
                <Switch
                  checked={prefs.player.subtitlesAuto}
                  label={t("settings.subtitles.autoSwitch")}
                  onChange={() => setPlayer({ subtitlesAuto: !prefs.player.subtitlesAuto })}
                />
              </Row>
              <Row label={t("settings.subtitles.size")}>
                <Segmented
                  label={t("settings.subtitles.sizeLabel")}
                  value={String(prefs.player.subtitleSize)}
                  onChange={(value) => setPlayer({ subtitleSize: Number(value) })}
                  options={subtitleSizes.map((value) => ({ value: String(value), label: <span className="segment-text">{value} %</span>, title: `${value} %` }))}
                />
              </Row>
              <Row label={t("settings.subtitles.color")}>
                <Segmented
                  label={t("settings.subtitles.colorLabel")}
                  value={prefs.player.subtitleColor}
                  onChange={(value) => setPlayer({ subtitleColor: value })}
                  options={subtitleColors.map((color) => ({
                    value: color.value,
                    label: (
                      <span className="segment-text">
                        <span className="color-dot" style={{ background: color.value }} />
                        {color.label}
                      </span>
                    ),
                    title: color.label,
                  }))}
                />
              </Row>
              <Row label={t("settings.subtitles.opacity")}>
                <Segmented
                  label={t("settings.subtitles.opacity")}
                  value={String(prefs.player.subtitleOpacity)}
                  onChange={(value) => setPlayer({ subtitleOpacity: Number(value) })}
                  options={[1, 0.75, 0.5].map((value) => ({ value: String(value), label: <span className="segment-text">{value * 100} %</span>, title: `${value * 100} %` }))}
                />
              </Row>
              <Row label={t("settings.subtitles.background")}>
                <Segmented
                  label={t("settings.subtitles.backgroundLabel")}
                  value={String(prefs.player.subtitleBackground)}
                  onChange={(value) => setPlayer({ subtitleBackground: Number(value) })}
                  options={[0, 0.25, 0.5, 0.75, 1].map((value) => ({
                    value: String(value),
                    label: <span className="segment-text">{value ? `${value * 100} %` : t("settings.subtitles.noBackground")}</span>,
                    title: value ? t("settings.subtitles.backgroundTitle", { percent: value * 100 }) : t("settings.subtitles.noBackground"),
                  }))}
                />
              </Row>
              <div className="subtitle-preview" aria-hidden="true" style={{
                "--subtitle-scale": prefs.player.subtitleSize / 100,
                "--subtitle-opacity": prefs.player.subtitleOpacity,
                "--subtitle-background": prefs.player.subtitleBackground,
                "--subtitle-color": prefs.player.subtitleColor,
              } as CSSProperties}>
                <div className="player-subtitle bottom">
                  <span>{t("settings.subtitles.preview")}</span>
                </div>
              </div>
              <Row
                label={t("settings.subtitles.delay")}
                description={t("settings.subtitles.delayHint")}
              />
            </div>
          </section>

          <section id="settings-audio" className="settings-group" aria-labelledby="settings-audio-title">
            <h2 id="settings-audio-title">{t("settings.section.audio")}</h2>
            <div className="settings-card">
              <Row label={t("settings.audio.preferred")} htmlFor="audio-language" description={t("settings.audio.preferredHint")}>
                <LanguageSelect id="audio-language" value={prefs.player.audioLanguage} empty={t("settings.audio.original")} onChange={(value) => setPlayer({ audioLanguage: value })} />
              </Row>
              <Row label={t("settings.audio.alternative")} htmlFor="audio-secondary" description={t("settings.audio.alternativeHint")}>
                <LanguageSelect id="audio-secondary" value={prefs.player.audioSecondary} disabled={!prefs.player.audioLanguage} onChange={(value) => setPlayer({ audioSecondary: value })} />
              </Row>
            </div>
          </section>

          <section id="settings-playback" className="settings-group" aria-labelledby="settings-playback-title">
            <h2 id="settings-playback-title">{t("settings.section.playback")}</h2>
            <div className="settings-card">
              {native && <VideoPlayerRow />}
              <Row
                label={t("settings.playback.builtIn")}
                description={t("settings.playback.builtInHint")}
              />
              {native && <HardwareDecodingRow notify={notify} />}
              <Row label={t("settings.playback.seekShort")} description={t("settings.playback.seekShortHint")}>
                <Segmented
                  label={t("settings.playback.seekShort")}
                  value={String(prefs.player.seekShort)}
                  onChange={(value) => setPlayer({ seekShort: Number(value) })}
                  options={[5, 10, 15, 30].map((value) => ({ value: String(value), label: <span className="segment-text">{value} s</span>, title: t("settings.playback.seconds", { value }) }))}
                />
              </Row>
              <Row label={t("settings.playback.seekLong")} description={t("settings.playback.seekLongHint")}>
                <Segmented
                  label={t("settings.playback.seekLong")}
                  value={String(prefs.player.seekLong)}
                  onChange={(value) => setPlayer({ seekLong: Number(value) })}
                  options={[10, 15, 30, 60, 85].map((value) => ({ value: String(value), label: <span className="segment-text">{value} s</span>, title: t("settings.playback.seconds", { value }) }))}
                />
              </Row>
              <Row label={t("settings.playback.nextEpisode")} description={t("settings.playback.nextEpisodeHint")}>
                <Switch
                  checked={prefs.player.autoNext}
                  label={t("settings.playback.nextEpisodeSwitch")}
                  onChange={() => setPlayer({ autoNext: !prefs.player.autoNext })}
                />
              </Row>
              {prefs.player.autoNext && (
                <Row label={t("settings.playback.autoStart")} description={t("settings.playback.autoStartHint")}>
                  <Segmented
                    label={t("settings.playback.countdown")}
                    value={String(prefs.player.nextCountdown)}
                    onChange={(value) => setPlayer({ nextCountdown: Number(value) })}
                    options={[0, 5, 10, 20].map((value) => ({
                      value: String(value),
                      label: <span className="segment-text">{value ? `${value} s` : t("settings.playback.countdownOff")}</span>,
                      title: value ? t("settings.playback.countdownAfter", { value }) : t("settings.playback.countdownWait"),
                    }))}
                  />
                </Row>
              )}
            </div>
          </section>

          {native && (
            <section id="settings-external" className="settings-group" aria-labelledby="settings-external-title">
              <h2 id="settings-external-title">{t("settings.section.external")}</h2>
              <div className="settings-card">
                <Row
                  label={t("settings.external.player")}
                  htmlFor="player-path"
                  description={t("settings.external.playerHint")}
                  stacked
                >
                  <input
                    id="player-path"
                    className="input"
                    value={playerPath}
                    onChange={(event) => setPlayerPath(event.target.value)}
                    onBlur={commitPlayer}
                    onKeyDown={(event) => event.key === "Enter" && commitPlayer()}
                    placeholder="C:\Program Files\mpv\mpv.exe"
                    spellCheck={false}
                  />
                </Row>
              </div>
            </section>
          )}

          <section id="settings-streaming" className="settings-group" aria-labelledby="settings-streaming-title">
            <h2 id="settings-streaming-title">{t("settings.section.streaming")}</h2>
            <div className="settings-card">
              {native && <TorrentEngineRow />}
              <Row
                label="Stremio Service"
                htmlFor="service-url"
                description={t("settings.streaming.serviceHint")}
                stacked
              >
                <div className="input-group">
                  <input
                    id="service-url"
                    className="input"
                    value={service}
                    aria-invalid={Boolean(serviceError)}
                    onChange={(event) => {
                      setService(event.target.value);
                      probe.reset();
                    }}
                    onBlur={commitService}
                    onKeyDown={(event) => event.key === "Enter" && commitService()}
                    type="url"
                    spellCheck={false}
                  />
                  <button className="button secondary" disabled={probe.isPending} onClick={() => probe.mutate()}>
                    {probe.isPending ? <Spinner /> : <Radio size={14} />}
                    {t("settings.streaming.test")}
                  </button>
                </div>
                <div className="field-status" aria-live="polite">
                  {serviceError ? (
                    <span className="status error"><XCircle size={14} /> {serviceError}</span>
                  ) : probe.isPending ? (
                    <span className="status">
                      <Spinner size={13} /> {t("settings.checking")}
                    </span>
                  ) : probe.isSuccess ? (
                    <span className="status ok">
                      <CheckCircle2 size={14} /> {t("settings.streaming.connected")}{probe.data.version ? t("settings.streaming.serverVersion", { version: probe.data.version }) : ""}
                    </span>
                  ) : probe.isError ? (
                    <span className="status error">
                      <XCircle size={14} /> {errorMessage(probe.error)}
                    </span>
                  ) : (
                    <span className="status">{t("settings.streaming.unchecked")}</span>
                  )}
                </div>
              </Row>
              <TorrentProfileRow serviceUrl={prefs.serviceUrl} notify={notify} />
              <KeywordRows />
              <Row label={t("settings.streaming.download")} description={t("settings.streaming.downloadHint")}>
                <button
                  className="button subtle"
                  onClick={() => void openExternal("https://www.stremio.com/downloads").catch((error) => notify(errorMessage(error)))}
                >
                  {t("settings.open")} <ExternalLink size={13} />
                </button>
              </Row>
            </div>
          </section>

          <section id="settings-library" className="settings-group" aria-labelledby="settings-library-title">
            <h2 id="settings-library-title">{t("nav.library")}</h2>
            <div className="settings-card">
              <Row
                label={t("settings.library.local")}
                description={t("settings.library.localHint", { count, progress: withProgress })}
              />
              <Row label={t("settings.library.export")} description={t("settings.library.exportHint")}>
                <button className="button secondary" onClick={exportLibrary} disabled={!count}>
                  <Download size={14} /> {t("settings.library.exportButton")}
                </button>
              </Row>
              <Row label={t("settings.library.clear")} description={t("settings.library.clearHint")}>
                <button className="button danger-outline" onClick={() => setClearing(true)} disabled={!count}>
                  <Trash2 size={14} /> {t("settings.library.clearButton")}
                </button>
              </Row>
            </div>
            {native && <StorageSettings notify={notify} />}
          </section>

          <section id="settings-keyboard" className="settings-group" aria-labelledby="settings-keyboard-title">
            <h2 id="settings-keyboard-title">{t("settings.section.keyboard")}</h2>
            <div className="settings-card">
              <TvRows />
            </div>
            <div className="settings-card">
              <ShortcutTable seekShort={prefs.player.seekShort} seekLong={prefs.player.seekLong} />
            </div>
          </section>

          <section id="settings-about" className="settings-group" aria-labelledby="settings-about-title">
            <h2 id="settings-about-title">{t("settings.section.about")}</h2>
            <div className="settings-card">
              <Row label={`Vela ${__APP_VERSION__}`} description={t("settings.about.description")} />
              {updates.supported() && <UpdateRows />}
              {native && <DiagnosticsRows notify={notify} />}
              {native && <DesktopRows notify={notify} />}
              <Row
                label={t("settings.about.privacy")}
                description={t("settings.about.privacyHint")}
              />
              <Row
                label="TMDB"
                description={t("settings.about.tmdbHint")}
              />
              <Row
                label={t("settings.about.demo")}
                description={t("settings.about.demoHint")}
              />
              <Row label={t("settings.about.protocol")} description={t("settings.about.protocolHint")}>
                <button
                  className="button subtle"
                  onClick={() =>
                    void openExternal("https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md").catch((error) =>
                      notify(errorMessage(error)),
                    )
                  }
                >
                  {t("settings.open")} <ExternalLink size={13} />
                </button>
              </Row>
            </div>
          </section>
        </div>
      </div>
      {clearing && (
        <Dialog title={t("settings.library.clear")} onClose={() => setClearing(false)} className="compact-dialog" hideClose>
          <h2>{t("settings.library.clearQuestion")}</h2>
          <p>{t("settings.library.clearWarning", { count })}</p>
          <div className="form-actions">
            <button className="button secondary" data-autofocus onClick={() => setClearing(false)}>
              {t("common.cancel")}
            </button>
            <button
              className="button danger"
              onClick={() => {
                preferencesStore.clearLibrary();
                setClearing(false);
                notify(t("settings.library.cleared"));
              }}
            >
              {t("settings.library.clear")}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

export function ShortcutTable({ seekShort, seekLong }: { seekShort?: number; seekLong?: number }) {
  return (
    <dl className="shortcut-table">
      {shortcutList(seekShort, seekLong).map(([keys, label]) => (
        <div key={label}>
          <dt>
            {keys.split("  ·  ").map((group, index) => (
              <span key={group}>
                {index > 0 && <span className="or">{t("settings.shortcuts.or")}</span>}
                {group.split(" ").filter(Boolean).map((key, keyIndex) => (
                  <kbd key={`${key}${keyIndex}`}>{key}</kbd>
                ))}
              </span>
            ))}
          </dt>
          <dd>{label}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Keyword filter for sources, stored on this device only. */
/** Stored by the desktop app, which needs it before the window exists. */
function HardwareDecodingRow({ notify }: { notify: (message: string) => void }) {
  const [enabled, setEnabled] = useState<boolean>();
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    void invoke<boolean>("hardware_decoding_get").then(setEnabled, () => setEnabled(true));
  }, []);
  const toggle = async () => {
    const next = !enabled;
    try {
      await invoke("hardware_decoding_set", { enabled: next });
      setEnabled(next);
      setChanged(true);
      notify(t("settings.hardware.applyOnRestart"));
    } catch (error) {
      notify(errorMessage(error));
    }
  };
  return (
    <Row
      label={t("settings.hardware.label")}
      description={
        changed
          ? t("settings.hardware.changed")
          : t("settings.hardware.hint")
      }
    >
      <Switch checked={enabled ?? true} label={t("settings.hardware.label")} onChange={() => enabled !== undefined && void toggle()} />
    </Row>
  );
}

/** Speed and connection limits of the server's torrent engine, stored by the server itself. */
function TorrentProfileRow({ serviceUrl, notify }: { serviceUrl: string; notify: (message: string) => void }) {
  const queryClient = useQueryClient();
  const key = ["torrent-profile", serviceUrl];
  const current = useQuery({ queryKey: key, queryFn: () => torrentProfile(serviceUrl), retry: 0 });
  const save = useMutation({
    mutationFn: (profile: TorrentProfile) => setTorrentProfile(serviceUrl, profile),
    onSuccess: (_, profile) => {
      queryClient.setQueryData(key, profile);
      notify(t("settings.torrent.saved", { name: torrentProfiles[profile].label }));
    },
    onError: (error) => notify(errorMessage(error)),
  });
  const profile = current.data;
  return (
    <Row
      label={t("settings.torrent.label")}
      description={
        current.isError
          ? t("settings.torrent.offline")
          : t("settings.torrent.hint", { custom: current.isSuccess && !profile ? t("settings.torrent.custom") : "", soft: torrentProfiles.soft.label })
      }
    >
      {current.isError ? (
        <button className="button secondary" onClick={() => void current.refetch()}>
          <Radio size={14} /> {t("common.retry")}
        </button>
      ) : (
        <Segmented
          label={t("settings.torrent.label")}
          value={(save.isPending ? save.variables : profile) ?? ("" as TorrentProfile)}
          onChange={(value) => !save.isPending && value !== profile && save.mutate(value)}
          options={(Object.keys(torrentProfiles) as TorrentProfile[]).map((id) => ({
            value: id,
            label: <span className="segment-text">{torrentProfiles[id].label}</span>,
            title: torrentProfiles[id].title,
          }))}
        />
      )}
    </Row>
  );
}

function KeywordRows() {
  const keywords = useSourceKeywords();
  const field = (kind: "include" | "exclude", label: string, description: string, placeholder: string) => (
    <Row label={label} htmlFor={`keywords-${kind}`} description={description} stacked>
      <input
        id={`keywords-${kind}`}
        className="input"
        // Re-created when the stored list changes so the field shows its normalized form.
        key={keywords[kind].join(",")}
        defaultValue={keywords[kind].join(", ")}
        placeholder={placeholder}
        spellCheck={false}
        onBlur={(event) => sourceKeywords.set({ ...keywords, [kind]: parseKeywords(event.currentTarget.value) })}
        onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
      />
    </Row>
  );
  return (
    <>
      {field(
        "include",
        t("settings.keywords.include"),
        t("settings.keywords.includeHint"),
        t("settings.keywords.includePlaceholder"),
      )}
      {field("exclude", t("settings.keywords.exclude"), t("settings.keywords.excludeHint"), "cam, hdcam, ts")}
    </>
  );
}

function UpdateRows() {
  const state = useUpdates();
  const automatic = updates.automatic();
  const busy = state.status === "checking" || state.status === "installing";
  return (
    <>
      <Row label={t("settings.updates.auto")} description={t("settings.updates.autoHint")}>
        <Switch checked={automatic} label={t("settings.updates.auto")} onChange={() => updates.setAutomatic(!automatic)} />
      </Row>
      <Row
        label={t("settings.updates.label")}
        description={
          <span aria-live="polite">
            {state.status === "checking"
              ? t("settings.checking")
              : state.status === "current"
                ? t("settings.updates.current")
                : state.status === "available" && state.info
                  ? t("settings.updates.available", { version: state.info.version })
                  : state.status === "installing"
                    ? t("settings.updates.installing")
                    : state.status === "error"
                      ? state.error
                      : t("settings.updates.unchecked")}
          </span>
        }
      >
        {state.status === "available" ? (
          <button className="button primary" onClick={() => void updates.install()}>
            <Download size={14} /> {t("update.install")}
          </button>
        ) : (
          <button className="button secondary" disabled={busy} onClick={() => void updates.check()}>
            {state.status === "checking" ? <Spinner /> : <RefreshCw size={14} />} {t("settings.updates.checkNow")}
          </button>
        )}
      </Row>
    </>
  );
}

function LanguageSelect({
  id,
  value,
  onChange,
  empty = t("settings.language.none"),
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  empty?: string;
  disabled?: boolean;
}) {
  const options = preferredLanguageOptions
    .map((code) => ({ code, label: languageLabel(code) }))
    .sort((a, b) => compareText(a.label, b.label));
  return (
    <label className="select">
      <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        <option value="">{empty}</option>
        {options.map((option) => (
          <option key={option.code} value={option.code}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const metadataLanguages = [
  ["es-ES", t("settings.metadata.esES")],
  ["es-MX", t("settings.metadata.esMX")],
  ["ca-ES", t("settings.metadata.caES")],
  ["eu-ES", t("settings.metadata.euES")],
  ["gl-ES", t("settings.metadata.glES")],
  ["en-US", t("settings.metadata.enUS")],
  ["fr-FR", t("settings.metadata.frFR")],
  ["de-DE", t("settings.metadata.deDE")],
  ["it-IT", t("settings.metadata.itIT")],
  ["pt-PT", t("settings.metadata.ptPT")],
  ["pt-BR", t("settings.metadata.ptBR")],
] as const;

function MetadataSettings({ notify }: { notify: (message: string) => void }) {
  const prefs = usePreferences();
  const configured = useTmdbConfigured();
  const [value, setValue] = useState("");
  useEffect(() => {
    void tmdb.key();
  }, []);
  const save = useMutation({
    mutationFn: () => tmdb.save(value),
    onSuccess: () => {
      setValue("");
      notify(t("settings.metadata.saved"));
    },
  });
  return (
    <div className="settings-card">
      <Row label={t("settings.metadata.language")} htmlFor="metadata-language" description={t("settings.metadata.languageHint")}>
        <label className="select">
          <select
            id="metadata-language"
            value={prefs.metadataLanguage}
            onChange={(event) => preferencesStore.setMetadataLanguage(event.target.value)}
          >
            {metadataLanguages.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
            <option value="">{t("settings.metadata.addonOriginal")}</option>
          </select>
        </label>
      </Row>
      <Row label={t("settings.interfaceLanguage")} htmlFor="interface-language" description={t("settings.interfaceLanguage.hint")}>
        <label className="select">
          <select
            id="interface-language"
            value={languageSetting()}
            onChange={(event) => void setLanguage(event.target.value as LanguageSetting)}
          >
            <option value="system">{t("settings.interfaceLanguage.system")}</option>
            <option value="es">{t("settings.interfaceLanguage.es")}</option>
            <option value="en">{t("settings.interfaceLanguage.en")}</option>
          </select>
        </label>
      </Row>
      <Row
        label={t("settings.metadata.tmdbKey")}
        htmlFor="tmdb-key"
        stacked
        description={
          <>
            {t("settings.metadata.tmdbKeyHint")}
          </>
        }
      >
        {configured ? (
          <div className="input-group">
            <span className="status ok">
              <CheckCircle2 size={14} /> {t("settings.metadata.keySaved")}
            </span>
            <button
              className="button subtle"
              onClick={() =>
                void tmdb
                  .remove()
                  .then(() => notify(t("settings.metadata.keyRemoved")))
                  .catch((error) => notify(errorMessage(error)))
              }
            >
              {t("settings.remove")}
            </button>
          </div>
        ) : (
          <>
            <div className="input-group">
              <input
                id="tmdb-key"
                className="input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={t("settings.metadata.keyPlaceholder")}
                value={value}
                aria-invalid={save.isError}
                onChange={(event) => {
                  setValue(event.target.value);
                  save.reset();
                }}
                onKeyDown={(event) => event.key === "Enter" && value.trim() && save.mutate()}
              />
              <button className="button secondary" disabled={!value.trim() || save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? <Spinner /> : null} {t("common.save")}
              </button>
            </div>
            <div className="field-status" aria-live="polite">
              {save.isError ? (
                <span className="status error">
                  <XCircle size={14} /> {errorMessage(save.error)}
                </span>
              ) : (
                <button
                  className="link-button"
                  onClick={() =>
                    void openExternal("https://www.themoviedb.org/settings/api").catch((error) => notify(errorMessage(error)))
                  }
                >
                  {t("settings.metadata.getKey")} <ExternalLink size={12} />
                </button>
              )}
            </div>
          </>
        )}
      </Row>
      <TmdbCatalogsRow />
    </div>
  );
}
