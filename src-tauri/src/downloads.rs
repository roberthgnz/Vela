//! Downloads of video files to `Downloads\Vela`, one task per file. A transfer writes to
//! `<name>.part`, resumes it with an HTTP Range request when restarted, and is renamed when it
//! completes. Progress, completion and failure are reported with events; the list of downloads
//! lives in the interface.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

use crate::transport::checked_url;

pub struct Downloads {
    client: reqwest::Client,
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Downloads {
    pub fn new() -> Result<Self, reqwest::Error> {
        // No overall timeout (files take as long as they take); a stalled connection fails.
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(60))
            .user_agent("Vela/0.3.2")
            .build()?;
        Ok(Self {
            client,
            running: Mutex::new(HashMap::new()),
        })
    }
}

pub fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .download_dir()
        .map_err(|_| "No se encontró la carpeta de descargas de Windows.".to_owned())?;
    Ok(base.join("Vela"))
}

/// A file name Windows accepts: no separators or reserved characters, no reserved device names,
/// and an extension (from the name, the content type, or `.mp4`).
pub fn safe_name(name: &str, content_type: Option<&str>) -> String {
    let mut clean: String = name
        .chars()
        .map(|c| {
            if c.is_control() || r#"<>:"/\|?*"#.contains(c) {
                ' '
            } else {
                c
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace(" .", ".");
    clean = clean.trim_matches(['.', ' ']).chars().take(150).collect();
    let stem = clean.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4);
    if clean.is_empty() || reserved {
        clean = format!("Vela {clean}").trim().to_owned();
    }
    let known = [
        ".mkv", ".mp4", ".m4v", ".webm", ".avi", ".mov", ".ts", ".m2ts", ".wmv", ".flv", ".mpg",
        ".mpeg",
    ];
    if !known
        .iter()
        .any(|ext| clean.to_ascii_lowercase().ends_with(ext))
    {
        let ext = match content_type.unwrap_or("") {
            t if t.contains("matroska") => ".mkv",
            t if t.contains("webm") => ".webm",
            t if t.contains("x-msvideo") => ".avi",
            t if t.contains("quicktime") => ".mov",
            t if t.contains("mp2t") => ".ts",
            _ => ".mp4",
        };
        clean.push_str(ext);
    }
    clean
}

/// `name`, or `name (2)`, `name (3)`… when a file already exists.
fn free_path(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    if !path.exists() {
        return path;
    }
    let (stem, ext) = name
        .rsplit_once('.')
        .map_or((name, String::new()), |(s, e)| (s, format!(".{e}")));
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|candidate| !candidate.exists())
        .unwrap()
}

/// Only paths inside the downloads folder can be removed or shown.
fn inside(app: &AppHandle, raw: &str) -> Result<PathBuf, String> {
    let root = folder(app)?
        .canonicalize()
        .map_err(|_| "La carpeta de descargas no existe.".to_owned())?;
    let path = PathBuf::from(raw);
    let resolved = path
        .canonicalize()
        .or_else(|_| {
            path.parent().map_or(Err(()), |parent| {
                parent
                    .canonicalize()
                    .map(|p| p.join(path.file_name().unwrap_or_default()))
                    .map_err(|_| ())
            })
        })
        .map_err(|_| "El archivo no existe.".to_owned())?;
    if !resolved.starts_with(&root) {
        return Err(
            "Solo se pueden gestionar archivos de la carpeta de descargas de Vela.".to_owned(),
        );
    }
    Ok(resolved)
}

#[tauri::command]
pub fn download_folder(app: AppHandle) -> Result<String, String> {
    Ok(folder(&app)?.to_string_lossy().into_owned())
}

/// Starts (or resumes) a download. Returns at once; events report what happens.
#[tauri::command]
pub async fn download_start(
    app: AppHandle,
    downloads: State<'_, Downloads>,
    id: String,
    url: String,
    name: String,
    headers: Option<BTreeMap<String, String>>,
) -> Result<(), String> {
    let url = checked_url(&url)?;
    let headers = headers.unwrap_or_default();
    if headers
        .iter()
        .any(|(k, v)| k.contains(['\r', '\n', ':']) || v.contains(['\r', '\n']))
    {
        return Err("La fuente pide cabeceras no válidas.".to_owned());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut running = downloads.running.lock().unwrap();
        if running.contains_key(&id) {
            return Ok(());
        }
        running.insert(id.clone(), cancel.clone());
    }
    let client = downloads.client.clone();
    tauri::async_runtime::spawn(async move {
        let result = transfer(&app, &client, &id, url, &name, &headers, &cancel).await;
        app.state::<Downloads>().running.lock().unwrap().remove(&id);
        match result {
            Ok((path, size)) => {
                let _ = app.emit(
                    "download-finished",
                    serde_json::json!({ "id": id, "path": path.to_string_lossy(), "size": size }),
                );
            }
            Err(error) => {
                let cancelled = cancel.load(Ordering::Relaxed);
                if !cancelled {
                    crate::logging::log_warn!("download {id} failed: {error}");
                }
                let _ = app.emit(
                    "download-failed",
                    serde_json::json!({ "id": id, "error": error, "cancelled": cancelled }),
                );
            }
        }
    });
    Ok(())
}

