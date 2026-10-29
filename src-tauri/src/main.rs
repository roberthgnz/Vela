#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod downloads;
mod mpv;
mod proxy;
mod secrets;
mod service;
mod transport;
mod updater;
mod vlc;
mod webview;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
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
    client
        .range(&url, start, length)
        .await
        .map(tauri::ipc::Response::new)
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
        candidates.push(PathBuf::from(&programs).join("mpv/mpv.exe"));
        // VLC only when MPV is not installed: MPV remains the preferred external player.
        candidates.push(PathBuf::from(programs).join("VideoLAN/VLC/vlc.exe"));
    }
    if let Some(programs) = std::env::var_os("ProgramFiles(x86)") {
        candidates.push(PathBuf::from(programs).join("VideoLAN/VLC/vlc.exe"));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "No se encontró MPV ni VLC. Instala uno o elige su ejecutable en Ajustes › Reproductor externo."
                .to_owned()
        })
}

/// Builds MPV arguments for request headers and the window title, rejecting unsafe values. VLC
/// gets its headers through a local proxy instead; other players cannot receive them.
fn mpv_arguments(
    executable: &Path,
    headers: &BTreeMap<String, String>,
    title: Option<&str>,
) -> Result<Vec<String>, String> {
    let is_mpv = is_mpv(executable);
    let mut arguments = Vec::new();
    if !headers.is_empty() {
        if !is_mpv && !vlc::is_vlc(executable) {
            return Err(
                "Esta fuente necesita cabeceras HTTP, que Vela solo puede pasar a MPV o VLC."
                    .to_owned(),
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
            if is_mpv {
                arguments.push(format!("--http-header-fields-append={name}: {value}"));
            }
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

/// Starts the player. With a session id, Vela follows playback (MPV through IPC, VLC through its
/// HTTP interface) and emits `player-progress` while it runs; for every player it emits
/// `player-closed` when the process exits.
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
    subtitles: Option<Vec<String>>,
    show_subtitles: Option<bool>,
) -> Result<serde_json::Value, String> {
    let url = checked_url(&url)?;
    let executable = player_executable(&path)?;
    let headers = headers.unwrap_or_default();
    let subtitles = subtitles.unwrap_or_default();
    let show_subtitles = show_subtitles.unwrap_or(false);
    let mut arguments = mpv_arguments(&executable, &headers, title.as_deref())?;
    let session = session.filter(|value| mpv::valid_session(value));
    let (is_mpv, is_vlc) = (is_mpv(&executable), vlc::is_vlc(&executable));
    let mut target = url.clone();
    let mut item_options = Vec::new();
    let mut proxy = None;
    // VLC's HTTP interface, protected by the session id, which only this window knows.
    let mut interface: Option<(u16, String)> = None;
    if is_mpv {
        if let Some(session) = &session {
            arguments.extend(mpv::ipc_arguments(session, start));
        }
        arguments.extend(mpv::subtitle_arguments(&subtitles, show_subtitles));
    } else if is_vlc {
        if !headers.is_empty() {
            let served = proxy::serve(url.clone(), headers.clone()).await?;
            target = served.url.clone();
            proxy = Some(served);
        }
        interface = session
            .as_ref()
            .and_then(|session| vlc::free_port().map(|port| (port, session.clone())));
        arguments.extend(vlc::arguments(
            interface
                .as_ref()
                .map(|(port, password)| (*port, password.as_str())),
            start,
            &subtitles,
        ));
        item_options = vlc::item_options(title.as_deref());
    }
    let ipc = session.is_some() && (is_mpv || interface.is_some());
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .arg("--")
        .arg(target.as_str())
        .args(item_options)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command
        .spawn()
        .map_err(|_| "No se pudo iniciar el reproductor elegido.".to_owned())?;
    // The proxy has to live as long as the player, even when nobody follows the session.
    if session.is_some() || proxy.is_some() {
        tauri::async_runtime::spawn(async move {
            let exited = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let alive = || !exited.load(std::sync::atomic::Ordering::Relaxed);
            let watcher = {
                let exited = exited.clone();
                async move {
                    let status = child.wait().await.ok().and_then(|status| status.code());
                    exited.store(true, std::sync::atomic::Ordering::Relaxed);
                    status
                }
            };
            let follower = async {
                let session = session.as_deref()?;
                let report = |value| {
                    let _ = app.emit("player-progress", value);
                };
                if let Some((port, password)) = &interface {
                    return vlc::follow(*port, password, session, !show_subtitles, alive, report)
                        .await;
                }
                #[cfg(windows)]
                if ipc {
                    return mpv::follow(&mpv::pipe_name(session), session, alive, report).await;
                }
                None
            };
            let (code, state) = tokio::join!(watcher, follower);
            drop(proxy);
            if let Some(session) = &session {
                let mut payload = state.clone().unwrap_or_default().to_json(session);
                payload["ipc"] = serde_json::json!(state.is_some());
                payload["exitCode"] = serde_json::json!(code);
                let _ = app.emit("player-closed", payload);
            }
        });
    }
    let player = if is_mpv {
        "mpv"
    } else if is_vlc {
        "vlc"
    } else {
        "other"
    };
    Ok(serde_json::json!({ "ipc": ipc, "player": player }))
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
        assert!(mpv_arguments(Path::new("C:/other/player.exe"), &headers, None).is_err());
        assert!(
            mpv_arguments(Path::new("C:/vlc/vlc.exe"), &headers, Some("x"))
                .unwrap()
                .is_empty()
        );
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
        .manage(downloads::Downloads::new().expect("could not initialize downloads"))
        .manage(service::Service::default())
        .setup(|app| Ok(webview::create_main_window(app.handle())?))
        .invoke_handler(tauri::generate_handler![
            request_json,
            post_json,
            request_text,
            request_bytes,
            request_range,
            downloads::download_folder,
            downloads::download_start,
            downloads::download_cancel,
            downloads::download_remove,
            downloads::download_reveal,
            open_external,
            launch_external_player,
            service::service_installed,
            service::service_start,
            webview::hardware_decoding_get,
            webview::hardware_decoding_set,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
            updater::update_check,
            updater::update_install
        ])
        .build(tauri::generate_context!())
        .expect("could not start Vela")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<service::Service>().stop();
            }
        });
}
