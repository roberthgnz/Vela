//! Application updates through tauri-plugin-updater.
//!
//! The release workflow publishes `latest.json` with the signed installer of every version;
//! the public key in `tauri.conf.json` verifies the signature before anything is installed.
//! `VELA_UPDATE_ENDPOINT` replaces the endpoint (for testing against a local `latest.json`);
//! the signature check still applies.

use serde_json::{Value, json};
use std::sync::Mutex;
use tauri::{AppHandle, State, ipc::Channel};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let mut builder = app.updater_builder();
    if let Some(endpoint) = std::env::var_os("VELA_UPDATE_ENDPOINT") {
        let url = endpoint
            .to_str()
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| "VELA_UPDATE_ENDPOINT no es una dirección válida.".to_owned())?;
        builder = builder
            .endpoints(vec![url])
            .map_err(|error| error.to_string())?;
    }
    builder
        .build()
        .map_err(|error| format!("El actualizador no está configurado ({error})."))
}

/// Returns the available version, or null when Vela is up to date.
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<Value>, String> {
    let update = updater(&app)?
        .check()
        .await
        .map_err(|error| format!("No se pudo comprobar si hay actualizaciones ({error})."))?;
    let info = update.as_ref().map(|update| {
        json!({
            "version": update.version,
            "current": update.current_version,
            "notes": update.body,
            "date": update.date.map(|date| date.to_string()),
        })
    });
    *pending
        .0
        .lock()
        .map_err(|_| "Estado interno no disponible.")? = update;
    Ok(info)
}

/// Downloads, verifies and installs the version found by `update_check`, reporting progress.
/// On Windows the installer closes Vela and opens the new version.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
    progress: Channel<Value>,
) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .map_err(|_| "Estado interno no disponible.")?
        .take()
        .ok_or_else(|| "No hay ninguna actualización pendiente.".to_owned())?;
    let mut downloaded = 0u64;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress.send(json!({ "downloaded": downloaded, "total": total }));
            },
            || {},
        )
        .await
        .map_err(|error| format!("No se pudo instalar la actualización ({error})."))?;
    app.restart();
}
