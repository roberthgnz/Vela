import { useState } from "react";
import { Download as DownloadIcon, FolderOpen, Pause, Play, RotateCw, Trash2 } from "lucide-react";
import { downloads, formatBytes, useDownloads, type Download } from "../lib/downloads";
import { episodeCode } from "../lib/episodes";
import { t } from "../lib/i18n";
import { errorMessage } from "../lib/utils";
import { Artwork, EmptyState } from "./Primitives";

const statusLabel: Record<Download["status"], string> = {
  downloading: t("downloads.status.downloading"),
  paused: t("downloads.status.paused"),
  failed: t("downloads.status.failed"),
  done: t("downloads.status.done"),
};

function detail(item: Download): string {
  if (item.status === "done") return formatBytes(item.received);
  const size = item.total ? t("downloads.sizeOf", { received: formatBytes(item.received), total: formatBytes(item.total) }) : formatBytes(item.received);
  if (item.status === "downloading" && item.speed && item.total) {
    const seconds = Math.round((item.total - item.received) / item.speed);
    const left = seconds >= 3600 ? `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min` : seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${seconds} s`;
    return t("downloads.detail", { size, speed: formatBytes(item.speed), left });
  }
  return size;
}

export function DownloadsView({ onPlay, notify }: { onPlay: (item: Download) => void; notify: (message: string) => void }) {
  const items = useDownloads();
  const [confirming, setConfirming] = useState<string | null>(null);
  const reveal = (path?: string) => void downloads.reveal(path).catch((error) => notify(errorMessage(error)));
  return (
    <div className="page">
      <header className="page-header">
        <h1>
          {t("nav.downloads")} <span className="count">{items.length}</span>
        </h1>
        <div className="toolbar">
          <button className="button secondary" onClick={() => reveal()}>
            <FolderOpen size={14} /> {t("downloads.openFolder")}
          </button>
        </div>
      </header>
      {!items.length ? (
        <EmptyState
          icon={<DownloadIcon size={20} />}
          title={t("downloads.emptyTitle")}
          description={t("downloads.emptyDescription")}
        />
      ) : (
        <ul className="download-list">
          {items.map((item) => {
            const percent = item.total ? Math.min(100, (item.received / item.total) * 100) : undefined;
            const title = item.episode ? `${item.meta.name} · ${episodeCode(item.episode)}` : item.meta.name;
            return (
              <li key={item.id} className={`download-item ${item.status}`}>
                <Artwork src={item.meta.poster} name={item.meta.name} className="download-art" />
                <div className="download-body">
                  <strong title={title}>
                    {title}
                    {item.episode?.title ? <span className="download-episode"> · {item.episode.title}</span> : null}
                  </strong>
                  <span className="download-file" title={item.path ?? item.name}>{item.name}</span>
                  {item.status !== "done" && (
                    <div
                      className="download-bar"
                      role="progressbar"
                      aria-label={t("downloads.progressOf", { title })}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent === undefined ? undefined : Math.round(percent)}
                    >
                      <span style={{ width: `${percent ?? 0}%` }} />
                    </div>
                  )}
                  <span className="download-status">
                    {statusLabel[item.status]}
                    {percent !== undefined && item.status !== "done" ? ` · ${Math.floor(percent)} %` : ""} · {detail(item)}
                    {item.status === "failed" && item.error ? ` · ${item.error}` : ""}
                  </span>
                </div>
                <div className="download-actions">
                  {item.status === "done" && (
                    <button className="button primary small" onClick={() => onPlay(item)}>
                      <Play size={14} /> {t("downloads.watch")}
                    </button>
                  )}
                  {item.status === "downloading" && (
                    <button className="icon-button" aria-label={t("downloads.pauseItem", { title })} title={t("downloads.pause")} onClick={() => downloads.pause(item.id)}>
                      <Pause size={15} />
                    </button>
                  )}
                  {(item.status === "paused" || item.status === "failed") && (
                    <button className="icon-button" aria-label={t("downloads.resumeItem", { title })} title={t("downloads.resume")} onClick={() => downloads.resume(item.id)}>
                      <RotateCw size={15} />
                    </button>
                  )}
                  {item.status === "done" && (
                    <button className="icon-button" aria-label={t("downloads.revealItem", { title })} title={t("downloads.reveal")} onClick={() => reveal(item.path)}>
                      <FolderOpen size={15} />
                    </button>
                  )}
                  {confirming === item.id ? (
                    <span className="download-confirm">
                      <button
                        className="button danger-outline small"
                        onClick={() => {
                          setConfirming(null);
                          void downloads.remove(item.id).catch((error) => notify(errorMessage(error)));
                        }}
                      >
                        {t("downloads.deleteFile")}
                      </button>
                      <button className="button subtle small" onClick={() => setConfirming(null)}>
                        {t("common.cancel")}
                      </button>
                    </span>
                  ) : (
                    <button
                      className="icon-button danger-hover"
                      aria-label={t("downloads.deleteItem", { title })}
                      title={t("common.delete")}
                      onClick={() => setConfirming(item.id)}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
