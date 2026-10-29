#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod transport;

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

#[tauri::command]
async fn launch_external_player(url: String, path: String) -> Result<(), String> {
    let url = checked_url(&url)?;
    let executable = player_executable(&path)?;
    let mut command = Command::new(executable);
    command
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

fn main() {
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("could not initialize the TLS provider");
    let client = HttpClient::new().expect("could not initialize the addon transport");
    tauri::Builder::default()
        .manage(client)
        .invoke_handler(tauri::generate_handler![
            request_json,
            request_text,
            open_external,
            launch_external_player
        ])
        .run(tauri::generate_context!())
        .expect("could not start Vela");
}
