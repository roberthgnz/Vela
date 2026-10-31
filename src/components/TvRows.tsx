import { interfaceScale, interfaceScales, useInterfaceScale } from "../lib/gamepad";
import { t } from "../lib/i18n";
import { Segmented } from "./Primitives";

/** Settings › Teclado: interface size for a TV, and what the controller does. */
export function TvRows() {
  const scale = useInterfaceScale();
  return (
    <>
      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-row-label">{t("tv.scale.label")}</span>
          <p>{t("tv.scale.hint")}</p>
        </div>
        <div className="settings-row-control">
          <Segmented
            label={t("tv.scale.label")}
            value={String(scale)}
            onChange={(value) => interfaceScale.set(Number(value) as (typeof interfaceScales)[number])}
            options={interfaceScales.map((value) => ({ value: String(value), label: <span className="segment-text">{value} %</span> }))}
          />
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-row-label">{t("tv.gamepad.label")}</span>
          <p>{t("tv.gamepad.hint")}</p>
        </div>
      </div>
    </>
  );
}
