//! A libmpv build for the embedded player, downloaded when the user asks for it.
//!
//! mpv inside Vela's window needs a libmpv (see `embedded_mpv`). Vela does not ship one: libmpv
//! builds are usually GPL. It can fetch an LGPL build into its own data folder instead, with no
//! installer and nothing registered in Windows; Settings can remove it again. The build is pinned
//! in `libmpv.json` (version, size, SHA-256 and the addresses it is published at), so whatever
//! answers at those addresses is accepted only if it is exactly that file.

use crate::embedded_mpv;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

const MANIFEST: &str = include_str!("../libmpv.json");
const EVENT: &str = "mpv-install";
/// Folder inside the install root where a download is prepared before it replaces anything.
const WORK: &str = ".partial";
/// The DLL is about 80 MB; anything far beyond that is not the file in the manifest.
const MAX_LIBRARY_BYTES: u64 = 512 * 1024 * 1024;
const PROGRESS_EVERY: Duration = Duration::from_millis(120);

#[derive(Deserialize, Debug)]
struct Build {
    version: String,
    sha256: String,
    size: u64,
    /// File name of the library inside the archive.
    entry: String,
    license: String,
    source: String,
    /// Where the archive is published, tried in order.
    urls: Vec<String>,
}

fn build() -> &'static Build {
    static BUILD: OnceLock<Build> = OnceLock::new();
    BUILD.get_or_init(|| serde_json::from_str(MANIFEST).expect("libmpv.json is not valid"))
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Progress {
    /// `download`, `unpack` or `check`.
    stage: &'static str,
    downloaded: u64,
    total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    version: String,
    /// Bytes to download.
    size: u64,
    license: String,
    source: String,
    /// The library Vela downloaded earlier, if it is still there.
    path: Option<String>,
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|folder| folder.join("libmpv"))
        .map_err(|_| "No se encontró la carpeta de datos de Vela.".to_owned())
}

/// The newest library a download left inside `root`.
fn installed_in(root: &Path, entry: &str) -> Option<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .filter(|item| !item.file_name().to_string_lossy().starts_with('.'))
        .map(|item| item.path().join(entry))
        .filter(|path| path.is_file())
        .collect();
    found.sort();
    found.pop()
}

/// The libmpv Vela downloaded, for `embedded_mpv` to find.
pub fn installed(app: &AppHandle) -> Option<PathBuf> {
    installed_in(&root(app).ok()?, &build().entry)
}

/// Whether an address may be fetched: HTTPS, or plain HTTP only to this machine (tests).
fn allowed(url: &url::Url) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && match url.scheme() {
            "https" => url.host_str().is_some(),
            "http" => matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")),
            _ => false,
        }
}

fn client() -> Result<reqwest::Client, String> {
    // No overall timeout (the file takes as long as it takes); a stalled connection fails.
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(45))
        .user_agent(format!("Vela/{}", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("demasiadas redirecciones")
            } else if allowed(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("redirección a una dirección no permitida")
            }
        }))
        .build()
        .map_err(|error| format!("No se pudo preparar la descarga: {error}"))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Downloads `url` into `dest`, which must be exactly the file in the manifest: its size and its
/// SHA-256 are checked, and a longer answer is cut off as soon as it exceeds the size.
async fn fetch(
    client: &reqwest::Client,
    url: &str,
    build: &Build,
    dest: &Path,
    cancel: &AtomicBool,
    progress: &(dyn Fn(Progress) + Sync),
) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| "La dirección de descarga no es válida.")?;
    if !allowed(&parsed) {
        return Err("La dirección de descarga no es segura.".to_owned());
    }
    let host = parsed.host_str().unwrap_or("el servidor").to_owned();
    let mut response = client
        .get(parsed)
        .send()
        .await
        .map_err(|_| format!("No se pudo conectar con {host}."))?;
    if !response.status().is_success() {
        return Err(format!("{host} respondió {}.", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length != build.size)
    {
        return Err(format!("{host} ofrece un archivo de otro tamaño."));
    }
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|error| format!("No se pudo crear el archivo temporal: {error}"))?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0u64;
    let mut reported = Instant::now();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| format!("Se cortó la conexión con {host}."))?
    {
        if cancel.load(Ordering::Relaxed) {
            return Err("Descarga cancelada.".to_owned());
        }
        downloaded += chunk.len() as u64;
        if downloaded > build.size {
            return Err(format!("{host} envía más datos de los esperados."));
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("No se pudo guardar la descarga: {error}"))?;
        if reported.elapsed() >= PROGRESS_EVERY {
            reported = Instant::now();
            progress(Progress {
                stage: "download",
                downloaded,
                total: build.size,
            });
        }
    }
    file.flush()
        .await
        .map_err(|error| format!("No se pudo guardar la descarga: {error}"))?;
    if downloaded != build.size {
        return Err("La descarga quedó incompleta.".to_owned());
    }
    if !hex(&hasher.finalize()).eq_ignore_ascii_case(&build.sha256) {
        return Err("El archivo descargado no coincide con el esperado.".to_owned());
    }
    progress(Progress {
        stage: "download",
        downloaded,
        total: build.size,
    });
    Ok(())
}

