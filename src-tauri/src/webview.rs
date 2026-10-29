//! WebView2 options that must be known before the window exists. The main window is created here
//! from its tauri.conf.json entry ("create": false) so its browser arguments can depend on them.

use std::path::PathBuf;
use tauri::{AppHandle, Manager, WebviewWindowBuilder};

const FILE: &str = "webview.json";

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(FILE))
}

/// Hardware video decoding is on unless the user turned it off.
fn hardware_decoding(app: &AppHandle) -> bool {
    path(app)
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value["hardwareDecoding"].as_bool())
        .unwrap_or(true)
}

/// Browser arguments for the window: the configured ones, plus the switch that makes Chromium
/// decode video in software when hardware decoding is off.
fn browser_arguments(configured: Option<&str>, hardware: bool) -> Option<String> {
    let configured = configured.unwrap_or_default().trim();
    if hardware {
        return (!configured.is_empty()).then(|| configured.to_owned());
    }
    Some(
        format!("{configured} --disable-accelerated-video-decode")
            .trim()
            .to_owned(),
    )
}

pub fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
    else {
        return Ok(());
    };
    let mut builder = WebviewWindowBuilder::from_config(app, &config)?;
    if let Some(arguments) = browser_arguments(
        config.additional_browser_args.as_deref(),
        hardware_decoding(app),
    ) {
        builder = builder.additional_browser_args(&arguments);
    }
    builder.build()?;
    Ok(())
}

#[tauri::command]
pub fn hardware_decoding_get(app: AppHandle) -> bool {
    hardware_decoding(&app)
}

/// Saves the choice; it applies the next time Vela starts.
#[tauri::command]
pub fn hardware_decoding_set(app: AppHandle, enabled: bool) -> Result<(), String> {
    let failed = || "No se pudo guardar el ajuste.".to_owned();
    let path = path(&app).ok_or_else(failed)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|_| failed())?;
    }
    let value = serde_json::json!({ "hardwareDecoding": enabled });
    std::fs::write(path, value.to_string()).map_err(|_| failed())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_the_software_decoding_switch_only_when_asked() {
        let configured = "--enable-blink-features=AudioVideoTracks";
        assert_eq!(
            browser_arguments(Some(configured), true).as_deref(),
            Some(configured)
        );
        assert_eq!(
            browser_arguments(Some(configured), false).as_deref(),
            Some("--enable-blink-features=AudioVideoTracks --disable-accelerated-video-decode")
        );
        assert_eq!(browser_arguments(None, true), None);
        assert_eq!(
            browser_arguments(None, false).as_deref(),
            Some("--disable-accelerated-video-decode")
        );
    }
}
