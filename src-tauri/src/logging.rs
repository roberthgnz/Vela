//! A log file for what goes wrong on a user's machine: `logs/vela.log` in the app data folder,
//! rotated at 2 MB (two older files kept). Rust writes through `logging::log_warn!` and friends;
//! the interface sends its own lines with `log_write`. Panics are written before the process
//! aborts. Nothing here is sent anywhere: Settings has «Copiar diagnóstico» for the user to share.

use crate::clock;
use std::fmt::Arguments;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

const FOLDER: &str = "logs";
const FILE: &str = "vela.log";
const ROTATE_AT: u64 = 2 * 1024 * 1024;
const KEEP_OLD: usize = 2;
/// The interface could loop on an error; longer lines are cut.
const MAX_LINE: usize = 4000;

pub struct Log {
    file: Mutex<Option<File>>,
    path: PathBuf,
    rotate_at: u64,
}

static LOG: OnceLock<Log> = OnceLock::new();

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn label(self) -> &'static str {
        match self {
            Level::Info => "INFO ",
            Level::Warn => "WARN ",
            Level::Error => "ERROR",
        }
    }

    fn parse(value: &str) -> Level {
        match value {
            "error" => Level::Error,
            "warn" => Level::Warn,
            _ => Level::Info,
        }
    }
}

fn open_file(path: &Path) -> std::io::Result<File> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    OpenOptions::new().create(true).append(true).open(path)
}

impl Log {
    fn new(dir: &Path) -> Self {
        Self::with_limit(dir, ROTATE_AT)
    }

    fn with_limit(dir: &Path, rotate_at: u64) -> Self {
        let path = dir.join(FOLDER).join(FILE);
        let file = open_file(&path).ok();
        Self {
            file: Mutex::new(file),
            path,
            rotate_at,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn rotated(&self, index: usize) -> PathBuf {
        self.path.with_file_name(format!("vela.{index}.log"))
    }

    /// `vela.log` → `vela.1.log` → `vela.2.log`; the oldest is dropped.
    fn rotate(&self, file: &mut Option<File>) {
        *file = None;
        let _ = std::fs::remove_file(self.rotated(KEEP_OLD));
        for index in (1..KEEP_OLD).rev() {
            let _ = std::fs::rename(self.rotated(index), self.rotated(index + 1));
        }
        let _ = std::fs::rename(&self.path, self.rotated(1));
        *file = open_file(&self.path).ok();
    }

    pub fn write(&self, level: Level, source: &str, message: &str) {
        let mut guard = self.file.lock().unwrap_or_else(|p| p.into_inner());
        let Some(file) = guard.as_mut() else { return };
        if file.metadata().map(|m| m.len()).unwrap_or(0) >= self.rotate_at {
            self.rotate(&mut guard);
        }
        let Some(file) = guard.as_mut() else { return };
        let message = if message.len() > MAX_LINE {
            let mut end = MAX_LINE;
            while !message.is_char_boundary(end) {
                end -= 1;
            }
            format!("{}…", &message[..end])
        } else {
            message.to_owned()
        };
        // One line per entry; embedded newlines are kept readable but do not break parsing.
        let message = message.replace('\n', "\n    ");
        let _ = writeln!(
            file,
            "{} {} [{source}] {message}",
            clock::iso(clock::now()),
            level.label()
        );
    }

    /// The last `bytes` of the current file (whole lines).
    pub fn tail(&self, bytes: u64) -> String {
        let Ok(mut file) = File::open(&self.path) else {
            return String::new();
        };
        let length = file.metadata().map(|m| m.len()).unwrap_or(0);
        let start = length.saturating_sub(bytes);
        if file.seek(SeekFrom::Start(start)).is_err() {
            return String::new();
        }
        let mut text = String::new();
        let _ = file.read_to_string(&mut text);
        if start > 0
            && let Some(index) = text.find('\n')
        {
            text.drain(..=index);
        }
        text
    }
}

/// Opens the log in `dir` and starts writing panics to it. Later calls are ignored.
pub fn init(dir: &Path) -> &'static Log {
    let log = LOG.get_or_init(|| Log::new(dir));
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(log) = LOG.get() {
            log.write(Level::Error, "rust", &format!("panic: {info}"));
        }
        previous(info);
    }));
    log
}

pub fn get() -> Option<&'static Log> {
    LOG.get()
}

pub fn write(level: Level, args: Arguments<'_>) {
    if let Some(log) = LOG.get() {
        log.write(level, "rust", &args.to_string());
    }
}

macro_rules! log_info {
    ($($arg:tt)*) => { $crate::logging::write($crate::logging::Level::Info, format_args!($($arg)*)) };
}
macro_rules! log_warn {
    ($($arg:tt)*) => { $crate::logging::write($crate::logging::Level::Warn, format_args!($($arg)*)) };
}
macro_rules! log_error {
    ($($arg:tt)*) => { $crate::logging::write($crate::logging::Level::Error, format_args!($($arg)*)) };
}
pub(crate) use {log_error, log_info, log_warn};