/// Writes the library named `entry` (wherever it is inside the archive) to `dest`.
fn unpack(archive: &Path, entry: &str, dest: &Path) -> Result<(), String> {
    use std::io::Read;
    let bad = |error: sevenz_rust2::Error| format!("El archivo de mpv no se pudo abrir: {error}");
    let mut reader =
        sevenz_rust2::ArchiveReader::open(archive, sevenz_rust2::Password::empty()).map_err(bad)?;
    let mut copied = None;
    reader
        .for_each_entries(|item, data| {
            let name = item.name().replace('\\', "/");
            if item.is_directory() || name.rsplit('/').next() != Some(entry) {
                return Ok(true);
            }
            let mut out = std::fs::File::create(dest).map_err(sevenz_rust2::Error::from)?;
            copied = Some(
                std::io::copy(&mut data.take(MAX_LIBRARY_BYTES + 1), &mut out)
                    .map_err(sevenz_rust2::Error::from)?,
            );
            Ok(false)
        })
        .map_err(bad)?;
    match copied {
        None => Err(format!("El archivo de mpv no contiene {entry}.")),
        Some(0) => Err(format!("{entry} está vacío en el archivo de mpv.")),
        Some(bytes) if bytes > MAX_LIBRARY_BYTES => {
            Err(format!("{entry} es demasiado grande para ser libmpv."))
        }
        Some(_) => Ok(()),
    }
}

fn notice(build: &Build, url: &str) -> String {
    format!(
        "libmpv {version}\r\n\
         License: {license}\r\n\
         Build scripts and sources: {source}\r\n\
         mpv: https://github.com/mpv-player/mpv\r\n\
         FFmpeg: https://ffmpeg.org\r\n\
         \r\n\
         Vela downloaded this library on request from {url}\r\n\
         (SHA-256 {sha}). It does not distribute it.\r\n",
        version = build.version,
        license = build.license,
        source = build.source,
        sha = build.sha256,
    )
}

/// Downloads, checks and unpacks `build` into `root/<version>/`, and returns the library's path.
/// `verify` gets the unpacked library before it is put in place. Nothing is left behind when it
/// fails, and the library of an earlier version is deleted once the new one is in place.
async fn install(
    root: &Path,
    build: &Build,
    client: &reqwest::Client,
    cancel: &AtomicBool,
    progress: &(dyn Fn(Progress) + Sync),
    verify: impl Fn(&Path) -> Result<(), String> + Send + Sync + 'static,
) -> Result<PathBuf, String> {
    let work = root.join(WORK);
    let _ = tokio::fs::remove_dir_all(&work).await;
    tokio::fs::create_dir_all(&work)
        .await
        .map_err(|error| format!("No se pudo crear la carpeta de mpv: {error}"))?;
    let result = prepare(root, &work, build, client, cancel, progress, verify).await;
    let _ = tokio::fs::remove_dir_all(&work).await;
    result
}

