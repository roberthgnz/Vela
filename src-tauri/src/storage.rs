//! Vela's data on disk: a SQLite database in the app data folder with one key-value table that
//! holds the same `vela.*` keys the interface used to keep in WebView2's localStorage. The
//! interface keeps a copy in memory and sends batches of changes; this module writes them in one
//! transaction. A copy of the database is made in `backups/` once a day and on demand; the seven
//! newest are kept.

use rusqlite::{Connection, OpenFlags, params};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use crate::clock::{civil, now};

const FILE: &str = "vela.db";
const BACKUPS: &str = "backups";
/// Backups kept, newest first.
const KEEP: usize = 7;
const BACKUP_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
const PREFERENCES: &str = "vela.preferences.v2";
const PROFILES: &str = "vela.profiles.v1";
const ACCOUNT: &str = "vela.account.v1";

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

/// Counts shown before the user confirms replacing the local data. Library entries are counted
/// per profile, including items in Continue watching that were not saved to the library.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreview {
    pub name: String,
    pub keys: usize,
    pub profiles: usize,
    pub library_items: usize,
}

fn is_backup_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() == 23
        && bytes.starts_with(b"vela-")
        && bytes.ends_with(b".db")
        && bytes[13] == b'-'
        && bytes[5..13].iter().all(u8::is_ascii_digit)
        && bytes[14..20].iter().all(u8::is_ascii_digit)
}

fn invalid_backup() -> String {
    "La copia no contiene una base de datos de Vela compatible y válida.".to_owned()
}

fn library_count(value: &str) -> Result<usize, String> {
    let json: serde_json::Value = serde_json::from_str(value).map_err(|_| invalid_backup())?;
    let object = json.as_object().ok_or_else(invalid_backup)?;
    if object.get("version").and_then(serde_json::Value::as_u64) != Some(2) {
        return Err(invalid_backup());
    }
    let library = object
        .get("library")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(invalid_backup)?;
    // The frontend validates every library field on read. Reject broken records here instead
    // of accepting a backup whose invalid entries would silently disappear after reloading.
    for entry in library.values() {
        let meta = entry.get("meta").ok_or_else(invalid_backup)?;
        for field in ["id", "type", "name"] {
            if !meta
                .get(field)
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
            {
                return Err(invalid_backup());
            }
        }
        if entry
            .get("addonUrl")
            .and_then(serde_json::Value::as_str)
            .is_none()
            || !entry
                .get("addedAt")
                .and_then(serde_json::Value::as_f64)
                .is_some_and(|at| at >= 0.0)
        {
            return Err(invalid_backup());
        }
    }
    Ok(library.len())
}