fn log(app: &AppHandle) -> Result<&'static Log, String> {
    let _ = app;
    get().ok_or_else(|| "El registro no está disponible.".to_owned())
}

/// A line from the interface. `level` is `info`, `warn` or `error`.
#[tauri::command]
pub fn log_write(app: AppHandle, level: String, message: String) -> Result<(), String> {
    log(&app)?.write(Level::parse(&level), "ui", &message);
    Ok(())
}

/// The end of the current log (at most 64 KB) for «Copiar diagnóstico».
#[tauri::command]
pub fn log_tail(app: AppHandle) -> Result<String, String> {
    Ok(log(&app)?.tail(64 * 1024))
}

#[tauri::command]
pub fn log_folder(app: AppHandle) -> Result<String, String> {
    Ok(log(&app)?
        .path()
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default())
}

/// Writes the diagnostic report next to the log files and selects it in Explorer, for users
/// whose clipboard is not available. Returns the file's path.
#[tauri::command]
pub async fn log_save_report(app: AppHandle, report: String) -> Result<String, String> {
    let folder = log(&app)?
        .path()
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "El registro no está disponible.".to_owned())?;
    tokio::fs::create_dir_all(&folder)
        .await
        .map_err(|_| "No se pudo crear la carpeta de registros.".to_owned())?;
    let stamp = clock::iso(clock::now())
        .replace([':', '-', '.'], "")
        .replace('T', "-");
    let stamp = &stamp[..stamp.len().min(15)];
    let path = folder.join(format!("vela-diagnostico-{stamp}.txt"));
    tokio::fs::write(&path, report.as_bytes())
        .await
        .map_err(|_| "No se pudo guardar el diagnóstico.".to_owned())?;
    let shown = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        let _ = tokio::process::Command::new("explorer")
            .arg(format!("/select,{shown}"))
            .spawn();
    }
    Ok(shown)
}

/// Shows the folder with the log files in Explorer.
#[tauri::command]
pub async fn log_reveal(app: AppHandle) -> Result<(), String> {
    let folder = log(&app)?.path().parent().map(Path::to_path_buf);
    let Some(folder) = folder else {
        return Err("El registro no está disponible.".to_owned());
    };
    tokio::fs::create_dir_all(&folder).await.ok();
    let program = if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    tokio::process::Command::new(program)
        .arg(folder.to_string_lossy().into_owned())
        .spawn()
        .map(|_| ())
        .map_err(|_| "No se pudo abrir el Explorador.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "vela-log-{}-{}",
            std::process::id(),
            clock::now().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn writes_one_line_per_entry_with_level_and_source() {
        let dir = temp();
        let log = Log::new(&dir);
        log.write(Level::Warn, "ui", "first\nsecond");
        log.write(Level::Error, "rust", &"x".repeat(5000));
        let text = std::fs::read_to_string(log.path()).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains("WARN  [ui] first"));
        assert!(lines[0].ends_with('Z') == false && lines[0].len() > 24);
        assert_eq!(lines[1], "    second");
        assert!(lines[2].starts_with("20"));
        assert!(lines[2].contains("ERROR [rust] "));
        assert!(lines[2].ends_with('…'));
        assert!(lines[2].len() < 4100);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rotates_when_the_file_is_large() {
        let dir = temp();
        let log = Log::with_limit(&dir, 60);
        log.write(Level::Info, "rust", "old");
        log.write(Level::Info, "rust", "still old");
        // Past the limit now: the next entry opens a fresh file.
        log.write(Level::Info, "rust", "new");
        assert!(log.rotated(1).exists());
        let current = std::fs::read_to_string(log.path()).unwrap();
        assert!(
            current.contains("new") && !current.contains("old"),
            "{current:?}"
        );
        let older = std::fs::read_to_string(log.rotated(1)).unwrap();
        assert!(older.starts_with("20") && older.contains("still old"));
        // Each further rotation shifts the files; the third copy is dropped.
        for round in 0..2 {
            for _ in 0..3 {
                log.write(Level::Info, "rust", &format!("round {round}"));
            }
        }
        assert!(log.rotated(1).exists() && log.rotated(2).exists() && !log.rotated(3).exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn tail_returns_whole_lines_from_the_end() {
        let dir = temp();
        let log = Log::new(&dir);
        for index in 0..50 {
            log.write(Level::Info, "rust", &format!("line {index}"));
        }
        let tail = log.tail(200);
        assert!(tail.starts_with("20"), "tail starts mid-line: {tail:?}");
        assert!(tail.trim_end().ends_with("line 49"));
        assert!(!tail.contains("line 0\n"));
        assert_eq!(log.tail(1 << 20).lines().count(), 50);
        let _ = std::fs::remove_dir_all(dir);
    }
}