async fn prepare(
    root: &Path,
    work: &Path,
    build: &Build,
    client: &reqwest::Client,
    cancel: &AtomicBool,
    progress: &(dyn Fn(Progress) + Sync),
    verify: impl Fn(&Path) -> Result<(), String> + Send + Sync + 'static,
) -> Result<PathBuf, String> {
    let archive = work.join("build.7z");
    let mut last = "No hay ninguna dirección de descarga.".to_owned();
    let mut source = None;
    for url in &build.urls {
        match fetch(client, url, build, &archive, cancel, progress).await {
            Ok(()) => {
                source = Some(url.as_str());
                break;
            }
            Err(error) => {
                crate::logging::log_warn!("libmpv: {url}: {error}");
                if cancel.load(Ordering::Relaxed) {
                    return Err(error);
                }
                last = error;
            }
        }
    }
    let Some(source) = source else {
        return Err(format!("No se pudo descargar mpv. {last}"));
    };

    progress(Progress {
        stage: "unpack",
        downloaded: build.size,
        total: build.size,
    });
    let library = work.join(&build.entry);
    let (archive_path, entry, target) = (archive.clone(), build.entry.clone(), library.clone());
    tokio::task::spawn_blocking(move || unpack(&archive_path, &entry, &target))
        .await
        .map_err(|error| error.to_string())??;

    progress(Progress {
        stage: "check",
        downloaded: build.size,
        total: build.size,
    });
    let checked = library.clone();
    tokio::task::spawn_blocking(move || verify(&checked))
        .await
        .map_err(|error| error.to_string())??;

    let folder = root.join(&build.version);
    let _ = tokio::fs::remove_dir_all(&folder).await;
    tokio::fs::create_dir_all(&folder)
        .await
        .map_err(|error| format!("No se pudo crear la carpeta de mpv: {error}"))?;
    let path = folder.join(&build.entry);
    tokio::fs::rename(&library, &path)
        .await
        .map_err(|error| format!("No se pudo guardar mpv: {error}"))?;
    let _ = tokio::fs::write(folder.join("NOTICE.txt"), notice(build, source)).await;

    // Older versions, now that this one works. One still loaded by a player stays until it closes.
    if let Ok(mut items) = tokio::fs::read_dir(root).await {
        while let Ok(Some(item)) = items.next_entry().await {
            let name = item.file_name();
            if name.to_string_lossy().starts_with('.') || item.path() == folder {
                continue;
            }
            let _ = tokio::fs::remove_dir_all(item.path()).await;
        }
    }
    Ok(path)
}

/// One download at a time, which the page can cancel.
#[derive(Default)]
pub struct Installer {
    cancel: Mutex<Option<Arc<AtomicBool>>>,
}

struct Running<'a>(&'a Installer);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        *self.0.cancel.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

impl Installer {
    fn begin(&self) -> Result<(Arc<AtomicBool>, Running<'_>), String> {
        let mut slot = self.cancel.lock().unwrap_or_else(|p| p.into_inner());
        if slot.is_some() {
            return Err("Ya se está descargando mpv.".to_owned());
        }
        let flag = Arc::new(AtomicBool::new(false));
        *slot = Some(flag.clone());
        Ok((flag, Running(self)))
    }
}

#[tauri::command]
pub fn mpv_install_info(app: AppHandle) -> Info {
    let build = build();
    Info {
        version: build.version.clone(),
        size: build.size,
        license: build.license.clone(),
        source: build.source.clone(),
        path: installed(&app).map(|path| path.to_string_lossy().into_owned()),
    }
}

