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
    AddTorrent, AddTorrentOptions, AddTorrentResponse, ConnectionOptions, DhtSessionConfig,
    ListenerMode, ListenerOptions, ManagedTorrent, PeerConnectionOptions, Session, SessionOptions,
    api::TorrentIdOrHash,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::net::{Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::OnceCell;

type ManagedTorrentHandle = Arc<ManagedTorrent>;

const FOLDER: &str = "torrents";
/// Metadata comes from peers found through trackers and the DHT; a dead torrent gives up here.
const METADATA_TIMEOUT: Duration = Duration::from_secs(60);
/// Bytes handed to the player per read. librqbit reads a piece from disk on every call, so the
/// 8 KiB of `tokio::io::copy` meant thousands of disk reads per second at 4K bitrates.
const COPY_BUFFER: usize = 512 * 1024;
/// Concurrent blocking work in librqbit: every open file stream holds one slot for its whole life
/// and every chunk received from a peer needs one to reach the disk. librqbit's default of 8 let a
/// few player requests stall the download.
const BLOCKING_SLOTS: usize = 64;
/// Connected peers per torrent. For streaming it matters more that every piece of the window is
/// held by a fast peer than having many peers: each one more is one more that may sit on a piece
/// at the head of the file, and librqbit only takes pieces from peers 10 times slower (see
/// `REQUEST_WINDOW`), starting with the oldest piece in flight in the whole file rather than the
/// one a stream waits for. Measured with Big Buck Bunny (256 KiB pieces), delivered in order in
/// 60 s: 0.26 MB/s with 200 (80 peers live, 20-30 s gaps in the first 32 MB), 0.76 with 60 and
/// 0.89-1.91 with 30, with no loss of raw download speed (1.7 / 2.1 / 1.2-2.4 MB/s). librqbit's
/// default of 128 has the same problem.
const PEER_LIMIT: usize = 40;
/// Size of a chunk request (the BitTorrent block).
const CHUNK_SIZE: u64 = 16 * 1024;
/// Chunk requests kept outstanding per peer, as the session's value: it covers torrents added
/// without metadata; the ones `Running::add` opens get `request_window` for their piece size.
///
/// What matters is how many pieces each peer holds, not bytes. librqbit hands a peer a new piece
/// as soon as it has requested every chunk of the current one (in the file's order once past
/// the streams' windows), and only takes a piece away from a peer that is 10 times slower than
/// the average of the one asking, an average that includes the time pieces wait in its queue.
/// With librqbit's 128 (or 64) and small pieces every peer queued many of them, that average
/// grew, slow peers kept pieces from the start of the file and the player waited 20-30 s while
/// the torrent downloaded 60-100 MB further on. Two pieces per peer keep the queues short, so
/// taking pieces from slow peers works and the first pieces are not held hostage. Measured with
/// Sintel (128 KiB pieces, 4 runs each, fresh cache): median 39 MB delivered in order in 60 s
/// with 16, against 7 with 64 and with 128.
const REQUEST_WINDOW: usize = 16;

/// The request window for pieces of `piece` bytes: two pieces in flight per peer. That keeps the
/// queues short (see `REQUEST_WINDOW`), and with big pieces leaves enough bytes in flight for a
/// fast peer; a flat 16 would cap every peer at 256 KiB per round trip (about 0.85 MB/s at
/// 300 ms), too little for 4K from a seedbox. 16 for 128 KiB pieces (what was measured), 128
/// (librqbit's default, 2 MiB in flight) from 1 MiB pieces up.
fn request_window(piece: u64) -> usize {
    (2 * piece / CHUNK_SIZE).clamp(16, 128) as usize
}
/// What librqbit prioritises ahead of each open stream (`PER_STREAM_BUF_DEFAULT`, not
/// configurable). Past it, pieces are downloaded from the start of the file.
const STREAM_WINDOW: u64 = 32 * 1024 * 1024;
/// At most this many extra windows are kept ahead of a reader (see `windows_ahead`). Each is a
/// librqbit stream holding one of the `BLOCKING_SLOTS` while the response lasts, slots that the
/// peers also need to write what they send. With `PEER_LIMIT` peers it is exactly what 4 MiB
/// pieces need (8 per window, 40 pieces in 5 windows) and costs 5 slots per response. Bigger
/// pieces stop at 160 MiB of priority (10 pieces of 16 MiB) and the remaining peers go on in the
/// file's order, which after a seek is its start; raising it is the thing to measure on a torrent
/// with big pieces.
const MAX_WINDOWS_AHEAD: u64 = 4;
/// The extra windows move with the reader every this many bytes...
const AHEAD_STEP: u64 = 4 * 1024 * 1024;
/// ...or this often, so that a reader waiting for its piece follows the swarm as it grows.
const AHEAD_RECHECK: Duration = Duration::from_secs(2);
/// The head of the file is fetched as soon as the torrent opens, before the player asks for it.
const WARM_HEAD: u64 = 8 * 1024 * 1024;
/// MKV indexes (Cues) usually sit at the end and are read on the first seek.
const WARM_TAIL: u64 = 4 * 1024 * 1024;
/// Public trackers added to every torrent, besides the addon's: with only the DHT, a bare magnet
/// can take a minute to find anyone. From ngosang/trackerslist (best).
///
/// Caveat (librqbit 9.1.0, `Session::make_peer_rx`): a private torrent with more than one tracker
/// is cut to its first and gets none of these, but one that brings exactly one tracker does get
/// them, announcing a private hash to public trackers. Rare through addons, which hand out
/// public torrents, so left as is.
const DEFAULT_TRACKERS: &[&str] = &[
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://open.tracker.cl:1337/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://explodie.org:6969/announce",
    "udp://tracker.qu.ax:6969/announce",
    "udp://tracker-udp.gbitt.info:80/announce",
    "udp://tracker2.dler.org:80/announce",
    "udp://tracker.gmi.gd:6969/announce",
    "http://tracker.opentrackr.org:1337/announce",
    "http://tracker.dler.org:6969/announce",
];
/// A released torrent stays this long in case the next episode is in the same torrent.
const RELEASE_GRACE: Duration = Duration::from_secs(90);
/// A released torrent still being served is checked again this often...
const RELEASE_RETRY: Duration = Duration::from_secs(30);
/// ...and removed anyway after this many checks (a response stuck waiting for pieces).
const RELEASE_ATTEMPTS: u32 = 20;

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
    /// Emptied when the engine stops, so nothing is left on disk after Vela exits.
    folder: PathBuf,
    port: u16,
    token: String,
    /// Open HTTP responses per info hash: a torrent being streamed is never removed.
    streaming: Mutex<HashMap<String, usize>>,
    /// Bumped by every prepare and release; a pending removal only runs if it still matches.
    generation: Mutex<HashMap<String, u64>>,
    /// Files whose head is being fetched ahead of the player (see `warm`). Each warm-up holds a
    /// librqbit stream, and with it one blocking slot, so preparing the same file again while
    /// one runs does not start another. Entries leave when the warm-up ends, so a torrent that
    /// was deleted and opened again is warmed again.
    warming: Arc<Mutex<HashSet<(Id20, usize)>>>,
    tuning: Tuning,
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

/// The files a torrent downloads: the chosen video and the subtitles. Earlier episodes of a season
/// pack are not kept downloading.
fn wanted_files(files: &[TorrentFile], chosen: usize) -> HashSet<usize> {
    let mut wanted: HashSet<usize> = files
        .iter()
        .enumerate()
        .filter(|(_, file)| is_subtitle(&file.name))
        .map(|(index, _)| index)
        .collect();
    wanted.insert(chosen);
    wanted
}

/// How many extra priority windows a reader needs so that every connected peer downloads near
/// the read position. librqbit gives each peer a whole piece and only prioritises
/// `STREAM_WINDOW` ahead of a stream; the other peers take pieces from the start of the file.
/// Playing from the start that is the same thing, but after a seek or when resuming they were
/// fetching the beginning while the player waited. With fewer peers than pieces in the window
/// nothing is added: librqbit shuffles the windows, and an extra one could take the only free
/// peer away from the piece the player needs now. Never past `remaining` bytes.
fn windows_ahead(peers: u64, piece: u64, remaining: u64) -> usize {
    if piece == 0 {
        return 0;
    }
    let per_window = (STREAM_WINDOW / piece).max(1);
    let wanted = peers.div_ceil(per_window).saturating_sub(1);
    let fit = remaining
        .saturating_sub(STREAM_WINDOW)
        .div_ceil(STREAM_WINDOW);
    wanted.min(fit).min(MAX_WINDOWS_AHEAD) as usize
}

fn piece_length(torrent: &ManagedTorrent) -> u64 {
    torrent
        .with_metadata(|metadata| metadata.lengths().default_piece_length() as u64)
        .unwrap_or_default()
}

fn live_peers(torrent: &ManagedTorrent) -> u64 {
    torrent
        .stats()
        .live
        .map_or(0, |live| live.snapshot.peer_stats.live as u64)
}

/// Where an MP4's index (`moov`) starts when it comes after the media data, from the first bytes
/// of the file. None when the index comes first (the player then needs nothing from the end) or
/// the boxes cannot be read.
fn mp4_index_after_media(head: &[u8], length: u64) -> Option<u64> {
    let mut offset = 0u64;
    let mut media_seen = false;
    while offset + 8 <= head.len() as u64 {
        let at = offset as usize;
        let size32 = u32::from_be_bytes(head[at..at + 4].try_into().ok()?) as u64;
        let kind = &head[at + 4..at + 8];
        let size = match size32 {
            0 => length - offset,
            1 => u64::from_be_bytes(head.get(at + 8..at + 16)?.try_into().ok()?),
            size => size,
        };
        if size < 8 {
            return None;
        }
        match kind {
            b"moov" => return media_seen.then_some(offset),
            b"mdat" => media_seen = true,
            _ => {}
        }
        offset += size;
        // Past the head: the next box is out of sight, which after `mdat` is where moov starts.
        if media_seen && offset > head.len() as u64 {
            return (offset < length).then_some(offset);
        }
    }
    None
}

/// Starts fetching what the player will ask for first, while the interface is still getting
/// ready: the head of the file, then the MP4 index if it comes last, or the end of an MKV, where
/// its seek index usually is. Readers are librqbit streams, which prioritise the pieces ahead of
/// them; the bytes are discarded and stay on disk for the player. `done` runs when it ends.
fn warm(
    torrent: ManagedTorrentHandle,
    index: usize,
    file: &TorrentFile,
    done: impl FnOnce() + Send + 'static,
) {
    let (name, length) = (file.name.clone(), file.length);
    tokio::spawn(async move {
        // Runs on every exit, also when the task is cancelled with the runtime.
        struct Done<F: FnOnce()>(Option<F>);
        impl<F: FnOnce()> Drop for Done<F> {
            fn drop(&mut self) {
                if let Some(done) = self.0.take() {
                    done();
                }
            }
        }
        let _done = Done(Some(done));
        let read = async |start: u64, count: u64, keep: usize| -> Option<Vec<u8>> {
            let mut stream = torrent.clone().stream(index).await.ok()?;
            stream.seek(std::io::SeekFrom::Start(start)).await.ok()?;
            let mut limited = (&mut stream).take(count);
            let mut kept = Vec::with_capacity(keep);
            let mut buffer = vec![0u8; COPY_BUFFER];
            loop {
                let read = limited.read(&mut buffer).await.ok()?;
                if read == 0 {
                    return Some(kept);
                }
                let room = keep.saturating_sub(kept.len()).min(read);
                kept.extend_from_slice(&buffer[..room]);
            }
        };
        let work = async {
            let head = read(0, WARM_HEAD.min(length), 64 * 1024).await?;
            let tail = match extension(&name).as_str() {
                "mp4" | "m4v" | "mov" => mp4_index_after_media(&head, length),
                "mkv" | "webm" => Some(length.saturating_sub(WARM_TAIL)),
                _ => None,
            };
            if let Some(start) = tail.filter(|start| *start >= WARM_HEAD.min(length)) {
                read(start, length - start, 0).await?;
            }
            Some(())
        };
        let _ = tokio::time::timeout(Duration::from_secs(180), work).await;
    });
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

/// Peer settings that decide how pieces spread over the swarm, kept together so the benchmark
/// can compare values against a live swarm.
#[derive(Clone, Copy, Debug)]
struct Tuning {
    /// A fixed request window for the torrents `Running::add` opens, instead of
    /// `request_window` for their piece size.
    request_window: Option<usize>,
    /// Connected peers per torrent.
    peer_limit: usize,
}

impl Default for Tuning {
    fn default() -> Self {
        Self {
            request_window: None,
            peer_limit: PEER_LIMIT,
        }
    }
}

impl Running {
    async fn start(cache: PathBuf) -> Result<Arc<Self>, String> {
        Self::start_tuned(cache, Tuning::default()).await
    }

    async fn start_tuned(cache: PathBuf, tuning: Tuning) -> Result<Arc<Self>, String> {
        let folder = cache.join(FOLDER);
        // Streaming data from earlier runs is not kept.
        let _ = tokio::fs::remove_dir_all(&folder).await;
        tokio::fs::create_dir_all(&folder)
            .await
            .map_err(|error| format!("No se pudo crear la carpeta de torrents: {error}"))?;
        let options = |listen: bool| SessionOptions {
            // The DHT's known nodes are kept between runs (outside the emptied folder) so peers
            // are found quickly; librqbit would otherwise write them to its own cache folder.
            dht: Some(DhtSessionConfig {
                persistence: Some(DhtPersistenceConfig {
                    config_filename: Some(cache.join("dht.json")),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            // Without a listening port only outgoing connections exist: peers behind NAT (most
            // of a swarm) could never reach Vela, and trackers were told a port nobody listens
            // on. uTP is tried when TCP does not connect within a second; UPnP opens the port.
            listen: listen.then(|| ListenerOptions {
                mode: ListenerMode::TcpAndUtp,
                listen_addr: SocketAddr::from((Ipv6Addr::UNSPECIFIED, 0)),
                enable_upnp_port_forwarding: true,
                ..Default::default()
            }),
            connect: Some(ConnectionOptions {
                peer_opts: Some(PeerConnectionOptions {
                    // Dead addresses are dropped sooner so live peers get the slots (default 10 s).
                    connect_timeout: Some(Duration::from_secs(5)),
                    // For torrents added without metadata; `Running::add` sets the window of
                    // each torrent from its piece size (see `REQUEST_WINDOW`).
                    max_request_window: Some(REQUEST_WINDOW),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            trackers: DEFAULT_TRACKERS
                .iter()
                .filter_map(|tracker| url::Url::parse(tracker).ok())
                .collect(),
            peer_limit: Some(tuning.peer_limit),
            runtime_worker_threads: Some(BLOCKING_SLOTS),
            fastresume: false,
            persistence: None,
            client_name_and_version: Some(format!("Vela {}", env!("CARGO_PKG_VERSION"))),
            ..Default::default()
        };
        let session = match Session::new_with_opts(folder.clone(), options(true)).await {
            Ok(session) => session,
            Err(error) => {
                // A port that cannot be opened must not leave Vela without an engine.
                crate::logging::log_warn!("torrent engine without incoming peers: {error:#}");
                Session::new_with_opts(folder.clone(), options(false))
                    .await
                    .map_err(|error| {
                        format!("No se pudo iniciar el motor de torrents: {error:#}")
                    })?
            }
        };
        Self::serve(session, folder, tuning).await
    }

    /// Opens the local HTTP server of a session's files.
    async fn serve(
        session: Arc<Session>,
        folder: PathBuf,
        tuning: Tuning,
    ) -> Result<Arc<Self>, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| format!("No se pudo abrir el servidor de torrents: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let running = Arc::new(Self {
            session,
            folder,
            port,
            token: crate::proxy::token(),
            streaming: Mutex::default(),
            generation: Mutex::default(),
            warming: Arc::default(),
            tuning,
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

    /// The request window of a torrent with pieces of `piece` bytes.
    fn window_for(&self, piece: u64) -> usize {
        self.tuning
            .request_window
            .unwrap_or_else(|| request_window(piece))
    }

    /// Warms up a file (see the free function `warm`) unless that is already under way.
    fn warm(&self, id: Id20, torrent: ManagedTorrentHandle, index: usize, file: &TorrentFile) {
        let key = (id, index);
        if !self
            .warming
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(key)
        {
            return;
        }
        let warming = self.warming.clone();
        warm(torrent, index, file, move || {
            warming
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&key);
        });
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

    /// Fetches the metadata, chooses the file and starts downloading only that file and the
    /// subtitles. The metadata is read with a listing first so the selection exists from the
    /// start; the peers found meanwhile are handed to the torrent. (Adding the torrent paused and
    /// unpausing it later threw them away and searched the DHT and trackers again.)
    async fn add(
        &self,
        hash: &str,
        sources: &[String],
        file_idx: Option<usize>,
        season: Option<u32>,
        episode: Option<u32>,
    ) -> Result<(ManagedTorrentHandle, Vec<TorrentFile>, usize), String> {
        let listing = self.session.add_torrent(
            AddTorrent::from_url(magnet(hash, sources)),
            Some(AddTorrentOptions {
                list_only: true,
                ..Default::default()
            }),
        );
        let listed = tokio::time::timeout(METADATA_TIMEOUT, listing)
            .await
            .map_err(|_| {
                "El torrent no ha respondido: no se encontraron pares ni metadatos a tiempo. Prueba otra fuente.".to_owned()
            })?
            .map_err(|error| format!("No se pudo abrir el torrent: {error:#}"))?;
        let listed = match listed {
            AddTorrentResponse::ListOnly(listed) => listed,
            // Opened by a concurrent prepare meanwhile, maybe for another episode of the pack.
            AddTorrentResponse::AlreadyManaged(_, torrent)
            | AddTorrentResponse::Added(_, torrent) => {
                return self.select(torrent, file_idx, season, episode).await;
            }
        };
        let files: Vec<TorrentFile> = listed
            .info
            .iter_file_details()
            .map(|file| TorrentFile {
                name: file
                    .filename
                    .to_pathbuf()
                    .to_string_lossy()
                    .replace('\\', "/"),
                length: file.len,
            })
            .collect();
        let chosen = choose_file(&files, file_idx, season, episode)?;
        let mut only_files: Vec<usize> = wanted_files(&files, chosen).into_iter().collect();
        only_files.sort_unstable();
        // Two pieces in flight per peer (see `request_window`): short queues, so pieces can be
        // taken from slow peers, and with big pieces enough bytes in flight for a fast one.
        let window = self.window_for(u64::from(listed.info.lengths().default_piece_length()));
        let added = self
            .session
            .add_torrent(
                AddTorrent::from_bytes(listed.torrent_bytes),
                Some(AddTorrentOptions {
                    only_files: Some(only_files),
                    initial_peers: Some(listed.seen_peers),
                    overwrite: true,
                    // librqbit merges these with the session's field by field, so the timeouts
                    // and the rest stay the session's.
                    peer_opts: Some(PeerConnectionOptions {
                        max_request_window: Some(window),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
            )
            .await
            .map_err(|error| format!("No se pudo abrir el torrent: {error:#}"))?;
        match added {
            AddTorrentResponse::Added(_, torrent) => Ok((torrent, files, chosen)),
            // A concurrent prepare added it while the metadata was being read: its selection is
            // the other file, so this one is chosen on top.
            AddTorrentResponse::AlreadyManaged(_, torrent) => {
                self.select(torrent, file_idx, season, episode).await
            }
            AddTorrentResponse::ListOnly(_) => Err("No se pudo abrir el torrent.".to_owned()),
        }
    }

    /// Chooses the file of a torrent that is already open and makes sure it downloads: the
    /// video and the subtitles become the selection, and a paused torrent starts.
    async fn select(
        &self,
        torrent: ManagedTorrentHandle,
        file_idx: Option<usize>,
        season: Option<u32>,
        episode: Option<u32>,
    ) -> Result<(ManagedTorrentHandle, Vec<TorrentFile>, usize), String> {
        tokio::time::timeout(METADATA_TIMEOUT, torrent.wait_until_initialized())
            .await
            .map_err(|_| "El torrent no terminó de prepararse a tiempo.".to_owned())?
            .map_err(|error| format!("No se pudo preparar el torrent: {error:#}"))?;
        let files = files_of(&torrent)?;
        let chosen = choose_file(&files, file_idx, season, episode)?;
        // librqbit closes download resources when the selected files finish. Changing only_files
        // on that live, completed selection can leave the next episode stuck after its shared
        // boundary piece. Restart it around the selection change so its files/peers reopen.
        let stats = torrent.stats();
        if stats.finished
            && stats.file_progress.get(chosen).copied().unwrap_or(0) < files[chosen].length
            && !torrent.is_paused()
        {
            self.session.pause(&torrent).await.map_err(|error| {
                format!("No se pudo preparar el siguiente archivo del torrent: {error:#}")
            })?;
        }
        self.session
            .update_only_files(&torrent, &wanted_files(&files, chosen))
            .await
            .map_err(|error| format!("No se pudo elegir el archivo del torrent: {error:#}"))?;
        if torrent.is_paused() {
            self.session
                .unpause(&torrent)
                .await
                .map_err(|error| format!("No se pudo iniciar el torrent: {error:#}"))?;
        }
        Ok((torrent, files, chosen))
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
        let (torrent, files, chosen) = match self.session.get(TorrentIdOrHash::Hash(id)) {
            // Already open (another episode of a season pack): only the selection changes.
            Some(torrent) => self.select(torrent, file_idx, season, episode).await?,
            None => self.add(&hash, sources, file_idx, season, episode).await?,
        };
        self.warm(id, torrent, chosen, &files[chosen]);
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
            for attempt in 0..=RELEASE_ATTEMPTS {
                let current = self
                    .generation
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(&hash)
                    .copied();
                // Prepared again meanwhile: someone wants it.
                if current != Some(generation) {
                    return;
                }
                if !self.is_streaming(&hash) || attempt == RELEASE_ATTEMPTS {
                    let _ = self.session.delete(TorrentIdOrHash::Hash(id), true).await;
                    return;
                }
                tokio::time::sleep(RELEASE_RETRY).await;
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
        let (mut reader, mut writer) = socket.split();
        let copy = async {
            let open = || async {
                torrent
                    .clone()
                    .stream(index)
                    .await
                    .map_err(std::io::Error::other)
            };
            let mut stream = open().await?;
            stream.seek(std::io::SeekFrom::Start(start)).await?;
            let piece = piece_length(&torrent);
            let end = start + count;
            let mut position = start;
            // Extra streams placed one after another past the reader's own window (see
            // `windows_ahead`); they are never read, only moved along with the reader.
            let mut ahead = Vec::new();
            let mut followed: Option<(u64, std::time::Instant)> = None;
            let mut buffer = vec![0u8; COPY_BUFFER];
            while position < end {
                if followed.is_none_or(|(at, when)| {
                    position >= at + AHEAD_STEP || when.elapsed() >= AHEAD_RECHECK
                }) {
                    let wanted = windows_ahead(live_peers(&torrent), piece, end - position);
                    ahead.truncate(wanted);
                    while ahead.len() < wanted {
                        ahead.push(open().await?);
                    }
                    for (window, extra) in ahead.iter_mut().enumerate() {
                        let at = position + (window as u64 + 1) * STREAM_WINDOW;
                        extra.seek(std::io::SeekFrom::Start(at)).await?;
                    }
                    followed = Some((position, std::time::Instant::now()));
                }
                let want = buffer.len().min((end - position) as usize);
                // Reads are cancel-safe: a piece that is not there yet consumes nothing, so the
                // wait is cut short to look at the swarm again (a seek waits for its piece while
                // more peers connect).
                let read =
                    match tokio::time::timeout(AHEAD_RECHECK, stream.read(&mut buffer[..want]))
                        .await
                    {
                        Ok(read) => read?,
                        Err(_) => continue,
                    };
                if read == 0 {
                    break;
                }
                writer.write_all(&buffer[..read]).await?;
                position += read as u64;
            }
            writer.flush().await
        };
        // The player drops a request when it seeks or closes. A response waiting for a piece
        // would not notice until that piece arrived, and meanwhile its stream kept claiming the
        // download for the old position. The request was read whole, so anything the client
        // does now on the socket (closing it) ends the response and frees the stream.
        let closed = async {
            let mut sink = [0u8; 256];
            while matches!(reader.read(&mut sink).await, Ok(read) if read > 0) {}
        };
        let result = tokio::select! {
            result = copy => result,
            _ = closed => Ok(()),
        };
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

    /// Stops the session and deletes what it downloaded.
    pub async fn stop(&self) {
        if let Some(running) = self.running.get() {
            running.session.stop().await;
            let _ = tokio::fs::remove_dir_all(&running.folder).await;
        }
    }
}

/// Starts the engine ahead of the first torrent (the window asks when Vela opens and the engine
/// will be used): the DHT gets its nodes and the listening port is open by the time a torrent is
/// played. Starting it again does nothing.
#[tauri::command]
pub async fn torrent_warm(app: AppHandle, engine: State<'_, Engine>) -> Result<(), String> {
    engine.running(&app).await.map(|_| ())
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

    #[test]
    fn keeps_two_pieces_in_flight_per_peer() {
        const KIB: u64 = 1024;
        // Sintel's 128 KiB pieces get the measured 16.
        assert_eq!(request_window(128 * KIB), 16);
        assert_eq!(request_window(256 * KIB), 32);
        assert_eq!(request_window(512 * KIB), 64);
        // From 1 MiB up, librqbit's 128: two pieces, 2 MiB in flight per peer.
        assert_eq!(request_window(1024 * KIB), 128);
        assert_eq!(request_window(4 * 1024 * KIB), 128);
        assert_eq!(request_window(16 * 1024 * KIB), 128);
        // Tiny pieces never go below the session's window.
        assert_eq!(request_window(32 * KIB), REQUEST_WINDOW);
        assert_eq!(request_window(0), REQUEST_WINDOW);
    }

    #[test]
    fn adds_windows_only_when_peers_outnumber_the_window() {
        const MIB: u64 = 1024 * 1024;
        let far = 10_000 * MIB;
        // 16 MiB pieces: the reader's window holds 2, so 5 peers need 2 more windows.
        assert_eq!(windows_ahead(5, 16 * MIB, far), 2);
        assert_eq!(windows_ahead(2, 16 * MIB, far), 0);
        assert_eq!(windows_ahead(0, 16 * MIB, far), 0);
        // Small pieces: 32 in the window already cover 20 peers.
        assert_eq!(windows_ahead(20, MIB, far), 0);
        assert_eq!(windows_ahead(20, 4 * MIB, far), 2);
        // At the peer limit: 128 pieces of 256 KiB in the window cover every peer...
        let limit = PEER_LIMIT as u64;
        assert_eq!(windows_ahead(limit, 256 * 1024, far), 0);
        // ...and the cap is exactly what 4 MiB pieces need (8 per window). If the peer limit
        // grows, the cap has to be looked at again.
        assert_eq!(
            windows_ahead(limit, 4 * MIB, far),
            MAX_WINDOWS_AHEAD as usize
        );
        assert_eq!(windows_ahead(limit - 8, 4 * MIB, far), 3);
        // Bigger pieces: capped (16 MiB would want 19 windows for 40 peers).
        assert_eq!(
            windows_ahead(limit, 16 * MIB, far),
            MAX_WINDOWS_AHEAD as usize
        );
        assert_eq!(
            windows_ahead(limit, 64 * MIB, far),
            MAX_WINDOWS_AHEAD as usize
        );
        // Nothing past the end of the request.
        assert_eq!(windows_ahead(5, 16 * MIB, 32 * MIB), 0);
        assert_eq!(windows_ahead(5, 16 * MIB, 40 * MIB), 1);
        assert_eq!(windows_ahead(5, 0, far), 0);
    }

    /// Sends one request to the engine's server and reads the answer: (status line, headers,
    /// body). `keep` limits how long the body is read; the connection is then dropped.
    async fn fetch(
        port: u16,
        request: &str,
        keep: Duration,
    ) -> (String, Vec<(String, String)>, Vec<u8>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        let _ = tokio::time::timeout(keep, socket.read_to_end(&mut raw)).await;
        let split = raw
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .expect("response head");
        let head = String::from_utf8(raw[..split].to_vec()).unwrap();
        let mut lines = head.split("\r\n");
        let status = lines.next().unwrap().to_owned();
        let headers = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
            .collect();
        (status, headers, raw[split + 4..].to_vec())
    }

    /// The server against a local torrent (no DHT, trackers or peers): byte-exact ranges, and a
    /// response waiting for a piece that never comes ends as soon as the client leaves, releasing
    /// the torrent (it was counted as streaming forever before).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn serves_ranges_and_lets_go_of_abandoned_requests() {
        use librqbit::{CreateTorrentOptions, create_torrent, spawn_utils::BlockingSpawner};
        let root = std::env::temp_dir().join(format!("vela-serve-{}", std::process::id()));
        let data = root.join("data");
        std::fs::create_dir_all(&data).unwrap();
        const PIECE: usize = 64 * 1024;
        let content: Vec<u8> = (0..12 * PIECE).map(|i| (i * 7 % 251) as u8).collect();
        let path = data.join("video.mp4");
        std::fs::write(&path, &content).unwrap();
        let created = create_torrent(
            &path,
            CreateTorrentOptions {
                piece_length: Some(PIECE as u32),
                ..Default::default()
            },
            &BlockingSpawner::new(2),
        )
        .await
        .unwrap();
        // The last four pieces are damaged on disk, so they are missing and nobody has them.
        let missing = 8 * PIECE;
        let mut damaged = content.clone();
        damaged[missing..].fill(0);
        std::fs::write(&path, &damaged).unwrap();

        let session = Session::new_with_opts(
            root.join("cache"),
            SessionOptions {
                dht: None,
                disable_trackers: true,
                disable_local_service_discovery: true,
                fastresume: false,
                persistence: None,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let torrent = session
            .add_torrent(
                AddTorrent::from_bytes(created.as_bytes().unwrap()),
                Some(AddTorrentOptions {
                    output_folder: Some(data.to_string_lossy().into_owned()),
                    overwrite: true,
                    ..Default::default()
                }),
            )
            .await
            .unwrap()
            .into_handle()
            .unwrap();
        torrent.wait_until_initialized().await.unwrap();
        let running = Running::serve(session, root.join("cache"), Tuning::default())
            .await
            .unwrap();
        let hash = created.info_hash().as_string();
        let path = format!("/{}/{hash}/0", running.token);
        let get = |range: &str| format!("GET {path} HTTP/1.1\r\nHost: x\r\nRange: {range}\r\n\r\n");
        let quick = Duration::from_secs(10);

        let (status, headers, body) = fetch(running.port, &get("bytes=100-199"), quick).await;
        assert!(status.contains("206"), "{status}");
        assert_eq!(body, &content[100..200]);
        assert!(headers.contains(&(
            "content-range".to_owned(),
            format!("bytes 100-199/{}", content.len())
        )));
        // Across pieces, with more than one read of the copy buffer.
        let (start, end) = (PIECE / 2, missing - 1);
        let (_, _, body) = fetch(running.port, &get(&format!("bytes={start}-{end}")), quick).await;
        assert_eq!(body, &content[start..=end]);
        let (status, _, body) = fetch(
            running.port,
            &format!("HEAD {path} HTTP/1.1\r\nHost: x\r\n\r\n"),
            quick,
        )
        .await;
        assert!(status.contains("200") && body.is_empty(), "{status}");
        let (status, _, _) = fetch(
            running.port,
            &get(&format!("bytes={}-", content.len())),
            quick,
        )
        .await;
        assert!(status.contains("416"), "{status}");

        // Waits for a missing piece; the client gives up after a moment.
        let (status, _, body) = fetch(
            running.port,
            &get(&format!("bytes={}-", missing + 10)),
            Duration::from_millis(500),
        )
        .await;
        assert!(status.contains("206") && body.is_empty(), "{status}");
        let released = async {
            while running.is_streaming(&hash) {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        };
        assert!(
            tokio::time::timeout(Duration::from_secs(5), released)
                .await
                .is_ok(),
            "the abandoned response still holds the torrent"
        );
        running.session.stop().await;
        let _ = std::fs::remove_dir_all(root);
    }

    fn mp4_box(kind: &[u8; 4], size: u32) -> Vec<u8> {
        let mut bytes = size.to_be_bytes().to_vec();
        bytes.extend_from_slice(kind);
        bytes
    }

    #[test]
    fn finds_the_mp4_index_after_the_media() {
        let length = 1_000_000_000;
        // ftyp, moov, mdat: the index comes first.
        let mut head = mp4_box(b"ftyp", 24);
        head.resize(24, 0);
        head.extend(mp4_box(b"moov", 1000));
        head.resize(1024, 0);
        head.extend(mp4_box(b"mdat", 50_000_000));
        assert_eq!(mp4_index_after_media(&head, length), None);
        // ftyp, free, mdat (past the head): moov starts where mdat ends.
        let mut head = mp4_box(b"ftyp", 24);
        head.resize(24, 0);
        head.extend(mp4_box(b"free", 8));
        head.extend(mp4_box(b"mdat", 900_000_000));
        head.resize(64 * 1024, 0);
        assert_eq!(mp4_index_after_media(&head, length), Some(32 + 900_000_000));
        // 64-bit mdat size.
        let mut head = mp4_box(b"ftyp", 24);
        head.resize(24, 0);
        head.extend(mp4_box(b"mdat", 1));
        head.extend(900_000_000u64.to_be_bytes());
        head.resize(64 * 1024, 0);
        assert_eq!(mp4_index_after_media(&head, length), Some(24 + 900_000_000));
        // A short mdat inside the head followed by moov.
        let mut head = mp4_box(b"ftyp", 24);
        head.resize(24, 0);
        head.extend(mp4_box(b"mdat", 100));
        head.resize(124, 0);
        head.extend(mp4_box(b"moov", 1000));
        head.resize(64 * 1024, 0);
        assert_eq!(mp4_index_after_media(&head, length), Some(124));
        // mdat up to the end of the file, and unreadable boxes.
        let mut head = mp4_box(b"ftyp", 24);
        head.resize(24, 0);
        head.extend(mp4_box(b"mdat", 0));
        assert_eq!(mp4_index_after_media(&head, length), None);
        assert_eq!(
            mp4_index_after_media(&[0, 0, 0, 3, 1, 2, 3, 4], length),
            None
        );
        assert_eq!(mp4_index_after_media(b"not an mp4 at all", length), None);
    }

    /// A reader like the player's: requests `range` and counts the body bytes as they arrive,
    /// which are the bytes the engine delivered in order. Aborting the task closes the request.
    struct Reader {
        delivered: Arc<std::sync::atomic::AtomicU64>,
        first: Arc<std::sync::OnceLock<Duration>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Reader {
        fn open(port: u16, path: &str, range: &str) -> Self {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let delivered = Arc::new(std::sync::atomic::AtomicU64::new(0));
            let first = Arc::new(std::sync::OnceLock::new());
            let request = format!("GET {path} HTTP/1.1\r\nHost: x\r\nRange: {range}\r\n\r\n");
            let (counter, first_byte) = (delivered.clone(), first.clone());
            let task = tokio::spawn(async move {
                let started = std::time::Instant::now();
                let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
                socket.write_all(request.as_bytes()).await.unwrap();
                let mut buffer = vec![0u8; 256 * 1024];
                let mut head = Vec::new();
                let mut in_body = false;
                while let Ok(read) = socket.read(&mut buffer).await {
                    if read == 0 {
                        break;
                    }
                    let body = if in_body {
                        read
                    } else {
                        head.extend_from_slice(&buffer[..read]);
                        let Some(at) = head.windows(4).position(|w| w == b"\r\n\r\n") else {
                            continue;
                        };
                        in_body = true;
                        head.len() - at - 4
                    };
                    if body > 0 {
                        first_byte.get_or_init(|| started.elapsed());
                        counter.fetch_add(body as u64, std::sync::atomic::Ordering::Relaxed);
                    }
                }
            });
            Self {
                delivered,
                first,
                task,
            }
        }

        fn delivered(&self) -> u64 {
            self.delivered.load(std::sync::atomic::Ordering::Relaxed)
        }
    }

    /// Reads `range` for at most `limit`, then closes the request: (time to the first byte,
    /// time to `want` bytes, bytes read).
    async fn timed_read(
        port: u16,
        path: &str,
        range: &str,
        want: u64,
        limit: Duration,
    ) -> (Option<Duration>, Option<Duration>, u64) {
        let reader = Reader::open(port, path, range);
        let started = std::time::Instant::now();
        let mut done = None;
        while started.elapsed() < limit {
            if reader.delivered() >= want {
                done = Some(started.elapsed());
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        reader.task.abort();
        (reader.first.get().copied(), done, reader.delivered())
    }

    fn env<T: FromStr>(name: &str) -> Option<T> {
        std::env::var(name)
            .ok()
            .and_then(|value| value.parse().ok())
    }

    /// A full season is selected episode by episode in one live engine session, over TCP.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn streams_a_complete_season_from_one_torrent() {
        use librqbit::{CreateTorrentOptions, create_torrent, spawn_utils::BlockingSpawner};
        let root = std::env::temp_dir().join(format!(
            "vela-season-{}-{}",
            std::process::id(),
            crate::clock::now().as_millis()
        ));
        let data = root.join("seed");
        std::fs::create_dir_all(&data).unwrap();
        let mut episodes = Vec::new();
        for episode in 1..=3u32 {
            let bytes = if let Ok(folder) = std::env::var("VELA_SEASON_MEDIA") {
                std::fs::read(PathBuf::from(folder).join(format!("ep{episode}.mp4"))).unwrap()
            } else {
                vec![episode as u8; 160_000 + episode as usize * 1000]
            };
            std::fs::write(data.join(format!("Synthetic.S01E{episode:02}.mp4")), &bytes).unwrap();
            episodes.push(bytes);
        }
        std::fs::write(
            data.join("Synthetic.spa.srt"),
            b"1\n00:00:01,000 --> 00:00:02,000\nTest\n",
        )
        .unwrap();
        let created = create_torrent(
            &data,
            CreateTorrentOptions {
                piece_length: Some(64 * 1024),
                ..Default::default()
            },
            &BlockingSpawner::new(2),
        )
        .await
        .unwrap();
        let options = || SessionOptions {
            dht: None,
            disable_trackers: true,
            disable_local_service_discovery: true,
            fastresume: false,
            persistence: None,
            ..Default::default()
        };
        let seed = Session::new_with_opts(
            data.clone(),
            SessionOptions {
                listen: Some(ListenerOptions {
                    listen_addr: "127.0.0.1:0".parse().unwrap(),
                    enable_upnp_port_forwarding: false,
                    ..Default::default()
                }),
                ..options()
            },
        )
        .await
        .unwrap();
        let seed_handle = seed
            .add_torrent(
                AddTorrent::from_bytes(created.as_bytes().unwrap()),
                Some(AddTorrentOptions {
                    output_folder: Some(data.to_string_lossy().into_owned()),
                    overwrite: true,
                    ..Default::default()
                }),
            )
            .await
            .unwrap()
            .into_handle()
            .unwrap();
        seed_handle.wait_until_completed().await.unwrap();
        let folder = root.join("client");
        let client = Session::new_with_opts(folder.clone(), options())
            .await
            .unwrap();
        let torrent = client
            .add_torrent(
                AddTorrent::from_bytes(created.as_bytes().unwrap()),
                Some(AddTorrentOptions {
                    initial_peers: Some(vec![seed.listen_addr().unwrap()]),
                    only_files: Some(vec![]),
                    ..Default::default()
                }),
            )
            .await
            .unwrap()
            .into_handle()
            .unwrap();
        torrent.wait_until_initialized().await.unwrap();
        let running = Running::serve(client, folder, Tuning::default())
            .await
            .unwrap();
        let hash = created.info_hash().as_string();
        for episode in 1..=3u32 {
            let prepared = running
                .prepare(&hash, None, &[], Some(1), Some(episode))
                .await
                .unwrap();
            assert!(prepared.file_name.contains(&format!("S01E{episode:02}")));
            let wanted = wanted_files(&prepared.files, prepared.file_idx);
            assert_eq!(
                wanted.len(),
                2,
                "only this episode and the subtitle should be selected"
            );
            let path = format!("/{}/{hash}/{}", running.token, prepared.file_idx);
            let (status, _, bytes) = fetch(
                running.port,
                &format!("GET {path} HTTP/1.1\r\nHost: x\r\nRange: bytes=0-\r\n\r\n"),
                Duration::from_secs(20),
            )
            .await;
            assert!(status.contains("206"));
            assert_eq!(
                bytes.len(),
                episodes[episode as usize - 1].len(),
                "episode {episode} incomplete"
            );
            assert!(
                bytes == episodes[episode as usize - 1],
                "episode {episode} bytes differ"
            );
            assert!(Arc::ptr_eq(
                &torrent,
                &running
                    .session
                    .get(TorrentIdOrHash::Hash(hash_of(&hash).unwrap()))
                    .unwrap()
            ));
            println!(
                "season=1 episode={episode} bytes={} file={} reused_session=true",
                bytes.len(),
                prepared.file_name
            );
        }
        running.session.stop().await;
        seed.stop().await;
        let _ = std::fs::remove_dir_all(root);
    }

    /// Controlled loopback benchmark, no external content or trackers.
    /// cargo test --locked large_piece_loopback_benchmark -- --ignored --nocapture
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "64 MiB network benchmark; run explicitly"]
    async fn large_piece_loopback_benchmark() {
        use librqbit::{CreateTorrentOptions, create_torrent, spawn_utils::BlockingSpawner};
        const PIECE: usize = 4 * 1024 * 1024;
        const SIZE: usize = 16 * PIECE;
        let root = std::env::temp_dir().join(format!(
            "vela-large-pieces-{}-{}",
            std::process::id(),
            crate::clock::now().as_millis()
        ));
        let data = root.join("seed");
        std::fs::create_dir_all(&data).unwrap();
        let content: Vec<u8> = (0..SIZE)
            .map(|i| ((i * 7 + i / PIECE) % 251) as u8)
            .collect();
        let file = data.join("synthetic.mp4");
        std::fs::write(&file, &content).unwrap();
        let created = create_torrent(
            &file,
            CreateTorrentOptions {
                piece_length: Some(PIECE as u32),
                ..Default::default()
            },
            &BlockingSpawner::new(2),
        )
        .await
        .unwrap();
        let options = || SessionOptions {
            dht: None,
            disable_trackers: true,
            disable_local_service_discovery: true,
            fastresume: false,
            persistence: None,
            ..Default::default()
        };
        let seed = Session::new_with_opts(
            data.clone(),
            SessionOptions {
                listen: Some(ListenerOptions {
                    listen_addr: "127.0.0.1:0".parse().unwrap(),
                    enable_upnp_port_forwarding: false,
                    ..Default::default()
                }),
                ..options()
            },
        )
        .await
        .unwrap();
        let seed_handle = seed
            .add_torrent(
                AddTorrent::from_bytes(created.as_bytes().unwrap()),
                Some(AddTorrentOptions {
                    output_folder: Some(data.to_string_lossy().into_owned()),
                    overwrite: true,
                    ..Default::default()
                }),
            )
            .await
            .unwrap()
            .into_handle()
            .unwrap();
        seed_handle.wait_until_completed().await.unwrap();
        let hash = created.info_hash().as_string();
        for run in 1..=3 {
            let folder = root.join(format!("run-{run}"));
            let session = Session::new_with_opts(folder.clone(), options())
                .await
                .unwrap();
            let handle = session
                .add_torrent(
                    AddTorrent::from_bytes(created.as_bytes().unwrap()),
                    Some(AddTorrentOptions {
                        initial_peers: Some(vec![seed.listen_addr().unwrap()]),
                        peer_opts: Some(PeerConnectionOptions {
                            max_request_window: Some(request_window(PIECE as u64)),
                            ..Default::default()
                        }),
                        ..Default::default()
                    }),
                )
                .await
                .unwrap()
                .into_handle()
                .unwrap();
            handle.wait_until_initialized().await.unwrap();
            assert_eq!(piece_length(&handle), PIECE as u64);
            let running = Running::serve(session, folder, Tuning::default())
                .await
                .unwrap();
            let path = format!("/{}/{hash}/0", running.token);
            let tail_range = format!("bytes={}-", SIZE - 1024 * 1024);
            let (head, tail) = tokio::join!(
                timed_read(
                    running.port,
                    &path,
                    "bytes=0-",
                    SIZE as u64,
                    Duration::from_secs(90)
                ),
                timed_read(
                    running.port,
                    &path,
                    &tail_range,
                    1024 * 1024,
                    Duration::from_secs(90)
                )
            );
            assert!(
                head.1.is_some() && tail.1.is_some(),
                "transfer stalled: {head:?} / {tail:?}"
            );
            assert_eq!(head.2, SIZE as u64);
            let (status, _, bytes) = fetch(
                running.port,
                &format!("GET {path} HTTP/1.1\r\nHost: x\r\nRange: bytes=100-199\r\n\r\n"),
                Duration::from_secs(5),
            )
            .await;
            assert!(status.contains("206"));
            assert_eq!(bytes, &content[100..200]);
            println!(
                "run={run} piece_bytes={PIECE} file_bytes={SIZE} request_window={} first_ms={} full_ms={} tail_ms={} delivered_bytes={} downloaded_bytes={}",
                request_window(PIECE as u64),
                head.0.unwrap().as_millis(),
                head.1.unwrap().as_millis(),
                tail.1.unwrap().as_millis(),
                head.2,
                running.stats(&hash).unwrap().downloaded
            );
            running.session.stop().await;
        }
        seed.stop().await;
        let _ = std::fs::remove_dir_all(root);
    }

    /// End-to-end streaming against a live swarm: how many bytes reach the player in order
    /// compared with what the torrent downloaded, from the start and after a seek.
    ///
    /// `cargo test --release streaming_benchmark -- --ignored --nocapture`, with optional
    /// VELA_BENCH_HASH, VELA_BENCH_FILE (index), VELA_BENCH_SECONDS (duration of the video, for
    /// its bitrate), VELA_BENCH_SOURCES (trackers, comma separated), VELA_BENCH_WINDOW (a fixed
    /// request window for the torrent instead of `request_window`) and VELA_BENCH_PEERS
    /// (`Tuning`), VELA_BENCH_TIME (seconds per phase, 60) and VELA_BENCH_SEEK=0 to skip the
    /// seek. Every 10 s a map of the first 32 MB shows, every 2 MB, whether a byte can be read
    /// there at once (`#`) or not (`.`). The effective window is printed with the piece size.
    ///
    /// Measurements behind the settings, delivered in order in 60 s:
    /// - Request window, Sintel (08ada5a7a6183aae1e09d831df6748d566095a10, 128 KiB pieces):
    ///   median 39 MB with 16, against 7 with 64 and with 128 (4 runs each). Only small pieces
    ///   were measured; there is no measurement yet for big pieces, where `request_window` gives
    ///   128, so compare there before changing it.
    /// - Peer limit, Big Buck Bunny (dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c, 256 KiB pieces,
    ///   276 MB): 0.26 MB/s with 200 (80 peers live), 0.76 with 60, 0.89 and 1.91 with 30, raw
    ///   download unchanged (1.7 / 2.1 / 1.2-2.4 MB/s); Sintel with 200 as control: 1.01 MB/s.
    ///   Repeat with VELA_BENCH_HASH=dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c and
    ///   VELA_BENCH_PEERS=200, 60, 30 (the default is `PEER_LIMIT`).
    ///
    /// Run one benchmark at a time on the machine: another process with the same torrent
    /// (another run, Vela, Stremio) is found through local service discovery and acts as a
    /// local seed, which skews the measurement. Compare only runs whose "downloaded" grows
    /// steadily; the swarm varies a lot from one run to the next.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "needs the network and a live swarm"]
    async fn streaming_benchmark() {
        let hash = std::env::var("VELA_BENCH_HASH")
            .unwrap_or_else(|_| "f015156e0a766402900ae7a006fba36af3a4df0c".to_owned());
        let tuning = Tuning {
            request_window: env("VELA_BENCH_WINDOW"),
            peer_limit: env("VELA_BENCH_PEERS").unwrap_or(PEER_LIMIT),
        };
        let phase = Duration::from_secs(env("VELA_BENCH_TIME").unwrap_or(60));
        // A fresh cache (and DHT state) for every run: Windows reuses process ids.
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let cache =
            std::env::temp_dir().join(format!("vela-bench-{}-{millis}", std::process::id()));
        let running = Running::start_tuned(cache.clone(), tuning).await.unwrap();
        let sources: Vec<String> = std::env::var("VELA_BENCH_SOURCES")
            .map(|list| list.split(',').map(|s| format!("tracker:{s}")).collect())
            .unwrap_or_default();
        let started = std::time::Instant::now();
        let prepared = running
            .prepare(&hash, env("VELA_BENCH_FILE"), &sources, None, None)
            .await
            .unwrap();
        let length = prepared.files[prepared.file_idx].length;
        let torrent = running
            .session
            .get(TorrentIdOrHash::Hash(hash_of(&hash).unwrap()))
            .unwrap();
        let bitrate = env::<f64>("VELA_BENCH_SECONDS").map(|seconds| length as f64 / seconds);
        let piece = piece_length(&torrent);
        // The same computation `Running::add` used for this torrent (librqbit keeps it private).
        let window = running.window_for(piece);
        println!(
            "metadata + selection {:.1?}: {} ({:.0} MB){}\npieces of {} KiB, request window {window}{}, peer limit {}",
            started.elapsed(),
            prepared.file_name,
            length as f64 / 1e6,
            bitrate.map_or(String::new(), |rate| format!(
                ", needs {:.2} MB/s",
                rate / 1e6
            )),
            piece / 1024,
            if tuning.request_window.is_some() {
                " (VELA_BENCH_WINDOW)"
            } else {
                ""
            },
            tuning.peer_limit,
        );
        let path = format!("/{}/{hash}/{}", running.token, prepared.file_idx);
        let port = running.port;
        // Gaps in the first 32 MB: a 1-byte read every 2 MB, `#` when it arrives in 100 ms.
        let monitor = {
            let path = path.clone();
            tokio::spawn(async move {
                let started = std::time::Instant::now();
                loop {
                    tokio::time::sleep(Duration::from_secs(10)).await;
                    let mut map = String::new();
                    for mb in (0..32u64).step_by(2).filter(|mb| mb << 20 < length) {
                        let range = format!("bytes={}-", mb << 20);
                        let (first, _, _) =
                            timed_read(port, &path, &range, 1, Duration::from_millis(100)).await;
                        map.push(if first.is_some() { '#' } else { '.' });
                    }
                    println!(
                        "  map   [{:>3}s] 0-32 MB by 2 MB: {map}",
                        started.elapsed().as_secs()
                    );
                }
            })
        };
        let sample = |label: &str, at: Duration, reader: &Reader, origin: u64| {
            let stats = running.stats(&hash).unwrap();
            let delivered = reader.delivered();
            println!(
                "  {label} [{:>3}s] in order {:>7.1} MB ({:.2} MB/s) | downloaded {:>7.1} MB | peers {:>3} | {:.2} MB/s",
                at.as_secs(),
                delivered as f64 / 1e6,
                delivered as f64 / at.as_secs_f64().max(1.0) / 1e6,
                (stats.downloaded - origin) as f64 / 1e6,
                stats.peers,
                stats.speed as f64 / 1e6,
            );
        };

        // From the start, with the end of the file asked for at once (MP4 index / MKV cues).
        let head = Reader::open(port, &path, "bytes=0-");
        let tail = Reader::open(
            port,
            &path,
            &format!("bytes={}-", length.saturating_sub(1 << 20)),
        );
        let begin = std::time::Instant::now();
        while begin.elapsed() < phase {
            tokio::time::sleep(Duration::from_secs(5)).await;
            sample("start", begin.elapsed(), &head, 0);
        }
        let in_order = head.delivered() as f64 / phase.as_secs_f64();
        let downloaded = running.stats(&hash).unwrap().downloaded;
        println!(
            "START: first byte {:.1?}, in order {:.2} MB/s{}, downloaded {:.2} MB/s; end of file {}",
            head.first.get(),
            in_order / 1e6,
            bitrate.map_or(String::new(), |rate| format!(
                " ({:.1}x the bitrate)",
                in_order / rate
            )),
            downloaded as f64 / phase.as_secs_f64() / 1e6,
            if tail.delivered() >= (1 << 20).min(length) {
                "ready"
            } else {
                "NOT ready"
            },
        );
        head.task.abort();
        tail.task.abort();

        if std::env::var("VELA_BENCH_SEEK").as_deref() != Ok("0") {
            // Seeks that are dropped at once, then one that stays.
            for at in [0.2, 0.3, 0.4] {
                let range = format!("bytes={}-", (length as f64 * at) as u64);
                let dropped = Reader::open(port, &path, &range);
                tokio::time::sleep(Duration::from_millis(300)).await;
                dropped.task.abort();
            }
            let origin = running.stats(&hash).unwrap().downloaded;
            let seek = Reader::open(port, &path, &format!("bytes={}-", length / 2));
            let begin = std::time::Instant::now();
            while begin.elapsed() < phase {
                tokio::time::sleep(Duration::from_secs(5)).await;
                sample("seek ", begin.elapsed(), &seek, origin);
            }
            println!(
                "SEEK 50%: first byte {:.1?}, in order {:.2} MB/s",
                seek.first.get(),
                seek.delivered() as f64 / phase.as_secs_f64() / 1e6
            );
            seek.task.abort();
        }
        monitor.abort();
        running.session.stop().await;
        let _ = std::fs::remove_dir_all(cache);
    }
}
