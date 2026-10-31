import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { setStremioLinks, stremioLinks, trayIcon, useTrayIcon } from "../lib/desktop";
import { t } from "../lib/i18n";
import { errorMessage } from "../lib/utils";
import { Switch } from "./Primitives";

function Row({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-row-label">{label}</span>
        <p>{description}</p>
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

/** Settings › Acerca de: the tray icon and which links open Vela. */
export function DesktopRows({ notify }: { notify: (message: string) => void }) {
  const tray = useTrayIcon();
  const queryClient = useQueryClient();
  const links = useQuery({ queryKey: ["stremio-links"], queryFn: stremioLinks, staleTime: Infinity });
  const toggleLinks = useMutation({
    mutationFn: (enabled: boolean) => setStremioLinks(enabled),
    onSuccess: (_, enabled) => {
      queryClient.setQueryData(["stremio-links"], enabled);
      notify(enabled ? t("desktop.stremioLinks.on") : t("desktop.stremioLinks.off"));
    },
    onError: (error) => notify(errorMessage(error)),
  });
  return (
    <>
      <Row label={t("desktop.tray.label")} description={t("desktop.tray.hint")}>
        <Switch checked={tray} label={t("desktop.tray.label")} onChange={() => trayIcon.set(!tray)} />
      </Row>
      <Row label={t("desktop.stremioLinks.label")} description={t("desktop.stremioLinks.hint")}>
        <Switch
          checked={Boolean(links.data)}
          label={t("desktop.stremioLinks.label")}
          disabled={!links.isSuccess || toggleLinks.isPending}
          onChange={() => toggleLinks.mutate(!links.data)}
        />
      </Row>
    </>
  );
}
