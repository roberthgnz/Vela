import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { useAccount } from "../lib/account";
import { formatDateTime, t } from "../lib/i18n";
import {
  applyLibraryImport, LibraryImportError, MAX_LIBRARY_IMPORT_BYTES, parseLibraryExport, previewLibraryImport,
  type ParsedLibraryImport,
} from "../lib/libraryImport";
import { PIN_LENGTH, validPin } from "../lib/pin";
import { managementGuard, profiles, useProfiles } from "../lib/profiles";
import { backupStorage, flushStorage, getStorageStatus, useStorageStatus } from "../lib/storage";
import { preferencesStore, usePreferences } from "../lib/store";
import { errorMessage } from "../lib/utils";
import { Dialog, Spinner } from "./Primitives";

type Selection = { parsed: ParsedLibraryImport; name: string; profile: string; profileName: string };

function parseError(cause: unknown): string {
  if (cause instanceof LibraryImportError) {
    if (cause.code === "tooLarge") return t("settings.library.importTooLarge", { size: MAX_LIBRARY_IMPORT_BYTES / 1024 / 1024 });
    if (cause.code === "unsupported") return t("settings.library.importUnsupported");
    return t("settings.library.importInvalid");
  }
  return t("settings.library.importReadError");
}

/** Imports only library data into the chosen profile; addons, credentials and preferences stay local. */
export function LibraryImport({ notify }: { notify: (message: string) => void }) {
  const prefs = usePreferences();
  const profileState = useProfiles();
  const account = useAccount();
  const storageState = useStorageStatus();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const [selection, setSelection] = useState<Selection>();
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [pin, setPin] = useState("");
  const guard = managementGuard(profileState);
  const wrongProfile = Boolean(selection && selection.profile !== profileState.active);
  const parsed = selection?.parsed;
  const summary = useMemo(() => parsed ? previewLibraryImport(parsed, prefs.library) : undefined, [parsed, prefs.library]);
  const busy = reading || importing;
  const blocked = account.syncing || Boolean(storageState.restoring);

  const choose = async (file: File) => {
    const sequence = ++request.current;
    const profile = preferencesStore.getProfile();
    const profileName = profileState.profiles.find((item) => item.id === profile)?.name ?? profile;
    setSelection(undefined);
    setError("");
    setPin("");
    setReading(true);
    try {
      if (file.size > MAX_LIBRARY_IMPORT_BYTES) throw new LibraryImportError("tooLarge");
      const text = await file.text();
      if (sequence !== request.current) return;
      if (preferencesStore.getProfile() !== profile) {
        setError(t("settings.library.importProfileChanged"));
        return;
      }
      setSelection({ parsed: parseLibraryExport(text), name: file.name, profile, profileName });
    } catch (cause) {
      if (sequence === request.current) setError(parseError(cause));
    } finally {
      if (sequence === request.current) setReading(false);
    }
  };

  const close = () => {
    if (importing) return;
    setSelection(undefined);
    setPin("");
    setError("");
  };

  const confirm = async () => {
    if (!selection || importing || blocked || wrongProfile) return;
    const selected = selection;
    const checkContext = () => {
      if (preferencesStore.getProfile() !== selected.profile) throw new Error(t("settings.library.importProfileChanged"));
      if (getStorageStatus().restoring) throw new Error(t("settings.library.importWait"));
    };
    setImporting(true);
    setError("");
    try {
      checkContext();
      if (guard) await profiles.verify(guard.id, pin);
      checkContext();
      if (getStorageStatus().backend === "desktop") await backupStorage();
      checkContext();
      // Recompute against the current store after the asynchronous backup/PIN checks.
      const result = applyLibraryImport(selected.parsed);
      await flushStorage();
      const saved = !getStorageStatus().error;
      setSelection(undefined);
      setPin("");
      notify(saved
        ? t("settings.library.imported", { added: result.added, updated: result.updated })
        : t("settings.library.importPending"));
      void queryClient.invalidateQueries({ queryKey: ["storage-info"] });
    } catch (cause) {
      setError(errorMessage(cause));
      setPin("");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-row-label">{t("settings.library.import")}</span>
        <p>{t("settings.library.importHint")}</p>
        {blocked && <p role="status">{t("settings.library.importWait")}</p>}
        {error && !selection && <p role="alert">{error}</p>}
      </div>
      <div className="settings-row-control">
        <input ref={input} hidden type="file" accept=".json,application/json" disabled={busy || blocked} aria-label={t("settings.library.importFile")} onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void choose(file);
        }} />
        <button className="button secondary" disabled={busy || blocked} onClick={() => input.current?.click()}>
          {reading ? <Spinner /> : <Upload size={14} />} {t("settings.library.importButton")}
        </button>
      </div>
      {selection && summary && (
        <Dialog title={t("settings.library.importQuestion")} onClose={close} className="compact-dialog" hideClose>
          <h2>{t("settings.library.importQuestion")}</h2>
          <p className="storage-backup-name">{selection.name}</p>
          <p>{t("settings.library.importTarget", { name: selection.profileName })}</p>
          {selection.parsed.exportedAt && <p>{t("settings.library.importDate", { date: formatDateTime(selection.parsed.exportedAt) })}</p>}
          <p>{t("settings.library.importSummary", { added: summary.added, updated: summary.updated, unchanged: summary.unchanged })}</p>
          <p>{t("settings.library.importMerge")}</p>
          <p>{t(storageState.backend === "desktop" ? "settings.library.importBackup" : "settings.library.importNoBackup")}</p>
          {account.status === "signed-in" && <p>{t("settings.library.importSync")}</p>}
          {guard && <label className="library-import-pin">
            <span>{t("profiles.pinOf", { name: guard.name })}</span>
            <input className="input pin-input" type="password" inputMode="numeric" autoComplete="off" maxLength={PIN_LENGTH}
              disabled={importing} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, PIN_LENGTH))} />
          </label>}
          {wrongProfile && <p role="alert">{t("settings.library.importProfileChanged")}</p>}
          {blocked && <p role="status">{t("settings.library.importWait")}</p>}
          {error && !wrongProfile && <p role="alert">{error}</p>}
          <div className="form-actions">
            <button className="button secondary" data-autofocus onClick={close} disabled={importing}>{t("common.cancel")}</button>
            <button className="button primary" disabled={importing || blocked || wrongProfile || (guard && !validPin(pin)) || summary.added + summary.updated === 0}
              onClick={() => void confirm()}>
              {importing && <Spinner />} {t("settings.library.importConfirm")}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
