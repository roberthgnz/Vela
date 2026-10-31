import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Clipboard, Download, MoreHorizontal, Plus, Puzzle, Trash2 } from "lucide-react";
import { account, useAccount } from "../lib/account";
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

export function AddonsView({
  notify,
  installRequest,
}: {
  notify: (message: string) => void;
  installRequest?: { id: number; url?: string };
}) {
  const prefs = usePreferences();
  const menu = useMenu();
  const [installOpen, setInstallOpen] = useState(false);
  const [handledRequest, setHandledRequest] = useState(installRequest?.id);
  const [linkUrl, setLinkUrl] = useState<string | undefined>(installRequest?.url);
  const [removing, setRemoving] = useState<InstalledAddon | null>(null);
  const [filter, setFilter] = useState<"all" | "on" | "off" | "account">("all");
  const accountState = useAccount();
  if (installRequest && installRequest.id !== handledRequest) {
    setHandledRequest(installRequest.id);
    setLinkUrl(installRequest.url);
    if (installRequest.id) setInstallOpen(true);
  }
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
        {filter === "account" && accountState.user ? (
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
        {filter !== "account" && !list.length && (
          <EmptyState
            icon={<Puzzle size={20} />}
            title={prefs.addons.length ? t("addons.emptyFiltered") : t("addons.emptyNone")}
            description={t("addons.emptyDescription")}
            action={
              <button className="button primary" onClick={() => setInstallOpen(true)}>
                <Plus size={15} /> {t("addons.add")}
              </button>
            }
          />
        )}
        <p className="footnote">
          {t("addons.footnote")}
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
