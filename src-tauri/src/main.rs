#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod secrets;
mod transport;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::State;
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

#[tauri::command]
async fn open_external(url: String) -> Result<(), String> {
    let url = checked_url(&url)?;
    webbrowser::open(url.as_str()).map_err(|_| "The browser could not be opened.".to_owned())
}

fn player_executable(configured: &str) -> Result<PathBuf, String> {
    if !configured.trim().is_empty() {
        let path = Path::new(configured);
        if !path.is_absolute() || !path.is_file() {
            return Err("Choose the full path to an installed player executable.".to_owned());
        }
        #[cfg(windows)]
        if !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
        {
            return Err("Choose a Windows .exe player executable.".to_owned());
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
            "mpv was not found. Install a player and select its executable in Settings.".to_owned()
        })
}

/// Builds MPV arguments for request headers and the window title, rejecting unsafe values.
fn mpv_arguments(
    executable: &Path,
    headers: &BTreeMap<String, String>,
    title: Option<&str>,
) -> Result<Vec<String>, String> {
    let is_mpv = executable
        .file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| stem.to_ascii_lowercase().starts_with("mpv"));
    let mut arguments = Vec::new();
    if !headers.is_empty() {
        if !is_mpv {
            return Err(
                "This source needs HTTP headers, which Vela can pass only to MPV.".to_owned(),
            );
        }
        for (name, value) in headers {
            let valid_name = !name.is_empty()
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte));
            if !valid_name || value.chars().any(|c| c.is_control()) {
                return Err("The source returned an invalid HTTP header.".to_owned());
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

#[tauri::command]
async fn launch_external_player(
    url: String,
    path: String,
    headers: Option<BTreeMap<String, String>>,
    title: Option<String>,
) -> Result<(), String> {
    let url = checked_url(&url)?;
    let executable = player_executable(&path)?;
    let arguments = mpv_arguments(&executable, &headers.unwrap_or_default(), title.as_deref())?;
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .arg("--")
        .arg(url.as_str())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .spawn()
        .map_err(|_| "The selected player could not be started.".to_owned())?;
    Ok(())
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
        .manage(client)
        .invoke_handler(tauri::generate_handler![
            request_json,
            post_json,
            request_text,
            open_external,
            launch_external_player,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete
        ])
        .run(tauri::generate_context!())
        .expect("could not start Vela");
}