async fn transfer(
    app: &AppHandle,
    client: &reqwest::Client,
    id: &str,
    url: url::Url,
    name: &str,
    headers: &BTreeMap<String, String>,
    cancel: &AtomicBool,
) -> Result<(PathBuf, u64), String> {
    let dir = folder(app)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| "No se pudo crear la carpeta de descargas.".to_owned())?;
    // The partial file is keyed by the download id so a resume finds it whatever the final name.
    let part = dir.join(format!(".{id}.part"));
    let existing = tokio::fs::metadata(&part)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    let mut request = client.get(url);
    for (key, value) in headers {
        request = request.header(key, value);
    }
    if existing > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
    }
    let mut response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            "El servidor no respondió a tiempo.".to_owned()
        } else {
            "No se pudo conectar con la fuente.".to_owned()
        }
    })?;
    let status = response.status();
    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && existing > 0 {
        // The part is already complete.
    } else if !status.is_success() {
        return Err(format!("La fuente respondió con HTTP {}.", status.as_u16()));
    }
    let resumed = status == reqwest::StatusCode::PARTIAL_CONTENT;
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let mut received = if resumed || status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        existing
    } else {
        0
    };
    let total = if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        Some(existing)
    } else {
        response.content_length().map(|length| length + received)
    };
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed && status != reqwest::StatusCode::RANGE_NOT_SATISFIABLE)
        .open(&part)
        .await
        .map_err(|_| "No se pudo escribir en la carpeta de descargas.".to_owned())?;
    let mut last = Instant::now();
    let _ = app.emit(
        "download-progress",
        serde_json::json!({ "id": id, "received": received, "total": total }),
    );
    if status != reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        while let Some(chunk) = response.chunk().await.map_err(|_| {
            "Se perdió la conexión con la fuente. Puedes reanudar la descarga.".to_owned()
        })? {
            if cancel.load(Ordering::Relaxed) {
                file.flush().await.ok();
                return Err("Descarga en pausa.".to_owned());
            }
            file.write_all(&chunk).await.map_err(|_| {
                "No se pudo escribir el archivo. ¿Queda espacio en el disco?".to_owned()
            })?;
            received += chunk.len() as u64;
            if last.elapsed() >= Duration::from_millis(500) {
                last = Instant::now();
                let _ = app.emit(
                    "download-progress",
                    serde_json::json!({ "id": id, "received": received, "total": total }),
                );
            }
        }
    }
    file.flush()
        .await
        .map_err(|_| "No se pudo escribir el archivo.".to_owned())?;
    drop(file);
    if total.is_some_and(|total| received < total) {
        return Err("La descarga quedó incompleta. Puedes reanudarla.".to_owned());
    }
    let path = free_path(&dir, &safe_name(name, content_type.as_deref()));
    tokio::fs::rename(&part, &path)
        .await
        .map_err(|_| "No se pudo guardar el archivo descargado.".to_owned())?;
    Ok((path, received))
}

#[tauri::command]
pub fn download_cancel(downloads: State<'_, Downloads>, id: String) {
    if let Some(flag) = downloads.running.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Removes a finished file, or the partial file of an unfinished download.
#[tauri::command]
pub async fn download_remove(
    app: AppHandle,
    id: String,
    path: Option<String>,
) -> Result<(), String> {
    let part = folder(&app)?.join(format!(".{id}.part"));
    let _ = tokio::fs::remove_file(part).await;
    if let Some(path) = path
        && let Ok(path) = inside(&app, &path)
    {
        let _ = tokio::fs::remove_file(path).await;
    }
    Ok(())
}

/// Opens Explorer with the file selected (or the folder, when there is no file yet).
#[tauri::command]
pub async fn download_reveal(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let target = match path {
        Some(path) => format!(
            "/select,{}",
            inside(&app, &path)?
                .to_string_lossy()
                .trim_start_matches(r"\\?\")
        ),
        None => {
            let dir = folder(&app)?;
            tokio::fs::create_dir_all(&dir).await.ok();
            dir.to_string_lossy().into_owned()
        }
    };
    tokio::process::Command::new("explorer")
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|_| "No se pudo abrir el Explorador.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn makes_windows_safe_names_with_an_extension() {
        assert_eq!(
            safe_name("Show: S01E01 / Pilot?.mkv", None),
            "Show S01E01 Pilot.mkv"
        );
        assert_eq!(
            safe_name("Película", Some("video/x-matroska")),
            "Película.mkv"
        );
        assert_eq!(safe_name("CON", None), "Vela CON.mp4");
        assert_eq!(safe_name("...", Some("video/webm")), "Vela.webm");
        assert_eq!(safe_name("a\u{0}b.mp4", None), "a b.mp4");
    }

    #[test]
    fn picks_a_free_name() {
        let dir = std::env::temp_dir().join(format!("vela-free-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.mp4"), b"").unwrap();
        std::fs::write(dir.join("a (2).mp4"), b"").unwrap();
        assert_eq!(free_path(&dir, "a.mp4"), dir.join("a (3).mp4"));
        assert_eq!(free_path(&dir, "b.mkv"), dir.join("b.mkv"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
