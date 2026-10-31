//! Vela's data on disk: a SQLite database in the app data folder with one key-value table that
//! holds the same `vela.*` keys the interface used to keep in WebView2's localStorage. The
//! interface keeps a copy in memory and sends batches of changes; this module writes them in one
//! transaction. A copy of the database is made in `backups/` once a day and on demand; the seven
//! newest are kept.

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const FILE: &str = "vela.db";
const BACKUPS: &str = "backups";
/// Backups kept, newest first.
const KEEP: usize = 7;
const BACKUP_EVERY: Duration = Duration::from_secs(24 * 60 * 60);

pub struct Storage {
    connection: Mutex<Connection>,
    path: PathBuf,
}

/// One change from the interface: `value` absent removes the key.
#[derive(Deserialize)]
pub struct Change {
    pub key: String,
    pub value: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Entry {
    pub key: String,
    pub value: String,
}

#[derive(Serialize)]
pub struct Backup {
    pub name: String,
    pub size: u64,
    /// Unix milliseconds.
    pub created: u64,
}

#[derive(Serialize)]
pub struct Info {
    pub path: String,
    pub folder: String,
    pub size: u64,
    pub keys: u64,
    pub backups: Vec<Backup>,
}

fn now() -> Duration {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
}

/// `(year, month, day)` of a day count since 1970-01-01 (Howard Hinnant's civil-from-days).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// `vela-YYYYMMDD-HHMMSS.db` in UTC, so names sort by date.
fn backup_name(at: Duration) -> String {
    let seconds = at.as_secs();
    let (year, month, day) = civil((seconds / 86_400) as i64);
    let rest = seconds % 86_400;
    format!(
        "vela-{year:04}{month:02}{day:02}-{:02}{:02}{:02}.db",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

impl Storage {
    /// Opens (or creates) the database in `dir`.
    pub fn open(dir: &Path) -> rusqlite::Result<Self> {
        std::fs::create_dir_all(dir).map_err(|error| {
            rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CANTOPEN),
                Some(error.to_string()),
            )
        })?;
        let path = dir.join(FILE);
        let connection = Connection::open(&path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS kv (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );",
        )?;
        Ok(Self {
            connection: Mutex::new(connection),
            path,
        })
    }

    fn connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn load(&self) -> rusqlite::Result<Vec<Entry>> {
        let connection = self.connection();
        let mut statement = connection.prepare("SELECT key, value FROM kv ORDER BY key")?;
        let rows = statement.query_map([], |row| {
            Ok(Entry {
                key: row.get(0)?,
                value: row.get(1)?,
            })
        })?;
        rows.collect()
    }

    /// Applies every change in one transaction.
    pub fn write(&self, changes: &[Change]) -> rusqlite::Result<()> {
        let mut connection = self.connection();
        let transaction = connection.transaction()?;
        let at = now().as_millis() as i64;
        {
            let mut upsert = transaction.prepare_cached(
                "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            )?;
            let mut delete = transaction.prepare_cached("DELETE FROM kv WHERE key = ?1")?;
            for change in changes {
                match &change.value {
                    Some(value) => upsert.execute(params![change.key, value, at])?,
                    None => delete.execute(params![change.key])?,
                };
            }
        }
        transaction.commit()
    }

    /// Folds the write-ahead log into the database file (before exit).
    pub fn checkpoint(&self) {
        let _ = self
            .connection()
            .pragma_update(None, "wal_checkpoint", "TRUNCATE");
    }

    pub fn backups_dir(&self) -> PathBuf {
        self.path.with_file_name(BACKUPS)
    }

    /// Existing backups, newest first.
    pub fn backups(&self) -> Vec<Backup> {
        let Ok(entries) = std::fs::read_dir(self.backups_dir()) else {
            return Vec::new();
        };
        let mut backups: Vec<Backup> = entries
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !(name.starts_with("vela-") && name.ends_with(".db")) {
                    return None;
                }
                let metadata = entry.metadata().ok()?;
                let created = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |time| time.as_millis() as u64);
                Some(Backup {
                    name,
                    size: metadata.len(),
                    created,
                })
            })
            .collect();
        // The name carries the date; the modification time breaks ties for copied files.
        backups.sort_by(|a, b| b.name.cmp(&a.name).then(b.created.cmp(&a.created)));
        backups
    }

    /// Copies the database to a new file in `backups/` and prunes the oldest ones.
    pub fn backup(&self) -> rusqlite::Result<PathBuf> {
        let dir = self.backups_dir();
        std::fs::create_dir_all(&dir).map_err(|error| {
            rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CANTOPEN),
                Some(error.to_string()),
            )
        })?;
        let mut target = dir.join(backup_name(now()));
        // Two backups within one second: keep both.
        let mut attempt = 0;
        while target.exists() {
            attempt += 1;
            target = dir.join(backup_name(now() + Duration::from_secs(attempt)));
        }
        self.connection()
            .execute("VACUUM INTO ?1", [target.to_string_lossy().into_owned()])?;
        self.prune();
        Ok(target)
    }

    /// Makes the daily backup when the newest one is older than a day (or missing).
    pub fn backup_if_due(&self) -> rusqlite::Result<Option<PathBuf>> {
        let newest = self
            .backups()
            .into_iter()
            .map(|backup| backup.created)
            .max();
        let due = newest.is_none_or(|created| {
            now().as_millis() as u64 >= created + BACKUP_EVERY.as_millis() as u64
        });
        if !due {
            return Ok(None);
        }
        self.backup().map(Some)
    }

    fn prune(&self) {
        let dir = self.backups_dir();
        for backup in self.backups().into_iter().skip(KEEP) {
            let _ = std::fs::remove_file(dir.join(backup.name));
        }
    }

    pub fn info(&self) -> Info {
        let size = std::fs::metadata(&self.path).map_or(0, |m| m.len())
            + std::fs::metadata(self.path.with_extension("db-wal")).map_or(0, |m| m.len());
        let keys = self
            .connection()
            .query_row("SELECT COUNT(*) FROM kv", [], |row| row.get::<_, i64>(0))
            .unwrap_or(0)
            .max(0) as u64;
        Info {
            path: self.path.to_string_lossy().into_owned(),
            folder: self
                .path
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
            size,
            keys,
            backups: self.backups(),
        }
    }
}