fn preview(name: &str, entries: &[Entry]) -> Result<BackupPreview, String> {
    let mut main = false;
    let mut library_items = 0;
    let mut profiles = std::collections::HashSet::from(["main".to_owned()]);
    for entry in entries {
        if !entry.key.starts_with("vela.") {
            return Err(invalid_backup());
        }
        if entry.key == PREFERENCES {
            main = true;
            library_items += library_count(&entry.value)?;
        } else if entry.key.starts_with("vela.profile.") && entry.key.ends_with(".v1") {
            library_items += library_count(&entry.value)?;
        } else if entry.key == PROFILES {
            let json: serde_json::Value =
                serde_json::from_str(&entry.value).map_err(|_| invalid_backup())?;
            let list = json
                .get("profiles")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(invalid_backup)?;
            let mut seen = std::collections::HashSet::new();
            for profile in list {
                let id = profile
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .filter(|id| !id.is_empty())
                    .ok_or_else(invalid_backup)?;
                if !seen.insert(id)
                    || !profile
                        .get("name")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|name| !name.trim().is_empty())
                {
                    return Err(invalid_backup());
                }
                profiles.insert(id.to_owned());
            }
        }
    }
    if !main {
        return Err(invalid_backup());
    }
    Ok(BackupPreview {
        name: name.to_owned(),
        keys: entries.len(),
        profiles: profiles.len(),
        library_items,
    })
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
                if !is_backup_name(&name) || !entry.file_type().ok()?.is_file() {
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
        self.backup_with(&self.connection(), None)
    }

    fn backup_with(
        &self,
        connection: &Connection,
        selected: Option<&str>,
    ) -> rusqlite::Result<PathBuf> {
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
        connection.execute("VACUUM INTO ?1", [target.to_string_lossy().into_owned()])?;
        self.prune(&target, selected);
        Ok(target)
    }

    /// Read only a regular, named copy inside this installation's backups folder. A view named
    /// kv or an unrelated SQLite database is not a Vela backup.
    fn read_backup(&self, name: &str) -> Result<Vec<Entry>, String> {
        if !is_backup_name(name) {
            return Err("El nombre de la copia no es válido.".to_owned());
        }
        let dir = self.backups_dir();
        let path = dir.join(name);
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|_| "No se encontró la copia seleccionada.".to_owned())?;
        if !metadata.file_type().is_file() {
            return Err(invalid_backup());
        }
        let base = self.path.parent().ok_or_else(invalid_backup)?;
        let base = base.canonicalize().map_err(|_| invalid_backup())?;
        let dir = dir.canonicalize().map_err(|_| invalid_backup())?;
        let path = path.canonicalize().map_err(|_| invalid_backup())?;
        if dir.parent() != Some(base.as_path()) || path.parent() != Some(dir.as_path()) {
            return Err(invalid_backup());
        }
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| invalid_backup())?;
        connection
            .pragma_update(None, "trusted_schema", false)
            .map_err(|_| invalid_backup())?;
        let check: String = connection
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(|_| invalid_backup())?;
        if check != "ok" {
            return Err(invalid_backup());
        }
        let table: String = connection
            .query_row(
                "SELECT type FROM sqlite_schema WHERE name = 'kv'",
                [],
                |row| row.get(0),
            )
            .map_err(|_| invalid_backup())?;
        if table != "table" {
            return Err(invalid_backup());
        }
        let mut schema = connection
            .prepare("PRAGMA table_info(kv)")
            .map_err(|_| invalid_backup())?;
        let columns: Vec<(String, String, bool, i64)> = schema
            .query_map([], |row| {
                Ok((row.get(1)?, row.get(2)?, row.get(3)?, row.get(5)?))
            })
            .map_err(|_| invalid_backup())?
            .collect::<rusqlite::Result<_>>()
            .map_err(|_| invalid_backup())?;
        let expected = vec![
            ("key".to_owned(), "TEXT".to_owned(), true, 1),
            ("value".to_owned(), "TEXT".to_owned(), true, 0),
            ("updated_at".to_owned(), "INTEGER".to_owned(), true, 0),
        ];
        if columns != expected {
            return Err(invalid_backup());
        }
        let mut statement = connection
            .prepare("SELECT key, value, updated_at FROM kv ORDER BY key")
            .map_err(|_| invalid_backup())?;
        let entries = statement
            .query_map([], |row| {
                let _: i64 = row.get(2)?;
                Ok(Entry {
                    key: row.get(0)?,
                    value: row.get(1)?,
                })
            })
            .map_err(|_| invalid_backup())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| invalid_backup())?;
        preview(name, &entries)?;
        Ok(entries)
    }

    pub fn backup_preview(&self, name: &str) -> Result<BackupPreview, String> {
        preview(name, &self.read_backup(name)?)
    }

    /// Validate before touching the current data; snapshot it while holding the same lock as
    /// the replacing transaction. The snapshot is also what the user can restore to undo this.
    /// Read the chosen copy before any writes and protect it from retention pruning too.
    pub fn restore(&self, name: &str) -> Result<PathBuf, String> {
        let entries = self.read_backup(name)?;
        let mut connection = self.connection();
        let previous = self
            .backup_with(&connection, Some(name))
            .map_err(failed("No se pudo crear la copia previa"))?;
        let transaction = connection
            .transaction()
            .map_err(failed("No se pudo restaurar la copia"))?;
        transaction
            .execute("DELETE FROM kv", [])
            .map_err(failed("No se pudo restaurar la copia"))?;
        let at = now().as_millis() as i64;
        {
            let mut insert = transaction
                .prepare("INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3)")
                .map_err(failed("No se pudo restaurar la copia"))?;
            for entry in entries {
                // Restored data must stay local until the user links the account again. Its
                // credential lives in the OS vault, outside the backup, and is not changed.
                if entry.key == ACCOUNT {
                    continue;
                }
                insert
                    .execute(params![entry.key, entry.value, at])
                    .map_err(failed("No se pudo restaurar la copia"))?;
            }
        }
        transaction
            .commit()
            .map_err(failed("No se pudo restaurar la copia"))?;
        Ok(previous)
    }

    /// Makes the daily backup when the newest one is older than a day (or missing).
    pub fn backup_if_due(&self) -> rusqlite::Result<Option<PathBuf>> {
        // An empty database (first start, before the interface copies the old data) is not worth
        // a backup; the interface asks for one once it has migrated.
        let keys: i64 = self
            .connection()
            .query_row("SELECT COUNT(*) FROM kv", [], |row| row.get(0))?;
        if keys == 0 {
            return Ok(None);
        }
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

    fn prune(&self, keep: &Path, selected: Option<&str>) {
        let dir = self.backups_dir();
        let backups = self.backups();
        let protected =
            |copy: &Backup| dir.join(&copy.name) == keep || selected == Some(copy.name.as_str());
        let reserved = backups.iter().filter(|copy| protected(copy)).count();
        for backup in backups
            .into_iter()
            .filter(|copy| !protected(copy))
            .skip(KEEP.saturating_sub(reserved))
        {
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
    move |error| {
        crate::logging::log_error!("{action}: {error}");
        format!("{action}: {error}")
    }
}

/// Runs blocking database work off the UI thread (synchronous commands run on it).
async fn blocking<T: Send + 'static>(
    app: AppHandle,
    job: impl FnOnce(&Storage) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || job(&*storage(&app)?))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn storage_load(app: AppHandle) -> Result<Vec<Entry>, String> {
    blocking(app, |storage| {
        storage
            .load()
            .map_err(failed("No se pudieron leer los datos guardados"))
    })
    .await
}

#[tauri::command]
pub async fn storage_write(app: AppHandle, changes: Vec<Change>) -> Result<(), String> {
    blocking(app, move |storage| {
        storage
            .write(&changes)
            .map_err(failed("No se pudieron guardar los cambios"))
    })
    .await
}

#[tauri::command]
pub async fn storage_info(app: AppHandle) -> Result<Info, String> {
    blocking(app, |storage| Ok(storage.info())).await
}

#[tauri::command]
pub async fn storage_backup(app: AppHandle) -> Result<String, String> {
    blocking(app, |storage| {
        storage
            .backup()
            .map(|path| path.to_string_lossy().into_owned())
            .map_err(failed("No se pudo crear la copia"))
    })
    .await
}

#[tauri::command]
pub async fn storage_backup_preview(app: AppHandle, name: String) -> Result<BackupPreview, String> {
    blocking(app, move |storage| storage.backup_preview(&name)).await
}

#[tauri::command]
pub async fn storage_restore(app: AppHandle, name: String) -> Result<String, String> {
    blocking(app, move |storage| {
        storage
            .restore(&name)
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
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

    struct TestDir(PathBuf);

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

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

    fn preferences(title: &str) -> String {
        serde_json::json!({
            "version": 2,
            "library": {
                "[\"series\",\"velatest:season\"]": {
                    "meta": { "id": "velatest:season", "type": "series", "name": title },
                    "addonUrl": "http://127.0.0.1:7010/manifest.json",
                    "addedAt": 100,
                    "progress": { "videoId": "velatest:season:1:2", "seconds": 42, "duration": 90, "updatedAt": 200 },
                    "videos": { "velatest:season:1:1": { "seconds": 90, "duration": 90, "updatedAt": 100, "watched": true } }
                }
            }
        }).to_string()
    }

    fn populate(storage: &Storage, title: &str) {
        storage.write(&[
            change(PREFERENCES, Some(&preferences(title))),
            change(PROFILES, Some(r##"{"profiles":[{"id":"main","name":"Principal","color":"#d6ef91"},{"id":"kids","name":"Infantil","color":"#8ec5ff"}],"last":"kids"}"##)),
            change("vela.profile.kids.v1", Some(&preferences("Kids"))),
            change(ACCOUNT, Some(r#"{"user":{"id":"old-account"},"sync":{"synced":{},"removed":{}}}"#)),
            change("vela.ui.language", Some("es")),
        ]).unwrap();
    }

    fn name(path: &Path) -> &str {
        path.file_name().unwrap().to_str().unwrap()
    }

    #[test]
    fn restore_preserves_profiles_progress_and_a_safety_copy_but_does_not_relink_account() {
        let dir = TestDir(temp());
        let storage = Storage::open(&dir.0).unwrap();
        populate(&storage, "Original");
        let expected: Vec<Entry> = storage
            .load()
            .unwrap()
            .into_iter()
            .filter(|entry| entry.key != ACCOUNT)
            .collect();
        let selected = storage.backup().unwrap();
        assert_eq!(
            storage.backup_preview(name(&selected)).unwrap(),
            BackupPreview {
                name: name(&selected).to_owned(),
                keys: 5,
                profiles: 2,
                library_items: 2,
            }
        );
        populate(&storage, "Changed after the copy");
        storage
            .write(&[change("vela.new-key", Some("new data"))])
            .unwrap();
        let before = storage.load().unwrap();
        let previous = storage.restore(name(&selected)).unwrap();
        assert_ne!(previous, selected);
        assert_eq!(storage.read_backup(name(&previous)).unwrap(), before);
        assert_eq!(storage.load().unwrap(), expected);
        drop(storage);
        let reopened = Storage::open(&dir.0).unwrap();
        assert_eq!(reopened.load().unwrap(), expected);
    }

    #[test]
    fn invalid_names_and_non_regular_files_cannot_be_restored() {
        let dir = TestDir(temp());
        let storage = Storage::open(&dir.0).unwrap();
        populate(&storage, "Current");
        let before = storage.load().unwrap();
        for invalid in [
            "../vela.db",
            "..\\vela.db",
            "C:\\vela.db",
            "/vela.db",
            "vela-20200101-000000.db/other",
            "vela-20200101-000000.db:stream",
            "vela-20200101-000000.db\0",
        ] {
            assert!(storage.backup_preview(invalid).is_err(), "{invalid:?}");
            assert!(storage.restore(invalid).is_err(), "{invalid:?}");
        }
        std::fs::create_dir_all(storage.backups_dir().join("vela-20200101-000000.db")).unwrap();
        assert!(storage.restore("vela-20200101-000000.db").is_err());
        assert!(storage.backups().is_empty());
        assert_eq!(storage.load().unwrap(), before);
    }

    #[test]
    fn corrupt_or_unrelated_copies_fail_without_backing_up_or_changing_current_data() {
        let dir = TestDir(temp());
        let storage = Storage::open(&dir.0).unwrap();
        populate(&storage, "Current");
        let before = storage.load().unwrap();
        std::fs::create_dir_all(storage.backups_dir()).unwrap();
        let corrupt = storage.backups_dir().join("vela-20200101-000000.db");
        std::fs::write(&corrupt, b"not a SQLite database").unwrap();
        assert!(storage.restore(name(&corrupt)).is_err());
        for (day, schema) in [
            (2, "CREATE TABLE other(value TEXT);"),
            (
                3,
                "CREATE VIEW kv AS SELECT 'vela.preferences.v2' AS key, '{}' AS value, 0 AS updated_at;",
            ),
            (
                4,
                "CREATE TABLE kv(key TEXT, value TEXT, updated_at INTEGER);",
            ),
        ] {
            let path = storage
                .backups_dir()
                .join(format!("vela-2020010{day}-000000.db"));
            let copy = Connection::open(&path).unwrap();
            copy.execute_batch(schema).unwrap();
            drop(copy);
            assert!(storage.backup_preview(name(&path)).is_err());
            assert!(storage.restore(name(&path)).is_err());
        }
        assert_eq!(storage.backups().len(), 4);
        assert_eq!(storage.load().unwrap(), before);
    }

    #[test]
    fn invalid_preferences_and_foreign_keys_are_not_accepted_as_a_backup() {
        let dir = TestDir(temp());
        let storage = Storage::open(&dir.0).unwrap();
        populate(&storage, "Current");
        for (index, invalid) in [
            change(PREFERENCES, Some("broken JSON")),
            change(PREFERENCES, Some(r#"{"version":3,"library":{}}"#)),
            change(PREFERENCES, Some(r#"{"version":2,"library":[]}"#)),
            change(PREFERENCES, Some(r#"{"version":2,"library":{"broken":{}}}"#)),
            change(PREFERENCES, None),
            change("unrelated-secret", Some("foreign data")),
            change(PROFILES, Some(r#"{"profiles":[{"id":"main","name":"Main"},{"id":"main","name":"Duplicate"}]}"#)),
        ].into_iter().enumerate() {
            let source_dir = TestDir(temp());
            let source = Storage::open(&source_dir.0).unwrap();
            populate(&source, "Invalid");
            source.write(&[invalid]).unwrap();
            let source_backup = source.backup().unwrap();
            std::fs::create_dir_all(storage.backups_dir()).unwrap();
            let selected = storage.backups_dir().join(format!("vela-2020010{}-000000.db", index + 1));
            std::fs::copy(source_backup, &selected).unwrap();
            let before = storage.load().unwrap();
            assert!(storage.restore(name(&selected)).is_err());
            assert_eq!(storage.load().unwrap(), before);
        }
    }

    #[test]
    fn a_failed_replacement_rolls_back_every_deleted_entry_and_keeps_the_safety_copy() {
        let dir = TestDir(temp());
        let storage = Storage::open(&dir.0).unwrap();
        populate(&storage, "Selected");
        let selected = storage.backup().unwrap();
        populate(&storage, "Current");
        storage.connection().execute_batch(
            "CREATE TRIGGER reject_restore BEFORE INSERT ON kv BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;"
        ).unwrap();
        let before = storage.load().unwrap();
        assert!(storage.restore(name(&selected)).is_err());
        assert_eq!(storage.load().unwrap(), before);
        let copies = storage.backups();
        assert_eq!(copies.len(), 2);
        assert_eq!(storage.read_backup(&copies[0].name).unwrap(), before);
    }

    #[test]
    fn a_failed_safety_copy_leaves_the_current_database_untouched() {
        let dir = TestDir(temp());
        let storage = Storage::open(&dir.0).unwrap();
        populate(&storage, "Selected");
        let selected = storage.backup().unwrap();
        populate(&storage, "Current");
        let before = storage.load().unwrap();
        // SQLite refuses VACUUM INTO while this connection has an open transaction.
        storage
            .connection()
            .execute_batch("BEGIN IMMEDIATE")
            .unwrap();
        assert!(storage.restore(name(&selected)).is_err());
        assert_eq!(storage.load().unwrap(), before);
        assert_eq!(storage.backups().len(), 1);
        storage.connection().execute_batch("ROLLBACK").unwrap();
    }

    #[test]
    fn restoring_the_oldest_copy_keeps_it_and_the_safety_copy_during_retention() {
        let dir = TestDir(temp());
        let storage = Storage::open(&dir.0).unwrap();
        populate(&storage, "Selected");
        let copy = storage.backup().unwrap();
        let selected = storage.backups_dir().join("vela-20000101-000000.db");
        std::fs::rename(&copy, &selected).unwrap();
        for day in 2..=KEEP {
            std::fs::copy(
                &selected,
                storage
                    .backups_dir()
                    .join(format!("vela-2000010{day}-000000.db")),
            )
            .unwrap();
        }
        populate(&storage, "Current");
        let previous = storage.restore(name(&selected)).unwrap();
        assert!(previous.is_file());
        assert!(selected.is_file());
        assert_eq!(storage.backups().len(), KEEP);
        assert!(
            storage
                .load()
                .unwrap()
                .iter()
                .any(|entry| entry.key == PREFERENCES && entry.value.contains("Selected"))
        );
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn a_symlink_to_a_copy_outside_the_backup_folder_is_rejected() {
        let dir = TestDir(temp());
        let source_dir = TestDir(temp());
        let storage = Storage::open(&dir.0).unwrap();
        let source = Storage::open(&source_dir.0).unwrap();
        populate(&storage, "Current");
        populate(&source, "Outside");
        let external = source.backup().unwrap();
        std::fs::create_dir_all(storage.backups_dir()).unwrap();
        let link = storage.backups_dir().join("vela-20200101-000000.db");
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(external, &link);
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(external, &link);
        if let Err(error) = linked {
            // Windows may forbid creating test symlinks without Developer Mode or privilege.
            assert!(
                error.kind() == std::io::ErrorKind::PermissionDenied
                    || (cfg!(windows) && error.raw_os_error() == Some(1314))
            );
            eprintln!("Symlink setup unavailable on this machine: {error}");
            return;
        }
        let before = storage.load().unwrap();
        assert!(storage.restore(name(&link)).is_err());
        assert_eq!(storage.load().unwrap(), before);
        assert!(storage.backups().is_empty());
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn a_backup_directory_redirected_outside_the_application_data_is_rejected() {
        let dir = TestDir(temp());
        let source_dir = TestDir(temp());
        let storage = Storage::open(&dir.0).unwrap();
        let source = Storage::open(&source_dir.0).unwrap();
        populate(&storage, "Current");
        populate(&source, "Outside");
        let external = source.backup().unwrap();
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(source.backups_dir(), storage.backups_dir());
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(source.backups_dir(), storage.backups_dir());
        if let Err(error) = linked {
            assert!(
                error.kind() == std::io::ErrorKind::PermissionDenied
                    || (cfg!(windows) && error.raw_os_error() == Some(1314))
            );
            eprintln!("Symlink setup unavailable on this machine: {error}");
            return;
        }
        let before = storage.load().unwrap();
        assert!(storage.restore(name(&external)).is_err());
        assert_eq!(storage.load().unwrap(), before);
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
        // Nothing to back up yet.
        assert!(storage.backup_if_due().unwrap().is_none());
        storage.write(&[change("vela.a", Some("1"))]).unwrap();
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
