import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Check,
  Clipboard,
  Compass,
  Download,
  ExternalLink,
  MoreHorizontal,
  Plus,
  Puzzle,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { account, useAccount } from "../lib/account";
import {
  COMMUNITY_SITE_URL,
  communityCapabilities,
  configureUrl,
  filterCommunityAddons,
  loadCommunityAddons,
  type CommunityAddon,
  type CommunityCapability,
} from "../lib/communityAddons";
import { allowsAdult } from "../lib/contentFilter";
import { useProfiles } from "../lib/profiles";
import { openExternal } from "../lib/transport";
import type { AddonDescriptor } from "../lib/stremioApi";
import type { InstalledAddon } from "../lib/contracts";
import { loadManifest, normalizeManifestUrl } from "../lib/protocol";
import { preferencesStore, usePreferences } from "../lib/store";
import { addonHost, errorMessage, safeImage } from "../lib/utils";
import { plural, t } from "../lib/i18n";
import {
  anchorFrom,
  Dialog,
  EmptyState,
  ErrorState,
  Spinner,
  Switch,
  useMenu,
} from "./Primitives";

const capabilityLabels: Record<string, string> = {
  catalog: t("addons.capability.catalog"),
  meta: t("addons.capability.meta"),
  stream: t("addons.capability.stream"),
  subtitles: t("addons.capability.subtitles"),
};

function AddonIcon({ addon }: { addon: InstalledAddon }) {
  const [failed, setFailed] = useState(false);
  const logo = safeImage(addon.manifest.logo);
  if (addon.manifestUrl.startsWith("vela:"))
    return (
      <span className="addon-icon">
        <img src="/vela.svg" alt="" />
      </span>
    );
  return (
    <span className="addon-icon">
      {logo && !failed ? (
        <img src={logo} alt="" onError={() => setFailed(true)} />
      ) : (
        <span>{addon.manifest.name.charAt(0).toUpperCase()}</span>
      )}
    </span>
  );
}

/** The last install request handled, across mounts of the view. */
let handledInstall = 0;

