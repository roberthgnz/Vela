//! Vela's own torrent engine, for when Stremio's streaming server is not installed or the user
//! prefers it. librqbit downloads the pieces the player asks for first (its `FileStream` reads
//! prioritise the current position); a small HTTP server on 127.0.0.1 with a secret path serves
//! the files with Range support to the integrated player, external players and the subtitle
//! reader. Data lives in the app cache folder: the folder is emptied when the engine starts, a
//! torrent is deleted with its files when the player releases it (after a grace period, so the
//! next episode of a season pack reuses it), and starting a new torrent removes the ones nobody
//! is streaming. Only the chosen video and the subtitle files are downloaded.

use librqbit::dht::{DhtPersistenceConfig, Id20};
use librqbit::{
    AddTorrent, AddTorrentOptions, DhtSessionConfig, ManagedTorrent, Session, SessionOptions,
    api::TorrentIdOrHash,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::OnceCell;

const FOLDER: &str = "torrents";
/// Metadata comes from peers found through trackers and the DHT; a dead torrent gives up here.
const METADATA_TIMEOUT: Duration = Duration::from_secs(60);
/// A released torrent stays this long in case the next episode is in the same torrent.
const RELEASE_GRACE: Duration = Duration::from_secs(90);

const VIDEO: &[&str] = &[
    "mp4", "m4v", "mkv", "webm", "avi", "mov", "wmv", "flv", "ts", "m2ts", "mpg", "mpeg", "ogv",
    "3gp",
];
const SUBTITLE: &[&str] = &["srt", "vtt", "ass", "ssa", "sub"];

#[derive(Default)]
pub struct Engine {
    running: OnceCell<Arc<Running>>,
}

struct Running {
    session: Arc<Session>,
    port: u16,
    token: String,
    /// Open HTTP responses per info hash: a torrent being streamed is never removed.
    streaming: Mutex<HashMap<String, usize>>,
    /// Bumped by every prepare and release; a pending removal only runs if it still matches.
    generation: Mutex<HashMap<String, u64>>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct TorrentFile {
    pub name: String,
    pub length: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    /// Base URL of the files: `{base}/{index}` streams file `index`.
    pub base: String,
    pub file_idx: usize,
    pub file_name: String,
    pub files: Vec<TorrentFile>,
}

#[derive(Serialize)]
pub struct Stats {
    pub peers: u32,
    pub found: u32,
    pub unchoked: u32,
    pub speed: u64,
    pub downloaded: u64,
    pub searching: bool,
}

fn extension(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default()
}

fn is_video(name: &str) -> bool {
    VIDEO.contains(&extension(name).as_str())
}

fn is_subtitle(name: &str) -> bool {
    SUBTITLE.contains(&extension(name).as_str())
}

/// Whether a file name is episode `episode` of season `season` (S01E02, 1x02, s1.e2…).
fn matches_episode(name: &str, season: u32, episode: u32) -> bool {
    let lower = name.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let number = |start: usize| -> Option<(u32, usize)> {
        let digits = bytes[start..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count();
        if digits == 0 || digits > 4 {
            return None;
        }
        lower[start..start + digits]
            .parse()
            .ok()
            .map(|n| (n, start + digits))
    };
    for index in 0..bytes.len() {
        // SxxEyy, with an optional separator between the two parts.
        if bytes[index] == b's'
            && (index == 0 || !bytes[index - 1].is_ascii_alphabetic())
            && let Some((s, mut after)) = number(index + 1)
        {
            if after < bytes.len() && matches!(bytes[after], b'.' | b' ' | b'_' | b'-') {
                after += 1;
            }
            if after < bytes.len()
                && bytes[after] == b'e'
                && let Some((e, end)) = number(after + 1)
                && s == season
                && e == episode
                && (end == bytes.len() || !bytes[end].is_ascii_digit())
            {
                return true;
            }
        }
        // NxMM
        if bytes[index].is_ascii_digit()
            && (index == 0 || !bytes[index - 1].is_ascii_digit())
            && let Some((s, after)) = number(index)
            && after < bytes.len()
            && bytes[after] == b'x'
            && let Some((e, _)) = number(after + 1)
            && s == season
            && e == episode
        {
            return true;
        }
    }
    false
}

/// The file to play: the addon's index when it points to a video, the episode for series, or
/// the largest video. Samples and extras lose to the real file by size.
pub fn choose_file(
    files: &[TorrentFile],
    index: Option<usize>,
    season: Option<u32>,
    episode: Option<u32>,
) -> Result<usize, String> {
    if let Some(index) = index {
        let file = files
            .get(index)
            .ok_or("El índice de archivo de la fuente no existe en este torrent.")?;
        if !is_video(&file.name) {
            return Err(format!(
                "El archivo seleccionado ({}) no es un vídeo. Prueba otra fuente.",
                file.name
            ));
        }
        return Ok(index);
    }
    let videos = files
        .iter()
        .enumerate()
        .filter(|(_, file)| is_video(&file.name));
    if let (Some(season), Some(episode)) = (season, episode)
        && let Some((index, _)) = videos
            .clone()
            .filter(|(_, file)| matches_episode(&file.name, season, episode))
            .max_by_key(|(_, file)| file.length)
    {
        return Ok(index);
    }
    videos
        .max_by_key(|(_, file)| file.length)
        .map(|(index, _)| index)
        .ok_or_else(|| "No hay ningún archivo de vídeo en este torrent.".to_owned())
}

/// A magnet link with the addon's trackers (`tracker:` sources; `dht:` ones need nothing).
fn magnet(info_hash: &str, sources: &[String]) -> String {
    let mut link = format!("magnet:?xt=urn:btih:{info_hash}");
    for source in sources {
        let tracker = source.strip_prefix("tracker:").unwrap_or(source);
        if source.starts_with("dht:") || tracker.is_empty() {
            continue;
        }
        link.push_str("&tr=");
        link.push_str(
            &url::form_urlencoded::byte_serialize(tracker.as_bytes()).collect::<String>(),
        );
    }
    link
}

fn content_type(name: &str) -> &'static str {
    match extension(name).as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "ts" | "m2ts" => "video/mp2t",
        "srt" => "application/x-subrip",
        "vtt" => "text/vtt",
        _ => "application/octet-stream",
    }
}

/// `bytes=start-end` / `bytes=start-` / `bytes=-suffix` against a file of `length` bytes.
pub fn parse_range(value: &str, length: u64) -> Option<(u64, u64)> {
    let spec = value.trim().strip_prefix("bytes=")?;
    let spec = spec.split(',').next()?.trim();
    let (start, end) = spec.split_once('-')?;
    if length == 0 {
        return None;
    }
    let (start, end) = if start.is_empty() {
        let suffix: u64 = end.parse().ok()?;
        (length.saturating_sub(suffix), length - 1)
    } else {
        let start: u64 = start.parse().ok()?;
        let end = if end.is_empty() {
            length - 1
        } else {
            end.parse::<u64>().ok()?.min(length - 1)
        };
        (start, end)
    };
    (start <= end && start < length).then_some((start, end))
}

fn hash_of(raw: &str) -> Result<Id20, String> {
    Id20::from_str(raw.trim()).map_err(|_| "El hash del torrent no es válido.".to_owned())
}

fn files_of(torrent: &ManagedTorrent) -> Result<Vec<TorrentFile>, String> {
    torrent
        .with_metadata(|metadata| {
            metadata
                .file_infos
                .iter()
                .map(|file| TorrentFile {
                    name: file.relative_filename.to_string_lossy().replace('\\', "/"),
                    length: file.len,
                })
                .collect::<Vec<_>>()
        })
        .map_err(|_| "El torrent aún no tiene metadatos.".to_owned())
}

impl Running {
    async fn start(cache: PathBuf) -> Result<Arc<Self>, String> {
        let folder = cache.join(FOLDER);
        // Streaming data from earlier runs is not kept.
        let _ = tokio::fs::remove_dir_all(&folder).await;
        tokio::fs::create_dir_all(&folder)
            .await
            .map_err(|error| format!("No se pudo crear la carpeta de torrents: {error}"))?;
        let options = SessionOptions {
            // The DHT's known nodes are kept between runs (outside the emptied folder) so peers
            // are found quickly; librqbit would otherwise write them to its own cache folder.
            dht: Some(DhtSessionConfig {
                persistence: Some(DhtPersistenceConfig {
                    config_filename: Some(cache.join("dht.json")),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            fastresume: false,
            persistence: None,
            client_name_and_version: Some(format!("Vela {}", env!("CARGO_PKG_VERSION"))),
            ..Default::default()
        };
        let session = Session::new_with_opts(folder, options)
            .await
            .map_err(|error| format!("No se pudo iniciar el motor de torrents: {error:#}"))?;
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| format!("No se pudo abrir el servidor de torrents: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let running = Arc::new(Self {
            session,
            port,
            token: crate::proxy::token(),
            streaming: Mutex::default(),
            generation: Mutex::default(),
        });
        let server = running.clone();
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let server = server.clone();
                tokio::spawn(async move {
                    let _ = server.handle(socket).await;
                });
            }
        });
        crate::logging::log_info!("torrent engine listening on 127.0.0.1:{port}");
        Ok(running)
    }

    fn bump(&self, hash: &str) -> u64 {
        let mut generations = self.generation.lock().unwrap_or_else(|p| p.into_inner());
        let entry = generations.entry(hash.to_owned()).or_default();
        *entry += 1;
        *entry
    }

    fn is_streaming(&self, hash: &str) -> bool {
        self.streaming
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(hash)
            .is_some_and(|count| *count > 0)
    }

    /// Removes every torrent but `keep` that nobody is streaming.
    async fn prune(&self, keep: &str) {
        let others: Vec<String> = self.session.with_torrents(|torrents| {
            torrents
                .map(|(_, torrent)| torrent.info_hash().as_string())
                .filter(|hash| hash != keep)
                .collect()
        });
        for hash in others {
            if !self.is_streaming(&hash)
                && let Ok(id) = hash_of(&hash)
            {
                let _ = self.session.delete(TorrentIdOrHash::Hash(id), true).await;
            }
        }
    }

    async fn prepare(
        &self,
        info_hash: &str,
        file_idx: Option<usize>,
        sources: &[String],
        season: Option<u32>,
        episode: Option<u32>,
    ) -> Result<Prepared, String> {
        let id = hash_of(info_hash)?;
        let hash = id.as_string();
        self.bump(&hash);
        self.prune(&hash).await;
        let torrent = match self.session.get(TorrentIdOrHash::Hash(id)) {
            Some(torrent) => torrent,
            None => {
                let add = self.session.add_torrent(
                    AddTorrent::from_url(magnet(&hash, sources)),
                    Some(AddTorrentOptions {
                        // Nothing is downloaded until the files are chosen below.
                        paused: true,
                        overwrite: true,
                        ..Default::default()
                    }),
                );
                tokio::time::timeout(METADATA_TIMEOUT, add)
                    .await
                    .map_err(|_| {
                        "El torrent no ha respondido: no se encontraron pares ni metadatos a tiempo. Prueba otra fuente.".to_owned()
                    })?
                    .map_err(|error| format!("No se pudo abrir el torrent: {error:#}"))?
                    .into_handle()
                    .ok_or("No se pudo abrir el torrent.")?
            }
        };
        // Files can be chosen only once the torrent has checked its (empty) storage.
        tokio::time::timeout(METADATA_TIMEOUT, torrent.wait_until_initialized())
            .await
            .map_err(|_| "El torrent no terminó de prepararse a tiempo.".to_owned())?
            .map_err(|error| format!("No se pudo preparar el torrent: {error:#}"))?;
        let files = files_of(&torrent)?;
        let chosen = choose_file(&files, file_idx, season, episode)?;
        let mut wanted: HashSet<usize> = files
            .iter()
            .enumerate()
            .filter(|(_, file)| is_subtitle(&file.name))
            .map(|(index, _)| index)
            .collect();
        wanted.insert(chosen);
        // Files chosen for an earlier episode of the same torrent stay wanted.
        if let Some(previous) = torrent.only_files() {
            wanted.extend(previous);
        }
        self.session
            .update_only_files(&torrent, &wanted)
            .await
            .map_err(|error| format!("No se pudo elegir el archivo del torrent: {error:#}"))?;
        if torrent.is_paused() {
            self.session
                .unpause(&torrent)
                .await
                .map_err(|error| format!("No se pudo iniciar el torrent: {error:#}"))?;
        }
        Ok(Prepared {
            base: format!("http://127.0.0.1:{}/{}/{hash}", self.port, self.token),
            file_idx: chosen,
            file_name: files[chosen].name.clone(),
            files,
        })
    }

    fn stats(&self, info_hash: &str) -> Result<Stats, String> {
        let id = hash_of(info_hash)?;
        let torrent = self
            .session
            .get(TorrentIdOrHash::Hash(id))
            .ok_or("Este torrent no está abierto en Vela.")?;
        let stats = torrent.stats();
        let (peers, found, unchoked, speed) = stats.live.as_ref().map_or((0, 0, 0, 0), |live| {
            let peers = &live.snapshot.peer_stats;
            (
                peers.live,
                peers.seen,
                peers.live_seeders,
                live.download_speed.as_bytes(),
            )
        });
        Ok(Stats {
            peers,
            found,
            unchoked,
            speed,
            downloaded: stats.progress_bytes,
            searching: stats.live.is_none() && !stats.finished,
        })
    }

    async fn release(self: Arc<Self>, info_hash: &str) {
        let Ok(id) = hash_of(info_hash) else { return };
        let hash = id.as_string();
        let generation = self.bump(&hash);
        tokio::spawn(async move {
            tokio::time::sleep(RELEASE_GRACE).await;
            let current = self
                .generation
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(&hash)
                .copied();
            if current == Some(generation) && !self.is_streaming(&hash) {
                let _ = self.session.delete(TorrentIdOrHash::Hash(id), true).await;
            }
        });
    }

    async fn handle(self: Arc<Self>, mut socket: TcpStream) -> std::io::Result<()> {
        let Some(head) = crate::proxy::read_head(&mut socket).await else {
            return crate::proxy::reply(&mut socket, "400 Bad Request").await;
        };
        let mut lines = head.split("\r\n");
        let mut request = lines.next().unwrap_or_default().split(' ');
        let (method, path) = (
            request.next().unwrap_or_default(),
            request.next().unwrap_or_default(),
        );
        if method == "OPTIONS" {
            // CORS preflight for page requests with a Range header.
            let head = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD\r\nAccess-Control-Allow-Headers: Range\r\nAccess-Control-Max-Age: 600\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            return socket.write_all(head.as_bytes()).await;
        }
        if method != "GET" && method != "HEAD" {
            return crate::proxy::reply(&mut socket, "405 Method Not Allowed").await;
        }
        let range = lines.find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("range")
                .then(|| value.trim().to_owned())
        });
        let mut parts = path.trim_start_matches('/').split('/');
        let (token, hash, index) = (parts.next(), parts.next(), parts.next());
        if token != Some(self.token.as_str()) {
            return crate::proxy::reply(&mut socket, "404 Not Found").await;
        }
        let (Some(Ok(id)), Some(Ok(index))) = (
            hash.map(hash_of),
            index.map(|i| i.split('?').next().unwrap_or(i).parse::<usize>()),
        ) else {
            return crate::proxy::reply(&mut socket, "404 Not Found").await;
        };
        let Some(torrent) = self.session.get(TorrentIdOrHash::Hash(id)) else {
            return crate::proxy::reply(&mut socket, "404 Not Found").await;
        };
        let Ok(files) = files_of(&torrent) else {
            return crate::proxy::reply(&mut socket, "503 Service Unavailable").await;
        };
        let Some(file) = files.get(index).cloned() else {
            return crate::proxy::reply(&mut socket, "404 Not Found").await;
        };
        let hash = id.as_string();
        let length = file.length;
        let (status, start, end) = match range.as_deref().map(|r| parse_range(r, length)) {
            Some(Some((start, end))) => ("206 Partial Content", start, end),
            Some(None) => {
                let head = format!(
                    "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{length}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                return socket.write_all(head.as_bytes()).await;
            }
            None => ("200 OK", 0, length.saturating_sub(1)),
        };
        let count = if length == 0 { 0 } else { end - start + 1 };
        let mut head = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {}\r\nContent-Length: {count}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\nCache-Control: no-store\r\nConnection: close\r\n",
            content_type(&file.name)
        );
        if status.starts_with("206") {
            head.push_str(&format!("Content-Range: bytes {start}-{end}/{length}\r\n"));
        }
        head.push_str("\r\n");
        socket.write_all(head.as_bytes()).await?;
        if method == "HEAD" || count == 0 {
            return Ok(());
        }
        // Count the response as streaming so the torrent is not removed under the player.
        *self
            .streaming
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(hash.clone())
            .or_default() += 1;
        let result = async {
            let mut stream = torrent
                .clone()
                .stream(index)
                .await
                .map_err(std::io::Error::other)?;
            stream.seek(std::io::SeekFrom::Start(start)).await?;
            let mut limited = (&mut stream).take(count);
            tokio::io::copy(&mut limited, &mut socket).await?;
            socket.flush().await
        }
        .await;
        if let Some(open) = self
            .streaming
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(&hash)
        {
            *open = open.saturating_sub(1);
        }
        result
    }
}