/// Downloads the pinned libmpv, reporting `mpv-install` events, and returns where it is.
#[tauri::command]
pub async fn mpv_install(
    app: AppHandle,
    installer: State<'_, Installer>,
) -> Result<String, String> {
    let (cancel, _running) = installer.begin()?;
    let build = build();
    let root = root(&app)?;
    let client = client()?;
    let emit = {
        let app = app.clone();
        move |progress: Progress| {
            let _ = app.emit(EVENT, progress);
        }
    };
    let result = install(&root, build, &client, &cancel, &emit, |path| {
        embedded_mpv::check_library(path)
    })
    .await;
    match &result {
        Ok(path) => {
            crate::logging::log_info!("libmpv {} installed in {}", build.version, path.display())
        }
        Err(error) => crate::logging::log_warn!("libmpv {} not installed: {error}", build.version),
    }
    result.map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn mpv_install_cancel(installer: State<'_, Installer>) {
    if let Some(flag) = installer
        .cancel
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
    {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Deletes what Vela downloaded. Fails while a video is playing with it (Windows keeps the DLL).
#[tauri::command]
pub async fn mpv_uninstall(app: AppHandle) -> Result<(), String> {
    let root = root(&app)?;
    match tokio::fs::remove_dir_all(&root).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(
            "No se pudo borrar mpv. Cierra el vídeo que lo usa y vuelve a intentarlo.".to_owned(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    enum Reply {
        Body(Vec<u8>),
        Status(u16),
        Redirect(String),
    }

    /// Serves `routes` on 127.0.0.1 until the test ends; returns the port.
    async fn serve(routes: Vec<(&'static str, Reply)>) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let routes = Arc::new(routes);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let routes = routes.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut buffer = [0u8; 1024];
                    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                        match socket.read(&mut buffer).await {
                            Ok(0) | Err(_) => return,
                            Ok(read) => head.extend_from_slice(&buffer[..read]),
                        }
                    }
                    let request = String::from_utf8_lossy(&head).into_owned();
                    let path = request.split_whitespace().nth(1).unwrap_or("/").to_owned();
                    let reply = routes.iter().find(|(route, _)| *route == path);
                    let answer: Vec<u8> = match reply.map(|(_, reply)| reply) {
                        Some(Reply::Body(body)) => {
                            let mut out = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                body.len()
                            )
                            .into_bytes();
                            out.extend_from_slice(body);
                            out
                        }
                        Some(Reply::Redirect(to)) => format!(
                            "HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        )
                        .into_bytes(),
                        Some(Reply::Status(code)) => format!(
                            "HTTP/1.1 {code} Nope\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        )
                        .into_bytes(),
                        None => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            .to_vec(),
                    };
                    let _ = socket.write_all(&answer).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        port
    }

    fn temp(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!(
            "vela-libmpv-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&folder).unwrap();
        folder
    }

    /// A 7z with a fake library in a subfolder next to other files, and its manifest entry.
    fn archive(folder: &Path, library: &[u8]) -> (Vec<u8>, String) {
        let source = folder.join("source");
        std::fs::create_dir_all(source.join("bin")).unwrap();
        std::fs::write(source.join("bin").join("libmpv-2.dll"), library).unwrap();
        std::fs::write(source.join("mpv.def"), b"EXPORTS\r\n").unwrap();
        std::fs::write(source.join("README.txt"), b"dev package").unwrap();
        let packed = folder.join("packed.7z");
        sevenz_rust2::compress_to_path(&source, &packed).unwrap();
        let bytes = std::fs::read(&packed).unwrap();
        let sha = hex(&Sha256::digest(&bytes));
        (bytes, sha)
    }

    fn build_for(port: u16, paths: &[&str], bytes: &[u8], sha: &str) -> Build {
        Build {
            version: "20260101-abcdef".to_owned(),
            sha256: sha.to_owned(),
            size: bytes.len() as u64,
            entry: "libmpv-2.dll".to_owned(),
            license: "LGPL-2.1-or-later".to_owned(),
            source: "https://example.org/source".to_owned(),
            urls: paths
                .iter()
                .map(|path| format!("http://127.0.0.1:{port}{path}"))
                .collect(),
        }
    }

    fn http() -> reqwest::Client {
        let _ = rustls::crypto::ring::default_provider().install_default();
        client().unwrap()
    }

    fn quiet(_: Progress) {}

    #[test]
    fn the_pinned_build_is_well_formed() {
        let build = build();
        assert_eq!(build.sha256.len(), 64);
        assert!(build.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(build.size > 1_000_000);
        assert_eq!(build.entry, "libmpv-2.dll");
        assert!(build.license.starts_with("LGPL"));
        assert!(!build.urls.is_empty());
        for url in &build.urls {
            let parsed = url::Url::parse(url).unwrap();
            assert_eq!(parsed.scheme(), "https", "{url}");
            assert!(allowed(&parsed));
        }
    }

    #[test]
    fn only_secure_or_local_addresses_are_allowed() {
        let ok = |text: &str| allowed(&url::Url::parse(text).unwrap());
        assert!(ok("https://github.com/x"));
        assert!(ok("http://127.0.0.1:8000/x"));
        assert!(!ok("http://github.com/x"));
        assert!(!ok("ftp://github.com/x"));
        assert!(!ok("https://user:secret@github.com/x"));
    }

    #[test]
    fn finds_the_newest_downloaded_library_and_ignores_work_folders() {
        let root = temp("newest");
        for version in ["20260101-aaa", "20260301-bbb", ".partial"] {
            std::fs::create_dir_all(root.join(version)).unwrap();
            std::fs::write(root.join(version).join("libmpv-2.dll"), b"x").unwrap();
        }
        std::fs::create_dir_all(root.join("20270101-empty")).unwrap();
        let found = installed_in(&root, "libmpv-2.dll").unwrap();
        assert!(
            found.ends_with("20260301-bbb/libmpv-2.dll")
                || found.ends_with(r"20260301-bbb\libmpv-2.dll")
        );
        assert!(installed_in(&root.join("missing"), "libmpv-2.dll").is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn unpacks_the_library_from_any_folder_of_the_archive() {
        let folder = temp("unpack");
        let (bytes, _) = archive(&folder, b"MZ fake libmpv");
        let packed = folder.join("in.7z");
        std::fs::write(&packed, bytes).unwrap();
        let out = folder.join("out.dll");
        unpack(&packed, "libmpv-2.dll", &out).unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), b"MZ fake libmpv");
        assert!(unpack(&packed, "mpv-2.dll", &folder.join("none.dll")).is_err());
        let _ = std::fs::remove_dir_all(folder);
    }

    #[tokio::test]
    async fn downloads_checks_unpacks_and_installs() {
        let folder = temp("install");
        let (bytes, sha) = archive(&folder, b"MZ fake libmpv");
        let port = serve(vec![("/mpv.7z", Reply::Body(bytes.clone()))]).await;
        let build = build_for(port, &["/mpv.7z"], &bytes, &sha);
        let root = folder.join("libmpv");
        // An older version that must go once the new one works.
        std::fs::create_dir_all(root.join("20250101-old")).unwrap();
        std::fs::write(root.join("20250101-old").join("libmpv-2.dll"), b"old").unwrap();
        let stages = Mutex::new(Vec::new());
        let progress = |p: Progress| stages.lock().unwrap().push(p.stage);
        let path = install(
            &root,
            &build,
            &http(),
            &AtomicBool::new(false),
            &progress,
            |dll| {
                std::fs::read(dll)
                    .map_err(|e| e.to_string())
                    .and_then(|data| {
                        (data == b"MZ fake libmpv")
                            .then_some(())
                            .ok_or("distinta".into())
                    })
            },
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"MZ fake libmpv");
        assert_eq!(installed_in(&root, "libmpv-2.dll").unwrap(), path);
        assert!(path.parent().unwrap().join("NOTICE.txt").is_file());
        assert!(!root.join(WORK).exists());
        assert!(!root.join("20250101-old").exists());
        let stages = stages.lock().unwrap();
        assert_eq!(stages.last(), Some(&"check"));
        assert!(stages.contains(&"download") && stages.contains(&"unpack"));
        let _ = std::fs::remove_dir_all(folder);
    }

    #[tokio::test]
    async fn rejects_a_file_that_is_not_the_pinned_one() {
        let folder = temp("hash");
        let (bytes, sha) = archive(&folder, b"MZ fake libmpv");
        let mut tampered = bytes.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0xff;
        let port = serve(vec![("/mpv.7z", Reply::Body(tampered))]).await;
        let build = build_for(port, &["/mpv.7z"], &bytes, &sha);
        let root = folder.join("libmpv");
        let error = install(
            &root,
            &build,
            &http(),
            &AtomicBool::new(false),
            &quiet,
            |_| Ok(()),
        )
        .await
        .unwrap_err();
        assert!(error.contains("no coincide"), "{error}");
        assert!(installed_in(&root, "libmpv-2.dll").is_none());
        assert!(!root.join(WORK).exists());
        let _ = std::fs::remove_dir_all(folder);
    }

    #[tokio::test]
    async fn refuses_an_answer_larger_than_the_pinned_size() {
        let folder = temp("size");
        let (bytes, sha) = archive(&folder, b"MZ fake libmpv");
        let mut longer = bytes.clone();
        longer.extend_from_slice(&[0u8; 64]);
        let port = serve(vec![("/mpv.7z", Reply::Body(longer))]).await;
        let build = build_for(port, &["/mpv.7z"], &bytes, &sha);
        let error = install(
            &folder.join("libmpv"),
            &build,
            &http(),
            &AtomicBool::new(false),
            &quiet,
            |_| Ok(()),
        )
        .await
        .unwrap_err();
        assert!(error.contains("otro tamaño"), "{error}");
        let _ = std::fs::remove_dir_all(folder);
    }

    #[tokio::test]
    async fn tries_the_next_address_when_one_fails() {
        let folder = temp("fallback");
        let (bytes, sha) = archive(&folder, b"MZ fake libmpv");
        let port = serve(vec![
            ("/gone.7z", Reply::Status(404)),
            ("/mpv.7z", Reply::Body(bytes.clone())),
        ])
        .await;
        let build = build_for(port, &["/gone.7z", "/mpv.7z"], &bytes, &sha);
        let path = install(
            &folder.join("libmpv"),
            &build,
            &http(),
            &AtomicBool::new(false),
            &quiet,
            |_| Ok(()),
        )
        .await
        .unwrap();
        assert!(path.is_file());
        let _ = std::fs::remove_dir_all(folder);
    }

    #[tokio::test]
    async fn fails_with_the_last_reason_when_no_address_works() {
        let folder = temp("nothing");
        let (bytes, sha) = archive(&folder, b"MZ fake libmpv");
        let port = serve(vec![
            ("/a.7z", Reply::Status(404)),
            ("/b.7z", Reply::Status(500)),
        ])
        .await;
        let build = build_for(port, &["/a.7z", "/b.7z"], &bytes, &sha);
        let error = install(
            &folder.join("libmpv"),
            &build,
            &http(),
            &AtomicBool::new(false),
            &quiet,
            |_| Ok(()),
        )
        .await
        .unwrap_err();
        assert!(error.starts_with("No se pudo descargar mpv."), "{error}");
        assert!(error.contains("500"), "{error}");
        let _ = std::fs::remove_dir_all(folder);
    }

    #[tokio::test]
    async fn does_not_follow_a_redirect_to_plain_http_elsewhere() {
        let folder = temp("redirect");
        let (bytes, sha) = archive(&folder, b"MZ fake libmpv");
        let port = serve(vec![(
            "/mpv.7z",
            Reply::Redirect("http://example.com/mpv.7z".into()),
        )])
        .await;
        let build = build_for(port, &["/mpv.7z"], &bytes, &sha);
        let error = install(
            &folder.join("libmpv"),
            &build,
            &http(),
            &AtomicBool::new(false),
            &quiet,
            |_| Ok(()),
        )
        .await
        .unwrap_err();
        assert!(error.contains("No se pudo conectar"), "{error}");
        let _ = std::fs::remove_dir_all(folder);
    }

    #[tokio::test]
    async fn a_library_that_fails_the_check_is_not_installed() {
        let folder = temp("verify");
        let (bytes, sha) = archive(&folder, b"MZ fake libmpv");
        let port = serve(vec![("/mpv.7z", Reply::Body(bytes.clone()))]).await;
        let build = build_for(port, &["/mpv.7z"], &bytes, &sha);
        let root = folder.join("libmpv");
        let error = install(
            &root,
            &build,
            &http(),
            &AtomicBool::new(false),
            &quiet,
            |_| Err("no es una libmpv compatible".to_owned()),
        )
        .await
        .unwrap_err();
        assert!(error.contains("compatible"), "{error}");
        assert!(installed_in(&root, "libmpv-2.dll").is_none());
        let _ = std::fs::remove_dir_all(folder);
    }

    #[tokio::test]
    async fn cancelling_stops_the_download() {
        let folder = temp("cancel");
        let (bytes, sha) = archive(&folder, b"MZ fake libmpv");
        let port = serve(vec![("/mpv.7z", Reply::Body(bytes.clone()))]).await;
        let build = build_for(port, &["/mpv.7z"], &bytes, &sha);
        let root = folder.join("libmpv");
        let error = install(
            &root,
            &build,
            &http(),
            &AtomicBool::new(true),
            &quiet,
            |_| Ok(()),
        )
        .await
        .unwrap_err();
        assert!(error.contains("cancelada"), "{error}");
        assert!(!root.join(WORK).exists());
        let _ = std::fs::remove_dir_all(folder);
    }

    /// The pinned build from the real address: size, hash, 7z format and a library that loads.
    /// `cargo test --release real_build -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "downloads about 29 MB from GitHub"]
    async fn the_real_build_downloads_and_loads() {
        let folder = temp("real");
        let root = folder.join("libmpv");
        let started = Instant::now();
        let seen = Mutex::new(0u64);
        let progress = |p: Progress| {
            if p.stage == "download" {
                *seen.lock().unwrap() = p.downloaded;
            }
        };
        let path = install(
            &root,
            build(),
            &http(),
            &AtomicBool::new(false),
            &progress,
            |dll| embedded_mpv::check_library(dll),
        )
        .await
        .unwrap();
        println!(
            "installed {} ({} bytes on disk) in {:?}",
            path.display(),
            std::fs::metadata(&path).unwrap().len(),
            started.elapsed()
        );
        assert_eq!(*seen.lock().unwrap(), build().size);
        assert_eq!(installed_in(&root, &build().entry).unwrap(), path);
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn only_one_download_runs_at_a_time() {
        let installer = Installer::default();
        let first = installer.begin().unwrap();
        assert!(installer.begin().is_err());
        drop(first);
        assert!(installer.begin().is_ok());
    }
}