/// Opens the database in the app data folder. A failure is reported, not fatal: the interface
/// then keeps its data in WebView2's storage as before and says so in Settings.
pub fn open(app: &AppHandle) -> Result<Storage, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "No se encontró la carpeta de datos de la aplicación.".to_owned())?;
    Storage::open(&dir).map_err(|error| error.to_string())
}

fn storage(app: &AppHandle) -> Result<tauri::State<'_, Storage>, String> {
    app.try_state::<Storage>()
        .ok_or_else(|| "La base de datos de Vela no está disponible.".to_owned())
}

fn failed(action: &str) -> impl Fn(rusqlite::Error) -> String + '_ {
    move |error| format!("{action}: {error}")
}

#[tauri::command]
pub fn storage_load(app: AppHandle) -> Result<Vec<Entry>, String> {
    storage(&app)?
        .load()
        .map_err(failed("No se pudieron leer los datos guardados"))
}

#[tauri::command]
pub fn storage_write(app: AppHandle, changes: Vec<Change>) -> Result<(), String> {
    storage(&app)?
        .write(&changes)
        .map_err(failed("No se pudieron guardar los cambios"))
}

#[tauri::command]
pub fn storage_info(app: AppHandle) -> Result<Info, String> {
    Ok(storage(&app)?.info())
}

#[tauri::command]
pub fn storage_backup(app: AppHandle) -> Result<String, String> {
    storage(&app)?
        .backup()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(failed("No se pudo crear la copia"))
}

/// Shows the folder with the database and its backups in Explorer.
#[tauri::command]
pub async fn storage_reveal(app: AppHandle) -> Result<(), String> {
    let dir = storage(&app)?.backups_dir();
    tokio::fs::create_dir_all(&dir).await.ok();
    let target = dir.to_string_lossy().into_owned();
    let program = if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    tokio::process::Command::new(program)
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|_| "No se pudo abrir el Explorador.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "vela-storage-{}-{}",
            std::process::id(),
            now().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn change(key: &str, value: Option<&str>) -> Change {
        Change {
            key: key.to_owned(),
            value: value.map(str::to_owned),
        }
    }

    #[test]
    fn writes_and_reads_back_in_key_order() {
        let dir = temp();
        let storage = Storage::open(&dir).unwrap();
        storage
            .write(&[
                change("vela.b", Some("2")),
                change("vela.a", Some("1")),
                change("vela.c", Some("3")),
            ])
            .unwrap();
        storage
            .write(&[change("vela.c", None), change("vela.a", Some("one"))])
            .unwrap();
        let entries = storage.load().unwrap();
        assert_eq!(
            entries,
            vec![
                Entry {
                    key: "vela.a".into(),
                    value: "one".into()
                },
                Entry {
                    key: "vela.b".into(),
                    value: "2".into()
                },
            ]
        );
        drop(storage);
        // The data survives reopening.
        let storage = Storage::open(&dir).unwrap();
        assert_eq!(storage.load().unwrap().len(), 2);
        assert_eq!(storage.info().keys, 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn backups_are_readable_copies_and_only_the_newest_are_kept() {
        let dir = temp();
        let storage = Storage::open(&dir).unwrap();
        storage.write(&[change("vela.a", Some("1"))]).unwrap();
        let first = storage.backup().unwrap();
        assert!(first.starts_with(dir.join(BACKUPS)));
        let copy = Connection::open(&first).unwrap();
        let value: String = copy
            .query_row("SELECT value FROM kv WHERE key = 'vela.a'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(value, "1");
        drop(copy);
        // Old backups, named earlier than any new one.
        for day in 1..=KEEP {
            std::fs::write(
                dir.join(BACKUPS)
                    .join(format!("vela-2020010{day}-000000.db")),
                b"old",
            )
            .unwrap();
        }
        storage.backup().unwrap();
        let names: Vec<String> = storage.backups().into_iter().map(|b| b.name).collect();
        assert_eq!(names.len(), KEEP);
        assert!(names.iter().all(|name| !name.starts_with("vela-2020")) || names.len() == KEEP);
        assert!(!names.contains(&"vela-20200101-000000.db".to_owned()));
        assert!(!names.contains(&"vela-20200102-000000.db".to_owned()));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn daily_backup_runs_once() {
        let dir = temp();
        let storage = Storage::open(&dir).unwrap();
        assert!(storage.backup_if_due().unwrap().is_some());
        assert!(storage.backup_if_due().unwrap().is_none());
        assert_eq!(storage.backups().len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn backup_names_carry_the_utc_date() {
        assert_eq!(
            backup_name(Duration::from_secs(0)),
            "vela-19700101-000000.db"
        );
        // 2024-02-29 12:34:56 UTC
        assert_eq!(
            backup_name(Duration::from_secs(1_709_210_096)),
            "vela-20240229-123456.db"
        );
        assert_eq!(civil(19_723), (2024, 1, 1));
    }

    #[test]
    fn opens_in_a_missing_folder() {
        let dir = temp().join("nested").join("deeper");
        let storage = Storage::open(&dir).unwrap();
        assert!(storage.load().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir.parent().unwrap().parent().unwrap());
    }
}