impl Engine {
    async fn running(&self, app: &AppHandle) -> Result<Arc<Running>, String> {
        let cache = app
            .path()
            .app_cache_dir()
            .map_err(|_| "No se encontró la carpeta temporal de la aplicación.".to_owned())?;
        self.running
            .get_or_try_init(|| Running::start(cache))
            .await
            .cloned()
    }

    pub async fn stop(&self) {
        if let Some(running) = self.running.get() {
            running.session.stop().await;
        }
    }
}

#[tauri::command]
pub async fn torrent_prepare(
    app: AppHandle,
    engine: State<'_, Engine>,
    info_hash: String,
    file_idx: Option<usize>,
    sources: Option<Vec<String>>,
    season: Option<u32>,
    episode: Option<u32>,
) -> Result<Prepared, String> {
    let running = engine.running(&app).await?;
    running
        .prepare(
            &info_hash,
            file_idx,
            &sources.unwrap_or_default(),
            season,
            episode,
        )
        .await
        .inspect_err(|error| crate::logging::log_warn!("torrent {info_hash}: {error}"))
}

#[tauri::command]
pub async fn torrent_stats(
    app: AppHandle,
    engine: State<'_, Engine>,
    info_hash: String,
) -> Result<Stats, String> {
    engine.running(&app).await?.stats(&info_hash)
}

