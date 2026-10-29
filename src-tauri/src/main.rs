#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod mpv;
mod secrets;
mod transport;
mod updater;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Emitter, State};
use tokio::process::Command;
use transport::{HttpClient, checked_url};

#[tauri::command]
async fn request_json(
    url: String,
    client: State<'_, HttpClient>,
) -> Result<serde_json::Value, String> {
    client.json(&url).await
}

#[tauri::command]
async fn post_json(
    url: String,
    body: serde_json::Value,
    client: State<'_, HttpClient>,
) -> Result<serde_json::Value, String> {
    client.post_json(&url, &body).await
}

#[tauri::command]
async fn request_text(url: String, client: State<'_, HttpClient>) -> Result<String, String> {
    client.text(&url).await
}

/// Raw bytes for files whose encoding Vela detects itself, such as subtitles.
#[tauri::command]
async fn request_bytes(
    url: String,
    client: State<'_, HttpClient>,
) -> Result<tauri::ipc::Response, String> {
    client.raw(&url).await.map(tauri::ipc::Response::new)
}

/// A slice of a media file, for reading container headers (MKV chapters) without the whole file.
#[tauri::command]
async fn request_range(
    url: String,
    start: u64,
    length: u64,
    client: State<'_, HttpClient>,
) -> Result<tauri::ipc::Response, String> {
    client.range(&url, start, length).await.map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn open_external(url: String) -> Result<(), String> {
    let url = checked_url(&url)?;
    webbrowser::open(url.as_str()).map_err(|_| "No se pudo abrir el navegador.".to_owned())
}

fn player_executable(configured: &str) -> Result<PathBuf, String> {
    if !configured.trim().is_empty() {
        let path = Path::new(configured);
        if !path.is_absolute() || !path.is_file() {
            return Err(
                "Elige la ruta completa del ejecutable de un reproductor instalado.".to_owned(),
            );
        }
        #[cfg(windows)]
        if !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
        {
            return Err("Elige un ejecutable .exe de Windows.".to_owned());
        }
        return Ok(path.to_owned());
    }
    let executable = if cfg!(windows) { "mpv.exe" } else { "mpv" };
    let mut candidates: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths)
                .filter(|path| path.is_absolute())
                .map(|path| path.join(executable))
                .collect()
        })
        .unwrap_or_default();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("Programs/mpv/mpv.exe"));
    }
    if let Some(programs) = std::env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(programs).join("mpv/mpv.exe"));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "No se encontró MPV. Instálalo o elige su ejecutable en Ajustes › Reproductor externo."
                .to_owned()
        })
}

/// Builds MPV arguments for request headers and the window title, rejecting unsafe values.
fn mpv_arguments(
    executable: &Path,
    headers: &BTreeMap<String, String>,
    title: Option<&str>,
) -> Result<Vec<String>, String> {
    let is_mpv = is_mpv(executable);
    let mut arguments = Vec::new();
    if !headers.is_empty() {
        if !is_mpv {
            return Err(
                "Esta fuente necesita cabeceras HTTP, que Vela solo puede pasar a MPV.".to_owned(),
            );
        }
        for (name, value) in headers {
            let valid_name = !name.is_empty()
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte));
            if !valid_name || value.chars().any(|c| c.is_control()) {
                return Err("La fuente indicó una cabecera HTTP no válida.".to_owned());
            }
            arguments.push(format!("--http-header-fields-append={name}: {value}"));
        }
    }
    if let Some(title) = title.filter(|_| is_mpv) {
        let title: String = title
            .chars()
            .filter(|c| !c.is_control())
            .take(200)
            .collect();
        arguments.push(format!("--force-media-title={title}"));
    }
    Ok(arguments)
}

fn is_mpv(executable: &Path) -> bool {
    executable
        .file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| stem.to_ascii_lowercase().starts_with("mpv"))
}

/// Starts the player. With MPV and a session id, Vela follows playback through IPC and emits
/// `player-progress` while it runs; for every player it emits `player-closed` when the process exits.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn launch_external_player(
    app: AppHandle,
    url: String,
    path: String,
    headers: Option<BTreeMap<String, String>>,
    title: Option<String>,
    session: Option<String>,
    start: Option<f64>,
) -> Result<serde_json::Value, String> {
    let url = checked_url(&url)?;
    let executable = player_executable(&path)?;
    let mut arguments = mpv_arguments(&executable, &headers.unwrap_or_default(), title.as_deref())?;
    let session = session.filter(|value| mpv::valid_session(value));
    let ipc = session.is_some() && is_mpv(&executable);
    if let (true, Some(session)) = (ipc, &session) {
        arguments.extend(mpv::ipc_arguments(session, start));
    }
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .arg("--")
        .arg(url.as_str())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command
        .spawn()
        .map_err(|_| "No se pudo iniciar el reproductor elegido.".to_owned())?;
    if let Some(session) = session {
        tauri::async_runtime::spawn(async move {
            let exited = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let watcher = {
                let exited = exited.clone();
                async move {
                    let status = child.wait().await.ok().and_then(|status| status.code());
                    exited.store(true, std::sync::atomic::Ordering::Relaxed);
                    status
                }
            };
            let follower = async {
                #[cfg(windows)]
                if ipc {
                    let app = app.clone();
                    return mpv::follow(
                        &mpv::pipe_name(&session),
                        &session,
                        || !exited.load(std::sync::atomic::Ordering::Relaxed),
                        move |value| {
                            let _ = app.emit("player-progress", value);
                        },
                    )
                    .await;
                }
                None
            };
            let (code, state) = tokio::join!(watcher, follower);
            let mut payload = state.clone().unwrap_or_default().to_json(&session);
            payload["ipc"] = serde_json::json!(state.is_some());
            payload["exitCode"] = serde_json::json!(code);
            let _ = app.emit("player-closed", payload);
        });
    }
    Ok(serde_json::json!({ "ipc": ipc }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_headers_and_title_only_to_mpv() {
        let headers = BTreeMap::from([("Referer".to_owned(), "https://example.com/".to_owned())]);
        assert_eq!(
            mpv_arguments(Path::new("C:/mpv/mpv.exe"), &headers, Some("Sintel")).unwrap(),
            vec![
                "--http-header-fields-append=Referer: https://example.com/".to_owned(),
                "--force-media-title=Sintel".to_owned()
            ]
        );
        assert!(mpv_arguments(Path::new("C:/vlc/vlc.exe"), &headers, None).is_err());
        assert!(
            mpv_arguments(Path::new("C:/vlc/vlc.exe"), &BTreeMap::new(), Some("x"))
                .unwrap()
                .is_empty()
        );
        let bad = BTreeMap::from([("X-Bad".to_owned(), "a\r\nInjected: 1".to_owned())]);
        assert!(mpv_arguments(Path::new("mpv.exe"), &bad, None).is_err());
        let bad = BTreeMap::from([("Bad Name".to_owned(), "x".to_owned())]);
        assert!(mpv_arguments(Path::new("mpv.exe"), &bad, None).is_err());
    }
}

fn main() {
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("could not initialize the TLS provider");
    let client = HttpClient::new().expect("could not initialize the addon transport");
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updater::PendingUpdate::default())
        .manage(client)
        .invoke_handler(tauri::generate_handler![
            request_json,
            post_json,
            request_text,
            request_bytes,
            request_range,
            open_external,
            launch_external_player,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
            updater::update_check,
            updater::update_install
        ])
        .run(tauri::generate_context!())
        .expect("could not start Vela");
}
