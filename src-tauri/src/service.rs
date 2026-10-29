//! Starts the streaming server that Stremio installs when nothing answers on its address.
//! Stremio runs it as `stremio-runtime.exe server.js` from its install folder (checked with
//! Stremio 4.4 and Stremio 5, server 4.22.3); Vela does the same and stops it when it exits.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use tauri::State;
use tokio::process::{Child, Command};

#[derive(Default)]
pub struct Service(Mutex<Option<Child>>);

impl Service {
    /// Stops the server Vela started, if any; a server started by Stremio is left alone.
    pub fn stop(&self) {
        if let Some(mut child) = self.0.lock().ok().and_then(|mut child| child.take()) {
            let _ = child.start_kill();
        }
    }
}

fn runtime(folder: &Path) -> Option<PathBuf> {
    let runtime = folder.join(if cfg!(windows) {
        "stremio-runtime.exe"
    } else {
        "stremio-runtime"
    });
    (runtime.is_file() && folder.join("server.js").is_file()).then_some(runtime)
}

/// Install folders of Stremio 5 and Stremio 4 for the current user, newest first.
fn installed() -> Option<(PathBuf, PathBuf)> {
    let local = PathBuf::from(std::env::var_os("LOCALAPPDATA")?);
    [
        local.join("Programs/Stremio"),
        local.join("Programs/LNV/Stremio-4"),
    ]
    .into_iter()
    .find_map(|folder| runtime(&folder).map(|runtime| (folder, runtime)))
}

#[tauri::command]
pub fn service_installed() -> bool {
    installed().is_some()
}

/// Starts the server unless Vela already did. The caller waits for it to answer.
#[tauri::command]
pub fn service_start(service: State<'_, Service>) -> Result<(), String> {
    let mut current = service
        .0
        .lock()
        .map_err(|_| "No se pudo iniciar el servidor de Stremio.".to_owned())?;
    if let Some(child) = current.as_mut()
        && matches!(child.try_wait(), Ok(None))
    {
        return Ok(());
    }
    let (folder, runtime) = installed().ok_or_else(|| {
        "No se encontró Stremio en este equipo. Instálalo o abre Stremio Service.".to_owned()
    })?;
    let mut command = Command::new(runtime);
    command
        .arg("server.js")
        .current_dir(folder)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    *current = Some(
        command
            .spawn()
            .map_err(|_| "No se pudo iniciar el servidor de Stremio.".to_owned())?,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn needs_both_the_runtime_and_the_server_script() {
        let folder = std::env::temp_dir().join(format!("vela-service-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let name = if cfg!(windows) {
            "stremio-runtime.exe"
        } else {
            "stremio-runtime"
        };
        std::fs::write(folder.join(name), b"").unwrap();
        assert!(runtime(&folder).is_none());
        std::fs::write(folder.join("server.js"), b"").unwrap();
        assert_eq!(runtime(&folder), Some(folder.join(name)));
        std::fs::remove_dir_all(&folder).unwrap();
    }
}