#[tauri::command]
pub async fn torrent_release(
    app: AppHandle,
    engine: State<'_, Engine>,
    info_hash: String,
) -> Result<(), String> {
    engine.running(&app).await?.release(&info_hash).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, length: u64) -> TorrentFile {
        TorrentFile {
            name: name.to_owned(),
            length,
        }
    }

    #[test]
    fn recognises_episode_names() {
        assert!(matches_episode("Show.S01E02.1080p.mkv", 1, 2));
        assert!(matches_episode("show s1e2.mp4", 1, 2));
        assert!(matches_episode("Show - S01.E02 - Title.mkv", 1, 2));
        assert!(matches_episode("Show 1x02.avi", 1, 2));
        assert!(!matches_episode("Show.S01E12.mkv", 1, 2));
        assert!(!matches_episode("Show.S01E02.mkv", 2, 2));
        assert!(!matches_episode("Show.S01E020.mkv", 1, 2));
        assert!(!matches_episode("Glass.mkv", 1, 2));
    }

    #[test]
    fn chooses_the_index_the_episode_or_the_largest_video() {
        let files = vec![
            file("Show/Sample.mkv", 10),
            file("Show/Show.S01E01.mkv", 900),
            file("Show/Show.S01E02.mkv", 800),
            file("Show/Show.S01E02.srt", 1),
            file("Show/cover.jpg", 5),
        ];
        assert_eq!(choose_file(&files, Some(2), None, None), Ok(2));
        assert!(
            choose_file(&files, Some(3), None, None)
                .unwrap_err()
                .contains("no es un vídeo")
        );
        assert!(
            choose_file(&files, Some(9), None, None)
                .unwrap_err()
                .contains("no existe")
        );
        assert_eq!(choose_file(&files, None, Some(1), Some(2)), Ok(2));
        assert_eq!(choose_file(&files, None, Some(1), Some(7)), Ok(1));
        assert_eq!(choose_file(&files, None, None, None), Ok(1));
        assert!(choose_file(&[file("a.txt", 1)], None, None, None).is_err());
    }

    #[test]
    fn builds_magnets_with_the_addon_trackers() {
        let link = magnet(
            "abc",
            &[
                "tracker:udp://tracker.example:80/announce".to_owned(),
                "dht:abc".to_owned(),
                "http://t.example/a?b=c".to_owned(),
            ],
        );
        assert_eq!(
            link,
            "magnet:?xt=urn:btih:abc&tr=udp%3A%2F%2Ftracker.example%3A80%2Fannounce&tr=http%3A%2F%2Ft.example%2Fa%3Fb%3Dc"
        );
    }

    #[test]
    fn parses_ranges() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_range("bytes=90-200", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=20-10", 100), None);
        assert_eq!(parse_range("items=0-1", 100), None);
        assert_eq!(parse_range("bytes=0-", 0), None);
    }
}