export function AddonsView({
  notify,
  installRequest,
}: {
  notify: (message: string) => void;
  installRequest?: { id: number; url?: string };
}) {
  const prefs = usePreferences();
  const menu = useMenu();
  // A request newer than the last one handled opens the dialog, also when it is what brought
  // the user here (the view mounts with it, from the command palette or a link).
  const fresh = Boolean(installRequest && installRequest.id > handledInstall);
  const [installOpen, setInstallOpen] = useState(fresh);
  const [linkUrl, setLinkUrl] = useState<string | undefined>(fresh ? installRequest?.url : undefined);
  const [removing, setRemoving] = useState<InstalledAddon | null>(null);
  const [filter, setFilter] = useState<"all" | "on" | "off" | "account" | "discover">("all");
  const accountState = useAccount();
  useEffect(() => {
    if (!installRequest || installRequest.id <= handledInstall) return;
    handledInstall = installRequest.id;
    setLinkUrl(installRequest.url);
    setInstallOpen(true);
  }, [installRequest]);
  const active = prefs.addons.filter((addon) => addon.enabled).length;
  const list = prefs.addons.filter((addon) =>
    filter === "all" ? true : filter === "on" ? addon.enabled : !addon.enabled,
  );
  return (
    <div className="page">
      <header className="page-header">
        <h1>
          {t("nav.addons")} <span className="count">{prefs.addons.length}</span>
        </h1>
        <div className="toolbar">
          <button className="button primary" onClick={() => setInstallOpen(true)}>
            <Plus size={15} />
            {t("addons.add")}
          </button>
        </div>
      </header>
      <div className="page-tabs" role="tablist" aria-label={t("addons.filterLabel")}>
        {(
          [
            ["all", t("addons.filter.all"), prefs.addons.length],
            ["on", t("addons.filter.on"), active],
            ["off", t("addons.filter.off"), prefs.addons.length - active],
            ...(accountState.status === "signed-in" ? ([["account", t("addons.filter.account"), null]] as const) : []),
            ["discover", t("addons.filter.discover"), null],
          ] as const
        ).map(([value, label, count]) => (
          <button
            key={value}
            role="tab"
            aria-selected={filter === value}
            className={filter === value ? "selected" : ""}
            onClick={() => setFilter(value)}
          >
            {label}
            {count !== null && <span className="tab-count">{count}</span>}
          </button>
        ))}
      </div>
      <div className="page-body narrow">
        {filter === "discover" ? (
          <CommunityAddons notify={notify} />
        ) : filter === "account" && accountState.user ? (
          <AccountAddons userId={accountState.user.id} notify={notify} />
        ) : list.length > 0 && (
          <div className="addon-list">
            {list.map((addon) => {
              const capabilities = [
                ...new Set(
                  addon.manifest.resources
                    .map((resource) => (typeof resource === "string" ? resource : resource.name))
                    .filter((name) => capabilityLabels[name]),
                ),
              ];
              return (
                <article
                  className={`addon-row ${addon.enabled ? "" : "disabled"}`}
                  key={addon.manifestUrl}
                  aria-label={addon.manifest.name}
                >
                  <AddonIcon addon={addon} />
                  <h3>{addon.manifest.name}</h3>
                  <span className="addon-version">v{addon.manifest.version}</span>
                  <p className="addon-description" title={addon.manifest.description}>
                    {addon.manifest.description || t("addons.noDescription")}
                  </p>
                  <div className="addon-meta">
                    {capabilities.map((name) => (
                      <span className="tag" key={name}>
                        {capabilityLabels[name]}
                      </span>
                    ))}
                    <span className="addon-host" title={addonHost(addon.manifestUrl)}>
                      {addonHost(addon.manifestUrl)}
                    </span>
                  </div>
                  <div className="addon-controls">
                    <Switch
                      checked={addon.enabled}
                      label={t(addon.enabled ? "addons.disable" : "addons.enable", { name: addon.manifest.name })}
                      onChange={() => preferencesStore.toggleAddon(addon.manifestUrl)}
                    />
                    <button
                      className="icon-button"
                      aria-label={t("addons.moreOptionsOf", { name: addon.manifest.name })}
                      aria-haspopup="menu"
                      title={t("addons.moreOptions")}
                      onClick={(event) =>
                        menu.open(
                          anchorFrom(event.currentTarget, "end"),
                          [
                            {
                              label: t("addons.copyManifestUrl"),
                              icon: <Clipboard size={15} />,
                              disabled: addon.manifestUrl.startsWith("vela:"),
                              onSelect: () =>
                                void navigator.clipboard
                                  .writeText(addon.manifestUrl)
                                  .then(() => notify(t("addons.urlCopied")))
                                  .catch(() => notify(t("addons.copyFailed"))),
                            },
                            "separator",
                            {
                              label: t("common.delete"),
                              icon: <Trash2 size={15} />,
                              danger: true,
                              onSelect: () => setRemoving(addon),
                            },
                          ],
                          addon.manifest.name,
                        )
                      }
                    >
                      <MoreHorizontal size={16} />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {filter !== "account" && filter !== "discover" && !list.length && (
          <EmptyState
            icon={<Puzzle size={20} />}
            title={prefs.addons.length ? t("addons.emptyFiltered") : t("addons.emptyNone")}
            description={t("addons.emptyDescription")}
            action={
              <>
                <button className="button primary" onClick={() => setInstallOpen(true)}>
                  <Plus size={15} /> {t("addons.add")}
                </button>
                <button className="button secondary" onClick={() => setFilter("discover")}>
                  <Compass size={15} /> {t("addons.explore")}
                </button>
              </>
            }
          />
        )}
        <p className="footnote">
          {filter === "discover" ? t("addons.discover.footnote") : t("addons.footnote")}
        </p>
      </div>
      {installOpen && (
        <InstallDialog
          initialUrl={linkUrl}
          onClose={() => {
            setInstallOpen(false);
            setLinkUrl(undefined);
          }}
          onInstalled={(addon) => notify(t("addons.installedNamed", { name: addon.manifest.name }))}
        />
      )}
      {removing && (
        <Dialog
          title={t("addons.removeTitle", { name: removing.manifest.name })}
          onClose={() => setRemoving(null)}
          className="compact-dialog"
          hideClose
        >
          <h2>{t("addons.removeQuestion", { name: removing.manifest.name })}</h2>
          <p>{t("addons.removeWarning")}</p>
          <div className="form-actions">
            <button className="button secondary" data-autofocus onClick={() => setRemoving(null)}>
              {t("common.cancel")}
            </button>
            <button
              className="button danger"
              onClick={() => {
                preferencesStore.removeAddon(removing.manifestUrl);
                notify(t("addons.removed", { name: removing.manifest.name }));
                setRemoving(null);
              }}
            >
              {t("addons.remove")}
            </button>
          </div>
        </Dialog>
      )}
      {menu.element}
    </div>
  );
}

function InstallDialog({
  initialUrl,
  onClose,
  onInstalled,
}: {
  /** From a vela:// or stremio:// link: filled in, still installed only on confirmation. */
  initialUrl?: string;
  onClose: () => void;
  onInstalled: (addon: InstalledAddon) => void;
}) {
  const [url, setUrl] = useState(initialUrl ?? "");
  const install = useMutation({
    mutationFn: () => loadManifest(url),
    onSuccess: (addon) => {
      preferencesStore.installAddon(addon);
      onInstalled(addon);
      onClose();
    },
  });
  return (
    <Dialog title={t("addons.add")} onClose={onClose} className="compact-dialog">
      <h2>{t("addons.add")}</h2>
      <p>{t("addons.installIntro")}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          install.mutate();
        }}
      >
        <label className="field-label" htmlFor="addon-url">
          {t("addons.urlLabel")}
        </label>
        <input
          id="addon-url"
          className="input"
          type="url"
          autoFocus
          data-autofocus
          autoComplete="off"
          spellCheck={false}
          required
          placeholder={t("addons.urlPlaceholder")}
          value={url}
          aria-describedby="addon-url-hint"
          onChange={(event) => {
            setUrl(event.target.value);
            if (install.isError) install.reset();
          }}
        />
        <span className="field-hint" id="addon-url-hint">
          {t("addons.urlHint")}
        </span>
        {install.isError && (
          <p className="form-error" role="alert">
            {errorMessage(install.error)}
          </p>
        )}
        <div className="form-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="button primary" disabled={install.isPending || !url.trim()} type="submit">
            {install.isPending ? <Spinner /> : <Plus size={15} />}
            {t("addons.install")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function installedUrl(descriptor: AddonDescriptor): string {
  try {
    return normalizeManifestUrl(descriptor.transportUrl);
  } catch {
    return descriptor.transportUrl;
  }
}

function AccountAddons({ userId, notify }: { userId: string; notify: (message: string) => void }) {
  const prefs = usePreferences();
  const query = useQuery({ queryKey: ["account-addons", userId], queryFn: () => account.addons(), staleTime: 60_000 });
  const [busy, setBusy] = useState<string[]>([]);
  const [failures, setFailures] = useState<Record<string, string>>({});
  const installed = new Set(prefs.addons.map((addon) => addon.manifestUrl));
  const missing = (query.data || []).filter((descriptor) => !installed.has(installedUrl(descriptor)));
  const install = async (descriptors: AddonDescriptor[]) => {
    setBusy((value) => [...value, ...descriptors.map((item) => item.transportUrl)]);
    let count = 0;
    for (const descriptor of descriptors) {
      try {
        preferencesStore.installAddon(await loadManifest(descriptor.transportUrl));
        count++;
        setFailures(({ [descriptor.transportUrl]: _, ...rest }) => rest);
      } catch (error) {
        setFailures((value) => ({ ...value, [descriptor.transportUrl]: errorMessage(error) }));
      }
    }
    setBusy((value) => value.filter((url) => !descriptors.some((item) => item.transportUrl === url)));
    if (count) notify(plural(count, "addons.installedFromAccount.one", "addons.installedFromAccount.other"));
  };
  if (query.isPending) return <p className="panel-status"><Spinner /> {t("addons.readingAccount")}</p>;
  if (query.isError)
    return <ErrorState title={t("addons.accountError")} message={errorMessage(query.error)} retry={() => void query.refetch()} />;
  return (
    <>
      <div className="list-toolbar">
        <p>
          {t("addons.accountSummary", { total: query.data.length, missing: missing.length })}
        </p>
        {missing.length > 0 && (
          <button className="button secondary" disabled={busy.length > 0} onClick={() => void install(missing)}>
            <Download size={14} /> {t("addons.installMissing", { count: missing.length })}
          </button>
        )}
      </div>
      <div className="addon-list">
        {query.data.map((descriptor) => {
          const isInstalled = installed.has(installedUrl(descriptor));
          const loading = busy.includes(descriptor.transportUrl);
          const failure = failures[descriptor.transportUrl];
          return (
            <article className="addon-row" key={descriptor.transportUrl} aria-label={descriptor.manifest.name}>
              <span className="addon-icon">
                {safeImage(descriptor.manifest.logo) ? (
                  <img src={safeImage(descriptor.manifest.logo)} alt="" />
                ) : (
                  <span>{descriptor.manifest.name.charAt(0).toUpperCase()}</span>
                )}
              </span>
              <h3>{descriptor.manifest.name}</h3>
              <span className="addon-version">{descriptor.manifest.version ? `v${descriptor.manifest.version}` : ""}</span>
              <p className="addon-description" title={failure || descriptor.manifest.description}>
                {failure ? <span className="status error">{failure}</span> : descriptor.manifest.description || t("addons.noDescription")}
              </p>
              <div className="addon-meta">
                {descriptor.flags?.official && <span className="tag">{t("addons.official")}</span>}
                {descriptor.flags?.protected && <span className="tag">{t("addons.protected")}</span>}
                <span className="addon-host">{addonHost(descriptor.transportUrl)}</span>
              </div>
              <div className="addon-controls">
                {isInstalled ? (
                  <span className="status ok"><Check size={14} /> {t("addons.installed")}</span>
                ) : (
                  <button className="button secondary small" disabled={loading} onClick={() => void install([descriptor])}>
                    {loading ? <Spinner /> : <Download size={13} />} {t("addons.installOne")}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}

/** Rows shown at first, and added by each «Show more». */
const PAGE = 60;

function CommunityAddons({ notify }: { notify: (message: string) => void }) {
  const prefs = usePreferences();
  const profileState = useProfiles();
  const adult = allowsAdult(profileState.profiles.find((profile) => profile.id === profileState.active));
  const query = useQuery({
    queryKey: ["community-addons"],
    queryFn: ({ signal }) => loadCommunityAddons(signal),
    staleTime: 4 * 60 * 60_000,
    gcTime: 24 * 60 * 60_000,
  });
  const [text, setText] = useState("");
  const search = useDeferredValue(text);
  const [capability, setCapability] = useState<CommunityCapability | "all">("all");
  const [limit, setLimit] = useState(PAGE);
  const [busy, setBusy] = useState<string[]>([]);
  const [failures, setFailures] = useState<Record<string, string>>({});
  useEffect(() => setLimit(PAGE), [search, capability]);
  // Adult addons are left out for profiles that do not allow them, as in the rest of Vela.
  const visible = useMemo(() => filterCommunityAddons(query.data ?? [], { adult }), [query.data, adult]);
  const results = useMemo(
    () => filterCommunityAddons(visible, { query: search, capability, adult }),
    [visible, search, capability, adult],
  );
  const counts = useMemo(
    () =>
      Object.fromEntries(
        communityCapabilities.map((name) => [
          name,
          filterCommunityAddons(visible, { query: search, capability: name, adult }).length,
        ]),
      ) as Record<CommunityCapability, number>,
    [visible, search, adult],
  );
  // An addon set up on its page is installed with its settings in the address: it still counts.
  const installedUrls = new Set(prefs.addons.map((addon) => addon.manifestUrl));
  const installedIds = new Set(prefs.addons.map((addon) => addon.manifest.id));
  const isInstalled = (addon: CommunityAddon) => installedUrls.has(addon.manifestUrl) || installedIds.has(addon.id);
  const open = (url: string) => void openExternal(url).catch((error) => notify(errorMessage(error)));
  const install = async (addon: CommunityAddon) => {
    setBusy((value) => [...value, addon.manifestUrl]);
    try {
      const loaded = await loadManifest(addon.manifestUrl);
      preferencesStore.installAddon(loaded);
      setFailures(({ [addon.manifestUrl]: _, ...rest }) => rest);
      notify(t("addons.installedNamed", { name: loaded.manifest.name }));
    } catch (error) {
      setFailures((value) => ({ ...value, [addon.manifestUrl]: errorMessage(error) }));
    } finally {
      setBusy((value) => value.filter((url) => url !== addon.manifestUrl));
    }
  };
  // Its page ends with an install link (stremio://), which Vela opens in its install dialog.
  const configure = (addon: CommunityAddon) => {
    open(configureUrl(addon.manifestUrl));
    notify(t("addons.discover.configureHint"));
  };
  return (
    <>
      <div className="discover-toolbar">
        <label className="filter-field">
          <Search size={14} />
          <input
            type="search"
            aria-label={t("addons.discover.searchLabel")}
            placeholder={t("addons.discover.searchPlaceholder")}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <div className="chip-row" role="toolbar" aria-label={t("addons.discover.capabilityLabel")}>
          <button
            className={`chip ${capability === "all" ? "selected" : ""}`}
            aria-pressed={capability === "all"}
            onClick={() => setCapability("all")}
          >
            {t("addons.filter.all")}
          </button>
          {communityCapabilities.map((name) => (
            <button
              key={name}
              className={`chip ${capability === name ? "selected" : ""}`}
              aria-pressed={capability === name}
              onClick={() => setCapability(name)}
            >
              {capabilityLabels[name]}
              {query.data && <span>{counts[name]}</span>}
            </button>
          ))}
        </div>
      </div>
      {query.isPending ? (
        <p className="panel-status">
          <Spinner /> {t("addons.discover.loading")}
        </p>
      ) : query.isError ? (
        <ErrorState title={t("addons.discover.error")} message={errorMessage(query.error)} retry={() => void query.refetch()} />
      ) : (
        <>
          <div className="list-toolbar">
            <p>{t("addons.discover.summary", { shown: results.length, total: visible.length })}</p>
            <button className="button subtle small" onClick={() => open(COMMUNITY_SITE_URL)}>
              <ExternalLink size={13} /> {t("addons.discover.openSite")}
            </button>
          </div>
          {results.length ? (
            <div className="addon-list">
              {results.slice(0, limit).map((addon) => (
                <CommunityRow
                  key={addon.manifestUrl}
                  addon={addon}
                  installed={isInstalled(addon)}
                  loading={busy.includes(addon.manifestUrl)}
                  failure={failures[addon.manifestUrl]}
                  onInstall={() => void install(addon)}
                  onConfigure={() => configure(addon)}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Search size={20} />}
              title={t("addons.discover.empty")}
              description={t("addons.discover.emptyDescription")}
            />
          )}
          {results.length > limit && (
            <div className="discover-more">
              <button className="button secondary" onClick={() => setLimit((value) => value + PAGE)}>
                {t("addons.discover.showMore", { count: Math.min(PAGE, results.length - limit) })}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function CommunityRow({
  addon,
  installed,
  loading,
  failure,
  onInstall,
  onConfigure,
}: {
  addon: CommunityAddon;
  installed: boolean;
  loading: boolean;
  failure?: string;
  onInstall: () => void;
  onConfigure: () => void;
}) {
  const [logoState, setLogoState] = useState<"loading" | "loaded" | "failed">("loading");
  const logo = safeImage(addon.logo);
  const host = addonHost(addon.manifestUrl);
  const configureLabel = t("addons.discover.configureOf", { name: addon.name });
  return (
    <article className="addon-row" aria-label={addon.name}>
      {/* The initial stays until the logo arrives: community logos are often slow or gone. */}
      <span className="addon-icon layered">
        {logoState !== "loaded" && <span>{addon.name.charAt(0).toUpperCase()}</span>}
        {logo && logoState !== "failed" && (
          <img
            src={logo}
            alt=""
            loading="lazy"
            className={logoState === "loaded" ? "" : "pending"}
            onLoad={() => setLogoState("loaded")}
            onError={() => setLogoState("failed")}
          />
        )}
      </span>
      <h3>{addon.name}</h3>
      <span className="addon-version">{addon.version ? `v${addon.version}` : ""}</span>
      <p className="addon-description" title={failure || addon.description}>
        {failure ? <span className="status error">{failure}</span> : addon.description || t("addons.noDescription")}
      </p>
      <div className="addon-meta">
        {addon.capabilities.map((name) => (
          <span className="tag" key={name}>
            {capabilityLabels[name]}
          </span>
        ))}
        {addon.configurationRequired && <span className="tag">{t("addons.discover.needsSetup")}</span>}
        {addon.p2p && <span className="tag">{t("addons.discover.p2p")}</span>}
        {addon.adult && <span className="tag">{t("addons.discover.adult")}</span>}
        <span className="addon-host" title={host}>
          {host}
        </span>
      </div>
      <div className="addon-controls">
        {installed ? (
          <span className="status ok">
            <Check size={14} /> {t("addons.installed")}
          </span>
        ) : addon.configurationRequired ? (
          <button className="button secondary small" title={configureLabel} onClick={onConfigure}>
            <Settings2 size={13} /> {t("addons.discover.configure")}
          </button>
        ) : (
          <>
            {addon.configurable && (
              <button className="icon-button" aria-label={configureLabel} title={configureLabel} onClick={onConfigure}>
                <Settings2 size={15} />
              </button>
            )}
            <button className="button secondary small" disabled={loading} onClick={onInstall}>
              {loading ? <Spinner /> : <Download size={13} />} {t("addons.installOne")}
            </button>
          </>
        )}
      </div>
    </article>
  );
}
