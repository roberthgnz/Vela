import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseBackup, FolderOpen, RotateCcw } from "lucide-react";
import { useAccount } from "../lib/account";
import { formatBytes, useDownloads } from "../lib/downloads";
import { formatDateTime, plural, t } from "../lib/i18n";
import { managementGuard, useProfiles } from "../lib/profiles";
import {
  backupStorage, previewStorageBackup, restoreStorage, revealStorage, storageInfo, useStorageStatus,
  type BackupPreview,
} from "../lib/storage";
import { errorMessage } from "../lib/utils";
import { Dialog, Spinner } from "./Primitives";

function when(at: number): string {
  return formatDateTime(at, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Backup recovery stays separate from the settings page so its destructive flow can be tested. */
export function StorageSettings({ notify }: { notify: (message: string) => void }) {
  const status = useStorageStatus();
  const account = useAccount();
  const downloads = useDownloads();
  const guarded = Boolean(managementGuard(useProfiles()));
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<BackupPreview>();
  const info = useQuery({ queryKey: ["storage-info"], queryFn: storageInfo, staleTime: 10_000 });
  const backup = useMutation({
    mutationFn: backupStorage,
    onSuccess: () => {
      notify(t("settings.storage.backupCreated"));
      void queryClient.invalidateQueries({ queryKey: ["storage-info"] });
    },
    onError: (error) => notify(errorMessage(error)),
  });
  const inspect = useMutation({ mutationFn: previewStorageBackup, onSuccess: setPreview });
  const restore = useMutation({
    mutationFn: restoreStorage,
    onSuccess: () => window.location.reload(),
  });
  const data = info.data;
  const backups = data?.backups ?? [];
  const newest = backups[0];
  const name = backups.some((item) => item.name === selected) ? selected : newest?.name ?? "";
  // A reload discards the old renderer; don't abandon an active download or account operation.
  const occupied = account.syncing || downloads.some((item) => item.status === "downloading");
  const busy = backup.isPending || inspect.isPending || restore.isPending || restore.isSuccess;
  const close = () => {
    if (restore.isPending || restore.isSuccess) return;
    setPreview(undefined);
    restore.reset();
  };

  return (
    <div className="settings-card">
      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-row-label">{t("settings.storage.database")}</span>
          <p>{status.backend !== "desktop"
            ? t("settings.storage.unavailable", { error: status.error ? ` (${status.error})` : "" })
            : data
              ? t("settings.storage.summary", { folder: data.folder, size: formatBytes(data.size), keys: data.keys, migrated: status.migrated ? t("settings.storage.migrated") : "" })
              : t("settings.storage.default")}</p>
        </div>
        {status.backend === "desktop" && (
          <div className="settings-row-control">
            <button className="button secondary" disabled={busy} onClick={() => void revealStorage().catch((error) => notify(errorMessage(error)))}>
              <FolderOpen size={14} /> {t("settings.openFolder")}
            </button>
          </div>
        )}
      </div>
      {status.backend === "desktop" && <>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-label">{t("settings.storage.backups")}</span>
            <p>{data
              ? backups.length
                ? plural(backups.length, "settings.storage.backupCount.one", "settings.storage.backupCount.other", { last: newest ? when(newest.created) : "" })
                : t("settings.storage.backupsNone")
              : t("settings.storage.backupsDefault")}</p>
            {info.isError && <p role="alert">{errorMessage(info.error)}</p>}
          </div>
          <div className="settings-row-control">
            <button className="button secondary" onClick={() => backup.mutate()} disabled={busy}>
              {backup.isPending ? <Spinner /> : <DatabaseBackup size={14} />} {t("settings.storage.backupNow")}
            </button>
          </div>
        </div>
        {backups.length > 0 && (
          <div className="settings-row stacked">
            <div className="settings-row-text">
              <label htmlFor="storage-backup">{t("settings.storage.restore")}</label>
              <p>{t("settings.storage.restoreHint")}</p>
              {occupied && <p role="status">{t("settings.storage.restoreOccupied")}</p>}
              {guarded && <p role="status">{t("settings.storage.restoreGuarded")}</p>}
              {inspect.isError && <p role="alert">{errorMessage(inspect.error)}</p>}
            </div>
            <div className="storage-backup-controls">
              <select className="input" id="storage-backup" value={name} disabled={busy} onChange={(event) => {
                setSelected(event.target.value);
                inspect.reset();
              }}>
                {backups.map((item) => <option key={item.name} value={item.name}>
                  {when(item.created)} · {formatBytes(item.size)} · {item.name}
                </option>)}
              </select>
              <button className="button secondary" disabled={busy || occupied || guarded} onClick={() => inspect.mutate(name)}>
                {inspect.isPending ? <Spinner /> : <RotateCcw size={14} />} {t("settings.storage.reviewBackup")}
              </button>
            </div>
          </div>
        )}
      </>}
      {preview && (
        <Dialog title={t("settings.storage.restoreQuestion")} onClose={close} className="compact-dialog" hideClose>
          <h2>{t("settings.storage.restoreQuestion")}</h2>
          <p className="storage-backup-name">{preview.name}</p>
          <p>{t("settings.storage.restoreSummary", { profiles: preview.profiles, titles: preview.libraryItems })}</p>
          <p>{t("settings.storage.restoreWarning")}</p>
          <p>{t("settings.storage.restoreAccount")}</p>
          {occupied && <p role="status">{t("settings.storage.restoreOccupied")}</p>}
          {restore.isError && <p role="alert">{errorMessage(restore.error)}</p>}
          {restore.isSuccess && <p role="status">{t("settings.storage.restored")}</p>}
          <div className="form-actions">
            <button className="button secondary" data-autofocus onClick={close} disabled={restore.isPending || restore.isSuccess}>
              {t("common.cancel")}
            </button>
            {restore.isSuccess
              ? <button className="button primary" onClick={() => window.location.reload()}>{t("settings.storage.reload")}</button>
              : <button className="button danger" disabled={restore.isPending || occupied || guarded} onClick={() => restore.mutate(preview.name)}>
                {restore.isPending && <Spinner />} {t("settings.storage.restoreConfirm")}
              </button>}
          </div>
        </Dialog>
      )}
    </div>
  );
}
